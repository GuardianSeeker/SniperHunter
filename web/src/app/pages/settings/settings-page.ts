import { Component, OnDestroy, computed, signal } from '@angular/core';

/** User preferences persisted by the server in config.json, shared across browsers. */
interface Settings {
  playerIds: string[];
  sniperThreshold: number;
  autoSwitchLastMatch: boolean;
  hideTrayIcon: boolean;
  openBrowserOnLaunch: boolean;
  downloadMissingSkins: boolean;
  backToTopSide: 'left' | 'right';
  proxyEnabled: boolean;
  customCursorEnabled: boolean;
}
/** Replay-marked owner candidate and number of games where that owner was recorded. */
interface SuggestedId {
  playerID: string;
  username: string;
  games: number;
}
/** Configured account ID with a best-known display name. */
interface OwnerProfile {
  playerID: string;
  username: string;
}
/** Monotonically numbered runtime log entry with a browser-local display time. */
interface ConsoleEntry {
  id: number;
  time: string;
  localTime?: string;
  level: string;
  message: string;
}

/** Portable preferences editor with serialized autosave, account suggestions and a bounded live console. */
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.html',
})
export class SettingsPage implements OnDestroy {
  readonly settings = signal<Settings | null>(null);
  readonly playerIdsText = signal('');
  readonly localUrl = signal('');
  readonly lanUrls = signal<string[]>([]);
  readonly suggested = signal<SuggestedId[]>([]);
  /** Only repeated replay owners not already configured are suggested; the template caps visible rows. */
  readonly visibleSuggested = computed(() => {
    const selected = new Set(
      this.playerIdsText()
        .split(/\r?\n/)
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    );
    return this.suggested().filter(
      (item) => item.games >= 2 && !selected.has(item.playerID.toLowerCase()),
    );
  });
  readonly ownerProfiles = signal<OwnerProfile[]>([]);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly saveTarget = signal<'accounts' | 'access' | 'general'>('general');
  readonly entries = signal<ConsoleEntry[]>([]);
  /**
   * Localize owner suggestion counts with thousands separators.
   * @param value Game count to display.
   * @returns Localized count text.
   */
  readonly formatCount = (value: number): string => new Intl.NumberFormat().format(value);
  private lastEntryId = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveVersion = 0;
  private savingNow = false;
  /** Requests only new log entries every two seconds; disposed when the page closes. */
  private readonly consolePoller = setInterval(() => void this.loadConsole(), 2000);

  /**
   * Load portable settings and the initial console entries.
   */
  constructor() {
    void this.load();
    void this.loadConsole();
  }

  /**
   * Stop polling/debouncing and flush pending settings before this page is destroyed.
   * @returns Nothing; an outstanding save continues asynchronously.
   */
  ngOnDestroy(): void {
    clearInterval(this.consolePoller);
    clearTimeout(this.saveTimer);
    if (this.saveVersion) void this.save();
  }

  /**
   * Append only console entries newer than the last seen ID, retaining at most 500 entries.
   * @returns A promise completing after the polling attempt.
   */
  private async loadConsole(): Promise<void> {
    try {
      const response = await fetch(`/api/console?after=${this.lastEntryId}`);
      if (!response.ok) return;
      const data = (await response.json()) as { entries: ConsoleEntry[] };
      if (!data.entries.length) return;
      this.lastEntryId = data.entries[data.entries.length - 1].id;
      const localEntries = data.entries.map((entry) => ({
        ...entry,
        localTime: new Date(entry.time).toLocaleTimeString(undefined, { hour12: false }),
      }));
      this.entries.update((current) => [...current, ...localEntries].slice(-500));
    } catch {
      /* Retain messages already loaded if the server is restarting. */
    }
  }

