import { Component, signal } from '@angular/core';
import { count } from './format';

interface SavedQuery { id: string; name: string; sql: string }
interface Result { columns: string[]; rows: Record<string, unknown>[]; message: string }
interface Table { name: string; rows: number; columns: { name: string; type: string; required: boolean; primaryKey: boolean }[] }

@Component({
  selector: 'app-sql-page',
  template: `
    <main class="page sql-page">
      <h1>Custom SQL</h1>
      <p class="muted">Run a statement against your local Sniper Hunter database. Changes take effect immediately.</p>
      <details class="schema-browser collapsible" (toggle)="openSchema($event)"><summary>Database tables @if (schemaLoaded()) { <span class="muted">({{ formatCount(tables().length) }})</span> }</summary>
        <div class="schema-overview"><p><strong>GameStats</strong> — replay details and your match statistics.</p><p><strong>GamePlayers</strong> — players, teams, placements, and kills in each match.</p><p><strong>GameEliminations</strong> — elimination times, players, and weapons.</p><p><strong>Players</strong> — known player IDs, names, platforms, and skins.</p></div>
        @if (schemaLoading()) { <p class="muted schema-loading">Loading table structure…</p> }
        <div class="schema-grid">@for (table of tables(); track table.name) {
          <details class="schema-table collapsible"><summary><strong>{{ table.name }}</strong><span class="muted">{{ formatCount(table.rows) }} rows</span></summary>
            <ul>@for (column of table.columns; track column.name) { <li><code>{{ column.name }}</code><span>{{ typeLabel(column.type) }}</span>@if (column.primaryKey) { <small>Primary key</small> }</li> }</ul>
          </details>
        }</div>
      </details>
      <label for="sql-input">SQL statement</label>
      <textarea id="sql-input" spellcheck="false" [value]="sql()" (input)="sql.set($any($event.target).value)" placeholder="DO NOT COPY PASTE CODE GIVEN TO YOU BY OTHERS BLINDLY HERE"></textarea>
      <div class="sql-actions">
        <button type="button" class="sql-run" (click)="run()" [disabled]="running()">{{ running() ? 'Running…' : 'Run SQL' }}</button>
        <div class="sql-save-group"><input type="text" aria-label="Saved query name" placeholder="Query name" [value]="name()" (input)="name.set($any($event.target).value)" />
          <button type="button" class="toolbar-action" (click)="save()">Save query</button></div>
      </div>
      @if (saved().length) {
        <section class="saved-queries"><h2>Saved queries</h2><div class="saved-query-list">
          @for (item of saved(); track item.id) {
            <span class="saved-query"><button type="button" (click)="use(item)">{{ item.name }}</button><button type="button" class="saved-delete" [attr.aria-label]="'Delete ' + item.name" (click)="remove(item)">×</button></span>
          }
        </div></section>
      }
      @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      @if (result(); as data) {
        <section class="panel sql-results">
          <div class="sql-result-head"><h2>Output</h2><span class="muted">{{ data.message }}</span>
            @if (data.columns.length) { <button type="button" class="toolbar-action" (click)="copyCsv()">Copy CSV</button><button type="button" class="toolbar-action" (click)="exportCsv()">Export CSV</button> }
          </div>
          @if (data.columns.length) {
            <div class="table-scroll"><table><thead><tr>@for (column of data.columns; track column) { <th>{{ column }}</th> }</tr></thead>
              <tbody>@for (row of data.rows; track $index) { <tr>@for (column of data.columns; track column) { <td>{{ display(row[column]) }}</td> }</tr> }</tbody></table></div>
          }
        </section>
      }
    </main>
  `,
})
export class SqlPage {
  readonly sql = signal('');
  readonly name = signal('');
  readonly saved = signal<SavedQuery[]>([]);
  readonly tables = signal<Table[]>([]);
  readonly schemaLoaded = signal(false);
  readonly schemaLoading = signal(false);
  readonly result = signal<Result | null>(null);
  readonly error = signal('');
  readonly running = signal(false);
  readonly formatCount = count;
  constructor() { void this.loadSaved(); }
  display(value: unknown): string { return value === null || value === undefined ? 'NULL' : String(value); }
  typeLabel(type: string): string {
    if (/CHAR|TEXT|CLOB/i.test(type)) return `String · ${type}`;
    if (/DATE|TIME/i.test(type)) return `Date/time · ${type}`;
    if (/INT/i.test(type)) return `Integer · ${type}`;
    if (/REAL|FLOAT|DOUBLE/i.test(type)) return `Number · ${type}`;
    return type || 'Any';
  }
  openSchema(event: Event): void {
    const details = event.target as HTMLDetailsElement;
    if (!details.classList.contains('schema-browser')) return;
    if (details.open && !this.schemaLoaded() && !this.schemaLoading()) void this.loadSchema();
    if (!details.open) details.querySelectorAll<HTMLDetailsElement>('.schema-table[open]').forEach(table => { table.open = false; });
  }
  private async loadSchema(): Promise<void> {
    this.schemaLoading.set(true);
    try { const response = await fetch('/api/sql/schema'); if (response.ok) { this.tables.set(await response.json()); this.schemaLoaded.set(true); } }
    catch { /* query results remain usable if schema browsing fails */ }
    finally { this.schemaLoading.set(false); }
  }
  private async loadSaved(): Promise<void> {
    try { const response = await fetch('/api/sql/saved'); if (response.ok) this.saved.set(await response.json()); }
    catch { this.error.set('Could not load saved queries.'); }
  }
  use(item: SavedQuery): void { this.sql.set(item.sql); this.name.set(item.name); void this.run(); }
  async run(): Promise<void> {
    this.running.set(true); this.error.set(''); this.result.set(null);
    try {
      const response = await fetch('/api/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: this.sql() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Invalid SQL.');
      this.result.set(data);
      if (this.schemaLoaded()) void this.loadSchema();
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Invalid SQL.'); }
    finally { this.running.set(false); }
  }
  async save(): Promise<void> {
    this.error.set('');
    try {
      const response = await fetch('/api/sql/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: this.name(), sql: this.sql() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save query.');
      this.saved.update(items => [...items, data]); this.name.set('');
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Could not save query.'); }
  }
  async remove(item: SavedQuery): Promise<void> {
    try {
      const response = await fetch(`/api/sql/saved/${item.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete query.');
      this.saved.update(items => items.filter(other => other.id !== item.id));
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Could not delete query.'); }
  }
  private csv(): string {
    const data = this.result(); if (!data) return '';
    const field = (value: unknown) => `"${(value === null || value === undefined ? '' : String(value)).replaceAll('"', '""')}"`;
    return [data.columns.map(field).join(','), ...data.rows.map(row => data.columns.map(column => field(row[column])).join(','))].join('\r\n');
  }
  async copyCsv(): Promise<void> {
    try { await navigator.clipboard.writeText(this.csv()); }
    catch { this.error.set('Could not copy CSV.'); }
  }
  exportCsv(): void {
    const url = URL.createObjectURL(new Blob(['\ufeff', this.csv()], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'sniper-hunter-query.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
