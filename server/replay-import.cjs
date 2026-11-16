'use strict';

// FortniteReplayReader's JSON uses PascalCase. Keep the mapping here so the
// database transaction can be tested without launching the reader process.
/**
 * Read the first available field alias used by historical parser output formats.
 * @param value Object to inspect.
 * @param names Field names in priority order.
 * @returns The first defined field value, or undefined.
 */
const field = (value, ...names) =>
  names.map((name) => value?.[name]).find((item) => item !== undefined && item !== null);
/**
 * Convert a replay value to a finite number, replacing invalid named floating-point values.
 * @param value Replay numeric value.
 * @param fallback Fallback when conversion is not finite.
 * @returns A finite number or the supplied fallback.
 */
const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
/**
 * Normalize nullable parser values into text for legacy database columns.
 * @param value Parser value to convert.
 * @returns A string, empty when the value is absent.
 */
const text = (value) => (value == null ? '' : String(value).trim());
/**
 * Trim and cap parser identifiers, normalizing 32-digit hexadecimal IDs to lowercase.
 * @param value Raw player/session identifier.
 * @returns The normalized ID string, empty when absent.
 */
const validId = (value) => {
  const id = text(value).slice(0, 255);
  return /^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : id;
};
/**
 * Prefer the game session ID, falling back to the replay header GUID for creative recordings.
 * @param replay Decoded parser replay.
 * @returns The chosen gameID and whether it came from the header.
 */
const replayIdentity = (replay) => {
  const data = field(replay, 'GameData', 'gameData') || {};
  const header = field(replay, 'Header', 'header') || {};
  const sessionID = validId(field(data, 'GameSessionId', 'gameSessionId'));
  return { gameID: sessionID || validId(field(header, 'Guid', 'guid')), fromHeader: !sessionID };
};
// Keep the names used by the original database for codes confirmed against old replays.
/** Legacy weapon-code names confirmed against older replay imports; unknown numeric codes remain visible instead of being discarded. */
const gunTypes = {
  0: 'Storm',
  1: 'Fall',
  2: 'Pistol',
  3: 'Shotgun',
  4: 'Rifle',
  5: 'SMG',
  6: 'Sniper',
  7: 'NoScope',
  8: 'Pickaxe',
  9: 'InfinityBlade',
  10: 'Grenade',
  11: 'C4',
  12: 'GrenadeLauncher',
  13: 'Explosives',
  14: 'Minigun',
  15: 'Bow',
  16: 'Trap',
  17: 'FinallyEliminated',
  18: 'Banhammer',
  19: 'RemovedFromGame',
  20: 'MassiveMelee',
  21: 'MassiveDiveBomb',
  22: 'MassiveRanged',
  23: 'Vehicle',
  24: 'ShoppingCart',
  25: 'ATK',
  26: 'QuadCrasher',
  27: 'Biplane',
  28: 'BiplaneGun',
  29: 'LMG',
  30: 'Stink',
  31: 'Water',
  32: 'Turret',
  33: 'ShipCannon',
  34: 'Cube',
  35: 'Balloon',
  36: 'StormSurge',
  37: 'Lava',
  38: 'BasicFiend',
  39: 'EliteFiend',
  40: 'RangedFiend',
  41: 'BasicBrute',
  42: 'EliteBrute',
  43: 'MegaBrute',
  44: 'SilentSwitchingToSpectate',
  45: 'LoggedOut',
  46: 'TeamSwitchSuicide',
  47: 'WonMatch',
  48: 'Unknown',
};
/**
 * Translate legacy numeric weapon codes while preserving textual categories.
 * @param value Numeric or textual gun type.
 * @returns The displayable weapon category.
 */
const gunName = (value) => {
  const raw = text(value);
  if (!raw) return 'Unknown';
  return /^\d+$/.test(raw) ? gunTypes[Number(raw)] || `Unknown (${raw})` : raw;
};

