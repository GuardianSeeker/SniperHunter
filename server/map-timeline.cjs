'use strict';

/** Default recorded-range estimate in Unreal world units when samples are insufficient. */
const DEFAULT_VISIBILITY_RADIUS = 28000;
/** Keep at most four positions per second per player in the transient timeline. */
const SAMPLE_INTERVAL_SECONDS = 0.25;
/** A bounded sample gives a robust clock offset without scanning every movement. */
const CLOCK_OFFSET_SAMPLE_LIMIT = 300;

/**
 * Find the owner's recorded location nearest another player's update time.
 * @param {object[]} locations Owner updates ordered by LastUpdateTime.
 * @param {number} time Replay time in seconds to match.
 * @returns {object|undefined} Closest update, preferring the earlier one on a tie.
 */
function nearestLocation(locations, time) {
  let low = 0;
  let high = locations.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (locations[middle].LastUpdateTime < time) low = middle + 1;
    else high = middle;
  }
  return [locations[low - 1], locations[low]]
    .filter(Boolean)
    .sort((a, b) => Math.abs(a.LastUpdateTime - time) - Math.abs(b.LastUpdateTime - time))[0];
}

/**
 * Collect distances when opponents return to the owner's recorded range.
 * @param {object[]} players Reader PlayerData, including the owner.
 * @param {object} owner Replay player whose Locations define the camera's range.
 * @returns {number[]} Plausible horizontal distances in Unreal world units.
 */
function visibilityDistances(players, owner) {
  const distances = [];
  for (const player of players) {
    if (player === owner || !Array.isArray(player.Locations)) continue;
    const locations = player.Locations;
    for (let index = 1; index < locations.length; index++) {
      const current = locations[index];
      const previous = locations[index - 1];
      const time = current.LastUpdateTime;
      if (!Number.isFinite(time) || time < 90 || time - previous.LastUpdateTime < 8) continue;
      const point = current.ReplicatedMovement?.Location;
      if (!point || !Number.isFinite(point.X) || !Number.isFinite(point.Y)) continue;
      const near = nearestLocation(owner.Locations, time);
      const position = near?.ReplicatedMovement?.Location;
      if (!position || Math.abs(near.LastUpdateTime - time) > 1) continue;
      const distance = Math.hypot(point.X - position.X, point.Y - position.Y);
      if (distance >= 20000 && distance <= 60000) distances.push(distance);
    }
  }
  return distances;
}

/**
 * Estimate the recording radius from opponent reappearances, not render distance.
 * @param {object[]} players Reader players with movement history.
 * @param {object|null} owner Unambiguous replay owner, if one can be identified.
 * @returns {number} Rounded 95th-percentile distance, or the established fallback.
 */
function estimateVisibilityRadius(players, owner) {
  if (!owner?.Locations?.length) return DEFAULT_VISIBILITY_RADIUS;
  const distances = visibilityDistances(players, owner);
  if (distances.length < 5) return DEFAULT_VISIBILITY_RADIUS;
  distances.sort((a, b) => a - b);
  return Math.ceil(distances[Math.floor((distances.length - 1) * 0.95)] / 1000) * 1000;
}

/**
 * Translate world-clock storm timestamps to the replay's elapsed-time clock.
 * @param {object[]} players Reader players containing both clock representations.
 * @returns {number} Median world time minus replay time, in seconds.
 */
function estimateWorldOffset(players) {
  const offsets = [];
  for (const player of players) {
    for (const movement of player.Locations || []) {
      const world =
        movement.ReplicatedWorldTimeSecondsDouble || movement.ReplicatedWorldTimeSeconds;
      const update = movement.LastUpdateTime;
      if (Number.isFinite(world) && world > 0 && Number.isFinite(update) && update >= 0)
        offsets.push(world - update);
      if (offsets.length >= CLOCK_OFFSET_SAMPLE_LIMIT) break;
    }
    if (offsets.length >= CLOCK_OFFSET_SAMPLE_LIMIT) break;
  }
  offsets.sort((a, b) => a - b);
  return offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0;
}

/**
 * Choose recorded facing direction, falling back to horizontal movement velocity.
 * @param {object} movement One reader location update with ReplicatedMovement.
 * @returns {number} Heading in degrees; zero when neither representation exists.
 */
function movementYaw(movement) {
  const rotation = movement.ReplicatedMovement.Rotation?.Yaw;
  const velocity = movement.ReplicatedMovement.LinearVelocity;
  if (Number.isFinite(rotation)) return rotation;
  return velocity && Number.isFinite(velocity.X) && Number.isFinite(velocity.Y)
    ? (Math.atan2(velocity.Y, velocity.X) * 180) / Math.PI
    : 0;
}

/**
 * Downsample a player's valid, ordered locations without retaining the reader JSON.
 * @param {object} player Reader player containing Locations.
 * @param {number} worldOffset World-clock offset in seconds.
 * @returns {{samples: number[][], usesReplayTime: boolean}} Compact [time,x,y,z,yaw] rows and their clock source.
 */
