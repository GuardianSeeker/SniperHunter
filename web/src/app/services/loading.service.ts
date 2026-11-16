import { Injectable, signal } from '@angular/core';

/** Shared page-loading signal used by the app shell splash screen. */
@Injectable({ providedIn: 'root' })
export class LoadingService {
  readonly busy = signal(false);
}