/**
 * Decode and deduplicate player records by account ID using supported parser field aliases.
 * @param replay Decoded replay with PlayerData.
 * @returns A map keyed by normalized player ID; duplicate IDs keep the first record.
 */
function readPlayers(replay) {
  const sourcePlayers = field(replay, 'PlayerData', 'playerData') || [];
  if (!Array.isArray(sourcePlayers)) throw new Error('Reader output PlayerData must be an array.');
  const players = new Map();
  for (const entry of sourcePlayers) {
    const id = validId(
      field(
        entry,
        'PlayerId',
        'playerId',
        'BotId',
        'botId',
        'EpicId',
        'epicId',
        'PlatformUniqueNetId',
      ),
    );
    if (!id || players.has(id)) continue;
    players.set(id, {
      id,
      username:
        text(
          field(
            entry,
            'PlayerName',
            'playerName',
            'PlayerNameCustomOverride',
            'playerNameCustomOverride',
          ),
        ) || id,
      isBot: field(entry, 'IsBot', 'isBot') === true,
      platform: text(field(entry, 'Platform', 'platform')) || null,
      skin: text(field(field(entry, 'Cosmetics', 'cosmetics'), 'Character', 'character')) || null,
      teamIndex: finite(field(entry, 'TeamIndex', 'teamIndex'), -1),
      kills: Math.max(0, finite(field(entry, 'Kills', 'kills'))),
      placement: Math.max(0, finite(field(entry, 'Placement', 'placement'))),
      // A game-session owner can be another player in a creative island.
      owner: field(entry, 'IsReplayOwner', 'isReplayOwner') === true,
    });
  }

  return players;
}

/**
 * Reconcile team and member placements, respecting still-alive teams until a winner is known.
 * @param replay Decoded replay containing TeamData.
 * @param gamePlayers Normalized player records.
 * @returns A map from raw replay team numbers to resolved placements.
 */
function resolveTeamPlacements(replay, gamePlayers) {
  const rawTeams = field(replay, 'TeamData', 'teamData') || [];
  const teamData = new Map(
    Array.isArray(rawTeams)
      ? rawTeams.map((team) => [
          finite(field(team, 'TeamIndex', 'teamIndex'), -1),
          Math.max(0, finite(field(team, 'Placement', 'placement'))),
        ])
      : [],
  );
  const winnerRecorded =
    [...teamData.values()].includes(1) || gamePlayers.some((player) => player.placement === 1);
  const membersByTeam = new Map();
  for (const player of gamePlayers) {
    if (!membersByTeam.has(player.teamIndex)) membersByTeam.set(player.teamIndex, []);
    membersByTeam.get(player.teamIndex).push(player);
  }
  const teamPlacement = new Map();
  for (const [teamIndex, members] of membersByTeam) {
    const recorded = teamData.get(teamIndex) || 0;
    const allPlaced = members.every((player) => player.placement > 0);
    // A missing member placement means the team may still be alive. A recorded
    // winner confirms the match finished, so TeamData can resolve that gap.
    const placement =
      !winnerRecorded && !allPlaced
        ? 0
        : recorded || (allPlaced ? Math.min(...members.map((player) => player.placement)) : 0);
    teamPlacement.set(teamIndex, placement);
  }

  return teamPlacement;
}

/**
 * Decode valid elimination/knock events while preserving their replay clock and participant IDs.
 * @param replay Decoded replay containing elimination events.
 * @returns Normalized elimination records.
 */
