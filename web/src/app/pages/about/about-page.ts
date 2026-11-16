import { Component, inject, signal } from '@angular/core';
import { UpdateService } from '../../services/update.service';
import { AccessService } from '../../services/access.service';

/** About text, feature catalog, external links and manual release-check entry point. */
@Component({
  selector: 'app-about-page',
  templateUrl: './about-page.html',
})
export class AboutPage {
  readonly access = inject(AccessService);
  readonly updateService = inject(UpdateService);
  readonly githubUrl = signal('');
  readonly currentVersion = signal('…');

  /**
   * Load the baked-in release configuration for the About links and version button.
   */
  constructor() {
    void this.loadConfig();
  }

  /**
   * Read the current version and configured GitHub repository for this build.
   * @returns A promise completing after the configuration request.
   */
  private async loadConfig(): Promise<void> {
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        const config = await response.json();
        this.githubUrl.set(config.githubRepositoryUrl || '');
        this.currentVersion.set(config.version || 'Unknown');
      }
    } catch {
      /* leave the GitHub button disabled */
    }
  }

  /**
   * Delegate a manual release check to the shared update service and existing app-shell modal.
   * @returns Nothing.
   */
  checkUpdates(): void {
    this.updateService.check();
  }
}
