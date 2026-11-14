function feedbackPosition(event: MouseEvent): { x: number; y: number } {
  const target = event.currentTarget as HTMLElement | null;
  const bounds = target?.getBoundingClientRect();
  const x = event.detail && event.clientX ? event.clientX : (bounds?.right ?? 0);
  const y = event.detail && event.clientY ? event.clientY : (bounds?.top ?? 0);
  return { x, y };
}

function showFeedback(message: string, { x, y }: { x: number; y: number }): void {
  const tooltip = document.createElement('span');
  tooltip.className = 'copy-feedback';
  tooltip.setAttribute('role', 'status');
  tooltip.textContent = message;
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - 100, x + 10))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - 35, y - 28))}px`;
  document.body.append(tooltip);
  window.setTimeout(() => tooltip.remove(), 1250);
}

export async function copyWithFeedback(value: string, event: MouseEvent): Promise<void> {
  event.preventDefault();
  const position = feedbackPosition(event);
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; }
      catch { /* Fall back for browsers without clipboard permission. */ }
    }
    if (!copied) {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('Copy failed');
    }
    showFeedback('copied', position);
  } catch { showFeedback('Could not copy', position); }
}