function readEliminations(replay) {
  const rawEliminations = field(replay, 'Eliminations', 'eliminations') || [];
  const eliminations = Array.isArray(rawEliminations)
    ? rawEliminations
        .map((entry) => {
          const timeText = text(field(entry, 'Time', 'time'));
          const parts = /^((?:\d+:)?\d+):\d+(?:\.\d+)?$/.test(timeText)
            ? timeText.split(':').map(Number)
            : [];
          const parsedTime = parts.length
            ? parts.reduce((sum, part) => sum * 60 + part, 0) * 1000
            : 0;
          return {
            killerID: validId(
              field(entry, 'Eliminator', 'eliminator', 'EliminatorInfo')?.Id ??
                field(entry, 'Eliminator', 'eliminator'),
            ),
            killedID: validId(
              field(entry, 'Eliminated', 'eliminated', 'EliminatedInfo')?.Id ??
                field(entry, 'Eliminated', 'eliminated'),
            ),
            time: Math.max(
              0,
              finite(field(field(entry, 'Info', 'info'), 'StartTime', 'startTime'), parsedTime),
            ),
            knocked: field(entry, 'Knocked', 'knocked') === true ? 1 : 0,
            weapon: gunName(field(entry, 'GunType', 'gunType')),
          };
        })
        .filter((item) => item.killerID && item.killedID)
    : [];

  return eliminations;
}

/**
 * Upsert player identities and write per-match membership inside the caller’s transaction.
 * @param db Writable SQLite connection.
 * @param gameID Session ID for these memberships.
 * @param gamePlayers Normalized players.
 * @param creative Whether the match uses creative-mode stat rules.
 * @param teamPlacement Resolved placements indexed by raw team number.
 * @returns Nothing; database writes participate in the existing transaction.
 */
function writePlayers(db, gameID, gamePlayers, creative, teamPlacement) {
  const insertGamePlayer =
    db.prepare(`INSERT INTO GamePlayers (playerID, gameID, isBot, team, kills, placement)
      VALUES (?, ?, ?, ?, ?, ?)`);
  const upsertPlayer =
    db.prepare(`INSERT INTO Players (playerID, username, isBot, platform, skin, snipes)
      VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(playerID) DO UPDATE SET
      username = CASE WHEN excluded.username = Players.playerID THEN Players.username ELSE excluded.username END,
      isBot = excluded.isBot,
      platform = COALESCE(excluded.platform, Players.platform),
      skin = COALESCE(excluded.skin, Players.skin), snipes = Players.snipes + 1`);
  for (const player of gamePlayers) {
    insertGamePlayer.run(
      player.id,
      gameID,
      player.isBot ? 1 : 0,
      player.teamIndex >= 2 ? player.teamIndex - 2 : -1,
      player.kills,
      creative ? 0 : teamPlacement.get(player.teamIndex) || 0,
    );
    upsertPlayer.run(
      player.id,
      player.username,
      String(player.isBot ? 1 : 0),
      player.platform,
      player.skin,
    );
  }
}

/**
 * Write normalized feed events inside the caller’s transaction.
 * @param db Writable SQLite connection.
 * @param gameID Session ID for these events.
 * @param eliminations Normalized elimination records.
 * @returns Nothing.
 */
function writeEliminations(db, gameID, eliminations) {
  const insertElimination =
    db.prepare(`INSERT INTO GameEliminations (gameID, time, killerID, killedID, knocked, weapon)
      VALUES (?, ?, ?, ?, ?, ?)`);
  for (const item of eliminations)
    insertElimination.run(
      gameID,
      item.time,
      item.killerID,
      item.killedID,
      item.knocked,
      item.weapon,
    );
}

/**
 * Import one complete replay atomically, retaining legacy raw stat units and avoiding duplicate game IDs.
 * @param db Writable SQLite connection.
 * @param replay Decoded parser replay.
 * @param replayName Original replay filename stored in GameStats.
 * @param ownerIds Configured accounts retained for API compatibility; replay ownership comes only from replay data.
 * @returns The imported game ID, counts and duplicate flag.
 */
