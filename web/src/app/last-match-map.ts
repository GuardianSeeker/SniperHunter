import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild, OnDestroy } from '@angular/core';
import { AccessService } from './access.service';
import { count, decimal } from './format';

type Sample = [number, number, number, number, number];
// A measured 25 m move changed replay X from 98,056 to 95,500.
const METRES_PER_WORLD_UNIT = 25 / (98056 - 95500);
interface Track { id: string; name: string; team: number; bot: boolean; samples: Sample[] }
interface StormZone { start: number; finish: number; radius: number; nextRadius: number; nextX: number; nextY: number }
interface Timeline { gameID: string; mapInfo: string; duration: number; tracks: Track[]; stormZones?: StormZone[];
  ownerId?: string | null; visibilityRadius?: number | null }
interface Anchor { x: number; y: number; u: number; v: number }
interface SavedMap { id: string; name: string; calibrated: boolean }
interface Marker { id: string; name: string; team: number; bot: boolean; u: number; v: number; angle: number; elevation: string }
function rotate([u, v]: [number, number], degrees: number): [number, number] {
  if (degrees === 90) return [1 - v, u];
  if (degrees === 180) return [1 - u, 1 - v];
  if (degrees === 270) return [v, 1 - u];
  return [u, v];
}

function sampleAt(track: Track, time: number): Sample | null {
  const values = track.samples;
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle][0] <= time) low = middle + 1;
    else high = middle;
  }
  const sample = values[low - 1];
  if (!sample || time - sample[0] > 20) return null;
  const next = values[low];
  if (!next || next[0] - sample[0] > 5 || time >= next[0]) return sample;
  const fraction = Math.max(0, (time - sample[0]) / (next[0] - sample[0]));
  const yawChange = ((next[4] - sample[4] + 540) % 360) - 180;
  return [time, sample[1] + (next[1] - sample[1]) * fraction,
    sample[2] + (next[2] - sample[2]) * fraction,
    sample[3] + (next[3] - sample[3]) * fraction,
    (sample[4] + yawChange * fraction + 360) % 360];
}

function ownerSampleAt(track: Track, time: number): Sample | null {
  const current = sampleAt(track, time);
  if (current && time - current[0] <= 8) return current;
  const values = track.samples;
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle][0] <= time) low = middle + 1;
    else high = middle;
  }
  const before = values[low - 1], after = values[low];
  // The reader can leave a several-second gap while the owner barely moves.
  // Keep the shade at that position only when the next sample confirms it;
  // a missing next sample still reveals the whole map.
  if (before && after && after[0] - before[0] <= 30 &&
      Math.hypot(before[1] - after[1], before[2] - after[2]) < 500)
    return before;
  return null;
}

function transform(anchors: Anchor[]): ((x: number, y: number) => [number, number]) | null {
  if (anchors.length !== 3) return null;
  const [a, b, c] = anchors;
  const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
  const determinant = bx * cy - cx * by;
  if (Math.abs(determinant) < 1000) return null;
  const ux = ((b.u - a.u) * cy - (c.u - a.u) * by) / determinant;
  const uy = (bx * (c.u - a.u) - cx * (b.u - a.u)) / determinant;
  const vx = ((b.v - a.v) * cy - (c.v - a.v) * by) / determinant;
  const vy = (bx * (c.v - a.v) - cx * (b.v - a.v)) / determinant;
  return (x, y) => [a.u + ux * (x - a.x) + uy * (y - a.y), a.v + vx * (x - a.x) + vy * (y - a.y)];
}

