import { Component, inject, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { count, dateTime, placement } from '../../shared/format';
import { skinFallback, skinUrl } from '../../shared/skin';
import { LoadingService } from '../../services/loading.service';
import { platformIcon } from '../../shared/platform-icon';
import { copyWithFeedback } from '../../shared/copy-feedback';

/** Player profile identity and historical appearance count. */
interface Player {
  playerID: string;
  username: string;
  platform: string | null;
  skin: string | null;
  isAI: number;
  games: number;
}
/** A shared match row with this player’s database-recorded kills and placement. */
interface Game {
  gameID: string;
  replayName: string;
  timestamp: string;
  mode: string;
  placement: number;
  kills: number;
}
/** Filtered shared-game counts and owner/player encounters, separating teammate trolling. */
interface Summary {
  games: number;
  youEliminated: number;
  youKnocked: number;
  eliminatedYou: number;
  knockedYou: number;
  trolledYou: number;
  trolledKnocked: number;
}
/** Encounter subset used by profile metric buttons and replay-neighbor navigation. */
type EventFilter = 'all' | 'you' | 'them' | 'trolled';

/** Player identity, encounter metrics and filtered shared games; preserves navigation context when opening a replay. */
@Component({
  selector: 'app-player-page',
  imports: [RouterLink],
  templateUrl: './player-page.html',
})
export class PlayerPage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly loadingScreen = inject(LoadingService);
  readonly player = signal<Player | null>(null);
  readonly summary = signal<Summary | null>(null);
  readonly games = signal<Game[]>([]);
  readonly query = signal('');
  readonly placementFilter = signal('');
  readonly direction = signal<'asc' | 'desc'>('desc');
  readonly filtering = signal(false);
  readonly after = signal('');
  readonly before = signal('');
  readonly eventFilter = signal<EventFilter>('all');
  readonly loading = signal(false);
  readonly hasMore = signal(true);
  readonly error = signal('');
  readonly skinUrl = skinUrl;
  readonly skinFallback = skinFallback;
  readonly platformIcon = platformIcon;
  readonly formatDate = dateTime;
  readonly formatCount = count;
  readonly formatPlacement = placement;

  /**
   * Create the Fortnite Tracker link for an account without embedding unescaped identifiers.
   * @param id Epic account ID.
   * @returns The account’s external profile URL.
   */
  trackerUrl(id: string): string {
    return `https://fortnitetracker.com/profile/all/${encodeURIComponent(id)}`;
  }
  private page = 0;
  private id = '';
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;

  /**
   * Reset profile filters and load each player selected through the route.
   */
  constructor() {
    this.route.paramMap.subscribe((params) => {
      this.id = params.get('id') || '';
      this.request++;
      this.player.set(null);
      this.query.set('');
      this.placementFilter.set('');
      this.after.set('');
      this.before.set('');
      this.eventFilter.set('all');
      this.error.set('');
      this.loadingScreen.busy.set(true);
      void this.loadPlayer();
    });
  }

  /**
   * Clear pending search work and release this page’s loading screen.
   * @returns Nothing.
   */
  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.loadingScreen.busy.set(false);
  }

  /**
   * Filter shared games by an encounter metric without recalculating unchanged summary totals.
   * @param value Encounter category, or all to reset.
   * @returns Nothing; reloads the filtered game list.
   */
  selectEvent(value: EventFilter): void {
    if (this.eventFilter() === value) return;
    this.eventFilter.set(value);
    this.filtering.set(true);
    void this.refresh(false);
  }

  /** Reverse shared-game date order while preserving all active profile filters. */
  reverse(): void {
    this.direction.update((value) => (value === 'desc' ? 'asc' : 'desc'));
    this.filtering.set(true);
    void this.refresh(false);
  }

  /**
   * Copy the requested name, ID or Tracker URL and show feedback beside its own control.
   * @param value Exact value to copy.
   * @param event Triggering click or context-menu event.
   * @returns Nothing; starts clipboard feedback handling.
   */
  copy(value: string, event: MouseEvent): void {
    event.stopPropagation();
    void copyWithFeedback(value, event);
  }

  /**
   * Debounce shared-game text search and refresh statistics/list together.
   * @param event Search input event.
   * @returns Nothing.
   */
  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.request++;
    this.filtering.set(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }

  /**
   * Debounce the profile’s placement filter before refreshing its summary and games.
   * @param event Placement input event.
   * @returns Nothing.
   */
  changePlacement(event: Event): void {
    this.placementFilter.set((event.target as HTMLInputElement).value);
    this.request++;
    this.filtering.set(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }

  /**
   * Apply one local-date boundary to the profile’s shared games and summary.
   * @param event Date input event.
   * @param field Boundary to update.
   * @returns Nothing.
   */
  changeDate(event: Event, field: 'after' | 'before'): void {
    (field === 'after' ? this.after : this.before).set((event.target as HTMLInputElement).value);
    void this.refresh();
  }

  /**
   * Clear both profile date filters and reload the summary and games.
   * @returns Nothing.
   */
  clearDates(): void {
    this.after.set('');
    this.before.set('');
    void this.refresh();
  }

  /**
   * Serialize text, placement and inclusive date filters shared by profile queries.
   * @returns An encoded query string; encounter selection is added separately.
   */
  private filterParams(): string {
    const params = new URLSearchParams({ q: this.query() });
    params.set('direction', this.direction());
    if (this.placementFilter()) params.set('placement', this.placementFilter());
    if (this.after()) params.set('after', new Date(`${this.after()}T00:00:00`).toISOString());
    if (this.before()) {
      const next = new Date(`${this.before()}T00:00:00`);
      next.setDate(next.getDate() + 1);
      params.set('before', next.toISOString());
    }
    return params.toString();
  }

  /**
   * Carry the player and current filters into replay-neighbor navigation.
   * @returns Router query parameters describing the originating profile list.
   */
  replayContext(): Record<string, string> {
    return {
      ...Object.fromEntries(new URLSearchParams(this.filterParams())),
      from: 'player',
      player: this.id,
      event: this.eventFilter(),
    };
  }

  /**
   * Fetch the routed player and then their filtered summary, ignoring superseded route requests.
   * @returns A promise completing after profile initialization or error handling.
   */
  private async loadPlayer(): Promise<void> {
    const id = this.id;
    try {
      const response = await fetch(`/api/players/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Player not found.');
      if (id !== this.id) return;
      this.player.set(await response.json());
      await this.refresh();
    } catch (error) {
      if (id === this.id) {
        this.error.set(error instanceof Error ? error.message : 'Could not load player.');
        this.loadingScreen.busy.set(false);
      }
    }
  }

  /**
   * Reset profile pagination and optionally reload encounter totals, discarding stale responses.
   * @param updateSummary Whether filter changes require a new summary rather than only a new game list.
   * @returns A promise completing after the refresh attempt.
   */
  private async refresh(updateSummary = true): Promise<void> {
    const request = ++this.request;
    this.filtering.set(true);
    this.page = 0;
    this.games.set([]);
    if (updateSummary) this.summary.set(null);
    this.hasMore.set(true);
    this.loading.set(false);
    if (this.after() && this.before() && this.after() > this.before()) {
      this.error.set('The After date must be on or before the Before date.');
      this.hasMore.set(false);
      if (updateSummary) this.loadingScreen.busy.set(false);
      this.filtering.set(false);
      return;
    }
    this.error.set('');
    try {
      if (updateSummary) {
        const response = await fetch(
          `/api/players/${encodeURIComponent(this.id)}/summary?${this.filterParams()}`,
        );
        if (!response.ok)
          throw new Error((await response.json()).error || 'Could not load player statistics.');
        if (request === this.request) this.summary.set(await response.json());
      }
      if (request === this.request) await this.loadMore();
    } catch (error) {
      if (request === this.request)
        this.error.set(
          error instanceof Error ? error.message : 'Could not load player statistics.',
        );
    } finally {
      if (request === this.request && updateSummary) this.loadingScreen.busy.set(false);
      if (request === this.request) this.filtering.set(false);
    }
  }

  /**
   * Append the next filtered shared-game page without accepting responses from an older filter state.
   * @returns A promise completing after the page request.
   */
  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    const request = this.request;
    this.loading.set(true);
    try {
      const response = await fetch(
        `/api/players/${encodeURIComponent(this.id)}/games?page=${this.page + 1}&event=${this.eventFilter()}&${this.filterParams()}`,
      );
      if (!response.ok) throw new Error('Could not load player games.');
      const data = (await response.json()) as { games: Game[]; hasMore: boolean };
      if (request !== this.request) return;
      this.games.update((previous) => [...previous, ...data.games]);
      this.page++;
      this.hasMore.set(data.hasMore);
    } catch (error) {
      if (request === this.request)
        this.error.set(error instanceof Error ? error.message : 'Could not load player games.');
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }
}
