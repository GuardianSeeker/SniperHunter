import { Component, signal } from '@angular/core';
import { count } from '../../shared/format';

/** Named SQL snippet persisted in portable config.json. */
interface SavedQuery {
  id: string;
  name: string;
  sql: string;
}
/** Custom SQL result preserving arbitrary column names and unformatted cell values. */
interface Result {
  columns: string[];
  rows: Record<string, unknown>[];
  message: string;
}
/** User-visible SQLite table metadata for the collapsible schema browser. */
interface Table {
  name: string;
  rows: number;
  columns: { name: string; type: string; required: boolean; primaryKey: boolean }[];
}

/** Local custom-SQL workspace with lazy schema inspection, named queries and CSV export. */
@Component({
  selector: 'app-sql-page',
  templateUrl: './sql-page.html',
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

  /**
   * Load named SQL snippets for one-click reuse.
   */
  constructor() {
    void this.loadSaved();
  }

  /**
   * Render arbitrary SQL values without applying statistics formatting.
   * @param value Cell value returned by custom SQL.
   * @returns Text suitable for a result-table cell.
   */
  display(value: unknown): string {
    return value === null || value === undefined ? 'NULL' : String(value);
  }

  /**
   * Map SQLite declared types to readable descriptions while retaining the original declaration.
   * @param type SQLite column type string.
   * @returns A readable type label.
   */
  typeLabel(type: string): string {
    if (/CHAR|TEXT|CLOB/i.test(type)) return `String · ${type}`;
    if (/DATE|TIME/i.test(type)) return `Date/time · ${type}`;
    if (/INT/i.test(type)) return `Integer · ${type}`;
    if (/REAL|FLOAT|DOUBLE/i.test(type)) return `Number · ${type}`;
    return type || 'Any';
  }

  /**
   * Fetch database table metadata only when its collapsible section is opened.
   * @param event Details toggle event.
   * @returns Nothing; starts lazy metadata loading.
   */
  openSchema(event: Event): void {
    const details = event.target as HTMLDetailsElement;
    if (!details.classList.contains('schema-browser')) return;
    if (details.open && !this.schemaLoaded() && !this.schemaLoading()) void this.loadSchema();
    if (!details.open)
      details.querySelectorAll<HTMLDetailsElement>('.schema-table[open]').forEach((table) => {
        table.open = false;
      });
  }

  /**
   * Load visible table descriptions, columns and row counts from the schema endpoint.
   * @returns A promise completing after the request.
   */
  private async loadSchema(): Promise<void> {
    this.schemaLoading.set(true);
    try {
      const response = await fetch('/api/sql/schema');
      if (response.ok) {
        this.tables.set(await response.json());
        this.schemaLoaded.set(true);
      }
    } catch {
      /* query results remain usable if schema browsing fails */
    } finally {
      this.schemaLoading.set(false);
    }
  }

  /**
   * Read named SQL snippets from portable configuration.
   * @returns A promise completing after the request.
   */
  private async loadSaved(): Promise<void> {
    try {
      const response = await fetch('/api/sql/saved');
      if (response.ok) this.saved.set(await response.json());
    } catch {
      this.error.set('Could not load saved queries.');
    }
  }

  /**
   * Load and run one saved query, keeping its name available for editing.
   * @param item Selected saved-query record.
   * @returns Nothing; initiates execution.
   */
  use(item: SavedQuery): void {
    this.sql.set(item.sql);
    this.name.set(item.name);
    void this.run();
  }

  /**
   * Execute the user’s SQL and display returned columns/rows or the database error.
   * @returns A promise completing after execution and loading-state cleanup.
   */
  async run(): Promise<void> {
    this.running.set(true);
    this.error.set('');
    this.result.set(null);
    try {
      const response = await fetch('/api/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: this.sql() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Invalid SQL.');
      this.result.set(data);
      if (this.schemaLoaded()) void this.loadSchema();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Invalid SQL.');
    } finally {
      this.running.set(false);
    }
  }

  /**
   * Persist the current SQL text under its entered name, then refresh saved-query buttons.
   * @returns A promise completing after persistence.
   */
  async save(): Promise<void> {
    this.error.set('');
    try {
      const response = await fetch('/api/sql/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.name(), sql: this.sql() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save query.');
      this.saved.update((items) => [...items, data]);
      this.name.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save query.');
    }
  }

  /**
   * Delete a saved query and reload the saved-query list.
   * @param item Saved-query record to remove.
   * @returns A promise completing after deletion.
   */
  async remove(item: SavedQuery): Promise<void> {
    try {
      const response = await fetch(`/api/sql/saved/${item.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete query.');
      this.saved.update((items) => items.filter((other) => other.id !== item.id));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not delete query.');
    }
  }

  /**
   * Serialize the displayed result table to CSV, including a header row.
   * @returns CSV text with escaped fields and CRLF row separators.
   */
  private csv(): string {
    const data = this.result();
    if (!data) return '';
    /**
     * Quote one CSV value and escape embedded double quotes.
     * @param value Result cell or column name.
     * @returns A CSV-safe field.
     */
    const field = (value: unknown) =>
      `"${(value === null || value === undefined ? '' : String(value)).replaceAll('"', '""')}"`;
    return [
      data.columns.map(field).join(','),
      ...data.rows.map((row) => data.columns.map((column) => field(row[column])).join(',')),
    ].join('\r\n');
  }

  /**
   * Copy the current result table as CSV and show operation feedback.
   * @returns A promise completing after clipboard handling.
   */
  async copyCsv(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.csv());
    } catch {
      this.error.set('Could not copy CSV.');
    }
  }

  /**
   * Download the current result table through a temporary browser object URL.
   * @returns Nothing; revokes the URL after initiating the download.
   */
  exportCsv(): void {
    const url = URL.createObjectURL(
      new Blob(['\ufeff', this.csv()], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sniper-hunter-query.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
