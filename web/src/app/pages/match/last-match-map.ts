import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  OnDestroy,
} from '@angular/core';
import { AccessService } from '../../services/access.service';
import { count, decimal } from '../../shared/format';

import type { Anchor, Marker, SavedMap, Timeline } from '../../models/map-types';
import {
  METRES_PER_WORLD_UNIT,
  rotate,
  sampleAt,
  ownerSampleAt,
  transform,
  circlePoints,
  outsideCirclePath,
} from './map-geometry';

/** Lazy movement viewer combining replay time, saved image calibration, storm/range overlays and player following. */
@Component({
  selector: 'app-last-match-map',
  templateUrl: './last-match-map.html',
})
export class LastMatchMap implements OnDestroy {
  readonly access = inject(AccessService);
  /** Requested replay identity; late responses from another match are discarded. */
  readonly gameID = input.required<string>();
  readonly replayName = input.required<string>();
  readonly activePlayerId = input<string | null>(null);
  /** Selection output shared with the teams/feed controller without implying a page scroll. */
  readonly activePlayerChange = output<string | null>();
  /** Explicit double-click jump request; the parent owns revealing the teams-table card. */
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
  readonly selectedMap = computed(
    () => this.maps().find((map) => map.id === this.selectedMapId()) || null,
  );
  readonly selectedMapIndex = computed(() =>
    this.maps().findIndex((map) => map.id === this.selectedMapId()),
  );
  readonly mapPickerOpen = signal(false);
  readonly newMapName = signal('');
  /** Working calibration points; only a complete, non-collinear set of three is persisted. */
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
  readonly mapViewportWidth = computed(() =>
    Math.min(this.mapAvailableWidth(), this.mapStageWidth()),
  );
  /** Zoom-independent image height derived from its original aspect ratio to avoid page-scroll jumps. */
  readonly mapViewportHeight = computed(() => this.mapBaseWidth() / this.mapImageRatio());
  readonly draggingMap = signal(false);
  readonly message = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private panStart: { x: number; y: number; left: number; top: number } | null = null;
  private lastRightDown: { at: number; x: number; y: number } | null = null;
  private followFrame = 0;
  /** Promise chain preserving calibration-write order when the user edits quickly. */
  private calibrationSave = Promise.resolve();
  readonly calibrated = computed(() => this.saved() && transform(this.anchors()) !== null);
  /** Replay sampling time in seconds after applying the user’s persisted millisecond offset. */
  readonly effectiveTime = computed(() => this.time() + this.timeOffsetMs() / 1000);
  readonly anchorMarkers = computed(() =>
    this.anchors().map((anchor) => rotate([anchor.u, anchor.v], this.rotation())),
  );
  readonly availableTracks = computed(() =>
    (this.timeline()?.tracks || []).filter((track) => sampleAt(track, this.effectiveTime())),
  );
  readonly chosenSample = computed(() => {
    const track = this.timeline()?.tracks.find((item) => item.id === this.chosenId());
    return track ? sampleAt(track, this.effectiveTime()) : null;
  });
  /** Conservative world extent used only for the uncalibrated center-based projection. */
  readonly estimatedExtent = computed(() => {
    let extent = 100000;
    for (const track of this.timeline()?.tracks || [])
      for (const sample of track.samples)
        extent = Math.max(extent, Math.abs(sample[1]), Math.abs(sample[2]));
    return extent;
  });
  /** World-to-image projection followed by the saved quarter-turn rotation; defaults to a centered estimate until calibrated. */
  readonly projection = computed(() => {
    const calibratedProjection = transform(this.anchors());
    const scale = 0.45 / this.estimatedExtent();
    /** World-to-image projection followed by the saved quarter-turn rotation; defaults to a centered estimate until calibrated. */
    const projection =
      calibratedProjection ||
      ((x: number, y: number): [number, number] => [0.5 + y * scale, 0.5 - x * scale]);
    return (x: number, y: number): [number, number] => rotate(projection(x, y), this.rotation());
  });
  /** Current visible player markers with yaw transformed through the same projection as their positions. */
  readonly markers = computed(() => {
    /** World-to-image projection followed by the saved quarter-turn rotation; defaults to a centered estimate until calibrated. */
    const projection = this.projection();
    const result: Marker[] = [];
    for (const track of this.timeline()?.tracks || []) {
      const sample = sampleAt(track, this.effectiveTime());
      if (!sample) continue;
      const [u, v] = projection(sample[1], sample[2]);
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const yaw = ((Number.isFinite(sample[4]) ? sample[4] : 0) * Math.PI) / 180;
        const [directionU, directionV] = projection(
          sample[1] + Math.cos(yaw) * 1000,
          sample[2] + Math.sin(yaw) * 1000,
        );
        const angle = (Math.atan2(directionV - v, directionU - u) * 180) / Math.PI + 90;
        result.push({
          id: track.id,
          name: track.name,
          team: track.team,
          bot: track.bot,
          u,
          v,
          angle,
          elevation: `${decimal(sample[3] * METRES_PER_WORLD_UNIT, 1)}m`,
        });
      }
    }
    return result;
  });
  /** Interpolate the active shrinking storm circle and show the next circle at its target center/radius. */
  readonly stormRings = computed(() => {
    const zones = this.timeline()?.stormZones || [];
    const time = this.effectiveTime();
    const zone = zones.find((item) => time <= item.finish) || zones[zones.length - 1];
    if (!zone) return [];
    const index = zones.indexOf(zone);
    const previous = zones[index - 1];
    const before = time < zone.start;
    const progress = before
      ? 0
      : Math.max(0, Math.min(1, (time - zone.start) / Math.max(1, zone.finish - zone.start)));
    const startX = previous?.nextX ?? zone.nextX;
    const startY = previous?.nextY ?? zone.nextY;
    const startRadius = zone.radius;
    const centerX = startX + (zone.nextX - startX) * progress;
    const centerY = startY + (zone.nextY - startY) * progress;
    const radius = startRadius + (zone.nextRadius - startRadius) * progress;
    /**
     * Build a current/next storm outline using the active map projection.
     * @param x World-space center X.
     * @param y World-space center Y.
     * @param r Radius in replay world units.
     * @param kind Outline role used by the template styling.
     * @returns The ring role and projected SVG polygon.
     */
    const ring = (x: number, y: number, r: number, kind: string) => ({
      kind,
      points: circlePoints(this.projection(), [x, y], r),
    });
    return [
      ring(centerX, centerY, radius, 'current'),
      ring(zone.nextX, zone.nextY, zone.nextRadius, 'next'),
    ];
  });
  /** Even-odd SVG mask for purple shading outside the current storm circle. */
  readonly stormShade = computed(() => {
    const current = this.stormRings().find((ring) => ring.kind === 'current');
    return outsideCirclePath(current?.points || '');
  });
  /** Projected owner range boundary; no owner/usable position means no visibility shading. */
  readonly visibilityPoints = computed(() => {
    const data = this.timeline();
    if (!data?.ownerId || !Number.isFinite(data.visibilityRadius) || !data.visibilityRadius)
      return '';
    const owner = data.tracks.find(
      (track) => track.id.toLowerCase() === data.ownerId!.toLowerCase(),
    );
    const sample = owner && ownerSampleAt(owner, this.effectiveTime());
    if (!sample) return '';
    return circlePoints(this.projection(), [sample[1], sample[2]], data.visibilityRadius!);
  });
  /** Outside-only owner shading; the template controls its opacity independently of storm shading. */
  readonly visibilityShade = computed(() => outsideCirclePath(this.visibilityPoints()));
  /** Five seconds of past/future positions at one-second spacing, skipping stale or off-image samples. */
  readonly trailDots = computed(() => {
    /** World-to-image projection followed by the saved quarter-turn rotation; defaults to a centered estimate until calibrated. */
    const projection = this.projection();
    const current = this.effectiveTime();
    const dots: {
      key: string;
      u: number;
      v: number;
      color: string;
      opacity: number;
      future: boolean;
    }[] = [];
    for (const track of this.timeline()?.tracks || []) {
      const now = sampleAt(track, current);
      if (!now || current - now[0] > 2) continue;
      for (let offset = -5; offset <= 5; offset++) {
        if (offset === 0) continue;
        const sample = sampleAt(track, current + offset);
        if (!sample || current + offset - sample[0] > 1.5) continue;
        const [u, v] = projection(sample[1], sample[2]);
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        dots.push({
          key: `${track.id}:${offset}`,
          u,
          v,
          color: this.teamColor(track.team),
          opacity: offset < 0 ? 0.75 : 0.9,
          future: offset > 0,
        });
      }
    }
    return dots;
  });

  /**
   * Load movement lazily, observe available map width and follow a selected player without scrolling the document.
   */
  constructor() {
    effect(() => {
      const id = this.gameID();
      if (this.open()) void this.load(id);
    });
    effect((onCleanup) => {
      const content = this.mapContent()?.nativeElement;
      if (!content) return;
      const resize = new ResizeObserver(() => this.mapAvailableWidth.set(content.clientWidth));
      resize.observe(content);
      this.mapAvailableWidth.set(content.clientWidth);
      onCleanup(() => resize.disconnect());
    });
    effect(() => {
      const id = this.activePlayerId();
      const marker =
        id && this.markers().find((item) => item.id.toLowerCase() === id.toLowerCase());
      const viewport = this.mapViewport();
      const stage = this.mapStage();
      if (!marker || !viewport || !stage) return;
      cancelAnimationFrame(this.followFrame);
      this.followFrame = requestAnimationFrame(() => this.centerOnPlayer(marker));
    });
  }

  /**
   * Load the map when its own section opens and pause playback when it closes.
   * @param event Details toggle event, excluding nested collapsibles.
   * @returns Nothing.
   */
  onToggle(event: Event): void {
    if (event.target !== event.currentTarget) return;
    const open = (event.target as HTMLDetailsElement).open;
    this.open.set(open);
    if (!open && this.playing()) this.togglePlay();
  }

  /**
   * Fetch movement for the requested match independently of page loading, ignoring superseded match requests.
   * @param id Expected match game ID.
   * @returns A promise completing after the timeline request and local loading-state cleanup.
   */
  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.timeline.set(null);
    this.movementMessage.set('');
    void this.loadArtwork(id);
    try {
      const timelineResponse = await fetch(`/api/map/matches/${encodeURIComponent(id)}`);
      const result = await timelineResponse.json();
      const timeline = timelineResponse.ok ? (result as Timeline) : null;
      if (id !== this.gameID()) return;
      this.timeline.set(timeline?.gameID === id ? timeline : null);
      if (!timeline)
        this.movementMessage.set(
          result.code === 'replay_missing'
            ? `Map movement data cannot be loaded because ${this.replayName()} is not in the Fortnite Demos folder. If you still have that replay, name it ${this.replayName()} and place it in %LOCALAPPDATA%\\FortniteGame\\Saved\\Demos, then try again.`
            : result.error || 'Could not load replay movement.',
        );
      this.time.set(0);
    } catch {
      this.movementMessage.set('Could not load replay movement. Try again.');
    } finally {
      if (id === this.gameID()) this.loading.set(false);
    }
  }

  /**
   * Load saved maps and the selected map’s complete calibration separately from replay parsing.
   * @param id Match ID used to reject an outdated artwork request.
   * @returns A promise completing after artwork/calibration initialization.
   */
  private async loadArtwork(id: string): Promise<void> {
    try {
      const mapResponse = await fetch('/api/maps');
      if (id !== this.gameID()) return;
      if (!mapResponse.ok) throw new Error('Could not load saved maps.');
      const catalog = (await mapResponse.json()) as {
        maps: SavedMap[];
        selectedMapId: string | null;
      };
      this.maps.set(catalog.maps);
      this.selectedMapId.set(catalog.selectedMapId);
      this.hasImage.set(!!catalog.selectedMapId);
      this.imageUrl.set(`/api/map/image?v=${catalog.selectedMapId || 'none'}`);
      const calibrationResponse = await fetch('/api/map/calibration');
      if (calibrationResponse.ok) {
        const calibration = await calibrationResponse.json();
        /** Working calibration points; only a complete, non-collinear set of three is persisted. */
        const anchors =
          calibration?.saved && calibration?.anchors?.length === 3 ? calibration.anchors : [];
        this.anchors.set(anchors);
        this.saved.set(anchors.length === 3);
        this.rotation.set(calibration?.rotation || 0);
        this.timeOffsetMs.set(
          Number.isFinite(calibration?.timeOffsetMs) ? calibration.timeOffsetMs : 0,
        );
        this.alignmentOpen.set(anchors.length !== 3);
      }
    } catch {
      /* the movement request reports its own errors */
    }
  }

  /**
   * Retry movement loading for the currently viewed match.
   * @returns Nothing.
   */
  retry(): void {
    void this.load(this.gameID());
  }

  /**
   * Record the uploaded image aspect ratio so zoom retains the original viewport height.
   * @param event Map image load event.
   * @returns Nothing.
   */
  onMapImageLoad(event: Event): void {
    const image = event.target as HTMLImageElement;
    if (image.naturalWidth && image.naturalHeight)
      this.mapImageRatio.set(image.naturalWidth / image.naturalHeight);
  }
  readonly formatCount = count;

  /**
   * Display the map clock in whole minutes and seconds.
   * @param seconds Timeline time in seconds.
   * @returns A minute:second label.
   */
  clock(seconds: number): string {
    return `${count(Math.floor(seconds / 60))}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }

  /**
   * Apply the user’s timeline slider position.
   * @param event Timeline range-input event.
   * @returns Nothing.
   */
  setTime(event: Event): void {
    this.time.set(Number((event.target as HTMLInputElement).value));
  }

  /**
   * Adjust map/storm time relative to the match clock and persist it with complete calibration.
   * @param event Millisecond offset input event.
   * @returns Nothing.
   */
  setTimeOffset(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    this.timeOffsetMs.set(value);
    if (this.anchors().length === 3) void this.persistCalibration();
  }

  /**
   * Apply the zoom slider and recenter on the followed player when one is selected.
   * @param event Zoom range-input event.
   * @returns Nothing.
   */
  setZoom(event: Event): void {
    this.zoomAt(Number((event.target as HTMLInputElement).value));
    const active = this.activePlayerId();
    const marker =
      active && this.markers().find((item) => item.id.toLowerCase() === active.toLowerCase());
    if (marker) requestAnimationFrame(() => this.centerOnPlayer(marker));
  }

  /**
   * Zoom around a viewport point while preserving document scroll and the map’s vertical footprint.
   * @param value Requested zoom multiplier.
   * @param clientX Optional pointer X in viewport coordinates; defaults to the map center.
   * @param clientY Optional pointer Y in viewport coordinates; defaults to the map center.
   * @returns Nothing; applies scroll offsets after layout updates.
   */
  private zoomAt(value: number, clientX?: number, clientY?: number): void {
    const viewport = this.mapViewport()?.nativeElement;
    const stage = this.mapStage()?.nativeElement;
    const next = Math.max(1, Math.min(10, Math.round(value * 10) / 10));
    if (!viewport || !stage || !stage.clientWidth || !stage.clientHeight || next === this.zoom())
      return;
    const pageX = window.scrollX,
      pageY = window.scrollY;
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

  /**
   * Zoom one step at the pointer, or out with Shift, unless a player marker owns the click.
   * @param event Map double-click event.
   * @returns Nothing.
   */
  onMapDoubleClick(event: MouseEvent): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.map-marker')) return;
    event.preventDefault();
    this.zoomAt(this.zoom() + (event.shiftKey ? -1 : 1), event.clientX, event.clientY);
  }

  /**
   * Compare a marker ID with the selected follow target case-insensitively.
   * @param id Marker player ID.
   * @returns Whether this marker is the active player.
   */
  isActivePlayer(id: string): boolean {
    return this.activePlayerId()?.toLowerCase() === id.toLowerCase();
  }

  /**
   * Select or deselect a map player and synchronize selection with the parent match view.
   * @param id Clicked player ID.
   * @param event Marker click event.
   * @returns Nothing; emits selection without scrolling the page.
   */
  selectMarker(id: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail > 1) return;
    this.activePlayerChange.emit(this.isActivePlayer(id) ? null : id);
  }

  /**
   * Request the parent match view to reveal this marker’s player in the teams table.
   * @param id Player ID to reveal.
   * @param event Marker double-click event.
   * @returns Nothing; emits the explicit jump request.
   */
  jumpToTeam(id: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.activePlayerChange.emit(id);
    this.playerJumpToTeam.emit(id);
  }

  /**
   * Center the map viewport on a projected player only when zoomed in.
   * @param marker Projected marker with normalized u/v coordinates.
   * @returns Nothing; changes only map-container scroll offsets.
   */
  private centerOnPlayer(marker: Marker): void {
    const viewport = this.mapViewport()?.nativeElement;
    const stage = this.mapStage()?.nativeElement;
    if (!viewport || !stage || this.zoom() <= 1 || !this.isActivePlayer(marker.id)) return;
    viewport.scrollLeft = marker.u * stage.clientWidth - viewport.clientWidth / 2;
    viewport.scrollTop = marker.v * stage.clientHeight - viewport.clientHeight / 2;
  }

  /**
   * Apply the playback-rate slider value.
   * @param event Playback range-input event.
   * @returns Nothing.
   */
  setPlaySpeed(event: Event): void {
    this.playSpeed.set(Number((event.target as HTMLInputElement).value));
  }

  /**
   * Handle speed-scaled arrow scrubbing and Space play/pause while the map has focus.
   * @param event Keyboard event on the map viewport.
   * @returns Nothing; suppresses native page scrolling for handled keys.
   */
  onMapKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const delta =
        (event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1) * this.playSpeed();
      this.time.update((value) =>
        Math.max(0, Math.min(this.timeline()?.duration || 0, value + delta)),
      );
    } else if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) this.togglePlay();
    }
  }

  /**
   * Capture map dragging or detect double-right-click zoom-out without moving the document.
   * @param event Pointer-down event on the map.
   * @returns Nothing; stores drag origin and captures the pointer when appropriate.
   */
  startPan(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    if (event.pointerType === 'mouse' && (event.target as HTMLElement).closest('.map-marker')) {
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'mouse' && event.button === 2) {
      const previous = this.lastRightDown;
      if (
        previous &&
        performance.now() - previous.at < 450 &&
        Math.hypot(previous.x - event.clientX, previous.y - event.clientY) < 12
      ) {
        this.zoomAt(this.zoom() - 1, event.clientX, event.clientY);
        this.lastRightDown = null;
      } else this.lastRightDown = { at: performance.now(), x: event.clientX, y: event.clientY };
      event.preventDefault();
      return;
    }
    if (
      event.pointerType !== 'mouse' ||
      event.button !== 0 ||
      this.zoom() <= 1 ||
      this.pendingAnchor() ||
      (event.target as HTMLElement).closest('.map-marker')
    )
      return;
    const viewport = event.currentTarget as HTMLElement;
    this.panStart = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    this.draggingMap.set(true);
    event.preventDefault();
  }

  /**
   * Translate captured pointer movement into map-container scroll offsets.
   * @param event Pointer-move event.
   * @returns Nothing.
   */
  movePan(event: PointerEvent): void {
    if (!this.panStart) return;
    const viewport = event.currentTarget as HTMLElement;
    viewport.scrollLeft = this.panStart.left - (event.clientX - this.panStart.x);
    viewport.scrollTop = this.panStart.top - (event.clientY - this.panStart.y);
  }

  /**
   * Release pointer capture and finish map dragging.
   * @param event Pointer-up/cancel event.
   * @returns Nothing.
   */
  endPan(event: PointerEvent): void {
    this.panStart = null;
    this.draggingMap.set(false);
    const viewport = event.currentTarget as HTMLElement;
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
  }

  /**
   * Choose the player whose current world position supplies the next calibration anchor.
   * @param event Calibration player-select event.
   * @returns Nothing.
   */
  choosePlayer(event: Event): void {
    this.chosenId.set((event.target as HTMLSelectElement).value);
    this.pendingAnchor.set(false);
  }

  /**
   * Generate the map’s bright, deterministic team hue.
   * @param team Displayed team number, already corrected from the raw replay value.
   * @returns An HSL color string.
   */
  teamColor(team: number): string {
    return `hsl(${(((team * 137.508) % 360) + 360) % 360} 80% 50%)`;
  }

  /**
   * Start or stop real-time timeline advancement, scaled by the selected playback speed.
   * @returns Nothing; owns the playback interval.
   */
  togglePlay(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.playing.set(false);
      return;
    }
    if (this.time() >= (this.timeline()?.duration || 0)) this.time.set(0);
    this.playing.set(true);
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min((now - this.lastTick) / 1000, 1);
      this.lastTick = now;
      this.time.update((value) =>
        Math.min(this.timeline()?.duration || 0, value + elapsed * this.playSpeed()),
      );
      if (this.time() >= (this.timeline()?.duration || 0)) this.togglePlay();
    }, 100);
  }

  /**
   * Pair a clicked image location with the chosen player’s current world position.
   * @param event Map click while collecting a calibration point.
   * @returns Nothing; persists calibration once three valid points exist.
   */
  placeAnchor(event: MouseEvent): void {
    if (!this.pendingAnchor() || this.access.readOnly()) return;
    const sample = this.chosenSample();
    if (!sample) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const [u, v] = rotate(
      [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height],
      (360 - this.rotation()) % 360,
    );
    this.anchors.update((values) => [...values, { x: sample[1], y: sample[2], u, v }]);
    this.pendingAnchor.set(false);
    if (this.anchors().length === 3) void this.persistCalibration();
    else
      this.message.set(
        `${this.anchors().length}/3 points marked locally. Visit another corner of the map.`,
      );
  }

  /**
   * Remove the last calibration point and invalidate previously saved alignment.
   * @returns Nothing.
   */
  undoAnchor(): void {
    const wasSaved = this.saved();
    this.anchors.update((values) => values.slice(0, -1));
    this.pendingAnchor.set(false);
    this.message.set('');
    if (wasSaved) void this.clearSavedCalibration();
  }

  /**
   * Rotate the map projection by one quarter turn and persist rotation independently of calibration.
   * @returns Nothing.
   */
  turnClockwise(): void {
    this.rotation.update((value) => (value + 90) % 360);
    void this.persistRotation();
  }

  /**
   * Save the selected map’s quarter-turn rotation without requiring three calibration points.
   * @returns A promise completing after persistence or a visible error.
   */
  private async persistRotation(): Promise<void> {
    this.calibrationSave = this.calibrationSave
      .catch(() => {})
      .then(async () => {
        try {
          const response = await fetch('/api/map/rotation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rotation: this.rotation() }),
          });
          if (!response.ok)
            throw new Error((await response.json()).error || 'Could not save map rotation.');
        } catch (error) {
          this.message.set(error instanceof Error ? error.message : 'Could not save map rotation.');
        }
      });
    await this.calibrationSave;
  }

  /**
   * Serialize calibration writes so later three-point alignment/time-offset edits cannot be overwritten by older requests.
   * @returns A promise completing after the queued save attempt.
   */
  private persistCalibration(): Promise<void> {
    if (this.anchors().length !== 3) return Promise.resolve();
    if (!transform(this.anchors())) {
      this.message.set(
        'Choose three positions spread across distinct map corners, then undo and replace the last point.',
      );
      return Promise.resolve();
    }
    const payload = JSON.stringify({
      anchors: this.anchors(),
      rotation: this.rotation(),
      timeOffsetMs: this.timeOffsetMs(),
    });
    this.calibrationSave = this.calibrationSave
      .catch(() => {})
      .then(async () => {
        try {
          const response = await fetch('/api/map/calibration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          });
          if (!response.ok)
            throw new Error((await response.json()).error || 'Could not save alignment.');
          if (
            payload ===
            JSON.stringify({
              anchors: this.anchors(),
              rotation: this.rotation(),
              timeOffsetMs: this.timeOffsetMs(),
            })
          ) {
            this.saved.set(true);
            this.maps.update((items) =>
              items.map((item) =>
                item.id === this.selectedMapId() ? { ...item, calibrated: true } : item,
              ),
            );
            if (this.calibrated()) this.alignmentOpen.set(false);
          }
        } catch (error) {
          this.message.set(error instanceof Error ? error.message : 'Could not save alignment.');
        }
      });
    return this.calibrationSave;
  }

  /**
   * Clear local alignment state and delete the selected map’s saved calibration.
   * @returns Nothing; initiates persistence.
   */
  resetCalibration(): void {
    this.anchors.set([]);
    this.saved.set(false);
    this.pendingAnchor.set(false);
    this.alignmentOpen.set(true);
    this.timeOffsetMs.set(0);
    void this.clearSavedCalibration();
  }

  /**
   * Delete only the selected map’s saved anchors/time offset while retaining its image and rotation.
   * @returns A promise completing after deletion.
   */
  private async clearSavedCalibration(): Promise<void> {
    try {
      await this.calibrationSave;
      const response = await fetch('/api/map/calibration', { method: 'DELETE' });
      if (!response.ok)
        throw new Error((await response.json()).error || 'Could not clear calibration.');
      this.saved.set(false);
      this.maps.update((items) =>
        items.map((item) =>
          item.id === this.selectedMapId() ? { ...item, calibrated: false } : item,
        ),
      );
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not clear calibration.');
    }
  }

  /**
   * Persist one selected saved map and reload its artwork/calibration.
   * @param id Saved map ID.
   * @returns A promise completing after selection and artwork refresh.
   */
  async selectMap(id: string): Promise<void> {
    if (id === this.selectedMapId()) {
      this.mapPickerOpen.set(false);
      return;
    }
    try {
      await this.calibrationSave;
      const response = await fetch(`/api/maps/${encodeURIComponent(id)}/select`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not select map.');
      await this.loadArtwork(this.gameID());
      this.mapImageRatio.set(1);
      this.pendingAnchor.set(false);
      this.mapPickerOpen.set(false);
      this.message.set('');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not select map.');
    }
  }

  /**
   * Select the adjacent saved map without wrapping around the list.
   * @param direction Step direction: minus one or plus one.
   * @returns Nothing.
   */
  stepMap(direction: -1 | 1): void {
    const map = this.maps()[this.selectedMapIndex() + direction];
    if (map) void this.selectMap(map.id);
  }

  /**
   * Autosave a nonempty map name and update the catalog after success.
   * @param id Saved map ID.
   * @param name Proposed display name.
   * @returns A promise completing after the rename attempt.
   */
  async renameMap(id: string, name: string): Promise<void> {
    try {
      const response = await fetch(`/api/maps/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not rename map.');
      const updated = (await response.json()) as { name: string };
      this.maps.update((items) =>
        items.map((item) => (item.id === id ? { ...item, name: updated.name } : item)),
      );
      this.message.set('');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not rename map.');
      await this.loadArtwork(this.gameID());
    }
  }

  /**
   * Delete a saved map and reload the surviving selection.
   * @param id Saved map ID.
   * @returns A promise completing after deletion and artwork refresh.
   */
  async deleteMap(id: string): Promise<void> {
    if (!window.confirm('Delete this saved map and its calibration?')) return;
    try {
      await this.calibrationSave;
      const response = await fetch(`/api/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not delete map.');
      await this.loadArtwork(this.gameID());
      this.mapImageRatio.set(1);
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not delete map.');
    }
  }

  /**
   * Convert the chosen map image to PNG, upload it with a name and load its new saved-map record.
   * @param event Map file-input change event.
   * @returns A promise completing after conversion, upload and refresh.
   */
  async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await this.calibrationSave;
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Could not convert map to PNG.'))),
          'image/png',
        ),
      );
      const name = this.newMapName().trim() || file.name.replace(/\.[^.]+$/, '');
      const response = await fetch(`/api/maps?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not upload map.');
      this.newMapName.set('');
      this.mapImageRatio.set(1);
      this.mapPickerOpen.set(false);
      await this.loadArtwork(this.gameID());
      this.message.set('Map saved. Mark three distinct corners to save its calibration.');
    } catch (error) {
      this.message.set(error instanceof Error ? error.message : 'Could not upload map.');
    }
    input.value = '';
  }

  /**
   * Stop playback and any pending player-follow animation frame.
   * @returns Nothing.
   */
  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    cancelAnimationFrame(this.followFrame);
  }
}
