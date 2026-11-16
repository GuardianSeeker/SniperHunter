import { Component, OnDestroy, signal } from '@angular/core';
import { count } from '../../shared/format';

/** Filename-specific validation, upload or parser failure shown beneath the drop box. */
interface ReplayError {
  name: string;
  message: string;
}

/** Manual/bulk replay upload controller; submits sequentially and polls parser outcomes without navigating away. */
@Component({
  selector: 'app-upload-page',
  templateUrl: './upload-page.html',
})
export class UploadPage implements OnDestroy {
  readonly busy = signal(false);
  readonly dragging = signal(false);
  readonly message = signal('');
  readonly errors = signal<ReplayError[]>([]);
  private batchID: string | null = null;
  private poller?: ReturnType<typeof setInterval>;

  /**
   * Stop batch-status polling when leaving Add replay.
   * @returns Nothing.
   */
  ngOnDestroy(): void {
    clearInterval(this.poller);
  }

  /**
   * Allow replay files to be dropped and show the active drop state.
   * @param event Drag-over event on the upload box.
   * @returns Nothing; prevents browser file navigation.
   */
  dragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.busy()) this.dragging.set(true);
  }

  /**
   * Accept dropped files without allowing the browser to navigate to them.
   * @param event Drop event containing the selected files.
   * @returns Nothing; starts upload processing.
   */
  drop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    if (!this.busy()) void this.upload(Array.from(event.dataTransfer?.files || []));
  }

  /**
   * Read selected browser files and reset the input so the same file can be selected again.
   * @param event File-input change event.
   * @returns Nothing; starts upload processing.
   */
  choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.upload(Array.from(input.files || []));
    input.value = '';
  }

  /**
   * Use the server-side Fortnite Demos picker locally, falling back to the browser file input when unavailable.
   * @returns A promise completing after selection and submission.
   */
  async browse(): Promise<void> {
    const input = document.getElementById('replay-file') as HTMLInputElement;
    // The browser cannot set a file input's initial folder. On the host, use
    // Windows' native picker, which explicitly starts at Fortnite Demos.
    if (!['sniperhunter.localhost', 'localhost'].includes(location.hostname)) {
      input.click();
      return;
    }
    this.busy.set(true);
    try {
      const response = await fetch('/api/replays/pick-local', { method: 'POST' });
      if (response.status === 409) {
        this.busy.set(false);
        input.click();
        return;
      }
      const data = (await response.json()) as { total?: number; batchID?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not open the replay picker.');
      if (!data.total || !data.batchID) return;
      this.errors.set([]);
      this.batchID = data.batchID;
      this.message.set(
        `${count(data.total)} replay file${data.total === 1 ? '' : 's'} selected. Parsing continues in the status bar.`,
      );
      clearInterval(this.poller);
      this.poller = setInterval(() => void this.pollBatch(), 1000);
      void this.pollBatch();
    } catch (error) {
      this.addError(
        'File picker',
        error instanceof Error ? error.message : 'Could not open the replay picker.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Add or update a filename-specific failure in the upload error list.
   * @param name Replay filename.
   * @param message User-facing failure reason.
   * @returns Nothing.
   */
  private addError(name: string, message: string): void {
    this.errors.update((items) =>
      items.some((item) => item.name === name && item.message === message)
        ? items
        : [...items, { name, message }],
    );
  }

  /**
   * Refresh bulk-import outcomes and stop polling once every submitted replay has a final result.
   * @returns A promise completing after a batch-status request.
   */
  private async pollBatch(): Promise<void> {
    if (!this.batchID) return;
    try {
      const response = await fetch(`/api/replays/batches/${this.batchID}`);
      if (!response.ok) return;
      const data = (await response.json()) as {
        total: number;
        parsed: number;
        added: number;
        duplicates: number;
        failed: number;
        errors: ReplayError[];
      };
      for (const item of data.errors) this.addError(item.name, item.message);
      if (data.parsed + data.failed >= data.total) {
        this.message.set(
          `${count(data.added)} replays added${data.duplicates ? `; ${count(data.duplicates)} already added` : ''}${data.failed ? `; ${count(data.failed)} failed to parse` : ''}.`,
        );
        clearInterval(this.poller);
      }
    } catch {
      /* retry on the next poll */
    }
  }

  /**
   * Validate and submit replay files sequentially as one batch, retaining per-file errors.
   * @param files Files selected by dropping or using the browser picker.
   * @returns A promise completing after all upload attempts; server parsing continues through polling.
   */
  async upload(files: File[]): Promise<void> {
    if (this.busy() || files.length === 0) return;
    this.errors.set([]);
    const replays = files.filter((file) => file.name.toLowerCase().endsWith('.replay'));
    for (const file of files)
      if (!replays.includes(file)) this.addError(file.name, 'Choose a .replay file.');
    if (!replays.length) {
      this.message.set('No replay files selected.');
      return;
    }
    this.busy.set(true);
    this.batchID = crypto.randomUUID();
    clearInterval(this.poller);
    let uploaded = 0;
    try {
      for (const [index, file] of replays.entries()) {
        this.message.set(`Adding replay ${count(index + 1)} of ${count(replays.length)}…`);
        try {
          const response = await fetch('/api/replays', {
            method: 'POST',
            body: file,
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Replay-Name': encodeURIComponent(file.name),
              'X-Replay-Batch': this.batchID,
              'X-Replay-Batch-Total': String(replays.length),
            },
          });
          if (!response.ok)
            throw new Error((await response.json()).error || 'Could not add replay.');
          uploaded++;
        } catch (error) {
          this.addError(
            file.name,
            error instanceof Error ? error.message : 'Could not add replay.',
          );
        }
      }
      this.message.set(
        `${count(uploaded)} of ${count(replays.length)} replay files added. Parsing continues in the status bar.`,
      );
      if (uploaded) {
        this.poller = setInterval(() => void this.pollBatch(), 1000);
        void this.pollBatch();
      }
    } finally {
      this.busy.set(false);
    }
  }
}
