import { Component, HostListener, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { skinFallback, skinUrl } from '../../shared/skin';
import { platformIcon } from '../../shared/platform-icon';
import { copyWithFeedback } from '../../shared/copy-feedback';
import { count, decimal } from '../../shared/format';

/** Directory card data from the paged player-count query. */
interface PlayerCard {
  playerID: string;
  username: string;
  platform: string;
  skin: string;
  isAI: number;
  games: number;
}
/** Platform-group total and ordered variant buttons, including percentage of all players. */
interface PlatformMetric {
  key: string;
  label: string;
  players: number;
  percent: number;
  variants: { code: string; players: number }[];
}
/** Global player population and grouped platform distribution. */
interface Metrics {
  total: number;
  platforms: PlatformMetric[];
}

/** Incrementally loaded player directory with search, platform metrics and sort/AI filters. */
@Component({
  selector: 'app-snipers-page',
  imports: [RouterLink],
  templateUrl: './snipers-page.html',
})
export class PlayersPage {
  /**
   * Copy a player name from its card with transient pointer-position feedback.
   * @param name Displayed player name.
   * @param event Context-menu event.
   * @returns Nothing.
   */
  copyName(name: string, event: MouseEvent): void {
    void copyWithFeedback(name, event);
  }
  readonly players = signal<PlayerCard[]>([]);
  readonly metrics = signal<Metrics | null>(null);
  readonly query = signal('');
  readonly sort = signal('games');
  readonly direction = signal<'asc' | 'desc'>('desc');
  readonly showAI = signal(false);
  readonly platform = signal('');
  readonly loading = signal(false);
  readonly filtering = signal(true);
  readonly hasMore = signal(true);
  readonly error = signal('');
  readonly skinUrl = skinUrl;
  readonly skinFallback = skinFallback;
  readonly platformIcon = platformIcon;
  readonly formatCount = count;
  readonly formatDecimal = decimal;
  private cursor: string | null = null;
  /** Remember the prior AI checkbox state while the explicit Bots/AI platform filter temporarily enables it. */
  private showAIBeforePlatform: boolean | null = null;
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;

  /**
   * Load platform totals and the first searchable player page.
   */
  constructor() {
    void fetch('/api/players/metrics')
      .then((response) => response.json())
      .then((value) => this.metrics.set(value))
      .catch(() => {});
    void this.loadMore();
  }

  /**
   * Load the next player page when scrolling near the document bottom.
   * @returns Nothing; delegates concurrency checks to loadMore.
   */
  @HostListener('window:scroll') onScroll(): void {
    if (
      this.hasMore() &&
      !this.loading() &&
      !this.filtering() &&
      window.innerHeight + window.scrollY > document.body.scrollHeight - 800
    )
      void this.loadMore();
  }

  /**
   * Debounce player search; quoted searches are interpreted by the server as username-only.
   * @param event Search input event.
   * @returns Nothing.
   */
  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.request++;
    this.filtering.set(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reset(), 250);
  }

  /**
   * Apply the selected player sort key and restart pagination.
   * @param event Sort-select change event.
   * @returns Nothing.
   */
  changeSort(event: Event): void {
    this.sort.set((event.target as HTMLSelectElement).value);
    this.reset();
  }

  /**
   * Reverse the current sort direction and restart pagination.
   * @returns Nothing.
   */
  reverse(): void {
    this.direction.update((value) => (value === 'desc' ? 'asc' : 'desc'));
    this.reset();
  }

  /**
   * Toggle AI visibility while keeping the explicit Bots/AI platform filter consistent.
   * @returns Nothing; reloads the list.
   */
  toggleAI(): void {
    this.showAI.update((value) => !value);
    if (!this.showAI() && this.platform() === 'AI') {
      this.platform.set('');
      this.showAIBeforePlatform = null;
    }
    this.reset();
  }

  /**
   * Filter by group or platform code and restore the prior AI preference when leaving the AI group.
   * @param value Platform/group code selected by the user.
   * @returns Nothing; reloads the list.
   */
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

  /**
   * Clear the platform restriction and restore the saved non-AI-filter preference.
   * @returns Nothing.
   */
  clearPlatform(): void {
    if (this.platform() === 'AI') this.showAI.set(this.showAIBeforePlatform ?? false);
    this.showAIBeforePlatform = null;
    this.platform.set('');
    this.reset();
  }

  /**
   * Invalidate previous responses, clear existing cards and request the first filtered player page.
   * @returns Nothing.
   */
  private reset(): void {
    this.request++;
    this.filtering.set(true);
    this.cursor = null;
    this.players.set([]);
    this.hasMore.set(true);
    this.loading.set(false);
    void this.loadMore();
  }

  /**
   * Append a bounded page of players, discarding stale results after filter changes.
   * @returns A promise completing after the page attempt.
   */
  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    this.loading.set(true);
    this.error.set('');
    const request = ++this.request;
    const cursor = this.cursor;
    try {
      const params = new URLSearchParams({
        q: this.query(),
        sort: this.sort(),
        direction: this.direction(),
        showAI: this.showAI() ? '1' : '0',
        platform: this.platform(),
      });
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/players?${params}`);
      if (!response.ok) throw new Error('Could not load players.');
      const data = (await response.json()) as { players: PlayerCard[]; nextCursor: string | null };
      if (request !== this.request) return;
      this.players.update((previous) => [...previous, ...data.players]);
      this.cursor = data.nextCursor;
      this.hasMore.set(!!data.nextCursor);
      if (data.nextCursor && window.innerHeight + window.scrollY > document.body.scrollHeight - 800)
        setTimeout(() => void this.loadMore(), 0);
    } catch (error) {
      if (request === this.request)
        this.error.set(error instanceof Error ? error.message : 'Could not load players.');
    } finally {
      if (request === this.request) {
        this.loading.set(false);
        this.filtering.set(false);
      }
    }
  }
}