function playerSamples(player, worldOffset) {
  const samples = [];
  let previous = -Infinity;
  let usesReplayTime = false;
  for (const movement of player.Locations || []) {
    const location = movement.ReplicatedMovement?.Location;
    const update = movement.LastUpdateTime;
    const world = movement.ReplicatedWorldTimeSecondsDouble || movement.ReplicatedWorldTimeSeconds;
    const time = Number.isFinite(update) && update >= 0 ? update : world - worldOffset;
    if (
      !location ||
      !Number.isFinite(time) ||
      !Number.isFinite(location.X) ||
      !Number.isFinite(location.Y)
    )
      continue;
    if (Number.isFinite(update) && update >= 0) usesReplayTime = true;
    if (time < previous || time - previous < SAMPLE_INTERVAL_SECONDS) continue;
    previous = time;
    const yaw = movementYaw(movement);
    samples.push([
      Math.round(time * 100) / 100,
      Math.round(location.X),
      Math.round(location.Y),
      Math.round(location.Z || 0),
      Math.round(((yaw % 360) + 360) % 360),
    ]);
  }
  return { samples, usesReplayTime };
}

/**
 * Build player tracks and normalize legacy timelines that lack elapsed timestamps.
 * @param {object[]} players Reader PlayerData in its original order.
 * @param {number} worldOffset World-to-replay clock offset in seconds.
 * @returns {{tracks: object[], maximum: number}} Tracks and their latest elapsed time.
 */
function movementTracks(players, worldOffset) {
  const tracks = [];
  let minimum = Infinity;
  let maximum = -Infinity;
  let usesReplayTime = false;
  for (const player of players) {
    const result = playerSamples(player, worldOffset);
    usesReplayTime ||= result.usesReplayTime;
    const samples = result.samples;
    if (!samples.length) continue;
    minimum = Math.min(minimum, samples[0][0]);
    maximum = Math.max(maximum, samples[samples.length - 1][0]);
    const rawTeam = Number(player.TeamIndex);
    tracks.push({
      id: String(
        player.PlayerId || player.EpicId || player.Id || player.PlayerName || tracks.length,
      ),
      name: String(player.PlayerName || player.PlayerNameCustomOverride || 'Unknown player'),
      team: Number.isFinite(rawTeam) && rawTeam >= 2 ? rawTeam - 2 : -1,
      bot: !!player.IsBot,
      samples,
    });
  }
  // Legacy files have only world time; their first recorded position becomes zero.
  if (!usesReplayTime && Number.isFinite(minimum)) {
    for (const track of tracks)
      for (const sample of track.samples) sample[0] = Math.round((sample[0] - minimum) * 10) / 10;
    maximum -= minimum;
  }
  return { tracks, maximum };
}

/**
 * Convert safe-zone stages to the same timebase as player movement.
 * @param {object} replay Fully analyzed reader output.
 * @param {number} worldOffset World-to-replay clock offset in seconds.
 * @returns {object[]} Finite, positive-radius stages used by the map animation.
 */
function stormZones(replay, worldOffset) {
  return (replay.MapData?.SafeZones || [])
    .map((zone) => ({
      start: Number(zone.StartShrinkTime) - worldOffset,
      finish: Number(zone.FinishShrinkTime) - worldOffset,
      radius: Number(zone.Radius),
      nextRadius: Number(zone.NextRadius),
      nextX: Number(zone.NextCenter?.X),
      nextY: Number(zone.NextCenter?.Y),
    }))
    .filter(
      (zone) =>
        Object.values(zone).every(Number.isFinite) && zone.radius > 0 && zone.nextRadius > 0,
    );
}

/**
 * Resolve the visibility owner without changing the replay's stored ownership.
 * @param {object[]} players Reader players, including any explicit replay owner.
 * @param {string[]} ownerIds User-configured accounts, consulted only if no replay owner exists.
 * @returns {object|null} Exactly one matching player; null for ambiguous ownership.
 */
function visibilityOwner(players, ownerIds) {
  const replayOwners = players.filter((player) => player.IsReplayOwner === true && player.PlayerId);
  const configuredIds = new Set(ownerIds.map((id) => String(id).toLowerCase()));
  const configuredOwners = players.filter(
    (player) => player.PlayerId && configuredIds.has(String(player.PlayerId).toLowerCase()),
  );
  return replayOwners.length === 1
    ? replayOwners[0]
    : replayOwners.length === 0 && configuredOwners.length === 1
      ? configuredOwners[0]
      : null;
}

/**
 * Reduce a fully analyzed replay to the transient data needed by the movement map.
 * @param {object} replay Parser JSON; the original object is never modified.
 * @param {string} gameID Validated database match identifier attached to the response.
 * @param {string[]} [ownerIds=[]] Configured accounts used only as a visibility fallback.
 * @returns {object} Clock offset, duration, player tracks, storm stages and visibility estimate.
 */
function extractMapTimeline(replay, gameID, ownerIds = []) {
  const players = replay.PlayerData || [];
  const worldOffset = estimateWorldOffset(players);
  const { tracks, maximum } = movementTracks(players, worldOffset);
  const owner = visibilityOwner(players, ownerIds);
  const recordedLength = Number(replay.Info?.LengthInMs) / 1000;
  return {
    gameID,
    mapInfo: replay.GameData?.MapInfo || '',
    duration: Math.ceil(Math.max(0, maximum, Number.isFinite(recordedLength) ? recordedLength : 0)),
    worldOffset,
    stormZones: stormZones(replay, worldOffset),
    ownerId: owner?.PlayerId || null,
    visibilityRadius: owner ? estimateVisibilityRadius(players, owner) : null,
    tracks,
  };
}

module.exports = { extractMapTimeline };
