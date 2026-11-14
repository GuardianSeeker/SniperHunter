import { Component, OnDestroy, computed, signal } from '@angular/core';

interface Settings { playerIds: string[]; sniperThreshold: number; autoSwitchLastMatch: boolean;
  hideTrayIcon: boolean; openBrowserOnLaunch: boolean; downloadMissingSkins: boolean; backToTopSide: 'left' | 'right';
  proxyEnabled: boolean; customCursorEnabled: boolean }
interface SuggestedId { playerID: string; username: string; games: number }
interface OwnerProfile { playerID: string; username: string }
interface ConsoleEntry { id: number; time: string; localTime?: string; level: string; message: string }

@Component({
  selector: 'app-settings-page',
  template: `
    <main class="page narrow-page settings-page">
      <h1>Settings</h1>
      @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      @if (settings(); as current) {
        <section class="panel settings-fields"><h2>Accounts</h2>
          @if (ownerProfiles().length) { <div class="owner-profiles">
            @for (owner of ownerProfiles(); track owner.playerID) {
              <button type="button" class="owner-profile" (click)="removeOwner(owner.playerID)"
                [attr.aria-label]="'Remove ' + owner.username + ' from your accounts'" title="Remove this account">
                <strong>{{ owner.username }}</strong><span class="identifier">{{ owner.playerID }}</span><span class="owner-remove" aria-hidden="true">×</span>
              </button>
            }
          </div> }
          <label for="player-ids">Your player IDs, one per line</label>
          <textarea id="player-ids" [value]="playerIdsText()" (input)="changePlayerIds($event)" placeholder="Fortnite player ID"></textarea>
          <p class="muted">These IDs identify your eliminations when a replay's owner is missing. They also exclude your accounts from Snipers in this match.</p>
          @if (visibleSuggested().length) { <div class="suggested-ids"><span class="muted">IDs found as replay owners in two or more games:</span>
            <div class="suggested-owner-list" [class.scrollable]="visibleSuggested().length > 2" [class.single]="visibleSuggested().length === 1">
              @for (item of visibleSuggested(); track item.playerID) { <button type="button" class="toolbar-action suggested-owner" (click)="addSuggested(item.playerID)"><strong>{{ item.username }}</strong><span>{{ item.playerID }} · {{ formatCount(item.games) }} games</span></button> }
            </div>
          </div> }
          @if (saveTarget() === 'accounts' && (saving() || message())) { <p role="status" class="settings-message">{{ saving() ? 'Saving…' : message() }}</p> }
        </section>
        <section class="panel settings-fields"><h2>Access from another computer</h2>
          <p class="muted">Open one of these addresses on another device on the same network. If several appear, use your Wi-Fi or Ethernet address. Windows Firewall may ask you to allow access. These local addresses can change your data; proxy views are read-only.</p>
          @if (lanUrls().length) {
            @for (url of lanUrls(); track url) { <input class="readonly-url" type="text" [value]="url" readonly (click)="selectText($event)" aria-label="Local network URL" /> }
          } @else { <p>No private-network IPv4 address was found. Connect this computer to your local network.</p> }
          <p class="muted">On this computer: {{ localUrl() }}</p>
          <label class="settings-toggle"><input type="checkbox" [checked]="current.proxyEnabled" (change)="patch('proxyEnabled', $any($event.target).checked)" /> Allow read-only views through a proxy</label>
          @if (saveTarget() === 'access' && (saving() || message())) { <p role="status" class="settings-message">{{ saving() ? 'Saving…' : message() }}</p> }
        </section>
        <section class="panel settings-fields"><h2>General</h2>
          <label for="sniper-threshold">Snipers in this match: minimum shared games</label>
          <input id="sniper-threshold" type="number" min="1" max="1000" [value]="current.sniperThreshold" (input)="patch('sniperThreshold', +$any($event.target).value)" />
          <label class="settings-toggle"><input type="checkbox" [checked]="current.autoSwitchLastMatch" (change)="patch('autoSwitchLastMatch', $any($event.target).checked)" /> Switch to Last match after a watched replay is read</label>
          <label class="settings-toggle"><input type="checkbox" [checked]="current.hideTrayIcon" (change)="patch('hideTrayIcon', $any($event.target).checked)" /> Hide the system tray icon</label>
          <label class="settings-toggle"><input type="checkbox" [checked]="current.openBrowserOnLaunch" (change)="patch('openBrowserOnLaunch', $any($event.target).checked)" /> Open the browser when Sniper Hunter starts</label>
          <label class="settings-toggle"><input type="checkbox" [checked]="current.downloadMissingSkins" (change)="patch('downloadMissingSkins', $any($event.target).checked)" /> Download missing skin icons</label>
          <label class="settings-toggle"><input type="checkbox" [checked]="current.customCursorEnabled" (change)="patch('customCursorEnabled', $any($event.target).checked)" /> Use the Sniper Hunter cursor</label>
          <fieldset class="setting-radio-group"><legend>Back to top button position</legend>
            <label><input type="radio" name="back-to-top-side" value="left" [checked]="current.backToTopSide === 'left'" (change)="patch('backToTopSide', 'left')" /> Left</label>
            <label><input type="radio" name="back-to-top-side" value="right" [checked]="current.backToTopSide === 'right'" (change)="patch('backToTopSide', 'right')" /> Right</label>
          </fieldset>
          <p class="muted">The browser-launch setting takes effect on the next start.</p>
          @if (saveTarget() === 'general' && (saving() || message())) { <p role="status" class="settings-message">{{ saving() ? 'Saving…' : message() }}</p> }
        </section>
      }
      <section class="panel console-panel" aria-labelledby="console-heading">
        <h2 id="console-heading">Console</h2>
        <div class="console-output" role="log" aria-live="off">
          @for (entry of entries(); track entry.id) {
            <div class="console-line" [class.console-error]="entry.level === 'error'">
              <time>{{ entry.localTime || entry.time.slice(11, 19) }}</time><span>{{ entry.message }}</span>
            </div>
          } @empty { <p>Waiting for log messages…</p> }
        </div>
      </section>
    </main>
  `,
})
export class SettingsPage implements OnDestroy {
  readonly settings = signal<Settings | null>(null);
  readonly playerIdsText = signal('');
  readonly localUrl = signal('');
  readonly lanUrls = signal<string[]>([]);
  readonly suggested = signal<SuggestedId[]>([]);
  readonly visibleSuggested = computed(() => {
    const selected = new Set(this.playerIdsText().split(/\r?\n/).map(id => id.trim().toLowerCase()).filter(Boolean));
    return this.suggested().filter(item => item.games >= 2 && !selected.has(item.playerID.toLowerCase()));
  });
  readonly ownerProfiles = signal<OwnerProfile[]>([]);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly saveTarget = signal<'accounts' | 'access' | 'general'>('general');
  readonly entries = signal<ConsoleEntry[]>([]);
  readonly formatCount = (value: number): string => new Intl.NumberFormat().format(value);
  private lastEntryId = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveVersion = 0;
  private savingNow = false;
  private readonly consolePoller = setInterval(() => void this.loadConsole(), 2000);
  constructor() { void this.load(); void this.loadConsole(); }
  ngOnDestroy(): void { clearInterval(this.consolePoller); clearTimeout(this.saveTimer); if (this.saveVersion) void this.save(); }
  private async loadConsole(): Promise<void> {
    try {
      const response = await fetch(`/api/console?after=${this.lastEntryId}`);
      if (!response.ok) return;
      const data = await response.json() as { entries: ConsoleEntry[] };
      if (!data.entries.length) return;
      this.lastEntryId = data.entries[data.entries.length - 1].id;
      const localEntries = data.entries.map(entry => ({ ...entry,
        localTime: new Date(entry.time).toLocaleTimeString(undefined, { hour12: false }) }));
      this.entries.update(current => [...current, ...localEntries].slice(-500));
    } catch { /* Retain messages already loaded if the server is restarting. */ }
  }
  private async load(): Promise<void> {
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error('Could not load settings.');
      const data = await response.json() as { settings: Settings; localUrl: string; lanUrls: string[]; ownerProfiles: OwnerProfile[]; suggestedPlayerIds: SuggestedId[] };
      this.settings.set(data.settings);
      this.playerIdsText.set(data.settings.playerIds.join('\n'));
      this.localUrl.set(data.localUrl);
      this.lanUrls.set(data.lanUrls);
      this.suggested.set(data.suggestedPlayerIds);
      this.ownerProfiles.set(data.ownerProfiles);
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Could not load settings.'); }
  }
  patch<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings.update(current => current ? { ...current, [key]: value } : null);
    this.queueSave(key === 'sniperThreshold' ? 450 : 0, key === 'proxyEnabled' ? 'access' : 'general');
  }
  changePlayerIds(event: Event): void {
    this.playerIdsText.set((event.target as HTMLTextAreaElement).value);
    this.updateOwnerProfiles();
    this.queueSave(450, 'accounts');
  }
  private queueSave(delay: number, target: 'accounts' | 'access' | 'general'): void {
    this.saveVersion++;
    this.saveTarget.set(target);
    this.message.set('');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), delay);
  }
  addSuggested(id: string): void {
    const ids = this.playerIdsText().split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!ids.includes(id)) { this.playerIdsText.set([...ids, id].join('\n')); this.updateOwnerProfiles(); this.queueSave(0, 'accounts'); }
  }
  removeOwner(id: string): void {
    const ids = this.playerIdsText().split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const remaining = ids.filter(value => value.toLowerCase() !== id.toLowerCase());
    if (remaining.length === ids.length) return;
    this.playerIdsText.set(remaining.join('\n'));
    this.updateOwnerProfiles();
    this.queueSave(0, 'accounts');
  }
  private updateOwnerProfiles(): void {
    const names = new Map([...this.ownerProfiles(), ...this.suggested()].map(item => [item.playerID, item.username]));
    this.ownerProfiles.set(this.playerIdsText().split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      .map(playerID => ({ playerID, username: names.get(playerID) || playerID })));
  }
  selectText(event: Event): void { (event.target as HTMLInputElement).select(); }
  private async save(): Promise<void> {
    const current = this.settings(); if (!current || this.savingNow) return;
    const version = this.saveVersion;
    this.savingNow = true;
    this.saving.set(true); this.error.set(''); this.message.set('');
    try {
      const playerIds = this.playerIdsText().split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const response = await fetch('/api/settings', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...current, playerIds }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save settings.');
      if (version === this.saveVersion) {
        this.settings.set(data.settings); this.ownerProfiles.set(data.ownerProfiles);
        this.message.set('Saved automatically.');
      }
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Could not save settings.'); }
    finally {
      this.savingNow = false;
      this.saving.set(false);
      if (version !== this.saveVersion) void this.save();
      else this.saveVersion = 0;
    }
  }
}
