import { Component, inject, signal } from '@angular/core';
import { UpdateService } from './update.service';
import { AccessService } from './access.service';

@Component({
  selector: 'app-about-page',
  template: `
    <main class="page narrow-page about-page">
      <div class="about-heading"><div><h1>About</h1><p class="muted">Sniper Hunter is created and maintained by Guardian Seeker.</p></div>
        <div class="about-links">
          <a href="https://streamlabs.com/guardianseeker/tip" target="_blank" rel="noopener noreferrer" class="about-link"><span aria-hidden="true">♥</span>Donate</a>
          @if (githubUrl()) { <a [href]="githubUrl()" target="_blank" rel="noopener noreferrer" class="about-link" title="Open GitHub repository"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="17" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 6c7 0 8 2 8 9"/></svg>GitHub</a> }
          @else { <span class="about-link disabled" title="Set githubRepositoryUrl in release-config.json"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="17" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 6c7 0 8 2 8 9"/></svg>GitHub</span> }
          <a href="https://discord.gg/vw6Rh6J" target="_blank" rel="noopener noreferrer" class="about-link">Discord</a>
        </div>
      </div>
      <section class="panel prose">
        <p>
          Sniper Hunter helps streamers identify repeat opponents and possible stream snipers, while giving every Fortnite player a clear way to track their games. It reads completed replays, organizes matches and players in a database on your computer, and displays the results in your browser. Your history and settings stay in the program folder.
        </p>
        <h2>Links and credits</h2>
        <p>The replay reader uses <a href="https://github.com/Shiqan/FortniteReplayDecompressor" target="_blank" rel="noopener noreferrer">FortniteReplayDecompressor</a>. 
        <br />
        Missing cosmetics come from <a href="https://fortnite-api.com/" target="_blank" rel="noopener noreferrer">Fortnite-API</a>.
        <br />Development assistance from ChatGPT Codex.</p>
        @if (!access.readOnly()) { <button type="button" class="toolbar-action" (click)="checkUpdates()">Check for updates</button> }
        @if (updateService.message()) { <p class="muted about-update-message" role="status">{{ updateService.message() }}</p> }
        <details class="about-features collapsible">
          <summary>Features</summary>
          <div class="about-feature-groups">
            <section><h3>Last match and replays</h3><ul>
              <li>Match statistics, platform distribution, repeat opponents, searchable elimination feed, and sortable team rosters with team-coloured portraits.</li>
              <li>Click players or teams to filter the feed; right-click names to copy them and open player profiles from team cards.</li>
              <li>Movement map with replay-time playback, player following, storm and visibility shading, trails, zoom, pan, and three-point alignment per saved map. Older matches reload movement only while their replay file remains in Fortnite Demos.</li>
              <li>Browse adjacent replays in the current game list or filtered player history.</li>
            </ul></section>
            <section><h3>Recent games</h3><ul>
              <li>Fast search, date and placement filters, clickable game totals, wins, kills, KD, and filtered time played.</li>
              <li>Delete games or import a previous database.</li>
            </ul></section>
            <section><h3>Snipers list and player profiles</h3><ul>
              <li>Search and sort large player histories; filter by platform or AI and see skin and platform icons.</li>
              <li>View shared games, encounter and teammate incident counts, placement filters, and Fortnite Tracker links.</li>
            </ul></section>
            <section><h3>Add replay</h3><ul>
              <li>Drag and drop replay files or select them from Fortnite Demos; automatic detection handles new completed replays.</li>
              <li>Background parsing keeps pages responsive, retries files still being written, skips duplicate game IDs, and reports batch progress and errors.</li>
            </ul></section>
            <section><h3>Custom SQL</h3><ul>
              <li>Browse database tables, run and save queries, and export results as CSV.</li>
            </ul></section>
            <section><h3>Settings</h3><ul>
              <li>Accounts, network and optional read-only proxy access, automatic navigation, and a live local Console.</li>
              <li>Portable database, skins, and one config.json beside the executable; automatic missing-skin downloads and database recovery prompts.</li>
              <li>Fixed replay status bar, optional themed cursors, Back to top placement, tray controls, and optional GitHub release checks.</li>
            </ul></section>
          </div>
        </details>
      </section>
    </main>
  `,
})
export class AboutPage {
  readonly access = inject(AccessService);
  readonly updateService = inject(UpdateService);
  readonly githubUrl = signal('');
  constructor() { void this.loadConfig(); }
  private async loadConfig(): Promise<void> {
    try { const response = await fetch('/api/config'); if (response.ok) this.githubUrl.set((await response.json()).githubRepositoryUrl || ''); }
    catch { /* leave the GitHub button disabled */ }
  }
  checkUpdates(): void { this.updateService.check(); }
}
