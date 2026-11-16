import { Injectable, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

/** Server-authoritative local/read-only access shared by navigation and route guards. */
@Injectable({ providedIn: 'root' })
export class AccessService {
  readonly readOnly = signal(true);
  private pending?: Promise<void>;

  /**
   * Fetch server-enforced access once and share the in-flight promise across route guards.
   * @returns A promise resolving after readOnly is known; failed checks remain read-only.
   */
  load(): Promise<void> {
    return (this.pending ??= fetch('/api/access')
      .then(async (response) => {
        if (!response.ok) throw new Error('Access check failed.');
        const value = (await response.json()) as { readOnly: boolean };
        this.readOnly.set(value.readOnly !== false);
      })
      .catch(() => this.readOnly.set(true)));
  }
}

/**
 * Protect local-only routes using server-reported access instead of browser hostname assumptions.
 * @returns A promise containing true for local access or a redirect to the last match.
 */
export const localOnly: CanActivateFn = async () => {
  const access = inject(AccessService);
  const router = inject(Router);
  await access.load();
  return access.readOnly() ? router.parseUrl('/lastmatch') : true;
};
