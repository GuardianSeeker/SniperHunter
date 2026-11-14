import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Elimination, MatchDetails } from './match-types';
import { accuracy, count, dateTime, distance, duration, killTime, placement } from './format';
import { skinFallback, skinUrl } from './skin';
import { AccessService } from './access.service';
import { LastMatchMap } from './last-match-map';
import { platformIcon } from './platform-icon';
import { copyWithFeedback } from './copy-feedback';

@Component({
  selector: 'app-match-page',
  imports: [RouterLink, LastMatchMap],
  template: `
    <main class="page">
      <div class="page-heading">
        <div>
          <h1>{{ selectedId() ? 'Match details' : 'Last match' }}</h1>
          <p class="muted">Match statistics and the elimination feed from your database.</p>
        </div>
        <div class="match-neighbors"><button type="button" class="toolbar-action neighbor-arrow" [disabled]="!newerId()" (click)="goToNeighbor('newer')" aria-label="Previous replay">
          <span class="map-button-glyph">←</span>
        </button>
          <a class="toolbar-action recent-games-button" routerLink="/games">Recent games</a>
          <button type="button" class="toolbar-action neighbor-arrow" [disabled]="!olderId()" (click)="goToNeighbor('older')" aria-label="Next replay">
            <span class="map-button-glyph">→</span>
          </button></div>
      </div>

      @if (loading()) {
        <p role="status">Loading match…</p>
      } @else if (error()) {
        <div class="notice error" role="alert">{{ error() }}</div>
      } @else if (details(); as data) {
        @if (data.match; as match) {
          <div class="panel-grid">
            <section class="panel" aria-labelledby="match-information" #matchInfoPanel>
              <h2 id="match-information">Match information</h2>
              <dl class="detail-list">
                <div><dt>Session ID</dt><dd class="identifier">{{ match.gameID }}</dd></div>
                <div><dt>Timestamp</dt><dd>{{ formatDate(match.timestamp) }}</dd></div>
                <div><dt>File</dt><dd class="filename">{{ match.replayName }}</dd></div>
                <div><dt>Mode</dt><dd>{{ match.mode }}</dd></div>
                <div><dt>Real players</dt><dd>{{ formatCount(match.players) }} / {{ formatCount(match.players + match.bots) }}</dd></div>
                <div><dt>Duration</dt><dd>{{ formatDuration(match.duration) }}</dd></div>
              </dl>
            </section>

            <section class="panel match-stats-panel" aria-labelledby="player-statistics">
              <h2 id="player-statistics">Player statistics</h2>
              <div class="stat-grid">
                <div><span>Placement</span><strong>{{ formatPlacement(match.placement) }}</strong></div>
                <div><span>Kills</span><strong>{{ formatCount(match.kills) }}</strong></div>
                <div><span>Assists</span><strong>{{ formatCount(match.assists) }}</strong></div>
                <div><span>Accuracy</span><strong>{{ formatAccuracy(match.accuracy) }}</strong></div>
                <div><span>Damage dealt</span><strong>{{ formatCount(match.damageDealt) }}</strong></div>
                <div><span>Damage taken</span><strong>{{ formatCount(match.damageTaken) }}</strong></div>
                <div><span>Distance travelled</span><strong>{{ formatDistance(match.distanceTravelled) }}</strong></div>
              </div>
              <div class="stats-platform-section" aria-labelledby="platform-distribution">
                <h2 id="platform-distribution">Platform distribution</h2>
                @if (data.platforms.length) {
                  <div class="platform-list">
                    @for (item of data.platforms; track item.platform) {
                      <div><span>{{ item.platform }}</span><strong>{{ formatCount(item.players) }} {{ item.players === 1 ? 'player' : 'players' }}</strong></div>
                    }
                  </div>
                } @else {
                  <p class="muted">No platform details recorded for this match.</p>
                }
              </div>
            </section>
          <section class="panel match-snipers-panel" [class.empty-snipers]="!data.snipers.length" aria-labelledby="snipers-heading" [style.--match-info-height.px]="matchInfoHeight() || null">
            <h2 id="snipers-heading" class="section-heading"><span>Snipers in this match</span><span class="heading-count">{{ formatCount(data.snipers.length) }}</span></h2>
            @if (data.snipers.length) {
              <div class="match-snipers">
                @for (player of data.snipers; track player.playerID) {
                  <div class="team-member match-sniper-card" [class.selected-member]="selectedMemberId() === player.playerID" (contextmenu)="copyName(player.username, $event)" (mouseenter)="showTeamTooltip(player.team, $event, sniperAvatar)" (mouseleave)="hideTeamTooltip()">
                    <button type="button" class="member-select" (click)="selectFromTeam(player.username, player.playerID)">
                      <span #sniperAvatar class="team-avatar" [style.--team-color]="teamColor(player.team)"><img [src]="skinUrl(player.skin, false)" (error)="skinFallback($event, false)" alt="" loading="lazy" /></span>
                      <span><strong>{{ player.username }}</strong><small>{{ formatCount(player.games) }} games together</small></span>
                    </button>
                    <a class="member-info" [routerLink]="['/player', player.playerID]" [attr.aria-label]="'View ' + player.username + ' profile'" title="Player profile">@if (platformIcon(player.platform, !!player.isBot); as icon) { <img [src]="icon" alt="" aria-hidden="true" /> }<span>i</span></a>
                  </div>
                }
              </div>
            } @else { <p class="muted">No repeat opponents recorded in this match.</p> }
          </section>
          </div>

          <app-last-match-map [gameID]="match.gameID" [replayName]="match.replayName"
            [activePlayerId]="activeMapPlayerId()" (activePlayerChange)="activeMapPlayerId.set($event)"
            (playerJumpToTeam)="jumpFromMap($event)" />

          <div class="feed-team-grid">
            <details class="panel feed-panel collapsible" open>
              <summary id="elimination-feed"><span>Elimination Feed</span><span class="heading-count">{{ formatCount(filteredEliminations().length) }} / {{ formatCount(data.eliminations.length) }}</span></summary>
              <div class="feed-filters">
                <label>Player name <input type="search" [value]="nameQuery()" (input)="updateName($event)" placeholder="Search names" /></label>
                <label>Team # <input type="search" [value]="teamQuery()" (input)="updateTeam($event)" placeholder="Team number" /></label>
              </div>
              @if (filteredEliminations().length) {
                <div class="feed-list">
                  @for (item of filteredEliminations(); track item.id) {
                    <div class="feed-row">
                      <time>{{ formatKillTime(item.time) }}</time>
                      <div class="feed-event">
                        <button type="button" class="person-inline" (click)="selectFromFeed(item.killerID)" (contextmenu)="copyName(item.killerName || 'Unknown player', $event)" (mouseenter)="showTeamTooltip(teamByPlayer().get(item.killerID), $event, killerAvatar)" (mouseleave)="hideTeamTooltip()"><span #killerAvatar class="team-avatar" [style.--team-color]="teamRingColor(item.killerID)"><img [src]="skinUrl(item.killerSkin, !!item.killerBot)" (error)="skinFallback($event, !!item.killerBot)" alt="" loading="lazy" /></span>{{ item.killerName || 'Unknown player' }}</button>
                        <span>{{ item.knocked ? 'knocked' : 'eliminated' }}</span>
                        <button type="button" class="person-inline" (click)="selectFromFeed(item.killedID)" (contextmenu)="copyName(item.killedName || 'Unknown player', $event)" (mouseenter)="showTeamTooltip(teamByPlayer().get(item.killedID), $event, killedAvatar)" (mouseleave)="hideTeamTooltip()"><span #killedAvatar class="team-avatar" [style.--team-color]="teamRingColor(item.killedID)"><img [src]="skinUrl(item.killedSkin, !!item.killedBot)" (error)="skinFallback($event, !!item.killedBot)" alt="" loading="lazy" /></span>{{ item.killedName || 'Unknown player' }}</button>
                      </div>
                      <span class="muted weapon">{{ item.weapon || 'Unknown weapon' }}</span>
                    </div>
                  }
                </div>
              } @else { <p class="muted">No eliminations match the current search.</p> }
            </details>
            <details class="panel team-panel collapsible" open>
              <summary id="team-heading"><span>Teams</span><span class="heading-count">{{ formatCount(data.teams.length) }}</span></summary>
              <div class="team-table-scroll"><table class="team-table">
                <thead><tr>
                  <th><button type="button" (click)="sortTeams('team')">Team {{ sortMark('team') }}</button></th>
                  <th>Members</th>
                  <th><button type="button" (click)="sortTeams('placement')">Placement {{ sortMark('placement') }}</button></th>
                  <th><button type="button" (click)="sortTeams('kills')">Kills {{ sortMark('kills') }}</button></th>
                  <th><button type="button" (click)="sortTeams('deaths')">Deaths {{ sortMark('deaths') }}</button></th>
                </tr></thead>
                <tbody>@for (team of sortedTeams(); track team.team) {
                  <tr><td><button type="button" class="team-select" (click)="selectTeam(team.team)" [attr.aria-label]="'Filter elimination feed to team ' + team.team"><span class="team-swatch" [style.background]="teamColor(team.team)"></span><span class="team-number">{{ formatCount(team.team) }}</span></button></td><td><div class="team-members">
                    @for (member of team.members; track member.playerID) {
                      <div class="team-member" [id]="'member-' + member.playerID" [class.selected-member]="selectedMemberId() === member.playerID" (contextmenu)="copyName(member.username, $event)">
                        <button type="button" class="member-select" (click)="selectFromTeam(member.username, member.playerID)" [attr.aria-pressed]="selectedMemberId() === member.playerID">
                          <span class="team-avatar" [style.--team-color]="teamColor(member.team)"><img [src]="skinUrl(member.skin, !!member.isBot)" (error)="skinFallback($event, !!member.isBot)" alt="" loading="lazy" /></span>
                          <span class="member-name">{{ member.username }}</span><span class="member-kills">{{ formatCount(member.kills) }} K · {{ formatCount(member.deaths) }} D</span>
                        </button>
                        <a class="member-info" [routerLink]="['/player', member.playerID]" [attr.aria-label]="'View ' + member.username + ' profile'" title="Player profile">@if (platformIcon(member.platform, !!member.isBot); as icon) { <img [src]="icon" alt="" aria-hidden="true" /> }<span>i</span></a>
                      </div>
                    }
                  </div></td><td>{{ formatPlacement(team.placement) }}</td><td>{{ formatCount(team.kills) }}</td><td>{{ formatCount(team.deaths) }}</td></tr>
                }</tbody>
              </table></div>
            </details>
          </div>
        } @else {
          <div class="notice">
            <h2>No matches yet</h2>
            <p>No match statistics are available yet.</p>
            @if (!access.readOnly()) { <a class="button-link" routerLink="/replay">Add a replay</a> }
          </div>
        }
      }
    </main>
  `,
})
export class MatchPage implements OnDestroy {
  readonly access = inject(AccessService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private requestNumber = 0;
  private neighborRequest = 0;
  private teamTooltip: HTMLElement | null = null;
  private matchInfoObserver?: ResizeObserver;
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
  readonly activeMapPlayerId = signal<string | null>(null);
  readonly teamSort = signal<'team' | 'placement' | 'kills' | 'deaths'>('placement');
  readonly teamDescending = signal(false);
  readonly sortedTeams = computed(() => [...(this.details()?.teams || [])].sort((a, b) =>
    (a[this.teamSort()] - b[this.teamSort()]) * (this.teamDescending() ? -1 : 1) || a.team - b.team));
  readonly teamByPlayer = computed(() => new Map((this.details()?.teams || [])
    .flatMap(team => team.members.map(member => [member.playerID, team.team] as const))));
  readonly filteredEliminations = computed(() => {
    const name = this.nameQuery().trim().toLowerCase();
    const team = this.teamQuery().trim().replace(/^#/, '');
    const teams = this.teamByPlayer();
    return [...(this.details()?.eliminations || [])].filter(item =>
      (!name || item.killerName.toLowerCase().includes(name) || item.killedName.toLowerCase().includes(name)) &&
      (!team || String(teams.get(item.killerID)) === team || String(teams.get(item.killedID)) === team))
      .sort((a, b) => Number(a.time) - Number(b.time) || a.id - b.id);
  });

  sortTeams(key: 'team' | 'placement' | 'kills' | 'deaths'): void {
    if (this.teamSort() === key) this.teamDescending.update(value => !value);
    else { this.teamSort.set(key); this.teamDescending.set(key === 'kills' || key === 'deaths'); }
  }
  sortMark(key: 'team' | 'placement' | 'kills' | 'deaths'): string {
    return this.teamSort() === key ? (this.teamDescending() ? '↓' : '↑') : '';
  }
  updateName(event: Event): void { this.nameQuery.set((event.target as HTMLInputElement).value); this.selectedMemberId.set(null); }
  updateTeam(event: Event): void { this.teamQuery.set((event.target as HTMLInputElement).value); this.selectedMemberId.set(null); }
  selectFromFeed(id: string): void {
    if (this.selectedMemberId() === id) { this.selectedMemberId.set(null); return; }
    this.selectedMemberId.set(id);
    this.revealTeamMember(id);
  }
  jumpFromMap(id: string): void {
    const playerID = /^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : id;
    this.selectedMemberId.set(playerID);
    this.revealTeamMember(playerID);
  }
  private revealTeamMember(id: string): void {
    requestAnimationFrame(() => {
      const member = document.getElementById(`member-${id}`);
      if (!member) return;
      const list = member.closest<HTMLElement>('.team-members');
      if (list) {
        const row = member.getBoundingClientRect(), area = list.getBoundingClientRect();
        if (row.top < area.top) list.scrollTop -= area.top - row.top + 4;
        else if (row.bottom > area.bottom) list.scrollTop += row.bottom - area.bottom + 4;
      }
      requestAnimationFrame(() => {
        const row = member.getBoundingClientRect();
        const top = (document.querySelector('.top-nav')?.getBoundingClientRect().height || 0) + 12;
        const bottom = window.innerHeight - 72;
        if (row.top < top) window.scrollBy({ top: row.top - top, behavior: 'smooth' });
        else if (row.bottom > bottom) window.scrollBy({ top: row.bottom - bottom, behavior: 'smooth' });
      });
    });
  }
  showTeamTooltip(team: number | undefined, event: MouseEvent, anchor?: HTMLElement): void {
    this.hideTeamTooltip();
    const bounds = (anchor || event.currentTarget as HTMLElement).getBoundingClientRect();
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
  hideTeamTooltip(): void { this.teamTooltip?.remove(); this.teamTooltip = null; }
  ngOnDestroy(): void { this.hideTeamTooltip(); this.matchInfoObserver?.disconnect(); }
  selectFromTeam(name: string, id?: string): void {
    if (id && this.selectedMemberId() === id && this.nameQuery() === name) {
      this.nameQuery.set(''); this.selectedMemberId.set(null); this.activeMapPlayerId.set(null); return;
    }
    this.nameQuery.set(name);
    this.teamQuery.set('');
    this.selectedMemberId.set(id || null);
    this.activeMapPlayerId.set(id || null);
    const pageX = window.scrollX, pageY = window.scrollY;
    document.querySelector<HTMLDetailsElement>('.feed-panel')?.setAttribute('open', '');
    requestAnimationFrame(() => window.scrollTo({ left: pageX, top: pageY, behavior: 'instant' }));
  }
  selectTeam(team: number): void {
    this.teamQuery.set(String(team));
    this.nameQuery.set('');
    this.selectedMemberId.set(null);
    document.querySelector<HTMLDetailsElement>('.feed-panel')?.setAttribute('open', '');
  }
  teamColor(team: number, alpha = 1): string {
    const value = Number.isFinite(team) ? team : 0;
    const hue = ((value * 137.508) % 360 + 360) % 360;
    const light = [34, 41, 29][Math.abs(value) % 3];
    return `hsl(${hue.toFixed(1)} 72% ${light}% / ${alpha})`;
  }
  teamRingColor(id: string): string { const team = this.teamByPlayer().get(id); return team === undefined ? '#777b8a' : this.teamColor(team); }
  copyName(name: string, event: MouseEvent): void { void copyWithFeedback(name, event); }

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(() => {
      const id = this.details()?.match?.gameID;
      if (id) void this.loadNeighbors(id);
    });
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const id = params.get('id');
      this.selectedId.set(id);
      this.selectedMemberId.set(null);
      this.activeMapPlayerId.set(null);
      this.nameQuery.set('');
      this.teamQuery.set('');
      this.newerId.set(null); this.olderId.set(null);
      void this.load(id);
    });
  }

