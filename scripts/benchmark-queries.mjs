// Read-only, opt-in measurement against a local database. No runtime dependency.
// node --expose-gc scripts/benchmark-queries.mjs release/database.db
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import queries from '../server/database-queries.cjs';

const database = path.resolve(process.argv[2] || 'release/database.db');
const mode = process.argv[3];
if (!mode) {
  if (!fs.existsSync(database)) throw new Error('Supply the path to a sample database.');
  const results = [];
  // Separate processes avoid one approach inheriting the other's JS heap.
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const variant of ['baseline', 'refactored']) {
      const child = spawnSync(
        process.execPath,
        ['--expose-gc', import.meta.filename, database, variant],
        { encoding: 'utf8' },
      );
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      results.push(JSON.parse(child.stdout));
    }
  }
  console.log(JSON.stringify({ node: process.version, results }, null, 2));
} else {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const id = db
      .prepare('SELECT gameID FROM GameStats ORDER BY timestamp DESC LIMIT 1')
      .get()?.gameID;
    if (!id) throw new Error('The sample database has no games.');
    const sql = 'SELECT replayName FROM GameStats WHERE gameID = ?';
    /**
     * Prepare or reuse the lookup statement according to the benchmark variant.
     * @returns The matching replay-name row.
     */
    const select = () =>
      (mode === 'baseline' ? db.prepare(sql) : queries.readStatement(db, sql)).get(id);
    for (let i = 0; i < 500; i++) select();
    global.gc();
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    for (let i = 0; i < 20000; i++) select();
    const lookupMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    global.gc();
    const memoryBefore = process.memoryUsage();
    // Exercise the SQL page's response conversion on the same rows, in order.
    const statement = db.prepare(
      'SELECT playerID, username, platform, skin FROM Players ORDER BY playerID LIMIT 100000',
    );
    const resultStart = performance.now();
    const rows =
      mode === 'baseline'
        ? statement
            .all()
            .map((row) =>
              Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value])),
            )
        : queries.sqlResultRows(statement);
    const resultMs = performance.now() - resultStart;
    const memoryAfter = process.memoryUsage();
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    console.log(
      JSON.stringify({
        mode,
        lookupIterations: 20000,
        lookupMs,
        lookupCpuMs: (cpu.user + cpu.system) / 1000,
        resultRows: rows.length,
        resultMs,
        resultHeapBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
        resultRssBytes: memoryAfter.rss - memoryBefore.rss,
        digest,
      }),
    );
  } finally {
    db.close();
  }
}
