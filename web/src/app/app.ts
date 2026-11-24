import {
  Component,
  HostListener,
  OnDestroy,
  computed,
  effect,
  signal,
  inject,
} from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { LoadingService } from './services/loading.service';
import { UpdateService } from './services/update.service';
import { AccessService } from './services/access.service';

/** Server-driven progress state and shared appearance/navigation preferences. */
interface AppStatus {
  kind: string;
  message: string;
  progress: number;
  startedAt?: number;
  addedAt?: number;
  addedSource?: string;
  autoSwitchLastMatch?: boolean;
  backToTopSide?: 'left' | 'right';
  customCursorEnabled?: boolean;
}
/** Available GitHub release metadata presented in the existing update modal. */
interface Update {
  version: string;
  url: string;
  notes: string;
  asset: { name: string } | null;
}

/**
 * Format elapsed time for the active replay's progress-bar message.
 * @param startedAt Server timestamp when the replay was first detected.
 * @param now Current browser time in Unix milliseconds.
 * @returns Minutes and seconds, with an hour prefix for longer matches.
 */
function formatReplayTimer(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const shortTime = `${minutes % 60}:${String(seconds % 60).padStart(2, '0')}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${shortTime.padStart(5, '0')}` : shortTime;
}

/** Application shell coordinating pinned navigation, progress, loading, update dialogs and local shutdown. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  /**
   * Suppress the browser menu so application-specific right-click copy/zoom actions remain consistent.
   * @param event Document context-menu event.
   * @returns Nothing; prevents the default menu.
   */
  @HostListener('document:contextmenu', ['$event'])
  disableContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }
  private readonly router = inject(Router);
  private readonly loading = inject(LoadingService);
  private readonly updateService = inject(UpdateService);
  readonly access = inject(AccessService);
  readonly status = signal<AppStatus>({ kind: 'idle', message: '', progress: 0 });
  private readonly clockNow = signal(Date.now());
  readonly restartSeconds = signal<number | null>(null);
  readonly updateRestarting = signal(false);
  /** Countdown presentation overrides status text while retaining server-reported download progress. */
  readonly displayStatus = computed<AppStatus>(() => {
    const state = this.status();
    if (this.restartSeconds() !== null)
      return {
        kind: 'updating',
        message:
          this.restartSeconds()! > 0 ? `Restarting in ${this.restartSeconds()}s` : 'Restarting',
        progress: state.progress,
      };
    if (state.kind === 'processing' && Number.isFinite(state.startedAt))
      return {
        ...state,
        message: `${formatReplayTimer(state.startedAt!, this.clockNow())} · ${state.message}`,
      };
    return state;
  });
  readonly update = signal<Update | null>(null);
  readonly updateError = signal('');
  readonly updateInstalling = signal(false);
  readonly currentVersion = signal('');
  readonly showBackToTop = signal(false);
  readonly backToTopSide = signal<'left' | 'right'>('left');
  readonly manualPulse = signal(false);
  private readonly navigationSplash = signal(true);
  readonly showSplash = computed(
    () => this.navigationSplash() || this.loading.busy() || this.updateRestarting(),
  );
  /** Lightweight status polling shared by replay progress, preferences and watched-match navigation. */
  private readonly poller = setInterval(() => void this.loadStatus(), 1500);
  /** Local second tick keeps the visible replay timer smooth without extra server requests. */
  private readonly replayTimer = setInterval(() => this.clockNow.set(Date.now()), 1000);
  /** Router lifecycle subscription keeps the splash visible during page changes and briefly after completion. */
  private readonly navigation = this.router.events.subscribe((event) => {
    if (event instanceof NavigationStart) {
      clearTimeout(this.splashTimer);
      this.navigationSplash.set(true);
    }
    if (
      event instanceof NavigationEnd ||
      event instanceof NavigationCancel ||
      event instanceof NavigationError
    ) {
      clearTimeout(this.splashTimer);
      this.splashTimer = setTimeout(() => this.navigationSplash.set(false), 350);
    }
  });
  private splashTimer?: ReturnType<typeof setTimeout>;
  private pulseTimer?: ReturnType<typeof setTimeout>;
  private updateStatusPoller?: ReturnType<typeof setInterval>;
  private restartCountdownTimer?: ReturnType<typeof setInterval>;
  private navObserver?: ResizeObserver;
  private statusObserver?: ResizeObserver;
  private lastAutoSwitch = 0;
  private receivedFirstStatus = false;

  /**
   * Start status/update observation and keep layout offsets synchronized with the pinned navigation and progress bar.
   */
  constructor() {
    void this.loadStatus();
    void this.access.load().then(() => {
      if (!this.access.readOnly()) void this.loadUpdate();
    });
    window.addEventListener('scroll', this.updateScroll, { passive: true });
    requestAnimationFrame(() => {
      const nav = document.querySelector('.top-nav');
      if (nav) {
        this.navObserver = new ResizeObserver(() =>
          document.documentElement.style.setProperty(
            '--nav-height',
            `${nav.getBoundingClientRect().height}px`,
          ),
        );
        this.navObserver.observe(nav);
      }
      const status = document.querySelector('.status-bar');
      if (status) {
        this.statusObserver = new ResizeObserver(() =>
          document.documentElement.style.setProperty(
            '--status-height',
            `${status.getBoundingClientRect().height}px`,
          ),
        );
        this.statusObserver.observe(status);
      }
    });
    effect(() => {
      if (this.updateService.requests() > 0 && !this.access.readOnly()) void this.loadUpdate(true);
    });
  }

  /**
   * Release polling timers, router subscription and layout observers owned by the app shell.
   * @returns Nothing.
   */
  ngOnDestroy(): void {
    clearInterval(this.poller);
    clearInterval(this.replayTimer);
    clearInterval(this.updateStatusPoller);
    clearInterval(this.restartCountdownTimer);
    clearTimeout(this.splashTimer);
    clearTimeout(this.pulseTimer);
    this.navigation.unsubscribe();
    window.removeEventListener('scroll', this.updateScroll);
    this.navObserver?.disconnect();
    this.statusObserver?.disconnect();
  }

  /**
   * Show the back-to-top control only after leaving the top of the page.
   * @returns Nothing; updates its visibility signal.
   */
  private readonly updateScroll = (): void => {
    this.showBackToTop.set(window.scrollY > 120);
  };

  /**
   * Position and size the navigation ripple from the pointer’s entry point.
   * @param event Pointer event on the navigation link.
   * @returns Nothing; writes the link’s ripple CSS variables.
   */
  setNavHoverOrigin(event: PointerEvent): void {
    const link = event.currentTarget as HTMLElement;
    const rect = link.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const radius = Math.max(
      Math.hypot(x, y),
      Math.hypot(rect.width - x, y),
      Math.hypot(x, rect.height - y),
      Math.hypot(rect.width - x, rect.height - y),
    );
    link.style.setProperty('--hover-x', `${x}px`);
    link.style.setProperty('--hover-y', `${y}px`);
    link.style.setProperty('--hover-radius', `${Math.ceil(radius)}px`);
  }

  /**
   * Refresh progress, cursor preference and watcher-triggered last-match navigation while retaining state during restarts.
   * @returns A promise completing after the status attempt.
   */
  private async loadStatus(): Promise<void> {
    try {
      const response = await fetch('/api/status');
      if (response.ok) {
        const state = (await response.json()) as AppStatus;
        this.status.set(state);
        document.documentElement.classList.toggle(
          'native-cursor',
          state.customCursorEnabled === false,
        );
        this.backToTopSide.set(state.backToTopSide === 'right' ? 'right' : 'left');
        if (!this.receivedFirstStatus) {
          this.receivedFirstStatus = true;
          this.lastAutoSwitch = state.addedAt || 0;
        } else if (state.addedAt && state.addedAt > this.lastAutoSwitch) {
          this.lastAutoSwitch = state.addedAt;
          if (state.addedSource === 'watcher' && state.autoSwitchLastMatch)
            window.location.assign('/lastmatch');
        }
      }
    } catch {
      /* retain the last known status */
    }
  }

  /**
   * Check release metadata and decide whether to show the update modal or transient manual-check feedback.
   * @param manual Whether this check was explicitly requested rather than startup polling.
   * @returns A promise completing after the update check.
   */
  private async loadUpdate(manual = false): Promise<void> {
    try {
      const response = await fetch(manual ? '/api/update?refresh=1' : '/api/update');
      if (!response.ok) return;
      const state = (await response.json()) as {
        currentVersion: string;
        update: Update | null;
        configured: boolean;
        dismissed?: boolean;
        error?: string;
      };
      this.currentVersion.set(state.currentVersion);
      if (
        state.update &&
        (manual ||
          (!state.dismissed && sessionStorage.getItem('ignoredUpdate') !== state.update.version))
      ) {
        this.updateError.set('');
        this.update.set(state.update);
        this.updateService.message.set('');
      } else if (manual) {
        if (!state.configured)
          this.updateService.message.set(
            'Set the GitHub repository URL in release-config.json to enable updates.',
          );
        else if (state.error) this.updateService.message.set(state.error);
        else this.updateService.noUpdate();
      }
    } catch {
      if (manual) this.updateService.message.set('Could not check for updates.');
    }
  }

  /**
   * Ignore this version for the current browser session and close the modal.
   * @returns Nothing.
   */
  ignoreUpdate(): void {
    if (this.update()) sessionStorage.setItem('ignoredUpdate', this.update()!.version);
    this.update.set(null);
  }

  /**
   * Close the update modal without persisting a dismissal.
   * @returns Nothing.
   */
  closeUpdate(): void {
    this.update.set(null);
  }

  /**
   * Request installation, track server progress, then wait for the new executable before reloading the page.
   * @returns A promise completing on reload or a reported installation error.
   */
  async installUpdate(): Promise<void> {
    if (this.access.readOnly() || this.updateInstalling()) return;
    const latest = this.update();
    const version = latest?.version;
    if (!version) return;
    this.updateError.set('');
    this.updateInstalling.set(true);
    this.update.set(null);
    this.status.set({ kind: 'updating', message: 'Updating...', progress: 0 });
    this.updateStatusPoller = setInterval(() => void this.loadStatus(), 500);
    try {
      const response = await fetch('/api/update/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not install the update.');
      this.startRestartCountdown(result.restartInMs);
      await this.waitForUpdatedVersion(version);
    } catch (error) {
      clearInterval(this.updateStatusPoller);
      clearInterval(this.restartCountdownTimer);
      this.restartSeconds.set(null);
      this.updateRestarting.set(false);
      this.update.set(latest);
      this.updateError.set(
        error instanceof Error ? error.message : 'Could not install the update.',
      );
      this.updateInstalling.set(false);
      void this.loadStatus();
    }
  }

  /**
   * Synchronize the local countdown to the server-provided restart delay.
   * @param restartInMs Milliseconds remaining until the scheduled restart.
   * @returns Nothing; starts the short countdown timer.
   */
  private startRestartCountdown(restartInMs: number): void {
    const restartAt = performance.now() + Math.max(0, Number(restartInMs) || 0);
    /**
     * Refresh remaining seconds and enter the loading screen when the restart deadline is reached.
     * @returns Nothing; stops its own timer at the deadline.
     */
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((restartAt - performance.now()) / 1000));
      this.restartSeconds.set(seconds);
      if (seconds === 0) {
        clearInterval(this.restartCountdownTimer);
        this.updateRestarting.set(true);
      }
    };
    updateCountdown();
    this.restartCountdownTimer = setInterval(updateCountdown, 50);
  }

  /**
   * Poll the returning server until it reports the requested version before refreshing this tab.
   * @param version Expected version after installation.
   * @returns A promise completing after reload is requested; throws if the server does not return in time.
   */
  private async waitForUpdatedVersion(version: string): Promise<void> {
    for (let attempt = 0; attempt < 480; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const check = await fetch('/api/config', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        const config = check.ok ? await check.json() : null;
        if (config?.version === version) {
          clearInterval(this.updateStatusPoller);
          clearInterval(this.restartCountdownTimer);
          window.location.reload();
          return;
        }
      } catch {
        /* the old program is stopping or the new one is starting */
      }
    }
    throw new Error(
      'The update did not restart in time. Check the Console after reopening Sniper Hunter.',
    );
  }

  /**
   * Persist a version-specific dismissal on the server and close the modal.
   * @returns A promise completing after persistence or visible error feedback.
   */
  async dismissUpdate(): Promise<void> {
    if (this.access.readOnly()) return;
    const version = this.update()?.version;
    if (!version) return;
    try {
      const response = await fetch('/api/update/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!response.ok) throw new Error('Could not save the dismissal.');
      this.update.set(null);
    } catch (error) {
      this.updateError.set(
        error instanceof Error ? error.message : 'Could not save the dismissal.',
      );
    }
  }

  /**
   * Smoothly return the current document to its top.
   * @returns Nothing.
   */
  scrollToTop(): void {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Restart the decorative progress-bar ripple without changing replay state.
   * @returns Nothing; resets the pulse after the animation.
   */
  pulseStatus(): void {
    clearTimeout(this.pulseTimer);
    this.manualPulse.set(false);
    setTimeout(() => {
      this.manualPulse.set(true);
      this.pulseTimer = setTimeout(() => this.manualPulse.set(false), 1250);
    }, 30);
  }

  /**
   * Ask the local server to shut down, then close the tab or fall back to about:blank.
   * @param event Power-button click, prevented from triggering the bar ripple.
   * @returns A promise completing after shutdown handling.
   */
  async shutdown(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.access.readOnly()) return;
    try {
      const response = await fetch('/api/shutdown', { method: 'POST' });
      if (!response.ok) throw new Error('Shutdown failed.');
      window.close();
      setTimeout(() => {
        if (!window.closed) window.location.replace('about:blank');
      }, 200);
    } catch {
      this.status.set({
        kind: 'warning',
        message: 'Could not shut down Sniper Hunter.',
        progress: 0,
      });
    }
  }
}