  goToNeighbor(side: 'newer' | 'older'): void {
    const id = side === 'newer' ? this.newerId() : this.olderId();
    if (id) void this.router.navigate(['/replay', id], { queryParamsHandling: 'preserve' });
  }
  private async loadNeighbors(id: string): Promise<void> {
    const request = ++this.neighborRequest;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.route.snapshot.queryParams))
      if (typeof value === 'string') params.set(key, value);
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(id)}/neighbors?${params}`);
      if (!response.ok) return;
      const neighbors = await response.json() as { newer: string | null; older: string | null };
      if (request === this.neighborRequest && this.details()?.match?.gameID === id) {
        this.newerId.set(neighbors.newer); this.olderId.set(neighbors.older);
      }
    } catch { /* Match details remain usable if neighboring games cannot load. */ }
  }

  private async load(id: string | null): Promise<void> {
    const request = ++this.requestNumber;
    this.loading.set(true);
    this.error.set('');
    try {
      const url = id ? `/api/matches/${encodeURIComponent(id)}` : '/api/matches/latest';
      const response = await fetch(url);
      if (!response.ok) throw new Error(response.status === 404 ? 'Match not found.' : 'Could not load match.');
      const data = await response.json() as MatchDetails;
      if (request === this.requestNumber) {
        const creative = data.match?.mode?.toLowerCase().includes('creative');
        this.teamSort.set(creative ? 'kills' : 'placement');
        this.teamDescending.set(!!creative);
        this.details.set(data);
        if (data.match) void this.loadNeighbors(data.match.gameID);
      }
    } catch (error) {
      if (request === this.requestNumber) this.error.set(error instanceof Error ? error.message : 'Could not load match.');
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
