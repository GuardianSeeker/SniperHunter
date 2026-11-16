/** Compact movement tuple: replay seconds, world X, world Y, world Z and yaw in degrees. Coordinates retain parser units. */
export type Sample = [number, number, number, number, number];
/** One player’s chronological samples and identity; team is already adjusted from the raw replay team number. */
export interface Track {
  id: string;
  name: string;
  team: number;
  bot: boolean;
  samples: Sample[];
}
/** Storm shrink stage on the replay clock; radii and centers use replay world coordinates. */
export interface StormZone {
  start: number;
  finish: number;
  radius: number;
  nextRadius: number;
  nextX: number;
  nextY: number;
}
/** Transient movement response for one verified game ID; never written to the match database. */
export interface Timeline {
  gameID: string;
  mapInfo: string;
  duration: number;
  tracks: Track[];
  stormZones?: StormZone[];
  ownerId?: string | null;
  visibilityRadius?: number | null;
}
/** Calibration pair linking world X/Y to normalized image U/V in the range zero to one. */
export interface Anchor {
  x: number;
  y: number;
  u: number;
  v: number;
}
/** Map-picker catalog entry; full alignment is loaded separately for the selected image. */
export interface SavedMap {
  id: string;
  name: string;
  calibrated: boolean;
}
/** Projected player marker, including direction and formatted elevation for the hover label. */
export interface Marker {
  id: string;
  name: string;
  team: number;
  bot: boolean;
  u: number;
  v: number;
  angle: number;
  elevation: string;
}
