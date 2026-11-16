import { Component, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { inject } from '@angular/core';
import type { RecentGame } from '../../models/match-types';
import { count, dateTime, decimal, distance, placement } from '../../shared/format';
import { AccessService } from '../../services/access.service';

/** Bounded game-list page and total count returned by the recent-games endpoint. */
interface GamesResponse {
  games: RecentGame[];
  total: number;
  page: number;
  pageSize: number;
}
/** Aggregate statistics for the active game filters; durations and distances retain database units. */
interface Metrics {
  games: number;
  averagePlacement: number | null;
  realPercent: number;
  creativeGames: number;
  creativePercent: number;
  nonCreativeGames: number;
  nonCreativePercent: number;
  distanceTravelled: number;
  timePlayed: number;
  gamesWon: number;
  totalKills: number;
  kd: number | null;
  winPercent: number;
}

/** Filtered recent-games list with aggregate metrics, pagination and local import/delete controls. */
@Component({
  selector: 'app-games-page',
  imports: [RouterLink],
  templateUrl: './games-page.html',
})
export class GamesPage {
  private readonly router = inject(Router);
  readonly access = inject(AccessService);
  readonly games = signal<RecentGame[]>([]);
  readonly total = signal(0);
  readonly metrics = signal<Metrics | null>(null);
  readonly query = signal('');
  readonly placementFilter = signal('');
  readonly direction = signal<'asc' | 'desc'>('desc');
  readonly kind = signal<'' | 'creative' | 'noncreative' | 'won'>('');
  readonly after = signal('');
  readonly before = signal('');
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly importing = signal(false);
  readonly importMessage = signal('');
  readonly error = signal('');
  readonly formatDate = dateTime;
  readonly formatPlacement = placement;
  readonly formatDistance = distance;
  readonly formatCount = count;
  readonly formatDecimal = decimal;

  /**
   * Extract whole hours from the filtered sum of match durations.
   * @param milliseconds Summed duration in milliseconds.
   * @returns Localized whole-hour text.
   */
  timeHours(milliseconds: number): number {
    return Math.floor(Math.max(0, milliseconds) / 3600000);
  }

  /**
   * Extract remaining whole minutes after the displayed hours.
   * @param milliseconds Summed duration in milliseconds.
   * @returns Localized remaining-minute text.
   */
  timeMinutes(milliseconds: number): number {
    return Math.floor(Math.max(0, milliseconds) / 60000) % 60;
  }
  private timer?: ReturnType<typeof setTimeout>;
  private request = 0;
  private metricsRequest = 0;

  /**
   * Load the initial recent-games list and aggregate statistics.
   */
  constructor() {
    void this.refresh();
  }

  /**
   * Open a replay while preserving the current filters for previous/next navigation.
   * @param game Selected game row.
   * @returns Nothing; initiates router navigation.
   */
  openGame(game: RecentGame): void {
    const queryParams = Object.fromEntries(new URLSearchParams(this.filterParams()));
    void this.router.navigate(['/replay', game.gameID], {
      queryParams: { ...queryParams, from: 'games' },
    });
  }

  /**
   * Activate a focused game row with Enter while leaving other keys alone.
   * @param event Keyboard event from the row.
   * @param game Selected game row.
   * @returns Nothing.
   */
  openGameFromKey(event: Event, game: RecentGame): void {
    if (event.target === event.currentTarget) this.openGame(game);
  }

  /**
   * Debounce replay search text before refreshing list and totals.
   * @param event Search input event.
   * @returns Nothing; schedules a refresh.
   */
  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.request++;
    this.metricsRequest++;
    this.loading.set(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }

  /**
   * Debounce the dedicated placement filter independently of textual search.
   * @param event Placement input event.
   * @returns Nothing; schedules a refresh.
   */
  changePlacement(event: Event): void {
    this.placementFilter.set((event.target as HTMLInputElement).value);
    this.request++;
    this.metricsRequest++;
    this.loading.set(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }

  /**
   * Apply the creative/non-creative/won metric filter and reload matching games.
   * @param value Selected game-kind filter.
   * @returns Nothing; starts a refresh.
   */
  setKind(value: '' | 'creative' | 'noncreative' | 'won'): void {
    this.kind.set(value);
    this.loading.set(true);
    void this.refresh();
  }

  /** Reverse the date order and reload the current filtered game list. */
  reverse(): void {
    this.direction.update((value) => (value === 'desc' ? 'asc' : 'desc'));
    this.loading.set(true);
    void this.refresh();
  }

  /**
   * Apply a date boundary and refresh the filtered statistics and games.
   * @param event Date input event.
   * @param field Which boundary changed: after or before.
   * @returns Nothing.
   */
  changeDate(event: Event, field: 'after' | 'before'): void {
    const value = (event.target as HTMLInputElement).value;
    (field === 'after' ? this.after : this.before).set(value);
    void this.refresh();
  }

  /**
   * Clear both date boundaries and refresh the view.
   * @returns Nothing.
   */
  clearDates(): void {
    this.after.set('');
    this.before.set('');
    void this.refresh();
  }

  /**
   * Serialize current filters, converting inclusive local dates to server timestamp bounds.
   * @param includeKind Whether the selected game-kind filter belongs in this request.
   * @returns An encoded query string for the current filter state.
   */
  private filterParams(includeKind = true): string {
    const params = new URLSearchParams({ q: this.query() });
    params.set('direction', this.direction());
    if (this.placementFilter()) params.set('placement', this.placementFilter());
    if (includeKind && this.kind()) params.set('kind', this.kind());
    if (this.after()) params.set('after', new Date(`${this.after()}T00:00:00`).toISOString());
    if (this.before()) {
      const next = new Date(`${this.before()}T00:00:00`);
      next.setDate(next.getDate() + 1);
      params.set('before', next.toISOString());
    }
    return params.toString();
  }

  /**
   * Request the next game page when another page is available.
   * @returns Nothing; starts the asynchronous page load.
   */
  loadMore(): void {
    if (!this.loadingMore() && this.games().length < this.total())
      void this.load(Math.floor(this.games().length / 25) + 1);
  }

  /**
   * Confirm and delete one replay’s database records, then refresh list and metrics.
   * @param game Game row selected for deletion.
   * @returns A promise completing after deletion or an error message.
   */
  async deleteGame(game: RecentGame): Promise<void> {
    if (this.access.readOnly()) return;
    if (
      !window.confirm(
        `Delete ${game.replayName} from the database? This removes its match statistics, teams, and elimination feed.`,
      )
    )
      return;
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(game.gameID)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not delete game.');
      await this.refresh();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not delete game.');
    }
  }

  /**
   * Upload the selected SQLite file through the compatible-schema import endpoint.
   * @param event File-input change event.
   * @returns A promise completing after import and refresh.
   */
  async importOldDatabase(event: Event): Promise<void> {
    if (this.access.readOnly()) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.importing.set(true);
    this.importMessage.set('Importing games and players…');
    try {
      const response = await fetch('/api/databases/import', { method: 'POST', body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Import failed.');
      this.importMessage.set(
        `Imported ${count(result.imported)} new game${result.imported === 1 ? '' : 's'}.`,
      );
      await this.refresh();
    } catch (error) {
      this.importMessage.set(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      input.value = '';
      this.importing.set(false);
    }
  }

  /**
   * Reset pagination and reload filtered aggregate metrics with the first game page.
   * @returns A promise completing after the refresh attempt.
   */
  private async refresh(): Promise<void> {
    if (this.after() && this.before() && this.after() > this.before()) {
      this.request++;
      this.metricsRequest++;
      this.games.set([]);
      this.total.set(0);
      this.metrics.set(null);
      this.loading.set(false);
      this.error.set('The After date must be on or before the Before date.');
      return;
    }
    const request = ++this.metricsRequest;
    const params = this.filterParams();
    await Promise.all([
      this.load(1),
      fetch(`/api/matches/metrics?${params}`)
        .then((response) => {
          if (!response.ok) throw new Error('Could not load game statistics.');
          return response.json();
        })
        .then((value) => {
          if (request === this.metricsRequest) this.metrics.set(value);
        })
        .catch(() => {}),
    ]);
  }

  /**
   * Load one filtered game page and append or replace the visible rows.
   * @param page One-based page number to request.
   * @returns A promise completing after the request and loading-state cleanup.
   */
  private async load(page: number): Promise<void> {
    const request = ++this.request;
    if (page === 1) {
      this.loading.set(true);
      this.error.set('');
    } else this.loadingMore.set(true);
    try {
      const response = await fetch(`/api/matches?page=${page}&${this.filterParams()}`);
      if (!response.ok) throw new Error('Could not load games.');
      const data = (await response.json()) as GamesResponse;
      if (request !== this.request) return;
      this.games.update((previous) => (page === 1 ? data.games : [...previous, ...data.games]));
      this.total.set(data.total);
    } catch (error) {
      if (request === this.request)
        this.error.set(error instanceof Error ? error.message : 'Could not load games.');
    } finally {
      if (request === this.request) {
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    }
  }
}
