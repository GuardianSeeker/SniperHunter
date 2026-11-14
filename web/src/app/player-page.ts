import { Component, inject, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { count, dateTime, placement } from './format';
import { skinFallback, skinUrl } from './skin';
import { LoadingService } from './loading.service';
import { platformIcon } from './platform-icon';
import { copyWithFeedback } from './copy-feedback';

interface Player { playerID: string; username: string; platform: string | null; skin: string | null; isAI: number; games: number }
interface Game { gameID: string; replayName: string; timestamp: string; mode: string; placement: number; kills: number }
interface Summary { games: number; youEliminated: number; youKnocked: number; eliminatedYou: number; knockedYou: number; trolledYou: number; trolledKnocked: number }
type EventFilter = 'all' | 'you' | 'them' | 'trolled';

@Component({
  selector: 'app-player-page',
  imports: [RouterLink],
  template: `
    <main class="page player-page">
      <a routerLink="/snipers" class="text-action">← Snipers list</a>
      @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      @if (player(); as p) {
        <section class="panel player-profile">
          <img class="profile-skin" [src]="skinUrl(p.skin, !!p.isAI)" (error)="skinFallback($event, !!p.isAI)" alt="" />
          <div class="profile-content">
            <h1><button class="copy-text" type="button" (click)="copy(p.username, $event)" title="Copy name">{{ p.username }} <span aria-hidden="true">⧉</span></button></h1>
            <p class="identifier"><button class="copy-text" type="button" (click)="copy(p.playerID, $event)" title="Copy player ID">{{ p.playerID }} <span aria-hidden="true">⧉</span></button></p>
            <p class="profile-platform">@if (platformIcon(p.platform, !!p.isAI); as icon) { <img class="platform-icon platform-icon-invert" [src]="icon" alt="" /> }{{ p.isAI ? 'AI' : (p.platform || 'Unknown platform') }} · {{ formatCount(summary()?.games ?? p.games) }} games</p>
            <p class="muted">Skin: {{ p.skin || 'Unknown' }}</p>
            <a class="toolbar-action" [href]="trackerUrl(p.playerID)" target="_blank" rel="noopener noreferrer" (contextmenu)="copy(trackerUrl(p.playerID), $event)">Fortnite Tracker stats ↗</a>
          </div>
        </section>
        @if (summary(); as stats) {
          <div class="metrics-row profile-metrics">
            <div class="metric" [class.selected]="eventFilter() === 'all'"><button type="button" class="metric-filter" (click)="selectEvent('all')" [attr.aria-pressed]="eventFilter() === 'all'"><span>Games together</span><strong>{{ formatCount(stats.games) }}</strong></button></div>
            <div class="metric" [class.selected]="eventFilter() === 'you'"><button type="button" class="metric-filter" (click)="selectEvent('you')" [attr.aria-pressed]="eventFilter() === 'you'"><span>You eliminated them</span><strong>{{ formatCount(stats.youEliminated) }} <small>({{ formatCount(stats.youKnocked) }} knocked)</small></strong></button></div>
            <div class="metric" [class.selected]="eventFilter() === 'them'"><button type="button" class="metric-filter" (click)="selectEvent('them')" [attr.aria-pressed]="eventFilter() === 'them'"><span>They eliminated you</span><strong>{{ formatCount(stats.eliminatedYou) }} <small>({{ formatCount(stats.knockedYou) }} knocked you)</small></strong></button></div>
            <div class="metric" [class.selected]="eventFilter() === 'trolled'"><button type="button" class="metric-filter" (click)="selectEvent('trolled')" [attr.aria-pressed]="eventFilter() === 'trolled'"><span>Trolled you as a teammate</span><strong>{{ formatCount(stats.trolledYou) }} <small>({{ formatCount(stats.trolledKnocked) }} knocked you)</small></strong></button></div>
          </div>
        }
        <h2>Games together</h2>
        <div class="list-toolbar">
          <label>Search games <input type="search" [value]="query()" (input)="search($event)" placeholder="Replay, mode, ID" /></label>
          <label>Placement <input class="placement-filter" type="number" min="0" max="99999" step="1" [value]="placementFilter()" (input)="changePlacement($event)" placeholder="Exact #" /></label>
          <label>After <input type="date" [value]="after()" [max]="before() || null" (change)="changeDate($event, 'after')" /></label>
          <label>Before <input type="date" [value]="before()" [min]="after() || null" (change)="changeDate($event, 'before')" /></label>
          @if (after() || before()) { <button type="button" class="toolbar-action" (click)="clearDates()">Clear dates</button> }
        </div>
        @if (loading()) { <p class="notice" role="status">Filtering player games…</p> }
        <div class="game-list">@for (game of games(); track game.gameID) {
          <a class="game-row player-game-row" [routerLink]="['/replay', game.gameID]" [queryParams]="replayContext()">
            <div class="game-primary"><strong>{{ game.replayName }}</strong><span>{{ formatDate(game.timestamp) }}</span></div>
            <div><span class="field-label">Mode</span>{{ game.mode }}</div>
            <div><span class="field-label">Placement</span>{{ formatPlacement(game.placement) }}</div>
            <div><span class="field-label">Kills</span>{{ formatCount(game.kills) }}</div>
          </a>
        }</div>
        @if (!games().length && !loading()) { <p class="notice">No games match these filters.</p> }
        @if (hasMore()) { <button type="button" class="load-more" (click)="loadMore()" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Load more games' }}</button> }
      }
    </main>
  `,
})
export class PlayerPage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly loadingScreen = inject(LoadingService);
  readonly player = signal<Player | null>(null);
  readonly summary = signal<Summary | null>(null);
  readonly games = signal<Game[]>([]);
  readonly query = signal('');
  readonly placementFilter = signal('');
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
  trackerUrl(id: string): string { return `https://fortnitetracker.com/profile/all/${encodeURIComponent(id)}`; }
  private page = 0;
  private id = '';
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.route.paramMap.subscribe(params => {
      this.id = params.get('id') || '';
      this.request++;
      this.player.set(null);
      this.query.set(''); this.placementFilter.set(''); this.after.set(''); this.before.set('');
      this.eventFilter.set('all');
      this.error.set('');
      this.loadingScreen.busy.set(true);
      void this.loadPlayer();
    });
  }
  ngOnDestroy(): void { clearTimeout(this.timer); this.loadingScreen.busy.set(false); }
  selectEvent(value: EventFilter): void {
    if (this.eventFilter() === value) return;
    this.eventFilter.set(value);
    void this.refresh(false);
  }
  copy(value: string, event: MouseEvent): void { event.stopPropagation(); void copyWithFeedback(value, event); }
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
  changeDate(event: Event, field: 'after' | 'before'): void {
    (field === 'after' ? this.after : this.before).set((event.target as HTMLInputElement).value);
    void this.refresh();
  }
  clearDates(): void { this.after.set(''); this.before.set(''); void this.refresh(); }
  private filterParams(): string {
    const params = new URLSearchParams({ q: this.query() });
    if (this.placementFilter()) params.set('placement', this.placementFilter());
    if (this.after()) params.set('after', new Date(`${this.after()}T00:00:00`).toISOString());
    if (this.before()) { const next = new Date(`${this.before()}T00:00:00`); next.setDate(next.getDate() + 1); params.set('before', next.toISOString()); }
    return params.toString();
  }
  replayContext(): Record<string, string> {
    return { ...Object.fromEntries(new URLSearchParams(this.filterParams())),
      from: 'player', player: this.id, event: this.eventFilter() };
  }
  private async loadPlayer(): Promise<void> {
    const id = this.id;
    try {
      const response = await fetch(`/api/players/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Player not found.');
      if (id !== this.id) return;
      this.player.set(await response.json());
      await this.refresh();
    } catch (error) {
      if (id === this.id) { this.error.set(error instanceof Error ? error.message : 'Could not load player.'); this.loadingScreen.busy.set(false); }
    }
  }
  private async refresh(updateSummary = true): Promise<void> {
    const request = ++this.request;
    if (updateSummary) this.loadingScreen.busy.set(true);
    this.page = 0; this.games.set([]); if (updateSummary) this.summary.set(null); this.hasMore.set(true); this.loading.set(false);
    if (this.after() && this.before() && this.after() > this.before()) {
      this.error.set('The After date must be on or before the Before date.'); this.hasMore.set(false); if (updateSummary) this.loadingScreen.busy.set(false); return;
    }
    this.error.set('');
    try {
      if (updateSummary) {
        const response = await fetch(`/api/players/${encodeURIComponent(this.id)}/summary?${this.filterParams()}`);
        if (!response.ok) throw new Error((await response.json()).error || 'Could not load player statistics.');
        if (request === this.request) this.summary.set(await response.json());
      }
      if (request === this.request) await this.loadMore();
    } catch (error) { if (request === this.request) this.error.set(error instanceof Error ? error.message : 'Could not load player statistics.'); }
    finally { if (request === this.request && updateSummary) this.loadingScreen.busy.set(false); }
  }
  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    const request = this.request;
    this.loading.set(true);
    try {
      const response = await fetch(`/api/players/${encodeURIComponent(this.id)}/games?page=${this.page + 1}&event=${this.eventFilter()}&${this.filterParams()}`);
      if (!response.ok) throw new Error('Could not load player games.');
      const data = await response.json() as { games: Game[]; hasMore: boolean };
      if (request !== this.request) return;
      this.games.update(previous => [...previous, ...data.games]);
      this.page++;
      this.hasMore.set(data.hasMore);
    } catch (error) { if (request === this.request) this.error.set(error instanceof Error ? error.message : 'Could not load player games.'); }
    finally { if (request === this.request) this.loading.set(false); }
  }
}
