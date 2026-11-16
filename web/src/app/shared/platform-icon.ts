// Add new replay platform codes and matching SVGs here as Fortnite introduces them.
/** Replay platform codes/group labels mapped to bundled SVG basenames. Add new platform associations here; unknown codes deliberately have no invented icon. */
const iconByPlatform: Record<string, string> = {
  PC: 'pc',
  WIN: 'pc',
  PLAYSTATION: 'playstation',
  PSN: 'playstation',
  PS4: 'playstation',
  PS5: 'playstation',
  XBOX: 'xbox',
  XBL: 'xbox',
  XSX: 'xbox',
  XB1: 'xbox',
  SWITCH: 'switch',
  SWT: 'switch',
  SWT2: 'switch',
  ANDROID: 'android',
  AND: 'android',
  IOS: 'ios',
  AI: 'epic',
};

/**
 * Resolve known platform codes and groups to bundled SVG icons without guessing for new codes.
 * @param platform Replay platform code or group label.
 * @param isAI Whether the player is classified as AI.
 * @returns The SVG asset URL, or null for an unmapped platform.
 */
export function platformIcon(platform: string | null | undefined, isAI = false): string | null {
  const key = isAI
    ? 'AI'
    : String(platform || '')
        .trim()
        .toUpperCase();
  const name = iconByPlatform[key];
  return name ? `/assets/${name}.svg` : null;
}
