/**
 * Format a stored timestamp in the browser’s locale and timezone.
 * @param value ISO/date-compatible timestamp text.
 * @returns Localized date and time, or the unchanged value if invalid.
 */
export function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Display a replay duration with rounded seconds and localized minute counts.
 * @param milliseconds Raw duration in milliseconds.
 * @returns Minutes and seconds, or an em dash for invalid input.
 */
export function duration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  return `${count(Math.floor(seconds / 60))} min ${String(seconds % 60).padStart(2, '0')} sec`;
}

/**
 * Format elimination time after rounding once, avoiding 0:00 at a minute rollover.
 * @param milliseconds Raw event time in milliseconds, including legacy numeric strings.
 * @returns A minute:second clock, or an em dash for invalid input.
 */
export function killTime(milliseconds: number | string): string {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.round(value / 1000);
  return `${count(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Format nonnegative statistics with locale-appropriate thousands separators.
 * @param value Numeric count to display.
 * @returns Localized count, or an em dash for invalid/negative values.
 */
export function count(value: number): string {
  return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat().format(value) : '—';
}

/**
 * Format a finite number with a fixed number of fractional digits.
 * @param value Number to display.
 * @param places Required fractional digits.
 * @returns Localized decimal text, or an em dash when nonfinite.
 */
export function decimal(value: number, places: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }).format(value)
    : '—';
}

/**
 * Convert raw fractional accuracy into the displayed percentage without changing database units.
 * @param value Accuracy fraction stored by the parser.
 * @returns Percentage with two decimal places, or an em dash.
 */
export function accuracy(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${decimal(value * 100, 2)}%` : '—';
}

/**
 * Convert the stored travel-distance value from centimetres to displayed metres.
 * @param value Raw database travel distance in centimetres.
 * @returns Localized metres with two decimal places, or an em dash.
 */
export function distance(value: number): string {
  return Number.isFinite(value) && value >= 0 ? `${decimal(value / 100, 2)} m` : '—';
}

/**
 * Display positive placements while treating zero as unplaced.
 * @param value Raw placement value.
 * @returns A hash-prefixed rank, or an em dash when unplaced.
 */
export function placement(value: number): string {
  return Number.isFinite(value) && value > 0 ? `#${count(value)}` : '—';
}
