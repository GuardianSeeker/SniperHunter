'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

/**
 * Evaluate trusted embedded helper source inside the isolated replay worker.
 * @param source Application-owned CommonJS module source.
 * @returns The helper module exports.
 */
function loadModule(source) {
  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports;
}

const { importReplay, replayIdentity } = loadModule(workerData.importSource);
const { extractMapTimeline } = loadModule(workerData.mapSource);
const { rebuildPlayerCounts } = loadModule(workerData.cacheSource);

/**
 * Read and validate the parser’s single JSON output, surfacing reported parser errors.
 * @param jsonPath Absolute parser-output path.
 * @returns The decoded replay object.
 */
function readReplayJson(jsonPath) {
  const replay = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!replay || Array.isArray(replay) || typeof replay !== 'object')
    throw new Error('Reader output must be a JSON object.');
  if (typeof replay.error === 'string' && replay.error) throw new Error(replay.error);
  return replay;
}

/**
 * Verify replay identity before exposing a restored timeline for a requested match.
 * @param db Read-only database connection used for legacy filename matching.
 * @param replay Decoded replay.
 * @param job Map job with expected gameID, input path and configured account IDs.
 * @returns The verified movement timeline.
 */
function readMapJob(db, replay, job) {
  const { gameID: decodedID, fromHeader } = replayIdentity(replay);
  const legacyMatch =
    fromHeader &&
    db
      .prepare('SELECT 1 FROM GameStats WHERE gameID = ? AND replayName = ?')
      .get(job.gameID, path.basename(job.input));
  if (decodedID.toLowerCase() !== String(job.gameID).toLowerCase() && !legacyMatch) {
    const error = new Error('The replay file has a different gameID from this match.');
    error.code = 'replay_mismatch';
    throw error;
  }
  return extractMapTimeline(replay, job.gameID, job.ownerIds);
}

/**
 * Import the replay, refresh player search data and return optional latest-match movement.
 * @param db Writable worker database connection.
 * @param replay Decoded replay.
 * @param job Import job with filename and configured account IDs.
 * @returns Import result, optional timeline, unique skin IDs and any nonfatal cache/map warning.
 */
function importReplayJob(db, replay, job) {
  const imported = importReplay(db, replay, job.name, job.ownerIds);
  let warning = null;
  if (!imported.duplicate) {
    try {
      rebuildPlayerCounts(db);
    } catch (error) {
      db.prepare("DELETE FROM PlayerCacheMeta WHERE key IN ('sourceRows', 'sourcePlayers')").run();
      warning = `Player search cache could not refresh: ${error.message}`;
    }
  }
  let timeline = null;
  const newest =
    !imported.duplicate &&
    db.prepare('SELECT gameID FROM GameStats ORDER BY timestamp DESC LIMIT 1').get();
  if (newest?.gameID === imported.gameID) {
    try {
      timeline = extractMapTimeline(replay, imported.gameID, job.ownerIds);
    } catch (error) {
      warning = `Map movement could not load: ${error.message}`;
    }
  }
  const skinIds = [
    ...new Set(
      (replay.PlayerData || []).map((player) => player?.Cosmetics?.Character).filter(Boolean),
    ),
  ];
  return { imported, timeline, skinIds, warning };
}

/**
 * Dispatch one worker job and report a serializable result/error before closing its SQLite connection.
 * @returns Nothing; sends one message to the parent thread.
 */
function runJob() {
  let db;
  try {
    const job = workerData.job;
    const replay = readReplayJson(job.jsonPath);
    db = new DatabaseSync(workerData.databasePath, { readOnly: job.action === 'map' });
    db.exec('PRAGMA busy_timeout = 5000');
    if (job.action === 'map') parentPort.postMessage({ result: readMapJob(db, replay, job) });
    else if (job.action === 'import')
      parentPort.postMessage({ result: importReplayJob(db, replay, job) });
    else throw new Error('Invalid replay worker action.');
  } catch (error) {
    parentPort.postMessage({
      error: { message: error.message || String(error), code: error.code || null },
    });
  } finally {
    db?.close();
  }
}

runJob();
