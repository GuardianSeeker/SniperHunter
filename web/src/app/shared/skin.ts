/**
 * Resolve a safe cosmetic filename or the appropriate human/AI fallback icon.
 * @param skin Replay cosmetic ID, if available.
 * @param isBot Whether the player is a bot.
 * @returns A local skin asset URL.
 */
export function skinUrl(skin: string | null | undefined, isBot = false): string {
  if (skin && /^[A-Za-z0-9_-]{1,128}$/.test(skin)) return `/assets/skins/${skin}.png`;
  return `/assets/skins/${isBot ? 'epic' : 'sniper'}.png`;
}

/**
 * Replace a failed skin image once, preventing an error loop if the fallback is also missing.
 * @param event Image load-error event.
 * @param isBot Whether to use the AI fallback instead of the human fallback.
 * @returns Nothing; updates the image source.
 */
export function skinFallback(event: Event, isBot = false): void {
  const image = event.target as HTMLImageElement;
  const fallback = `/assets/skins/${isBot ? 'epic' : 'sniper'}.png`;
  if (!image.src.endsWith(fallback)) image.src = fallback;
}
