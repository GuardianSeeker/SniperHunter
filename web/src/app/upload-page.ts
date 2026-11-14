import { Component, OnDestroy, signal } from '@angular/core';
import { count } from './format';

interface ReplayError { name: string; message: string }

@Component({
  selector: 'app-upload-page',
  template: `
    <main class="page narrow-page">
      <div class="page-heading"><div><h1>Add replay</h1><p class="muted">Drop replay files here or click to browse. Files are read one at a time.</p></div></div>
      <section class="panel upload-panel">
        <input #fileInput id="replay-file" class="visually-hidden" type="file" accept=".replay" multiple (change)="choose($event)" [disabled]="busy()" />
        <button type="button" class="drop-zone" [class.dragging]="dragging()" [disabled]="busy()"
          (click)="browse()" (dragover)="dragOver($event)" (dragleave)="dragging.set(false)" (drop)="drop($event)">
          <span class="drop-icon" aria-hidden="true">＋</span><strong>Drop .replay files here</strong><span>or click to select files</span>
        </button>
        @if (message()) { <p class="message" role="status">{{ message() }}</p> }
      </section>
      @if (errors().length) {
        <section class="panel" aria-labelledby="replay-errors"><h2 id="replay-errors">Errors</h2>
          <ul class="replay-errors">@for (item of errors(); track item.name + item.message) { <li><strong>{{ item.name }}</strong><span>{{ item.message }}</span></li> }</ul>
        </section>
      }
    </main>
  `,
})
export class UploadPage implements OnDestroy {
  readonly busy = signal(false);
  readonly dragging = signal(false);
  readonly message = signal('');
  readonly errors = signal<ReplayError[]>([]);
  private batchID: string | null = null;
  private poller?: ReturnType<typeof setInterval>;

  ngOnDestroy(): void { clearInterval(this.poller); }
  dragOver(event: DragEvent): void { event.preventDefault(); if (!this.busy()) this.dragging.set(true); }
  drop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    if (!this.busy()) void this.upload(Array.from(event.dataTransfer?.files || []));
  }
  choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.upload(Array.from(input.files || []));
    input.value = '';
  }

  async browse(): Promise<void> {
    const input = document.getElementById('replay-file') as HTMLInputElement;
    // The browser cannot set a file input's initial folder. On the host, use
    // Windows' native picker, which explicitly starts at Fortnite Demos.
    if (location.hostname !== 'sniperhunter.localhost') { input.click(); return; }
    this.busy.set(true);
    try {
      const response = await fetch('/api/replays/pick-local', { method: 'POST' });
      if (response.status === 409) { this.busy.set(false); input.click(); return; }
      const data = await response.json() as { total?: number; batchID?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not open the replay picker.');
      if (!data.total || !data.batchID) return;
      this.errors.set([]);
      this.batchID = data.batchID;
      this.message.set(`${count(data.total)} replay file${data.total === 1 ? '' : 's'} selected. Parsing continues in the status bar.`);
      clearInterval(this.poller);
      this.poller = setInterval(() => void this.pollBatch(), 1000);
      void this.pollBatch();
    } catch (error) { this.addError('File picker', error instanceof Error ? error.message : 'Could not open the replay picker.'); }
    finally { this.busy.set(false); }
  }

  private addError(name: string, message: string): void {
    this.errors.update(items => items.some(item => item.name === name && item.message === message) ? items : [...items, { name, message }]);
  }

  private async pollBatch(): Promise<void> {
    if (!this.batchID) return;
    try {
      const response = await fetch(`/api/replays/batches/${this.batchID}`);
      if (!response.ok) return;
      const data = await response.json() as { total: number; parsed: number; added: number; duplicates: number; failed: number; errors: ReplayError[] };
      for (const item of data.errors) this.addError(item.name, item.message);
      if (data.parsed + data.failed >= data.total) {
        this.message.set(`${count(data.added)} replays added${data.duplicates ? `; ${count(data.duplicates)} already added` : ''}${data.failed ? `; ${count(data.failed)} failed to parse` : ''}.`);
        clearInterval(this.poller);
      }
    } catch { /* retry on the next poll */ }
  }

  async upload(files: File[]): Promise<void> {
    if (this.busy() || files.length === 0) return;
    this.errors.set([]);
    const replays = files.filter(file => file.name.toLowerCase().endsWith('.replay'));
    for (const file of files) if (!replays.includes(file)) this.addError(file.name, 'Choose a .replay file.');
    if (!replays.length) { this.message.set('No replay files selected.'); return; }
    this.busy.set(true);
    this.batchID = crypto.randomUUID();
    clearInterval(this.poller);
    let uploaded = 0;
    try {
      for (const [index, file] of replays.entries()) {
        this.message.set(`Adding replay ${count(index + 1)} of ${count(replays.length)}…`);
        try {
          const response = await fetch('/api/replays', { method: 'POST', body: file,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Replay-Name': encodeURIComponent(file.name),
              'X-Replay-Batch': this.batchID, 'X-Replay-Batch-Total': String(replays.length) } });
          if (!response.ok) throw new Error((await response.json()).error || 'Could not add replay.');
          uploaded++;
        } catch (error) { this.addError(file.name, error instanceof Error ? error.message : 'Could not add replay.'); }
      }
      this.message.set(`${count(uploaded)} of ${count(replays.length)} replay files added. Parsing continues in the status bar.`);
      if (uploaded) {
        this.poller = setInterval(() => void this.pollBatch(), 1000);
        void this.pollBatch();
      }
    } finally { this.busy.set(false); }
  }
}
