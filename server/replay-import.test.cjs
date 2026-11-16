'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { importReplay, replayIdentity } = require('./replay-import.cjs');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE GameStats (gameID TEXT PRIMARY KEY, owner TEXT NOT NULL, timestamp TEXT UNIQUE, replayName TEXT,
    mode TEXT, bots INTEGER, players INTEGER, duration INTEGER, placement INTEGER, kills INTEGER, assists INTEGER,
    accuracy REAL, damageDealt INTEGER, damageTaken INTEGER, distanceTravelled REAL);
  CREATE TABLE GamePlayers (id INTEGER PRIMARY KEY, playerID TEXT, gameID TEXT, isBot INTEGER, team INTEGER, kills INTEGER, placement INTEGER);
  CREATE TABLE Players (playerID TEXT PRIMARY KEY, username TEXT, isBot TEXT, platform TEXT, skin TEXT, snipes INTEGER);
  CREATE TABLE GameEliminations (id INTEGER PRIMARY KEY, gameID TEXT, time INTEGER, killerID TEXT, killedID TEXT, knocked INTEGER, weapon TEXT);
`);
const replay = {
  Info: { Timestamp: '2026-11-11T19:52:43Z' },
  GameData: {
    GameSessionId: 'match-one',
    CurrentPlaylist: 'Playlist_DefaultDuo',
    MatchEndTime: 600,
  },
  PlayerData: [
    {
      PlayerId: 'owner',
      PlayerName: 'Owner',
      IsReplayOwner: true,
      IsBot: false,
      TeamIndex: 3,
      Placement: 3,
      Kills: 8,
      Platform: 'WIN',
      Cosmetics: { Character: 'CID_A' },
    },
    {
      PlayerId: 'partner',
      PlayerName: 'Partner',
      IsBot: false,
      TeamIndex: 3,
      Placement: 4,
      Kills: 2,
      Platform: 'PS5',
    },
    { PlayerId: 'bot', PlayerName: 'Bot', IsBot: true, TeamIndex: 4, Placement: 5, Kills: 0 },
  ],
  Stats: {
    Info: { StartTime: 550000 },
    Eliminations: 8,
    Assists: 1,
    Accuracy: 0.3443,
    WeaponDamage: 1000,
    OtherDamage: 467,
    DamageTaken: 770,
    TotalTraveled: 4218.47,
  },
  Eliminations: [
    {
      Eliminator: 'owner',
      Eliminated: 'bot',
      Info: { StartTime: 49000 },
      Knocked: false,
      GunType: 3,
    },
  ],
};
assert.equal(importReplay(db, replay, 'first.replay').duplicate, false);
assert.deepEqual(
  {
    ...db
      .prepare(
        'SELECT owner, bots, players, placement, kills, accuracy, damageDealt FROM GameStats',
      )
      .get(),
  },
  {
    owner: 'owner',
    bots: 1,
    players: 2,
    placement: 3,
    kills: 8,
    accuracy: 0.3443,
    damageDealt: 1467,
  },
);
assert.equal(
  db.prepare('SELECT distanceTravelled FROM GameStats').get().distanceTravelled,
  4218.47,
);
assert.deepEqual(
  { ...db.prepare('SELECT team, placement FROM GamePlayers WHERE playerID = ?').get('partner') },
  { team: 1, placement: 3 },
);
assert.equal(db.prepare('SELECT time FROM GameEliminations').get().time, 49000);
assert.equal(db.prepare('SELECT weapon FROM GameEliminations').get().weapon, 'Shotgun');
assert.equal(importReplay(db, replay, 'first.replay').duplicate, true);
const duplicate = structuredClone(replay);
duplicate.Info.Timestamp = '2026-11-12T00:00:00Z';
assert.equal(importReplay(db, duplicate, 'renamed-copy.replay').duplicate, true);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM GameStats').get().n, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM GameEliminations').get().n, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Players').get().n, 3);
const unmarked = structuredClone(replay);
unmarked.GameData.GameSessionId = 'unmarked-match';
unmarked.Info.Timestamp = '2026-11-11T19:54:43Z';
unmarked.PlayerData[0].IsReplayOwner = false;
unmarked.PlayerData[0].IsGameSessionOwner = true;
importReplay(db, unmarked, 'unmarked.replay', ['owner']);
assert.equal(
  db.prepare("SELECT owner FROM GameStats WHERE gameID = 'unmarked-match'").get().owner,
  'null',
);
const missingSession = structuredClone(replay);
missingSession.GameData.GameSessionId = null;
missingSession.Header = { Guid: 'E2B72A7BEA68704EB50501801D2618B3' };
assert.deepEqual(replayIdentity(missingSession), {
  gameID: 'e2b72a7bea68704eb50501801d2618b3',
  fromHeader: true,
});
assert.deepEqual(importReplay(db, missingSession, 'first.replay'), {
  gameID: 'match-one',
  duplicate: true,
});
missingSession.Info.Timestamp = '2026-11-11T19:55:43Z';
assert.equal(
  importReplay(db, missingSession, 'creative.replay').gameID,
  'e2b72a7bea68704eb50501801d2618b3',
);
assert.equal(importReplay(db, missingSession, 'creative.replay').duplicate, true);
const second = structuredClone(replay);
second.GameData.GameSessionId = 'match-two';
second.Info.Timestamp = '2026-11-11T20:00:00Z';
second.GameData.CurrentPlaylist = 'CREATIVE_UNREAL';
second.PlayerData[0].Cosmetics.Character = null;
second.PlayerData[0].PlayerName = null;
importReplay(db, second, 'second.replay');
assert.deepEqual(
  { ...db.prepare('SELECT skin, username, snipes FROM Players WHERE playerID = ?').get('owner') },
  { skin: 'CID_A', username: 'Owner', snipes: 4 },
);
assert.equal(
  db.prepare('SELECT placement FROM GameStats WHERE gameID = ?').get('match-two').placement,
  0,
);
const completed = structuredClone(replay);
completed.GameData.GameSessionId = 'completed-teams';
completed.Info.Timestamp = '2026-11-11T20:01:00Z';
completed.PlayerData[0].IsReplayOwner = false;
completed.PlayerData[1].Placement = 0;
completed.TeamData = [
  { TeamIndex: 3, Placement: 1 },
  { TeamIndex: 4, Placement: 2 },
];
completed.TeamStats = { Position: 1 };
importReplay(db, completed, 'completed.replay', ['owner']);
assert.deepEqual(
  {
    ...db.prepare("SELECT owner, placement FROM GameStats WHERE gameID = 'completed-teams'").get(),
  },
  { owner: 'null', placement: 1 },
);
assert.deepEqual(
  db
    .prepare(
      "SELECT DISTINCT placement FROM GamePlayers WHERE gameID = 'completed-teams' AND team = 1",
    )
    .all()
    .map((row) => row.placement),
  [1],
);
const unfinished = structuredClone(completed);
unfinished.GameData.GameSessionId = 'unfinished-teams';
unfinished.Info.Timestamp = '2026-11-11T20:02:00Z';
unfinished.TeamData = [{ TeamIndex: 3, Placement: 2 }];
unfinished.TeamStats = { Position: 0 };
unfinished.PlayerData[0].Placement = 0;
importReplay(db, unfinished, 'unfinished.replay', ['owner']);
assert.equal(
  db.prepare("SELECT placement FROM GameStats WHERE gameID = 'unfinished-teams'").get().placement,
  0,
);
assert.deepEqual(
  db
    .prepare(
      "SELECT DISTINCT placement FROM GamePlayers WHERE gameID = 'unfinished-teams' AND team = 1",
    )
    .all()
    .map((row) => row.placement),
  [0],
);
if (process.argv[2]) {
  const actual = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
  const result = importReplay(db, actual, 'actual.replay');
  assert.equal(result.duplicate, false);
  assert.ok(result.players > 0 && result.eliminations > 0);
  const replayOwner = actual.PlayerData.find((player) => player.IsReplayOwner)?.PlayerId || 'null';
  assert.equal(
    db.prepare('SELECT owner FROM GameStats WHERE gameID = ?').get(result.gameID).owner,
    replayOwner,
  );
  const stats = db
    .prepare('SELECT bots, players, duration, distanceTravelled FROM GameStats WHERE gameID = ?')
    .get(result.gameID);
  assert.equal(stats.duration, actual.Info.LengthInMs);
  assert.equal(stats.distanceTravelled, actual.Stats.TotalTraveled);
  console.log(
    `Actual reader JSON imported: ${result.players} players, ${result.eliminations} eliminations, ${stats.bots} bots.`,
  );
}
console.log('Replay import mapping passed.');