@Component({
  selector: 'app-last-match-map',
  template: `
    <details class="panel match-map-panel collapsible" (toggle)="onToggle($event)">
      <summary class="map-summary">Player movement map</summary>
      @if (open()) { <div #mapContent class="map-content">
      <div class="map-heading"><div class="map-intro"><p class="muted">Movement is read from the replay file and kept in memory for this session, without adding it to the database.</p>
        <div class="map-guide">
          <div><strong>Time</strong><span>Use the slider. With the map focused: ←/↓ back, →/↑ forward (steps follow Play speed); Space plays or pauses.</span></div>
          <div><strong>View</strong><span>Double-click to zoom in 1×; double-right-click to zoom out 1×. Drag to pan. Click a player to follow; double-click them to find their Teams card.</span></div>
          <div><strong>Overlays</strong><span>@if (timeline()) { {{ formatCount(markers().length) }} players shown. } Coloured dots show 5 seconds before and after. Visibility shading is estimated; storm circles show the current and next zones.</span></div>
          <div><strong>Alignment</strong><span>@if (!calibrated()) { Positions are approximate until three points are calibrated. } Time offset shifts movement and storm; positive moves them forward.</span></div>
        </div></div>
        @if (access.readOnly()) { <strong>{{ selectedMap()?.name || 'No map selected' }}</strong> }
        @else { <div class="map-picker-controls">
          <button type="button" class="secondary-button map-arrow" [disabled]="selectedMapIndex() <= 0" (click)="stepMap(-1)" aria-label="Previous map"><span class="map-button-glyph">←</span></button>
          <button type="button" class="secondary-button map-select" (click)="mapPickerOpen.set(true)">Map: {{ selectedMap()?.name || 'No map selected' }}</button>
          <button type="button" class="secondary-button map-arrow" [disabled]="selectedMapIndex() < 0 || selectedMapIndex() >= maps().length - 1" (click)="stepMap(1)" aria-label="Next map"><span class="map-button-glyph">→</span></button>
        </div> }
      </div>
      @if (mapPickerOpen()) { <div class="map-modal-backdrop" (click)="mapPickerOpen.set(false)">
        <div class="map-modal panel" role="dialog" aria-modal="true" aria-label="Select map" (click)="$event.stopPropagation()">
          <div class="map-modal-heading"><h2>Saved maps</h2><button type="button" class="secondary-button" (click)="mapPickerOpen.set(false)" aria-label="Close map selector"><span class="map-button-glyph">×</span></button></div>
          @for (map of maps(); track map.id) { <div class="saved-map-row" [class.selected]="map.id === selectedMapId()">
            <label class="map-radio" [attr.aria-label]="'Select ' + map.name"><input type="radio" name="selected-map" [checked]="map.id === selectedMapId()" (change)="selectMap(map.id)" /></label>
            <input #mapName type="text" maxlength="80" [value]="map.name" [attr.aria-label]="'Name for ' + map.name" [readonly]="access.readOnly()"
              (change)="renameMap(map.id, mapName.value)" (keydown.enter)="mapName.blur()" />
            <span class="map-calibration-state" [class.calibrated]="map.calibrated">{{ map.calibrated ? 'Calibrated' : 'Uncalibrated' }}</span>
            @if (!access.readOnly()) { <button type="button" class="danger-button" (click)="deleteMap(map.id)">Delete</button> }
          </div> } @empty { <p class="muted">No maps saved yet.</p> }
          @if (!access.readOnly()) { <div class="map-add-row"><input type="text" maxlength="80" placeholder="Map name" [value]="newMapName()" (input)="newMapName.set($any($event.target).value)" aria-label="New map name" />
            <label class="secondary-button map-upload">Add map image<input type="file" accept="image/png,image/jpeg,image/webp" (change)="upload($event)" /></label></div> }
        </div></div> }
      @if (message()) { <p class="map-message" role="status">{{ message() }}</p> }
      @if (!hasImage()) { <p class="muted">Add a top-down map image to begin. Maps are saved beside the executable.</p> }
      @if (loading()) {
        <div class="map-loading" role="status"><span class="map-loading-spinner" aria-hidden="true"></span>
          <span>Loading movement from the replay… You can continue using the match page.</span></div>
        @if (hasImage()) { <img class="map-loading-preview" [src]="imageUrl()" alt="Uploaded Fortnite map" /> }
      }
      @else if (!timeline()) {
        <p class="muted map-movement-message" role="status">{{ movementMessage() }}</p>
        <button type="button" class="toolbar-action map-retry" (click)="retry()">Try again</button>
      }
      @if (timeline(); as data) {
        @if (!data.tracks.length) { <p class="muted">The reader returned no player locations for this replay.</p> }
        @else {
          <div class="map-controls"><div class="map-time-controls">
            <label>Match time <input type="range" min="0" [max]="data.duration" step="0.1" [value]="time()" (input)="setTime($event)" /></label>
            <strong>{{ clock(time()) }} / {{ clock(data.duration) }}</strong>
            <button type="button" class="secondary-button" (click)="togglePlay()">{{ playing() ? 'Pause' : 'Play' }}</button>
            @if (activePlayerId()) { <button type="button" class="secondary-button" (click)="activePlayerChange.emit(null)">Stop following</button> }
            </div><div class="map-adjustments">
              <label>Map zoom <input type="range" min="1" max="10" step="0.1" [value]="zoom()" (input)="setZoom($event)" /><strong>{{ zoom().toFixed(1) }}×</strong></label>
              <label>Play speed <input type="range" min="0.25" max="4" step="0.25" [value]="playSpeed()" (input)="setPlaySpeed($event)" /><strong>{{ playSpeed() }}×</strong></label>
            </div>
          </div>
          @if (hasImage()) {
            <div #mapViewport class="map-viewport" tabindex="0" role="region" aria-label="Player movement map"
              [style.width.px]="mapViewportWidth()" [style.height.px]="mapViewportHeight()"
              [class.pannable]="zoom() > 1" [class.dragging]="draggingMap()" (keydown)="onMapKeydown($event)"
              (dblclick)="onMapDoubleClick($event)" (contextmenu)="$event.preventDefault()"
              (pointerdown)="startPan($event)" (pointermove)="movePan($event)" (pointerup)="endPan($event)" (pointercancel)="endPan($event)">
              <div #mapStage class="map-stage" [style.width.px]="mapStageWidth()" (click)="placeAnchor($event)" [class.calibrating]="pendingAnchor()">
              <img [src]="imageUrl()" alt="Uploaded Fortnite map" (load)="onMapImageLoad($event)" />
              <svg class="map-trails-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
                @for (dot of trailDots(); track dot.key) {
                  <circle [attr.cx]="dot.u * 1000" [attr.cy]="dot.v * 1000" [attr.r]="3.1 / zoom()"
                    [attr.fill]="dot.color" [attr.opacity]="dot.opacity" />
                  <circle [attr.cx]="dot.u * 1000" [attr.cy]="dot.v * 1000" [attr.r]=".9 / zoom()"
                    fill="none" [attr.stroke]="dot.future ? '#fff' : '#101113'" [attr.stroke-width]=".5 / zoom()" />
                }
              </svg>
              <svg class="map-storm-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
                @if (stormShade()) { <path class="outside" [attr.d]="stormShade()" fill-rule="evenodd" /> }
                @if (visibilityShade()) { <path class="visibility-outside" [attr.d]="visibilityShade()" fill-rule="evenodd" /> }
                @for (ring of stormRings(); track ring.kind) {
                  <polyline [attr.points]="ring.points" [attr.class]="ring.kind" />
                }
              </svg>
              @for (marker of markers(); track marker.id) {
                <button type="button" class="map-marker" [class.active-player]="isActivePlayer(marker.id)"
                  [style.left.%]="marker.u * 100" [style.top.%]="marker.v * 100"
                  (click)="selectMarker(marker.id, $event)" (dblclick)="jumpToTeam(marker.id, $event)"
                  [attr.aria-pressed]="isActivePlayer(marker.id)"
                  [attr.aria-label]="marker.team + ' | ' + marker.name + ' (' + marker.elevation + ')'">
                  <svg viewBox="0 0 100 100" aria-hidden="true" [style.transform]="'rotate(' + marker.angle + 'deg)'">
                    <path d="M 50 10 L 80 78 L 59 73 A 9 9 0 0 0 41 73 L 20 78 Z"
                      [attr.fill]="teamColor(marker.team)" stroke="#1A1A1A" stroke-width="2.5" stroke-linejoin="miter" stroke-linecap="square" />
                  </svg>
                  <span class="map-tooltip">{{ formatCount(marker.team) }} | {{ marker.name }} <small class="map-elevation">({{ marker.elevation }})</small></span>
                </button>
              }
              @for (anchor of alignmentOpen() && !access.readOnly() ? anchorMarkers() : []; track $index) {
                <span class="map-anchor" [style.left.%]="anchor[0] * 100" [style.top.%]="anchor[1] * 100" [title]="'Anchor ' + ($index + 1)">{{ $index + 1 }}</span>
              }
            </div></div>
            @if (!access.readOnly()) {
              <details class="map-calibration collapsible" [open]="alignmentOpen()" (toggle)="alignmentOpen.set($any($event.target).open)"><summary>Map alignment and synchronization · {{ calibrated() ? 'Calibrated' : anchors().length + '/3 points marked' }}</summary>
                <p class="muted">Calibration saves only after all three points are set. Visit three distinct corners of the map for the best alignment. Rotation is saved separately, even before calibration. X and Y are Unreal world coordinates in approximately centimeter-scale units.</p>
                <div class="map-calibration-controls"><label>Player at {{ clock(time()) }}
                  <select [value]="chosenId()" (change)="choosePlayer($event)">
                    <option value="">Choose player</option>
                    @for (track of availableTracks(); track track.id) { <option [value]="track.id">{{ track.name }} · Team {{ formatCount(track.team) }}</option> }
                  </select></label>
                  <button type="button" class="secondary-button" (click)="turnClockwise()">Rotate coordinates 90° clockwise ({{ rotation() }}°)</button>
                  <label>Map time offset (ms)
                    <input type="number" step="any" [value]="timeOffsetMs()" (change)="setTimeOffset($event)" />
                  </label>
                  @if (anchors().length) { <button type="button" class="secondary-button" (click)="resetCalibration()">Start alignment over</button> }
                  <button type="button" class="secondary-button" [disabled]="!chosenSample() || anchors().length >= 3" (click)="pendingAnchor.set(true)">Click map for point {{ anchors().length + 1 }}</button>
                  @if (pendingAnchor()) { <span role="status">Now click the selected player's location on the map.</span> }
                  @if (anchors().length) { <button type="button" class="secondary-button" (click)="undoAnchor()">Undo point</button> }
                </div>
                @if (chosenSample(); as sample) { <p class="map-coordinates">Selected world position: X {{ sample[1] }}, Y {{ sample[2] }}</p> }
              </details>
            }
          }
        }
      }
      </div> }
    </details>
  `,
})
export class LastMatchMap implements OnDestroy {
  readonly access = inject(AccessService);
  readonly gameID = input.required<string>();
  readonly replayName = input.required<string>();
  readonly activePlayerId = input<string | null>(null);
  readonly activePlayerChange = output<string | null>();
  readonly playerJumpToTeam = output<string>();
  readonly mapViewport = viewChild<ElementRef<HTMLElement>>('mapViewport');
  readonly mapStage = viewChild<ElementRef<HTMLElement>>('mapStage');
  readonly mapContent = viewChild<ElementRef<HTMLElement>>('mapContent');
  readonly timeline = signal<Timeline | null>(null);
  readonly open = signal(false);
  readonly loading = signal(true);
  readonly movementMessage = signal('');
  readonly hasImage = signal(false);
  readonly imageUrl = signal('/api/map/image');
  readonly maps = signal<SavedMap[]>([]);
  readonly selectedMapId = signal<string | null>(null);
  readonly selectedMap = computed(() => this.maps().find(map => map.id === this.selectedMapId()) || null);
  readonly selectedMapIndex = computed(() => this.maps().findIndex(map => map.id === this.selectedMapId()));
  readonly mapPickerOpen = signal(false);
  readonly newMapName = signal('');
  readonly anchors = signal<Anchor[]>([]);
  readonly saved = signal(false);
  readonly rotation = signal(0);
  readonly timeOffsetMs = signal(0);
  readonly alignmentOpen = signal(true);
  readonly time = signal(0);
  readonly chosenId = signal('');
  readonly pendingAnchor = signal(false);
  readonly playing = signal(false);
  readonly playSpeed = signal(1);
  readonly zoom = signal(1);
  readonly mapAvailableWidth = signal(950);
  readonly mapImageRatio = signal(1);
  readonly mapBaseWidth = computed(() => Math.min(950, this.mapAvailableWidth()));
  readonly mapStageWidth = computed(() => this.mapBaseWidth() * this.zoom());
  readonly mapViewportWidth = computed(() => Math.min(this.mapAvailableWidth(), this.mapStageWidth()));
  readonly mapViewportHeight = computed(() => this.mapBaseWidth() / this.mapImageRatio());
  readonly draggingMap = signal(false);
  readonly message = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private panStart: { x: number; y: number; left: number; top: number } | null = null;
  private lastRightDown: { at: number; x: number; y: number } | null = null;
  private followFrame = 0;
  private calibrationSave = Promise.resolve();
  readonly calibrated = computed(() => this.saved() && transform(this.anchors()) !== null);
  readonly effectiveTime = computed(() => this.time() + this.timeOffsetMs() / 1000);
  readonly anchorMarkers = computed(() => this.anchors().map(anchor => rotate([anchor.u, anchor.v], this.rotation())));
  readonly availableTracks = computed(() => (this.timeline()?.tracks || []).filter(track => sampleAt(track, this.effectiveTime())));
  readonly chosenSample = computed(() => {
    const track = this.timeline()?.tracks.find(item => item.id === this.chosenId());
    return track ? sampleAt(track, this.effectiveTime()) : null;
  });
  readonly estimatedExtent = computed(() => {
    let extent = 100000;
    for (const track of this.timeline()?.tracks || []) for (const sample of track.samples)
      extent = Math.max(extent, Math.abs(sample[1]), Math.abs(sample[2]));
    return extent;
  });
  readonly projection = computed(() => {
    const calibratedProjection = transform(this.anchors());
    const scale = .45 / this.estimatedExtent();
    const projection = calibratedProjection || ((x: number, y: number): [number, number] =>
      [.5 + y * scale, .5 - x * scale]);
    return (x: number, y: number): [number, number] => rotate(projection(x, y), this.rotation());
  });
  readonly markers = computed(() => {
    const projection = this.projection();
    const result: Marker[] = [];
    for (const track of this.timeline()?.tracks || []) {
      const sample = sampleAt(track, this.effectiveTime());
      if (!sample) continue;
      const [u, v] = projection(sample[1], sample[2]);
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const yaw = (Number.isFinite(sample[4]) ? sample[4] : 0) * Math.PI / 180;
        const [directionU, directionV] = projection(sample[1] + Math.cos(yaw) * 1000,
          sample[2] + Math.sin(yaw) * 1000);
        const angle = Math.atan2(directionV - v, directionU - u) * 180 / Math.PI + 90;
        result.push({ id: track.id, name: track.name, team: track.team, bot: track.bot, u, v, angle,
          elevation: `${decimal(sample[3] * METRES_PER_WORLD_UNIT, 1)}m` });
      }
    }
    return result;
  });
  readonly stormRings = computed(() => {
    const zones = this.timeline()?.stormZones || [];
    const time = this.effectiveTime();
    const zone = zones.find(item => time <= item.finish) || zones[zones.length - 1];
    if (!zone) return [];
    const index = zones.indexOf(zone);
    const previous = zones[index - 1];
    const before = time < zone.start;
    const progress = before ? 0 : Math.max(0, Math.min(1, (time - zone.start) / Math.max(1, zone.finish - zone.start)));
    const startX = previous?.nextX ?? zone.nextX;
    const startY = previous?.nextY ?? zone.nextY;
    const startRadius = zone.radius;
    const centerX = startX + (zone.nextX - startX) * progress;
    const centerY = startY + (zone.nextY - startY) * progress;
    const radius = startRadius + (zone.nextRadius - startRadius) * progress;
    const ring = (x: number, y: number, r: number, kind: string) => ({ kind,
      points: Array.from({ length: 73 }, (_, index) => {
        const angle = index * Math.PI / 36;
        const [u, v] = this.projection()(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
        return `${(u * 1000).toFixed(1)},${(v * 1000).toFixed(1)}`;
      }).join(' ') });
    return [ring(centerX, centerY, radius, 'current'), ring(zone.nextX, zone.nextY, zone.nextRadius, 'next')];
  });
  readonly stormShade = computed(() => {
    const current = this.stormRings().find(ring => ring.kind === 'current');
    return current ? `M0 0H1000V1000H0Z M${current.points.replaceAll(' ', 'L')}Z` : '';
  });
  readonly visibilityPoints = computed(() => {
    const data = this.timeline();
    if (!data?.ownerId || !Number.isFinite(data.visibilityRadius) || !data.visibilityRadius) return '';
    const owner = data.tracks.find(track => track.id.toLowerCase() === data.ownerId!.toLowerCase());
    const sample = owner && ownerSampleAt(owner, this.effectiveTime());
    if (!sample) return '';
    const projection = this.projection();
    return Array.from({ length: 73 }, (_, index) => {
      const angle = index * Math.PI / 36;
      const [u, v] = projection(sample[1] + Math.cos(angle) * data.visibilityRadius!,
        sample[2] + Math.sin(angle) * data.visibilityRadius!);
      return `${(u * 1000).toFixed(1)},${(v * 1000).toFixed(1)}`;
    }).join(' ');
  });
  readonly visibilityShade = computed(() => this.visibilityPoints()
    ? `M0 0H1000V1000H0Z M${this.visibilityPoints().replaceAll(' ', 'L')}Z` : '');
  readonly trailDots = computed(() => {
    const projection = this.projection();
    const current = this.effectiveTime();
    const dots: { key: string; u: number; v: number; color: string; opacity: number; future: boolean }[] = [];
    for (const track of this.timeline()?.tracks || []) {
      const now = sampleAt(track, current);
      if (!now || current - now[0] > 2) continue;
      for (let offset = -5; offset <= 5; offset++) {
        if (offset === 0) continue;
        const sample = sampleAt(track, current + offset);
        if (!sample || current + offset - sample[0] > 1.5) continue;
        const [u, v] = projection(sample[1], sample[2]);
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        dots.push({ key: `${track.id}:${offset}`, u, v, color: this.teamColor(track.team),
          opacity: offset < 0 ? .75 : .9, future: offset > 0 });
      }
    }
    return dots;
  });

  constructor() {
    effect(() => { const id = this.gameID(); if (this.open()) void this.load(id); });
    effect(onCleanup => {
      const content = this.mapContent()?.nativeElement;
      if (!content) return;
      const resize = new ResizeObserver(() => this.mapAvailableWidth.set(content.clientWidth));
      resize.observe(content);
      this.mapAvailableWidth.set(content.clientWidth);
      onCleanup(() => resize.disconnect());
    });
    effect(() => {
      const id = this.activePlayerId();
      const marker = id && this.markers().find(item => item.id.toLowerCase() === id.toLowerCase());
      const viewport = this.mapViewport();
      const stage = this.mapStage();
      if (!marker || !viewport || !stage) return;
      cancelAnimationFrame(this.followFrame);
      this.followFrame = requestAnimationFrame(() => this.centerOnPlayer(marker));
    });
  }
  onToggle(event: Event): void {
    if (event.target !== event.currentTarget) return;
    const open = (event.target as HTMLDetailsElement).open;
    this.open.set(open);
    if (!open && this.playing()) this.togglePlay();
  }
  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.timeline.set(null);
    this.movementMessage.set('');
    void this.loadArtwork(id);
    try {
      const timelineResponse = await fetch(`/api/map/matches/${encodeURIComponent(id)}`);
      const result = await timelineResponse.json();
      const timeline = timelineResponse.ok ? result as Timeline : null;
      if (id !== this.gameID()) return;
      this.timeline.set(timeline?.gameID === id ? timeline : null);
      if (!timeline) this.movementMessage.set(result.code === 'replay_missing'
        ? `Map movement data cannot be loaded because ${this.replayName()} is not in the Fortnite Demos folder. If you still have that replay, name it ${this.replayName()} and place it in %LOCALAPPDATA%\\FortniteGame\\Saved\\Demos, then try again.`
        : result.error || 'Could not load replay movement.');
      this.time.set(0);
    } catch { this.movementMessage.set('Could not load replay movement. Try again.'); }
    finally { if (id === this.gameID()) this.loading.set(false); }
  }
  private async loadArtwork(id: string): Promise<void> {
    try {
      const mapResponse = await fetch('/api/maps');
      if (id !== this.gameID()) return;
      if (!mapResponse.ok) throw new Error('Could not load saved maps.');
      const catalog = await mapResponse.json() as { maps: SavedMap[]; selectedMapId: string | null };
      this.maps.set(catalog.maps); this.selectedMapId.set(catalog.selectedMapId);
      this.hasImage.set(!!catalog.selectedMapId);
      this.imageUrl.set(`/api/map/image?v=${catalog.selectedMapId || 'none'}`);
      const calibrationResponse = await fetch('/api/map/calibration');
      if (calibrationResponse.ok) {
        const calibration = await calibrationResponse.json();
        const anchors = calibration?.saved && calibration?.anchors?.length === 3 ? calibration.anchors : [];
        this.anchors.set(anchors); this.saved.set(anchors.length === 3);
        this.rotation.set(calibration?.rotation || 0);
        this.timeOffsetMs.set(Number.isFinite(calibration?.timeOffsetMs) ? calibration.timeOffsetMs : 0);
        this.alignmentOpen.set(anchors.length !== 3);
      }
    } catch { /* the movement request reports its own errors */ }
  }
  retry(): void { void this.load(this.gameID()); }
  onMapImageLoad(event: Event): void {
    const image = event.target as HTMLImageElement;
    if (image.naturalWidth && image.naturalHeight) this.mapImageRatio.set(image.naturalWidth / image.naturalHeight);
  }
  readonly formatCount = count;
  clock(seconds: number): string { return `${count(Math.floor(seconds / 60))}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
  setTime(event: Event): void { this.time.set(Number((event.target as HTMLInputElement).value)); }
  setTimeOffset(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    this.timeOffsetMs.set(value);
    if (this.anchors().length === 3) void this.persistCalibration();
  }
  setZoom(event: Event): void {
    this.zoomAt(Number((event.target as HTMLInputElement).value));
    const active = this.activePlayerId();
    const marker = active && this.markers().find(item => item.id.toLowerCase() === active.toLowerCase());
    if (marker) requestAnimationFrame(() => this.centerOnPlayer(marker));
  }
  private zoomAt(value: number, clientX?: number, clientY?: number): void {
    const viewport = this.mapViewport()?.nativeElement;
    const stage = this.mapStage()?.nativeElement;
    const next = Math.max(1, Math.min(10, Math.round(value * 10) / 10));
    if (!viewport || !stage || !stage.clientWidth || !stage.clientHeight || next === this.zoom()) return;
    const pageX = window.scrollX, pageY = window.scrollY;
    const bounds = viewport.getBoundingClientRect();
    const focusX = clientX ?? bounds.left + viewport.clientWidth / 2;
    const focusY = clientY ?? bounds.top + viewport.clientHeight / 2;
    const mapX = (viewport.scrollLeft + focusX - bounds.left) / stage.clientWidth;
    const mapY = (viewport.scrollTop + focusY - bounds.top) / stage.clientHeight;
    this.zoom.set(next);
    requestAnimationFrame(() => {
      const after = viewport.getBoundingClientRect();
      viewport.scrollLeft = mapX * stage.clientWidth - (focusX - after.left);
      viewport.scrollTop = mapY * stage.clientHeight - (focusY - after.top);
      window.scrollTo({ left: pageX, top: pageY, behavior: 'instant' });
    });
  }
  onMapDoubleClick(event: MouseEvent): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.map-marker')) return;
    event.preventDefault();
    this.zoomAt(this.zoom() + (event.shiftKey ? -1 : 1), event.clientX, event.clientY);
  }
  isActivePlayer(id: string): boolean { return this.activePlayerId()?.toLowerCase() === id.toLowerCase(); }
  selectMarker(id: string, event: MouseEvent): void {
    event.preventDefault(); event.stopPropagation();
    if (event.detail > 1) return;
    this.activePlayerChange.emit(this.isActivePlayer(id) ? null : id);
  }
  jumpToTeam(id: string, event: MouseEvent): void {
    event.preventDefault(); event.stopPropagation();
    this.activePlayerChange.emit(id);
    this.playerJumpToTeam.emit(id);
  }
  private centerOnPlayer(marker: Marker): void {
    const viewport = this.mapViewport()?.nativeElement;
    const stage = this.mapStage()?.nativeElement;
    if (!viewport || !stage || this.zoom() <= 1 || !this.isActivePlayer(marker.id)) return;
    viewport.scrollLeft = marker.u * stage.clientWidth - viewport.clientWidth / 2;
    viewport.scrollTop = marker.v * stage.clientHeight - viewport.clientHeight / 2;
  }
  setPlaySpeed(event: Event): void { this.playSpeed.set(Number((event.target as HTMLInputElement).value)); }
  onMapKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const delta = (event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1) * this.playSpeed();
      this.time.update(value => Math.max(0, Math.min(this.timeline()?.duration || 0, value + delta)));
    } else if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) this.togglePlay();
    }
  }
  startPan(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    if (event.pointerType === 'mouse' && (event.target as HTMLElement).closest('.map-marker')) {
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'mouse' && event.button === 2) {
      const previous = this.lastRightDown;
      if (previous && performance.now() - previous.at < 450 &&
          Math.hypot(previous.x - event.clientX, previous.y - event.clientY) < 12) {
        this.zoomAt(this.zoom() - 1, event.clientX, event.clientY);
        this.lastRightDown = null;
      } else this.lastRightDown = { at: performance.now(), x: event.clientX, y: event.clientY };
      event.preventDefault();
      return;
    }
    if (event.pointerType !== 'mouse' || event.button !== 0 || this.zoom() <= 1 || this.pendingAnchor() ||
        (event.target as HTMLElement).closest('.map-marker')) return;
    const viewport = event.currentTarget as HTMLElement;
    this.panStart = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    this.draggingMap.set(true);
    event.preventDefault();
  }
  movePan(event: PointerEvent): void {
    if (!this.panStart) return;
    const viewport = event.currentTarget as HTMLElement;
    viewport.scrollLeft = this.panStart.left - (event.clientX - this.panStart.x);
    viewport.scrollTop = this.panStart.top - (event.clientY - this.panStart.y);
  }
  endPan(event: PointerEvent): void {
    this.panStart = null;
    this.draggingMap.set(false);
    const viewport = event.currentTarget as HTMLElement;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  }
  choosePlayer(event: Event): void { this.chosenId.set((event.target as HTMLSelectElement).value); this.pendingAnchor.set(false); }
  teamColor(team: number): string { return `hsl(${((team * 137.508) % 360 + 360) % 360} 80% 50%)`; }
  togglePlay(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; this.playing.set(false); return; }
    if (this.time() >= (this.timeline()?.duration || 0)) this.time.set(0);
    this.playing.set(true);
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min((now - this.lastTick) / 1000, 1);
      this.lastTick = now;
      this.time.update(value => Math.min(this.timeline()?.duration || 0, value + elapsed * this.playSpeed()));
      if (this.time() >= (this.timeline()?.duration || 0)) this.togglePlay();
    }, 100);
  }
  placeAnchor(event: MouseEvent): void {
    if (!this.pendingAnchor() || this.access.readOnly()) return;
    const sample = this.chosenSample();
    if (!sample) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const [u, v] = rotate([(event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height], (360 - this.rotation()) % 360);
    this.anchors.update(values => [...values, { x: sample[1], y: sample[2], u, v }]);
    this.pendingAnchor.set(false);
    if (this.anchors().length === 3) void this.persistCalibration();
    else this.message.set(`${this.anchors().length}/3 points marked locally. Visit another corner of the map.`);
  }
  undoAnchor(): void {
    const wasSaved = this.saved();
    this.anchors.update(values => values.slice(0, -1)); this.pendingAnchor.set(false); this.message.set('');
    if (wasSaved) void this.clearSavedCalibration();
  }
  turnClockwise(): void {
    this.rotation.update(value => (value + 90) % 360);
    void this.persistRotation();
  }
  private async persistRotation(): Promise<void> {
    this.calibrationSave = this.calibrationSave.catch(() => {}).then(async () => { try {
      const response = await fetch('/api/map/rotation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotation: this.rotation() }) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not save map rotation.');
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'Could not save map rotation.'); } });
    await this.calibrationSave;
  }
  private persistCalibration(): Promise<void> {
    if (this.anchors().length !== 3) return Promise.resolve();
    if (!transform(this.anchors())) {
      this.message.set('Choose three positions spread across distinct map corners, then undo and replace the last point.');
      return Promise.resolve();
    }
    const payload = JSON.stringify({ anchors: this.anchors(), rotation: this.rotation(), timeOffsetMs: this.timeOffsetMs() });
    this.calibrationSave = this.calibrationSave.catch(() => {}).then(async () => {
      try {
        const response = await fetch('/api/map/calibration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not save alignment.');
        if (payload === JSON.stringify({ anchors: this.anchors(), rotation: this.rotation(), timeOffsetMs: this.timeOffsetMs() })) {
          this.saved.set(true);
          this.maps.update(items => items.map(item => item.id === this.selectedMapId() ? { ...item, calibrated: true } : item));
          if (this.calibrated()) this.alignmentOpen.set(false);
        }
      } catch (error) { this.message.set(error instanceof Error ? error.message : 'Could not save alignment.'); }
    });
    return this.calibrationSave;
  }
  resetCalibration(): void {
    this.anchors.set([]); this.saved.set(false); this.pendingAnchor.set(false); this.alignmentOpen.set(true);
    this.timeOffsetMs.set(0);
    void this.clearSavedCalibration();
  }
  private async clearSavedCalibration(): Promise<void> {
    try {
      await this.calibrationSave;
      const response = await fetch('/api/map/calibration', { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not clear calibration.');
      this.saved.set(false);
      this.maps.update(items => items.map(item => item.id === this.selectedMapId() ? { ...item, calibrated: false } : item));
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'Could not clear calibration.'); }
  }
  async selectMap(id: string): Promise<void> {
    if (id === this.selectedMapId()) { this.mapPickerOpen.set(false); return; }
    try {
      await this.calibrationSave;
      const response = await fetch(`/api/maps/${encodeURIComponent(id)}/select`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not select map.');
      await this.loadArtwork(this.gameID());
      this.mapImageRatio.set(1); this.pendingAnchor.set(false); this.mapPickerOpen.set(false);
      this.message.set('');
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'Could not select map.'); }
  }
  stepMap(direction: -1 | 1): void {
    const map = this.maps()[this.selectedMapIndex() + direction];
    if (map) void this.selectMap(map.id);
  }
  async renameMap(id: string, name: string): Promise<void> {
    try {
      const response = await fetch(`/api/maps/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not rename map.');
      const updated = await response.json() as { name: string };
      this.maps.update(items => items.map(item => item.id === id ? { ...item, name: updated.name } : item));
      this.message.set('');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not rename map.');
      await this.loadArtwork(this.gameID());
    }
  }
  async deleteMap(id: string): Promise<void> {
    if (!window.confirm('Delete this saved map and its calibration?')) return;
    try {
      await this.calibrationSave;
      const response = await fetch(`/api/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not delete map.');
      await this.loadArtwork(this.gameID());
      this.mapImageRatio.set(1);
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'Could not delete map.'); }
  }
  async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await this.calibrationSave;
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not convert map to PNG.')), 'image/png'));
      const name = this.newMapName().trim() || file.name.replace(/\.[^.]+$/, '');
      const response = await fetch(`/api/maps?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not upload map.');
      this.newMapName.set(''); this.mapImageRatio.set(1); this.mapPickerOpen.set(false);
      await this.loadArtwork(this.gameID());
      this.message.set('Map saved. Mark three distinct corners to save its calibration.');
    } catch (error) { this.message.set(error instanceof Error ? error.message : 'Could not upload map.'); }
    input.value = '';
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); cancelAnimationFrame(this.followFrame); }
}
