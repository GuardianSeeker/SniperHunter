import { Component, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { inject } from '@angular/core';
import type { RecentGame } from './match-types';
import { count, dateTime, decimal, distance, placement } from './format';
import { AccessService } from './access.service';

interface GamesResponse { games: RecentGame[]; total: number; page: number; pageSize: number }
interface Metrics { games: number; averagePlacement: number | null; realPercent: number;
  creativeGames: number; creativePercent: number; nonCreativeGames: number; nonCreativePercent: number; distanceTravelled: number; timePlayed: number; gamesWon: number; totalKills: number; kd: number | null; winPercent: number }

@Component({
  selector: 'app-games-page',
  imports: [RouterLink],
  template: `
    <main class="page">
      <div class="page-heading"><div><h1>Recent games</h1><p class="muted">Search and review saved matches.</p></div></div>
      @if (metrics(); as stats) {
        <div class="metrics-row">
          <div class="metric" [class.selected]="kind() === ''"><button type="button" class="metric-filter" (click)="setKind('')" [attr.aria-pressed]="kind() === ''"><span>Games played</span><strong>{{ formatCount(stats.games) }}</strong></button></div>
          <div class="metric" [class.selected]="kind() === 'noncreative'"><button type="button" class="metric-filter" (click)="setKind('noncreative')" [attr.aria-pressed]="kind() === 'noncreative'"><span>Non-creative games</span><strong>{{ formatCount(stats.nonCreativeGames) }} <small>({{ formatDecimal(stats.nonCreativePercent, 1) }}%)</small></strong></button></div>
          <div class="metric" [class.selected]="kind() === 'creative'"><button type="button" class="metric-filter" (click)="setKind('creative')" [attr.aria-pressed]="kind() === 'creative'"><span>Creative games</span><strong>{{ formatCount(stats.creativeGames) }} <small>({{ formatDecimal(stats.creativePercent, 1) }}%)</small></strong></button></div>
          <div class="metric" [class.selected]="kind() === 'won'"><button type="button" class="metric-filter" (click)="setKind('won')" [attr.aria-pressed]="kind() === 'won'"><span>Games won</span><strong>{{ formatCount(stats.gamesWon) }} <small>({{ formatDecimal(stats.winPercent, 1) }}%)</small></strong></button></div>
          <div class="metric"><span>Average placement</span><strong>{{ stats.averagePlacement === null ? '—' : formatDecimal(stats.averagePlacement, 2) }}</strong></div>
          <div class="metric"><span>Total kills</span><strong>{{ formatCount(stats.totalKills) }} <small>(KD {{ stats.kd === null ? '—' : formatDecimal(stats.kd, 2) }})</small></strong></div>
          <div class="metric"><span>Real players</span><strong>{{ formatDecimal(stats.realPercent, 1) }}%</strong></div>
          <div class="metric"><span>Time played</span><strong>{{ formatCount(timeHours(stats.timePlayed)) }} <small>hrs</small> {{ timeMinutes(stats.timePlayed) }} <small>mins</small></strong></div>
          <div class="metric"><span>Distance travelled</span><strong>{{ formatDistance(stats.distanceTravelled) }}</strong></div>
        </div>
      }
      <div class="list-toolbar">
        <label>Search games <input type="search" [value]="query()" (input)="search($event)" placeholder="Replay, mode, ID" /></label>
        <label>Placement <input class="placement-filter" type="number" min="0" max="99999" step="1" [value]="placementFilter()" (input)="changePlacement($event)" placeholder="Exact #" /></label>
        <label>After <input type="date" [value]="after()" [max]="before() || null" (change)="changeDate($event, 'after')" /></label>
        <label>Before <input type="date" [value]="before()" [min]="after() || null" (change)="changeDate($event, 'before')" /></label>
        @if (after() || before()) { <button type="button" class="toolbar-action" (click)="clearDates()">Clear dates</button> }
        @if (!access.readOnly()) { <label class="file-button games-import-control">Import old database.db <input type="file" accept=".db" (change)="importOldDatabase($event)" [disabled]="importing()" /></label> }
      </div>
      @if (importMessage()) { <p class="notice" role="status">{{ importMessage() }}</p> }
      @if (loading()) { <p role="status">Loading games…</p> }
      @else if (error()) { <div class="notice error" role="alert">{{ error() }}</div> }
      @else if (games().length) {
        <div class="game-list">
          @for (game of games(); track game.gameID) {
            <div class="game-row clickable-game" role="link" tabindex="0" [attr.aria-label]="'Open ' + game.replayName" (click)="openGame(game)" (keydown.enter)="openGameFromKey($event, game)">
              <div class="game-primary"><strong>{{ game.replayName }}</strong><span class="muted">{{ formatDate(game.timestamp) }}</span></div>
              <div><span class="field-label">Mode</span><span>{{ game.mode }}</span></div>
              <div><span class="field-label">Placement</span><strong>{{ formatPlacement(game.placement) }}</strong></div>
              <div class="game-id"><span class="field-label">Session ID</span><code>{{ game.gameID }}</code></div>
              @if (!access.readOnly()) { <button type="button" class="danger-button" (click)="$event.stopPropagation(); deleteGame(game)">Delete</button> }
            </div>
          }
        </div>
        @if (games().length < total()) {
          <button type="button" class="load-more" (click)="loadMore()" [disabled]="loadingMore()">{{ loadingMore() ? 'Loading…' : 'Load more games' }}</button>
        }
      } @else { <div class="notice"><h2>No games found</h2><p>Try another search.</p>@if (!access.readOnly()) { <a class="button-link" routerLink="/replay">Add a replay</a> }</div> }
    </main>
  `,
})
export class GamesPage {
  private readonly router = inject(Router);
  readonly access = inject(AccessService);
  readonly games = signal<RecentGame[]>([]);
  readonly total = signal(0);
  readonly metrics = signal<Metrics | null>(null);
  readonly query = signal('');
  readonly placementFilter = signal('');
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
  timeHours(milliseconds: number): number { return Math.floor(Math.max(0, milliseconds) / 3600000); }
  timeMinutes(milliseconds: number): number { return Math.floor(Math.max(0, milliseconds) / 60000) % 60; }
  private timer?: ReturnType<typeof setTimeout>;
  private request = 0;
  private metricsRequest = 0;

  constructor() { void this.refresh(); }
  openGame(game: RecentGame): void {
    const queryParams = Object.fromEntries(new URLSearchParams(this.filterParams()));
    void this.router.navigate(['/replay', game.gameID], { queryParams: { ...queryParams, from: 'games' } });
  }
  openGameFromKey(event: Event, game: RecentGame): void {
    if (event.target === event.currentTarget) this.openGame(game);
  }

  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }
  changePlacement(event: Event): void {
    this.placementFilter.set((event.target as HTMLInputElement).value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 250);
  }
  setKind(value: '' | 'creative' | 'noncreative' | 'won'): void {
    this.kind.set(value);
    void this.refresh();
  }

  changeDate(event: Event, field: 'after' | 'before'): void {
    const value = (event.target as HTMLInputElement).value;
    (field === 'after' ? this.after : this.before).set(value);
    void this.refresh();
  }

  clearDates(): void { this.after.set(''); this.before.set(''); void this.refresh(); }

  private filterParams(includeKind = true): string {
    const params = new URLSearchParams({ q: this.query() });
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

  loadMore(): void { if (!this.loadingMore() && this.games().length < this.total()) void this.load(Math.floor(this.games().length / 25) + 1); }

  async deleteGame(game: RecentGame): Promise<void> {
    if (this.access.readOnly()) return;
    if (!window.confirm(`Delete ${game.replayName} from the database? This removes its match statistics, teams, and elimination feed.`)) return;
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(game.gameID)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not delete game.');
      await this.refresh();
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Could not delete game.'); }
  }

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
      this.importMessage.set(`Imported ${count(result.imported)} new game${result.imported === 1 ? '' : 's'}.`);
      await this.refresh();
    } catch (error) { this.importMessage.set(error instanceof Error ? error.message : 'Import failed.'); }
    finally { input.value = ''; this.importing.set(false); }
  }

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
    await Promise.all([this.load(1), fetch(`/api/matches/metrics?${params}`).then(response => {
      if (!response.ok) throw new Error('Could not load game statistics.');
      return response.json();
    })
      .then(value => { if (request === this.metricsRequest) this.metrics.set(value); }).catch(() => {})]);
  }

  private async load(page: number): Promise<void> {
    const request = ++this.request;
    if (page === 1) { this.loading.set(true); this.error.set(''); }
    else this.loadingMore.set(true);
    try {
      const response = await fetch(`/api/matches?page=${page}&${this.filterParams()}`);
      if (!response.ok) throw new Error('Could not load games.');
      const data = await response.json() as GamesResponse;
      if (request !== this.request) return;
      this.games.update(previous => page === 1 ? data.games : [...previous, ...data.games]);
      this.total.set(data.total);
    } catch (error) { if (request === this.request) this.error.set(error instanceof Error ? error.message : 'Could not load games.'); }
    finally { if (request === this.request) { this.loading.set(false); this.loadingMore.set(false); } }
  }
}