function importReplay(db, replay, replayName, ownerIds = []) {
  const data = field(replay, 'GameData', 'gameData') || {};
  const info = field(replay, 'Info', 'info') || {};
  const { gameID, fromHeader } = replayIdentity(replay);
  if (!gameID) throw new Error('Reader output has neither GameData.GameSessionId nor Header.Guid.');
  if (db.prepare('SELECT 1 FROM GameStats WHERE gameID = ?').get(gameID))
    return { gameID, duplicate: true };
  // Older imports could have used a different ID for a replay without a session ID.
  if (fromHeader) {
    const existing = db
      .prepare('SELECT gameID FROM GameStats WHERE replayName = ? LIMIT 1')
      .get(replayName);
    if (existing) return { gameID: existing.gameID, duplicate: true };
  }
  const timestamp = new Date(
    field(info, 'Timestamp', 'timestamp') ||
      field(data, 'UtcTimeStartedMatch', 'utcTimeStartedMatch'),
  );
  if (Number.isNaN(timestamp.getTime()))
    throw new Error('Reader output has no valid replay timestamp.');
  const mode = text(field(data, 'CurrentPlaylist', 'currentPlaylist')) || 'CREATIVE_UNREAL';
  const creative = mode.toLowerCase().includes('creative');
  const players = readPlayers(replay);
  const owner = [...players.values()].find((player) => player.owner)?.id || 'null';
  const gamePlayers = [...players.values()];
  const teamPlacement = resolveTeamPlacements(replay, gamePlayers);
  const eliminations = readEliminations(replay);
  const stats = field(replay, 'Stats', 'stats') || {};
  const personalStats = field(stats, 'Info', 'info') || {};
  const duration = Math.max(
    0,
    finite(field(info, 'LengthInMs', 'lengthInMs')),
    finite(field(personalStats, 'StartTime', 'startTime')),
    ...eliminations.map((item) => item.time),
  );
  const ownerPlayer = players.get(owner);
  const configuredPlayers = ownerIds
    .map(validId)
    .map((id) => players.get(id))
    .filter(Boolean);
  const personalPlayer =
    ownerPlayer || (configuredPlayers.length === 1 ? configuredPlayers[0] : null);
  const teamStats = field(replay, 'TeamStats', 'teamStats') || {};
  const reportedPlacement = Math.max(0, finite(field(teamStats, 'Position', 'position')));
  const personalPlacement =
    reportedPlacement || (personalPlayer ? teamPlacement.get(personalPlayer.teamIndex) || 0 : 0);
  const accuracy = finite(field(stats, 'Accuracy', 'accuracy'));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO GameStats (gameID, owner, timestamp, replayName, mode, bots, players, duration,
      placement, kills, assists, accuracy, damageDealt, damageTaken, distanceTravelled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      gameID,
      owner,
      timestamp.toISOString(),
      replayName,
      mode,
      creative ? 0 : gamePlayers.filter((player) => player.teamIndex > 2 && player.isBot).length,
      gamePlayers.filter((player) => player.teamIndex > 2 && !player.isBot).length,
      duration,
      creative ? 0 : personalPlacement,
      creative ? 0 : finite(field(stats, 'Eliminations', 'eliminations')),
      creative ? 0 : finite(field(stats, 'Assists', 'assists')),
      creative ? 0 : accuracy,
      creative
        ? 0
        : finite(
            field(stats, 'DamageToPlayers', 'damageToPlayers'),
            finite(field(stats, 'WeaponDamage', 'weaponDamage')) +
              finite(field(stats, 'OtherDamage', 'otherDamage')),
          ),
      creative ? 0 : finite(field(stats, 'DamageTaken', 'damageTaken')),
      creative ? 0 : finite(field(stats, 'TotalTraveled', 'totalTraveled')),
    );
    writePlayers(db, gameID, gamePlayers, creative, teamPlacement);
    writeEliminations(db, gameID, eliminations);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    gameID,
    duplicate: false,
    players: gamePlayers.length,
    eliminations: eliminations.length,
  };
}

module.exports = { importReplay, replayIdentity };
