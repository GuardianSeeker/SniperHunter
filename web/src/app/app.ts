import { Component, HostListener, OnDestroy, computed, effect, signal, inject } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LoadingService } from './loading.service';
import { UpdateService } from './update.service';
import { AccessService } from './access.service';

interface AppStatus { kind: string; message: string; progress: number; addedAt?: number; addedSource?: string;
  autoSwitchLastMatch?: boolean; backToTopSide?: 'left' | 'right'; customCursorEnabled?: boolean }
interface Update { version: string; url: string }

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  @HostListener('document:contextmenu', ['$event'])
  disableContextMenu(event: MouseEvent): void { event.preventDefault(); }
  private readonly router = inject(Router);
  private readonly loading = inject(LoadingService);
  private readonly updateService = inject(UpdateService);
  readonly access = inject(AccessService);
  readonly status = signal<AppStatus>({ kind: 'idle', message: '', progress: 0 });
  readonly update = signal<Update | null>(null);
  readonly updateError = signal('');
  readonly showBackToTop = signal(false);
  readonly backToTopSide = signal<'left' | 'right'>('left');
  readonly manualPulse = signal(false);
  private readonly navigationSplash = signal(true);
  readonly showSplash = computed(() => this.navigationSplash() || this.loading.busy());
  private readonly poller = setInterval(() => void this.loadStatus(), 1500);
  private readonly navigation = this.router.events.subscribe(event => {
    if (event instanceof NavigationStart) { clearTimeout(this.splashTimer); this.navigationSplash.set(true); }
    if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
      clearTimeout(this.splashTimer);
      this.splashTimer = setTimeout(() => this.navigationSplash.set(false), 350);
    }
  });
  private splashTimer?: ReturnType<typeof setTimeout>;
  private pulseTimer?: ReturnType<typeof setTimeout>;
  private navObserver?: ResizeObserver;
  private statusObserver?: ResizeObserver;
  private lastAutoSwitch = 0;
  private receivedFirstStatus = false;

  constructor() {
    void this.loadStatus(); void this.access.load().then(() => { if (!this.access.readOnly()) void this.loadUpdate(); });
    window.addEventListener('scroll', this.updateScroll, { passive: true });
    requestAnimationFrame(() => {
      const nav = document.querySelector('.top-nav');
      if (nav) {
        this.navObserver = new ResizeObserver(() => document.documentElement.style.setProperty('--nav-height', `${nav.getBoundingClientRect().height}px`));
        this.navObserver.observe(nav);
      }
      const status = document.querySelector('.status-bar');
      if (status) {
        this.statusObserver = new ResizeObserver(() => document.documentElement.style.setProperty('--status-height', `${status.getBoundingClientRect().height}px`));
        this.statusObserver.observe(status);
      }
    });
    effect(() => { if (this.updateService.requests() > 0 && !this.access.readOnly()) void this.loadUpdate(true); });
  }
  ngOnDestroy(): void { clearInterval(this.poller); clearTimeout(this.splashTimer); clearTimeout(this.pulseTimer); this.navigation.unsubscribe(); window.removeEventListener('scroll', this.updateScroll); this.navObserver?.disconnect(); this.statusObserver?.disconnect(); }

  private readonly updateScroll = (): void => { this.showBackToTop.set(window.scrollY > 120); };

  setNavHoverOrigin(event: PointerEvent): void {
    const link = event.currentTarget as HTMLElement;
    const rect = link.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const radius = Math.max(
      Math.hypot(x, y), Math.hypot(rect.width - x, y),
      Math.hypot(x, rect.height - y), Math.hypot(rect.width - x, rect.height - y),
    );
    link.style.setProperty('--hover-x', `${x}px`);
    link.style.setProperty('--hover-y', `${y}px`);
    link.style.setProperty('--hover-radius', `${Math.ceil(radius)}px`);
  }

  private async loadStatus(): Promise<void> {
    try {
      const response = await fetch('/api/status');
      if (response.ok) {
        const state = await response.json() as AppStatus;
        this.status.set(state);
        document.documentElement.classList.toggle('native-cursor', state.customCursorEnabled === false);
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
    } catch { /* retain the last known status */ }
  }
  private async loadUpdate(manual = false): Promise<void> {
    try {
      const response = await fetch(manual ? '/api/update?refresh=1' : '/api/update');
      if (!response.ok) return;
      const state = await response.json() as { update: Update | null; configured: boolean; error?: string };
      if (state.update && (manual || sessionStorage.getItem('ignoredUpdate') !== state.update.version)) {
        this.updateError.set(''); this.update.set(state.update); this.updateService.message.set('');
      } else if (manual) this.updateService.message.set(!state.configured ? 'Set the GitHub repository URL in release-config.json to enable updates.' : state.error || 'No newer release found.');
    } catch { if (manual) this.updateService.message.set('Could not check for updates.'); }
  }
  ignoreUpdate(): void {
    if (this.update()) sessionStorage.setItem('ignoredUpdate', this.update()!.version);
    this.update.set(null);
  }
  async dismissUpdate(): Promise<void> {
    if (this.access.readOnly()) return;
    const version = this.update()?.version;
    if (!version) return;
    try {
      const response = await fetch('/api/update/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
      if (!response.ok) throw new Error('Could not save the dismissal.');
      this.update.set(null);
    } catch (error) { this.updateError.set(error instanceof Error ? error.message : 'Could not save the dismissal.'); }
  }
  scrollToTop(): void { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  pulseStatus(): void {
    clearTimeout(this.pulseTimer);
    this.manualPulse.set(false);
    setTimeout(() => {
      this.manualPulse.set(true);
      this.pulseTimer = setTimeout(() => this.manualPulse.set(false), 1250);
    }, 30);
  }
  async shutdown(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.access.readOnly()) return;
    try {
      const response = await fetch('/api/shutdown', { method: 'POST' });
      if (!response.ok) throw new Error('Shutdown failed.');
      window.close();
      setTimeout(() => { if (!window.closed) window.location.replace('about:blank'); }, 200);
    } catch { this.status.set({ kind: 'warning', message: 'Could not shut down Sniper Hunter.', progress: 0 }); }
  }
}
