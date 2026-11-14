import { Component, HostListener, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { skinFallback, skinUrl } from './skin';
import { platformIcon } from './platform-icon';
import { copyWithFeedback } from './copy-feedback';
import { count, decimal } from './format';

interface PlayerCard { playerID: string; username: string; platform: string; skin: string; isAI: number; games: number }
interface PlatformMetric { key: string; label: string; players: number; percent: number; variants: { code: string; players: number }[] }
interface Metrics { total: number; platforms: PlatformMetric[] }

@Component({
  selector: 'app-snipers-page',
  imports: [RouterLink],
  template: `
    <main class="page">
      <div class="page-heading"><div><h1>Snipers list</h1><p class="muted">People who have appeared in your games.</p></div></div>
      @if (metrics(); as stats) {
        <div class="metrics-row player-metrics"><div class="metric" [class.selected]="!platform()"><button type="button" class="metric-filter" (click)="clearPlatform()" [attr.aria-pressed]="!platform()"><span>Total players</span><strong>{{ formatCount(stats.total) }}</strong></button></div>
          @for (item of stats.platforms; track item.key) {
            <div class="metric platform-metric" [class.selected]="platform() === item.key">
              <button type="button" class="metric-filter" (click)="filterPlatform(item.key)" [attr.aria-pressed]="platform() === item.key">
                <span class="platform-metric-label">{{ item.label }} @if (platformIcon(item.key); as icon) { <img class="platform-icon platform-icon-invert" [src]="icon" alt="" /> }</span><strong>{{ formatCount(item.players) }} <small>{{ formatDecimal(item.percent, 1) }}%</small></strong>
              </button>
              @if (item.variants.length > 1) { <div class="variant-list">
                @for (variant of item.variants; track variant.code) {
                  <button type="button" [class.selected]="platform() === variant.code" (click)="filterPlatform(variant.code)" [attr.aria-pressed]="platform() === variant.code">{{ variant.code }} {{ formatCount(variant.players) }}</button>
                }
              </div> }
            </div>
          }
        </div>
      }
      <div class="list-toolbar">
        <label>Search players <input type="search" [value]="query()" (input)="search($event)" placeholder="Name, ID, platform, skin" /></label>
        <label>Sort by <select [value]="sort()" (change)="changeSort($event)"><option value="games">Games</option><option value="username">Username</option><option value="id">ID</option><option value="skin">Skin name</option></select></label>
        <button type="button" class="secondary-button sort-direction" (click)="reverse()" [attr.aria-label]="direction() === 'desc' ? 'Sort descending; click to reverse' : 'Sort ascending; click to reverse'" [title]="direction() === 'desc' ? 'Descending' : 'Ascending'">{{ direction() === 'desc' ? '↓' : '↑' }}</button>
        <button type="button" class="toggle-ai" [class.on]="showAI()" [attr.aria-pressed]="showAI()" (click)="toggleAI()"><span class="toggle-check">{{ showAI() ? '✓' : '' }}</span> Show AI</button>
        @if (platform()) { <button type="button" class="toolbar-action" (click)="clearPlatform()">Clear platform filter</button> }
      </div>
      @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      <div class="player-wall">
        @for (player of players(); track player.playerID) {
          <a class="player-card" [routerLink]="['/player', player.playerID]" (contextmenu)="copyName(player.username, $event)">
            <img [src]="skinUrl(player.skin, !!player.isAI)" (error)="skinFallback($event, !!player.isAI)" alt="" loading="lazy" />
            <div><strong>{{ player.username }}</strong><small class="identifier">{{ player.playerID }}</small><span class="player-platform-line">{{ player.isAI ? 'AI' : (player.platform && player.platform.toUpperCase() !== 'NULL' ? player.platform : 'Unknown platform') }}
              @if (platformIcon(player.platform, !!player.isAI); as icon) { <img class="platform-icon platform-icon-invert" [src]="icon" alt="" /> } @else { <span class="platform-dot">·</span> }
              {{ formatCount(player.games) }} {{ player.games === 1 ? 'game' : 'games' }}</span></div>
          </a>
        }
      </div>
      @if (loading()) { <p role="status" class="loading-note">Loading players…</p> }
      @else if (!players().length) { <p class="notice">No players found.</p> }
      @else if (hasMore()) { <button type="button" class="load-more" (click)="loadMore()">Load more players</button> }
    </main>
  `,
})
export class PlayersPage {
  copyName(name: string, event: MouseEvent): void { void copyWithFeedback(name, event); }
  readonly players = signal<PlayerCard[]>([]);
  readonly metrics = signal<Metrics | null>(null);
  readonly query = signal('');
  readonly sort = signal('games');
  readonly direction = signal<'asc' | 'desc'>('desc');
  readonly showAI = signal(false);
  readonly platform = signal('');
  readonly loading = signal(false);
  readonly hasMore = signal(true);
  readonly error = signal('');
  readonly skinUrl = skinUrl;
  readonly skinFallback = skinFallback;
  readonly platformIcon = platformIcon;
  readonly formatCount = count;
  readonly formatDecimal = decimal;
  private cursor: string | null = null;
  private showAIBeforePlatform: boolean | null = null;
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    void fetch('/api/players/metrics').then(response => response.json()).then(value => this.metrics.set(value)).catch(() => {});
    void this.loadMore();
  }

  @HostListener('window:scroll') onScroll(): void {
    if (this.hasMore() && !this.loading() && window.innerHeight + window.scrollY > document.body.scrollHeight - 800)
      void this.loadMore();
  }

  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reset(), 250);
  }
  changeSort(event: Event): void { this.sort.set((event.target as HTMLSelectElement).value); this.reset(); }
  reverse(): void { this.direction.update(value => value === 'desc' ? 'asc' : 'desc'); this.reset(); }
  toggleAI(): void {
    this.showAI.update(value => !value);
    if (!this.showAI() && this.platform() === 'AI') {
      this.platform.set(''); this.showAIBeforePlatform = null;
    }
    this.reset();
  }
  filterPlatform(value: string): void {
    const previous = this.platform();
    const next = previous === value ? '' : value;
    if (next === 'AI' && previous !== 'AI') this.showAIBeforePlatform = this.showAI();
    if (previous === 'AI' && next !== 'AI') {
      this.showAI.set(this.showAIBeforePlatform ?? false);
      this.showAIBeforePlatform = null;
    }
    this.platform.set(next);
    if (next === 'AI') this.showAI.set(true);
    this.reset();
  }
  clearPlatform(): void {
    if (this.platform() === 'AI') this.showAI.set(this.showAIBeforePlatform ?? false);
    this.showAIBeforePlatform = null;
    this.platform.set(''); this.reset();
  }
  private reset(): void { this.request++; this.cursor = null; this.players.set([]); this.hasMore.set(true); this.loading.set(false); void this.loadMore(); }

  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    this.loading.set(true);
    this.error.set('');
    const request = ++this.request;
    const cursor = this.cursor;
    try {
      const params = new URLSearchParams({ q: this.query(), sort: this.sort(), direction: this.direction(),
        showAI: this.showAI() ? '1' : '0', platform: this.platform() });
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/players?${params}`);
      if (!response.ok) throw new Error('Could not load players.');
      const data = await response.json() as { players: PlayerCard[]; nextCursor: string | null };
      if (request !== this.request) return;
      this.players.update(previous => [...previous, ...data.players]);
      this.cursor = data.nextCursor;
      this.hasMore.set(!!data.nextCursor);
      if (data.nextCursor && window.innerHeight + window.scrollY > document.body.scrollHeight - 800)
        setTimeout(() => void this.loadMore(), 0);
    } catch (error) { if (request === this.request) this.error.set(error instanceof Error ? error.message : 'Could not load players.'); }
    finally { if (request === this.request) this.loading.set(false); }
  }
}
