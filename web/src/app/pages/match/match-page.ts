import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Elimination, MatchDetails } from '../../models/match-types';
import {
  accuracy,
  count,
  dateTime,
  distance,
  duration,
  killTime,
  placement,
} from '../../shared/format';
import { skinFallback, skinUrl } from '../../shared/skin';
import { AccessService } from '../../services/access.service';
import { LastMatchMap } from './last-match-map';
import { platformIcon } from '../../shared/platform-icon';
import { copyWithFeedback } from '../../shared/copy-feedback';

/** Replay summary, linked team/feed selection and optional movement map with filtered previous/next navigation. */
@Component({
  selector: 'app-match-page',
  imports: [RouterLink, LastMatchMap],
  templateUrl: './match-page.html',
})
export class MatchPage implements OnDestroy {
  readonly access = inject(AccessService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private requestNumber = 0;
  private neighborRequest = 0;
  private teamTooltip: HTMLElement | null = null;
  private matchInfoObserver?: ResizeObserver;
  /** Measured reference height for the capped snipers list on narrow layouts. */
  readonly matchInfoHeight = signal(0);
  readonly newerId = signal<string | null>(null);
  readonly olderId = signal<string | null>(null);
  readonly selectedId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly details = signal<MatchDetails | null>(null);

  readonly formatDate = dateTime;
  readonly formatDuration = duration;
  readonly formatKillTime = killTime;
  readonly formatCount = count;
  readonly formatAccuracy = accuracy;
  readonly formatDistance = distance;
  readonly formatPlacement = placement;
  readonly skinUrl = skinUrl;
  readonly skinFallback = skinFallback;
  readonly platformIcon = platformIcon;
  readonly nameQuery = signal('');
  readonly teamQuery = signal('');
  readonly selectedMemberId = signal<string | null>(null);
  /** Follow target shared with the movement map; selecting it does not scroll the document. */
  readonly activeMapPlayerId = signal<string | null>(null);
  readonly teamSort = signal<'team' | 'placement' | 'kills' | 'deaths'>('placement');
  readonly teamDescending = signal(false);
  /** Stable sortable view of team totals; sorting never mutates the response data. */
  readonly sortedTeams = computed(() =>
    [...(this.details()?.teams || [])].sort(
      (a, b) =>
        (a[this.teamSort()] - b[this.teamSort()]) * (this.teamDescending() ? -1 : 1) ||
        a.team - b.team,
    ),
  );
  /** Player-to-team lookup shared by feed filters and avatar ring colors. */
  readonly teamByPlayer = computed(
    () =>
      new Map(
        (this.details()?.teams || []).flatMap((team) =>
          team.members.map((member) => [member.playerID, team.team] as const),
        ),
      ),
  );
  /** Name/team-filtered feed sorted numerically by milliseconds, with database ID as the tie-breaker. */
  readonly filteredEliminations = computed(() => {
    const name = this.nameQuery().trim().toLowerCase();
    const team = this.teamQuery().trim().replace(/^#/, '');
    const teams = this.teamByPlayer();
    return [...(this.details()?.eliminations || [])]
      .filter(
        (item) =>
          (!name ||
            item.killerName.toLowerCase().includes(name) ||
            item.killedName.toLowerCase().includes(name)) &&
          (!team ||
            String(teams.get(item.killerID)) === team ||
            String(teams.get(item.killedID)) === team),
      )
      .sort((a, b) => Number(a.time) - Number(b.time) || a.id - b.id);
  });

  /**
   * Choose a sortable team column, reversing direction when the same column is clicked again.
   * @param key Team property to sort by.
   * @returns Nothing.
   */
  sortTeams(key: 'team' | 'placement' | 'kills' | 'deaths'): void {
    if (this.teamSort() === key) this.teamDescending.update((value) => !value);
    else {
      this.teamSort.set(key);
      this.teamDescending.set(key === 'kills' || key === 'deaths');
    }
  }

  /**
   * Render the direction arrow only for the active team sort column.
   * @param key Column being rendered.
   * @returns An up/down arrow, or an empty string.
   */
  sortMark(key: 'team' | 'placement' | 'kills' | 'deaths'): string {
    return this.teamSort() === key ? (this.teamDescending() ? '↓' : '↑') : '';
  }

  /**
   * Apply manual feed text search and clear the selected-card highlight.
   * @param event Player-name search input event.
   * @returns Nothing.
   */
  updateName(event: Event): void {
    this.nameQuery.set((event.target as HTMLInputElement).value);
    this.selectedMemberId.set(null);
  }

  /**
   * Apply a team-number feed filter and clear the selected-card highlight.
   * @param event Team search input event.
   * @returns Nothing.
   */
  updateTeam(event: Event): void {
    this.teamQuery.set((event.target as HTMLInputElement).value);
    this.selectedMemberId.set(null);
  }

  /**
   * Toggle the selected participant and reveal their teams-table card on selection.
   * @param id Player account ID from the elimination feed.
   * @returns Nothing.
   */
  selectFromFeed(id: string): void {
    if (this.selectedMemberId() === id) {
      this.selectedMemberId.set(null);
      return;
    }
    this.selectedMemberId.set(id);
    this.revealTeamMember(id);
  }

  /**
   * Normalize a map player ID and reveal the corresponding teams-table card.
   * @param id Player ID emitted by the map’s double-click action.
   * @returns Nothing.
   */
  jumpFromMap(id: string): void {
    const playerID = /^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : id;
    this.selectedMemberId.set(playerID);
    this.revealTeamMember(playerID);
  }

  /**
   * Reveal a player inside the team-member scroller and then within the document viewport.
   * @param id Player ID used in the team-card element ID.
   * @returns Nothing; scrolls after rendering while respecting pinned bars.
   */
  private revealTeamMember(id: string): void {
    requestAnimationFrame(() => {
      const member = document.getElementById(`member-${id}`);
      if (!member) return;
      const list = member.closest<HTMLElement>('.team-members');
      if (list) {
        const row = member.getBoundingClientRect(),
          area = list.getBoundingClientRect();
        if (row.top < area.top) list.scrollTop -= area.top - row.top + 4;
        else if (row.bottom > area.bottom) list.scrollTop += row.bottom - area.bottom + 4;
      }
      requestAnimationFrame(() => {
        const row = member.getBoundingClientRect();
        const top = (document.querySelector('.top-nav')?.getBoundingClientRect().height || 0) + 12;
        const bottom = window.innerHeight - 72;
        if (row.top < top) window.scrollBy({ top: row.top - top, behavior: 'smooth' });
        else if (row.bottom > bottom)
          window.scrollBy({ top: row.bottom - bottom, behavior: 'smooth' });
      });
    });
  }

  /**
   * Place an unclipped team tooltip above the supplied avatar anchor.
   * @param team Displayed team number, if known.
   * @param event Hover event providing a fallback anchor.
   * @param anchor Optional avatar element to anchor above.
   * @returns Nothing; replaces the previous tooltip element.
   */
  showTeamTooltip(team: number | undefined, event: MouseEvent, anchor?: HTMLElement): void {
    this.hideTeamTooltip();
    const bounds = (anchor || (event.currentTarget as HTMLElement)).getBoundingClientRect();
    const tooltip = document.createElement('span');
    tooltip.className = 'team-hover-tooltip';
    tooltip.textContent = team === undefined ? 'Team unknown' : `Team ${team}`;
    document.body.append(tooltip);
    const size = tooltip.getBoundingClientRect();
    const width = size.width;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, bounds.left + bounds.width / 2 - width / 2))}px`;
    tooltip.style.top = `${bounds.top > size.height + 6 ? bounds.top - size.height - 6 : bounds.bottom + 6}px`;
    this.teamTooltip = tooltip;
  }

  /**
   * Remove the body-level team tooltip.
   * @returns Nothing.
   */
  hideTeamTooltip(): void {
    this.teamTooltip?.remove();
    this.teamTooltip = null;
  }

  /**
   * Remove the tooltip and release the match-information resize observer.
   * @returns Nothing.
   */
  ngOnDestroy(): void {
    this.hideTeamTooltip();
    this.matchInfoObserver?.disconnect();
  }

  /**
   * Toggle feed filtering and map following for one player while preserving document scroll.
   * @param name Player name used for the feed filter.
   * @param id Optional player ID for card highlight and map following.
   * @returns Nothing.
   */
  selectFromTeam(name: string, id?: string): void {
    if (id && this.selectedMemberId() === id && this.nameQuery() === name) {
      this.nameQuery.set('');
      this.selectedMemberId.set(null);
      this.activeMapPlayerId.set(null);
      return;
    }
    this.nameQuery.set(name);
    this.teamQuery.set('');
    this.selectedMemberId.set(id || null);
    this.activeMapPlayerId.set(id || null);
    const pageX = window.scrollX,
      pageY = window.scrollY;
    document.querySelector<HTMLDetailsElement>('.feed-panel')?.setAttribute('open', '');
    requestAnimationFrame(() => window.scrollTo({ left: pageX, top: pageY, behavior: 'instant' }));
  }

  /**
   * Filter eliminations by a team and open the feed.
   * @param team Displayed team number.
   * @returns Nothing.
   */
  selectTeam(team: number): void {
    this.teamQuery.set(String(team));
    this.nameQuery.set('');
    this.selectedMemberId.set(null);
    document.querySelector<HTMLDetailsElement>('.feed-panel')?.setAttribute('open', '');
  }

  /**
   * Generate deterministic team colors for avatar rings and table indicators.
   * @param team Displayed team number.
   * @param alpha Color opacity; defaults to fully opaque.
   * @returns An HSLA color string.
   */
  teamColor(team: number, alpha = 1): string {
    const value = Number.isFinite(team) ? team : 0;
    const hue = (((value * 137.508) % 360) + 360) % 360;
    const light = [34, 41, 29][Math.abs(value) % 3];
    return `hsl(${hue.toFixed(1)} 72% ${light}% / ${alpha})`;
  }

  /**
   * Resolve an elimination participant’s team ring color.
   * @param id Player account ID.
   * @returns The team color, or the fallback for an unknown team.
   */
  teamRingColor(id: string): string {
    const team = this.teamByPlayer().get(id);
    return team === undefined ? '#777b8a' : this.teamColor(team);
  }

  /**
   * Copy a player name and display a fading tooltip at the triggering click.
   * @param name Displayed player name.
   * @param event Context-menu event.
   * @returns Nothing.
   */
  copyName(name: string, event: MouseEvent): void {
    void copyWithFeedback(name, event);
  }

  /**
   * Observe replay route/filter changes and synchronize the desktop/mobile summary-panel height reference.
   */
  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(() => {
      const id = this.details()?.match?.gameID;
      if (id) void this.loadNeighbors(id);
    });
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');
      this.selectedId.set(id);
      this.selectedMemberId.set(null);
      this.activeMapPlayerId.set(null);
      this.nameQuery.set('');
      this.teamQuery.set('');
      this.newerId.set(null);
      this.olderId.set(null);
      void this.load(id);
    });
  }

  /**
   * Open the adjacent replay while preserving the originating game/profile filters.
   * @param side Newer or older navigation direction.
   * @returns Nothing.
   */
  goToNeighbor(side: 'newer' | 'older'): void {
    const id = side === 'newer' ? this.newerId() : this.olderId();
    if (id) void this.router.navigate(['/replay', id], { queryParamsHandling: 'preserve' });
  }

  /**
   * Find adjacent replay IDs within the current filtered navigation context.
   * @param id Current game ID.
   * @returns A promise completing after the neighbor request; stale responses are ignored.
   */
  private async loadNeighbors(id: string): Promise<void> {
    const request = ++this.neighborRequest;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.route.snapshot.queryParams))
      if (typeof value === 'string') params.set(key, value);
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(id)}/neighbors?${params}`);
      if (!response.ok) return;
      const neighbors = (await response.json()) as { newer: string | null; older: string | null };
      if (request === this.neighborRequest && this.details()?.match?.gameID === id) {
        this.newerId.set(neighbors.newer);
        this.olderId.set(neighbors.older);
      }
    } catch {
      /* Match details remain usable if neighboring games cannot load. */
    }
  }

  /**
   * Load replay details, choose the default team sort and reset selections for the new match.
   * @param id Game ID, or the latest-match route’s empty selection.
   * @returns A promise completing after details and loading-state updates.
   */
  private async load(id: string | null): Promise<void> {
    const request = ++this.requestNumber;
    this.loading.set(true);
    this.error.set('');
    try {
      const url = id ? `/api/matches/${encodeURIComponent(id)}` : '/api/matches/latest';
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(response.status === 404 ? 'Match not found.' : 'Could not load match.');
      const data = (await response.json()) as MatchDetails;
      if (request === this.requestNumber) {
        const creative = data.match?.mode?.toLowerCase().includes('creative');
        this.teamSort.set(creative ? 'kills' : 'placement');
        this.teamDescending.set(!!creative);
        this.details.set(data);
        if (data.match) void this.loadNeighbors(data.match.gameID);
      }
    } catch (error) {
      if (request === this.requestNumber)
        this.error.set(error instanceof Error ? error.message : 'Could not load match.');
    } finally {
      if (request === this.requestNumber) {
        this.loading.set(false);
        requestAnimationFrame(() => {
          this.matchInfoObserver?.disconnect();
          const panel = document.getElementById('match-information')?.closest('.panel');
          if (!panel) return;
          this.matchInfoObserver = new ResizeObserver(() => {
            const height = Math.round(panel.getBoundingClientRect().height);
            if (height !== this.matchInfoHeight()) this.matchInfoHeight.set(height);
          });
          this.matchInfoObserver.observe(panel);
        });
      }
    }
  }
}
