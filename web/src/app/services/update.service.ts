import { Injectable, signal } from '@angular/core';

/** Connects the About update button to the app-shell modal without duplicating update logic. */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  readonly requests = signal(0);
  readonly message = signal('');
  private messageTimer?: ReturnType<typeof setTimeout>;

  /**
   * Notify the app shell to perform a manual update check and clear old transient feedback.
   * @returns Nothing; increments the request signal.
   */
  check(): void {
    clearTimeout(this.messageTimer);
    this.message.set('Checking for updates…');
    this.requests.update((value) => value + 1);
  }

  /**
   * Temporarily replace the About update-button label when no newer version is available.
   * @returns Nothing; restores the normal label after three seconds.
   */
  noUpdate(): void {
    clearTimeout(this.messageTimer);
    this.message.set('No newer release found.');
    this.messageTimer = setTimeout(() => {
      if (this.message() === 'No newer release found.') this.message.set('');
    }, 3000);
  }
}