  /**
   * Load settings, network URLs and account names/suggestions from the local server.
   * @returns A promise completing after initialization or error handling.
   */
  private async load(): Promise<void> {
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error('Could not load settings.');
      const data = (await response.json()) as {
        settings: Settings;
        localUrl: string;
        lanUrls: string[];
        ownerProfiles: OwnerProfile[];
        suggestedPlayerIds: SuggestedId[];
      };
      this.settings.set(data.settings);
      this.playerIdsText.set(data.settings.playerIds.join('\n'));
      this.localUrl.set(data.localUrl);
      this.lanUrls.set(data.lanUrls);
      this.suggested.set(data.suggestedPlayerIds);
      this.ownerProfiles.set(data.ownerProfiles);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not load settings.');
    }
  }

  /**
   * Update one typed preference and autosave in the appropriate settings section.
   * @param key Settings property being changed.
   * @param value New value of that property.
   * @returns Nothing; schedules persistence.
   */
  patch<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings.update((current) => (current ? { ...current, [key]: value } : null));
    this.queueSave(
      key === 'sniperThreshold' ? 450 : 0,
      key === 'proxyEnabled' ? 'access' : 'general',
    );
  }

  /**
   * Update account text, refresh displayed names and debounce account persistence.
   * @param event Account textarea input event.
   * @returns Nothing.
   */
  changePlayerIds(event: Event): void {
    this.playerIdsText.set((event.target as HTMLTextAreaElement).value);
    this.updateOwnerProfiles();
    this.queueSave(450, 'accounts');
  }

  /**
   * Coalesce edits and associate autosave feedback with the section being edited.
   * @param delay Debounce duration in milliseconds.
   * @param target Section receiving save feedback.
   * @returns Nothing; schedules save.
   */
  private queueSave(delay: number, target: 'accounts' | 'access' | 'general'): void {
    this.saveVersion++;
    this.saveTarget.set(target);
    this.message.set('');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), delay);
  }

  /**
   * Add a suggested account if absent and save it immediately.
   * @param id Suggested player ID.
   * @returns Nothing.
   */
  addSuggested(id: string): void {
    const ids = this.playerIdsText()
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!ids.includes(id)) {
      this.playerIdsText.set([...ids, id].join('\n'));
      this.updateOwnerProfiles();
      this.queueSave(0, 'accounts');
    }
  }

  /**
   * Remove an explicitly selected account, comparing IDs case-insensitively.
   * @param id Player ID to remove.
   * @returns Nothing; updates account cards and persists the change.
   */
  removeOwner(id: string): void {
    const ids = this.playerIdsText()
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const remaining = ids.filter((value) => value.toLowerCase() !== id.toLowerCase());
    if (remaining.length === ids.length) return;
    this.playerIdsText.set(remaining.join('\n'));
    this.updateOwnerProfiles();
    this.queueSave(0, 'accounts');
  }

  /**
   * Reconcile entered account IDs with known names from selected and suggested accounts.
   * @returns Nothing; updates the displayed account cards.
   */
  private updateOwnerProfiles(): void {
    const names = new Map(
      [...this.ownerProfiles(), ...this.suggested()].map((item) => [item.playerID, item.username]),
    );
    this.ownerProfiles.set(
      this.playerIdsText()
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((playerID) => ({ playerID, username: names.get(playerID) || playerID })),
    );
  }

  /**
   * Select a displayed URL for copying.
   * @param event Input focus/click event.
   * @returns Nothing.
   */
  selectText(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  /**
   * Persist current settings serially and repeat if edits arrived during the request.
   * @returns A promise completing after this save attempt; newer edits trigger a follow-up save.
   */
  private async save(): Promise<void> {
    const current = this.settings();
    if (!current || this.savingNow) return;
    const version = this.saveVersion;
    this.savingNow = true;
    this.saving.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const playerIds = this.playerIdsText()
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const response = await fetch('/api/settings', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...current, playerIds }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save settings.');
      if (version === this.saveVersion) {
        this.settings.set(data.settings);
        this.ownerProfiles.set(data.ownerProfiles);
        this.message.set('Saved automatically.');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save settings.');
    } finally {
      this.savingNow = false;
      this.saving.set(false);
      if (version !== this.saveVersion) void this.save();
      else this.saveVersion = 0;
    }
  }
}
