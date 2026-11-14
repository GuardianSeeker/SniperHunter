export function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function duration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  return `${count(Math.floor(seconds / 60))} min ${String(seconds % 60).padStart(2, '0')} sec`;
}

export function killTime(milliseconds: number | string): string {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.round(value / 1000);
  return `${count(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

export function count(value: number): string {
  return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat().format(value) : '—';
}

export function decimal(value: number, places: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, {
    minimumFractionDigits: places, maximumFractionDigits: places,
  }).format(value) : '—';
}

export function accuracy(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${decimal(value * 100, 2)}%` : '—';
}

export function distance(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${decimal(value / 100, 2)} m` : '—';
}

export function placement(value: number): string {
  return Number.isFinite(value) && value > 0 ? `#${count(value)}` : '—';
}
