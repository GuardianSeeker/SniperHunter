'use strict';

/**
 * Rebuild derived player counts and search indexes transactionally when source table counts change.
 * @param db Open SQLite connection; source rows remain authoritative.
 * @returns Nothing; updates cache metadata only after a successful rebuild.
 */
function rebuildPlayerCounts(db) {
  const missingPlatform =
    "(p.platform IS NULL OR TRIM(p.platform) = '' OR UPPER(TRIM(p.platform)) = 'NULL')";
  const hasSkin = "(p.skin IS NOT NULL AND TRIM(p.skin) <> '')";
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DELETE FROM PlayerCounts;
      INSERT INTO PlayerCounts (playerID, games, kills, isBot, username, platform, platformCode, skin, category, isAI)
      SELECT gp.playerID, gp.games, gp.kills, gp.isBot,
        COALESCE(NULLIF(p.username, ''), gp.playerID), COALESCE(p.platform, ''),
        UPPER(TRIM(COALESCE(p.platform, ''))), COALESCE(p.skin, ''),
        CASE WHEN ${missingPlatform} AND NOT ${hasSkin} THEN 'AI'
          WHEN ${missingPlatform} THEN 'Unknown'
          WHEN UPPER(TRIM(p.platform)) IN ('WIN', 'MAC', 'LIN') THEN 'PC'
          WHEN UPPER(TRIM(p.platform)) IN ('PS4', 'PS5', 'PSN') THEN 'PlayStation'
          WHEN UPPER(TRIM(p.platform)) IN ('XSX', 'XBL', 'XB1') THEN 'Xbox'
          WHEN UPPER(TRIM(p.platform)) IN ('SWT', 'SWT2') THEN 'Switch'
          WHEN UPPER(TRIM(p.platform)) = 'AND' THEN 'Android'
          WHEN UPPER(TRIM(p.platform)) = 'IOS' THEN 'iOS'
          ELSE 'Other' END,
        CASE WHEN ${missingPlatform} AND NOT ${hasSkin} THEN 1 ELSE 0 END
      FROM (SELECT playerID, COUNT(DISTINCT gameID) AS games, COALESCE(SUM(kills), 0) AS kills,
        MAX(isBot) AS isBot FROM GamePlayers GROUP BY playerID) AS gp
      LEFT JOIN Players p ON p.playerID = gp.playerID;
      INSERT INTO PlayerSearch(PlayerSearch) VALUES('delete-all');
      INSERT INTO PlayerSearch (rowid, playerID, username, platform, skin)
        SELECT rowid, playerID, username, platform, skin FROM PlayerCounts;
      DELETE FROM PlayerPlatformCounts;
      INSERT INTO PlayerPlatformCounts (category, code, players)
        SELECT category, platformCode, COUNT(*) FROM PlayerCounts GROUP BY category, platformCode;
      INSERT OR REPLACE INTO PlayerCacheMeta (key, value)
        VALUES ('sourceRows', (SELECT COUNT(*) FROM GamePlayers)),
          ('sourcePlayers', (SELECT COUNT(*) FROM Players));`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { rebuildPlayerCounts };
