'use strict';

// Cache compiled statements, never results: worker imports remain visible on the next read.
/** Maximum prepared read statements retained per SQLite connection; bounds dynamic filter combinations. */
const READ_CACHE_LIMIT = 64;
/** Connection-owned LRU maps held weakly so closing/dropping a connection does not pin it in memory. */
const readCaches = new WeakMap();

/**
 * Reuse a prepared read statement, refreshing its position in the bounded per-connection LRU cache. Results are never cached.
 * @param {import('node:sqlite').DatabaseSync} db Open connection that owns the statement.
 * @param {string} sql SQL text, including placeholders; values are bound by the caller.
 * @returns {import('node:sqlite').StatementSync} Prepared statement for this connection and SQL.
 */
function readStatement(db, sql) {
  let cache = readCaches.get(db);
  if (!cache) {
    cache = new Map();
    readCaches.set(db, cache);
  }
  let statement = cache.get(sql);
  if (statement) cache.delete(sql);
  else statement = db.prepare(sql);
  cache.set(sql, statement);
  if (cache.size > READ_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return statement;
}

/**
 * Discard cached statements after custom SQL may have changed the schema or connection state.
 * Call even when custom SQL failed part-way through; it may already have changed the schema.
 * @param {import('node:sqlite').DatabaseSync} db Connection whose next read must prepare fresh SQL.
 * @returns {void} Removes only the statement cache, not database rows.
 */
function clearReadStatements(db) {
  readCaches.delete(db);
}

/**
 * Choose the oldest queued replay whose watcher retry delay has elapsed without allocating the entire queue.
 * @param {import('node:sqlite').DatabaseSync} db Open SQLite connection.
 * @param {Map<string, number>} retryAt Import IDs and their next permitted retry time in Unix milliseconds.
 * @param {number} now Current Unix time in milliseconds; injectable for deterministic scheduling tests.
 * @returns The next import row, or undefined when none is ready.
 */
function nextQueuedReplay(db, retryAt, now = Date.now()) {
  const statement = readStatement(
    db,
    `SELECT id, name, source, sourcePath, addedAt
    FROM ReplayImports WHERE status = 'awaiting-reader' ORDER BY addedAt, rowid`,
  );
  // Returning from for-of closes the SQLite iterator before the queue writes.
  // Do not materialize every pending upload just to choose the first one.
  for (const entry of statement.iterate()) {
    if (entry.source !== 'watcher' || (retryAt.get(entry.id) || 0) <= now) return entry;
  }
  return undefined;
}

/**
 * Convert SQLite values that JSON cannot represent directly, preserving ordinary scalar values.
 * @param {unknown} value A single SQLite result value.
 * @returns A JSON-safe scalar; integers become decimal strings and blobs become hexadecimal strings.
 */
function sqlValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value).toString('hex');
  return value;
}

/**
 * Materialize only the final JSON-safe result rows while iterating the SQLite cursor.
 * @param {import('node:sqlite').StatementSync} statement Prepared statement to execute without additional bindings.
 * @returns Rows in database order, with blob and bigint values converted for JSON.
 */
function sqlResultRows(statement) {
  const rows = [];
  // Keep just the final response rows, instead of all() plus a second mapped
  // copy of the complete result. Row order and JSON conversions are unchanged.
  for (const row of statement.iterate()) {
    rows.push(
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sqlValue(value)])),
    );
  }
  return rows;
}

module.exports = { readStatement, clearReadStatements, nextQueuedReplay, sqlResultRows };
