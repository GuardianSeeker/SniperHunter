'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  readStatement,
  clearReadStatements,
  nextQueuedReplay,
  sqlResultRows,
} = require('./database-queries.cjs');

test('cached reads rebind arguments and see writes from another database connection', () => {
  const work = path.join(__dirname, '..', 'work');
  fs.mkdirSync(work, { recursive: true });
  const dir = fs.mkdtempSync(path.join(work, 'query-test-'));
  const file = path.join(dir, 'test.db');
  const db = new DatabaseSync(file);
  let writer;
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1,'one'),(2,'two')",
    );
    writer = new DatabaseSync(file);
    const sql = 'SELECT name FROM items WHERE id = ?';
    const first = readStatement(db, sql);
    assert.equal(first.get(1).name, 'one');
    assert.equal(readStatement(db, sql), first);
    assert.equal(first.get(2).name, 'two');
    assert.equal(first.get(null), undefined);
    writer.exec("UPDATE items SET name='changed' WHERE id=1");
    assert.equal(readStatement(db, sql).get(1).name, 'changed');
    assert.notEqual(readStatement(writer, sql), first);
    clearReadStatements(db);
    assert.notEqual(readStatement(db, sql), first);
    db.exec(
      "DROP TABLE items; CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1,'replacement')",
    );
    clearReadStatements(db);
    assert.equal(readStatement(db, sql).get(1).name, 'replacement');
  } finally {
    writer?.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read cache is bounded and retains recently used statements', () => {
  let prepared = 0;
  const db = {
    /**
     * Count preparations in the test double before returning its statement stub.
     * @param sql SQL text used as the stub identity.
     * @returns The prepared-statement stub.
     */
    prepare(sql) {
      return { sql, generation: ++prepared };
    },
  };
  const first = readStatement(db, 'SELECT 0');
  const second = readStatement(db, 'SELECT 1');
  for (let n = 2; n < 64; n++) readStatement(db, `SELECT ${n}`);
  assert.equal(readStatement(db, 'SELECT 0'), first);
  readStatement(db, 'SELECT 64');
  assert.equal(readStatement(db, 'SELECT 0'), first);
  assert.notEqual(readStatement(db, 'SELECT 1'), second);
  assert.equal(prepared, 66);
});

test('queue selection preserves time/rowid order, skips deferred watchers, and releases its iterator', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE ReplayImports(id TEXT, name TEXT, source TEXT, sourcePath TEXT, addedAt TEXT, status TEXT);
      INSERT INTO ReplayImports VALUES
        ('failed','failed.replay','upload',NULL,'0','failed'),
        ('watcher','live.replay','watcher',NULL,'1','awaiting-reader'),
        ('first','one.replay','local','one.replay','2','awaiting-reader'),
        ('second','two.replay','upload',NULL,'2','awaiting-reader');`);
    const retry = new Map([['watcher', 2000]]);
    const expected = db
      .prepare(
        `SELECT id, name, source, sourcePath, addedAt FROM ReplayImports
      WHERE status='awaiting-reader' ORDER BY addedAt,rowid`,
      )
      .all()
      .find((row) => row.source !== 'watcher' || (retry.get(row.id) || 0) <= 1000);
    assert.deepEqual(nextQueuedReplay(db, retry, 1000), expected);
    db.exec("UPDATE ReplayImports SET status='decoded' WHERE id='first'");
    assert.equal(nextQueuedReplay(db, retry, 1000).id, 'second');
    assert.equal(nextQueuedReplay(db, retry, 2000).id, 'watcher');
    db.exec("UPDATE ReplayImports SET status='decoded'");
    assert.equal(nextQueuedReplay(db, retry, 2000), undefined);
    db.exec('DROP TABLE ReplayImports');
  } finally {
    db.close();
  }
});

test('SQL result iteration preserves values, column order and write-returning behavior', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE items(id INTEGER, name TEXT, value BLOB); INSERT INTO items VALUES(2,NULL,x'00ff'),(1,'name',NULL)",
    );
    const sql = 'SELECT id, name, value FROM items ORDER BY id';
    /**
     * Reproduce the original result conversion for equivalence testing.
     * @param value SQLite cell value.
     * @returns The legacy JSON-safe representation.
     */
    const convert = (value) =>
      typeof value === 'bigint'
        ? value.toString()
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('hex')
          : value;
    const expected = db
      .prepare(sql)
      .all()
      .map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, convert(value)])),
      );
    assert.deepEqual(sqlResultRows(db.prepare(sql)), expected);
    const big = db.prepare('SELECT 9223372036854775807 AS value');
    big.setReadBigInts(true);
    assert.deepEqual(sqlResultRows(big), [{ value: '9223372036854775807' }]);
    assert.deepEqual(
      sqlResultRows(db.prepare("UPDATE items SET name='changed' WHERE id=1 RETURNING id,name")),
      [{ id: 1, name: 'changed' }],
    );
    assert.equal(db.prepare('SELECT name FROM items WHERE id=1').get().name, 'changed');
    assert.deepEqual(sqlResultRows(db.prepare('SELECT * FROM items WHERE 0')), []);
  } finally {
    db.close();
  }
});
