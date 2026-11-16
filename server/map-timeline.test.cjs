'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractMapTimeline } = require('./map-timeline.cjs');

test('movement extraction normalizes timestamps and omits dense or invalid positions', () => {
  /**
   * Create a replay location with both replay and world clocks for timeline tests.
   * @param time Replay time in seconds.
   * @param x World X coordinate.
   * @param y World Y coordinate.
   * @returns A parser-shaped location sample.
   */
  const point = (time, x, y) => ({
    ReplicatedWorldTimeSecondsDouble: time,
    ReplicatedMovement: { Location: { X: x, Y: y, Z: 42 }, Rotation: { Yaw: 90 } },
  });
  const replay = {
    GameData: { MapInfo: 'Island' },
    PlayerData: [
      {
        PlayerId: 'one',
        PlayerName: 'One',
        TeamIndex: 2,
        Locations: [
          point(100, 10, 20),
          point(100.1, 11, 21),
          point(100.4, 15, 25),
          point(101.5, 30, 40),
          point(103, NaN, 50),
        ],
      },
      { PlayerId: 'two', PlayerName: 'Two', TeamIndex: 3, Locations: [point(99, 1, 2)] },
    ],
  };
  const result = extractMapTimeline(replay, 'match');
  assert.equal(result.duration, 3);
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[0].team, 0);
  assert.equal(result.tracks[1].team, 1);
  assert.deepEqual(result.tracks[0].samples, [
    [1, 10, 20, 42, 90],
    [1.4, 15, 25, 42, 90],
    [2.5, 30, 40, 42, 90],
  ]);
  assert.deepEqual(result.tracks[1].samples, [[0, 1, 2, 42, 90]]);
});

test('movement uses replay elapsed time and aligns world-time storm stages', () => {
  const replay = {
    Info: { LengthInMs: 150000 },
    MapData: {
      SafeZones: [
        {
          Radius: 10000,
          NextRadius: 5000,
          NextCenter: { X: 100, Y: 200 },
          StartShrinkTime: 140,
          FinishShrinkTime: 160,
        },
      ],
    },
    PlayerData: [
      {
        PlayerId: 'owner',
        Locations: [
          {
            LastUpdateTime: 100,
            ReplicatedWorldTimeSecondsDouble: 140,
            ReplicatedMovement: { Location: { X: 1, Y: 2 }, Rotation: { Yaw: 90 } },
          },
        ],
      },
    ],
  };
  const result = extractMapTimeline(replay, 'game');
  assert.equal(result.tracks[0].samples[0][0], 100);
  assert.equal(result.worldOffset, 40);
  assert.equal(result.stormZones[0].start, 100);
  assert.equal(result.duration, 150);
});

test('visibility owner uses replay marker or exactly one configured account', () => {
  /**
   * Create a minimal player fixture for owner-selection tests.
   * @param id Player ID for the fixture.
   * @returns A parser-shaped player record.
   */
  const player = (id) => ({
    PlayerId: id,
    Locations: [{ LastUpdateTime: 100, ReplicatedMovement: { Location: { X: 0, Y: 0 } } }],
  });
  const replay = { PlayerData: [player('one'), player('two')] };
  assert.equal(extractMapTimeline(replay, 'game', ['one']).ownerId, 'one');
  assert.equal(extractMapTimeline(replay, 'game', ['one', 'two']).ownerId, null);
  replay.PlayerData[1].IsReplayOwner = true;
  assert.equal(extractMapTimeline(replay, 'game', ['one', 'two']).ownerId, 'two');
});
