import type { Anchor, Sample, Track } from '../../models/map-types';

// A measured 25 m move changed replay X from 98,056 to 95,500.
/** Empirical world-unit-to-metre scale: a measured 25 m traversal changed X from 98,056 to 95,500. This is separate from stored travel-stat units. */
export const METRES_PER_WORLD_UNIT = 25 / (98056 - 95500);

/**
 * Find the first movement sample strictly after the requested time using binary search.
 * @param values Time-sorted movement samples.
 * @param time Requested replay time in seconds.
 * @returns Insertion index after all samples at or before time.
 */
function upperSampleIndex(values: Sample[], time: number): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle][0] <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Rotate normalized image coordinates clockwise by a supported quarter turn.
 * @param options Image coordinates u/v in the unit square.
 * @param degrees Clockwise rotation in degrees: 0, 90, 180 or 270.
 * @returns Rotated normalized image coordinates.
 */
export function rotate([u, v]: [number, number], degrees: number): [number, number] {
  if (degrees === 90) return [1 - v, u];
  if (degrees === 180) return [1 - u, 1 - v];
  if (degrees === 270) return [v, 1 - u];
  return [u, v];
}

/**
 * Interpolate nearby movement samples and shortest-path yaw without bridging large recording gaps.
 * @param track Player track containing sorted samples.
 * @param time Requested replay time in seconds.
 * @returns Interpolated or recent sample, or null when no position is usable.
 */
export function sampleAt(track: Track, time: number): Sample | null {
  const values = track.samples;
  const low = upperSampleIndex(values, time);
  const sample = values[low - 1];
  if (!sample || time - sample[0] > 20) return null;
  const next = values[low];
  if (!next || next[0] - sample[0] > 5 || time >= next[0]) return sample;
  const fraction = Math.max(0, (time - sample[0]) / (next[0] - sample[0]));
  const yawChange = ((next[4] - sample[4] + 540) % 360) - 180;
  return [
    time,
    sample[1] + (next[1] - sample[1]) * fraction,
    sample[2] + (next[2] - sample[2]) * fraction,
    sample[3] + (next[3] - sample[3]) * fraction,
    (sample[4] + yawChange * fraction + 360) % 360,
  ];
}

/**
 * Keep visibility shading through confirmed stationary gaps while revealing the map once the owner is missing.
 * @param track Owner movement track.
 * @param time Requested replay time in seconds.
 * @returns A current or confirmed stationary sample, otherwise null.
 */
export function ownerSampleAt(track: Track, time: number): Sample | null {
  const current = sampleAt(track, time);
  if (current && time - current[0] <= 8) return current;
  const values = track.samples;
  const low = upperSampleIndex(values, time);
  const before = values[low - 1],
    after = values[low];
  // The reader can leave a several-second gap while the owner barely moves.
  // Keep the shade at that position only when the next sample confirms it;
  // a missing next sample still reveals the whole map.
  if (
    before &&
    after &&
    after[0] - before[0] <= 30 &&
    Math.hypot(before[1] - after[1], before[2] - after[2]) < 500
  )
    return before;
  return null;
}

/**
 * Solve an affine world-to-image projection from three non-collinear calibration anchors.
 * @param anchors Three world/image coordinate pairs.
 * @returns A projection function, or null when calibration is incomplete or degenerate.
 */
export function transform(anchors: Anchor[]): ((x: number, y: number) => [number, number]) | null {
  if (anchors.length !== 3) return null;
  const [a, b, c] = anchors;
  const bx = b.x - a.x,
    by = b.y - a.y,
    cx = c.x - a.x,
    cy = c.y - a.y;
  const determinant = bx * cy - cx * by;
  if (Math.abs(determinant) < 1000) return null;
  const ux = ((b.u - a.u) * cy - (c.u - a.u) * by) / determinant;
  const uy = (bx * (c.u - a.u) - cx * (b.u - a.u)) / determinant;
  const vx = ((b.v - a.v) * cy - (c.v - a.v) * by) / determinant;
  const vy = (bx * (c.v - a.v) - cx * (b.v - a.v)) / determinant;
  return (x, y) => [a.u + ux * (x - a.x) + uy * (y - a.y), a.v + vx * (x - a.x) + vy * (y - a.y)];
}

/**
 * Project a world-space circle into the normalized 1000-unit SVG overlay.
 * @param projection World-to-image coordinate projection.
 * @param center World-space circle center x/y.
 * @param radius Circle radius in replay world units.
 * @returns A closed polygon point string sampled every five degrees.
 */
export function circlePoints(
  projection: (x: number, y: number) => [number, number],
  center: [number, number],
  radius: number,
): string {
  return Array.from({ length: 73 }, (_, index) => {
    const angle = (index * Math.PI) / 36;
    const [u, v] = projection(
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius,
    );
    return `${(u * 1000).toFixed(1)},${(v * 1000).toFixed(1)}`;
  }).join(' ');
}

/**
 * Create an even-odd SVG path that shades the image outside a projected circle.
 * @param points Projected polygon point string, or an empty string when unavailable.
 * @returns An outside-only SVG path, or an empty path.
 */
export function outsideCirclePath(points: string): string {
  return points ? `M0 0H1000V1000H0Z M${points.replaceAll(' ', 'L')}Z` : '';
}
