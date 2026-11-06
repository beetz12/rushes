// Plain-language helpers for the floating recording bar.

export type BubbleSize = 160 | 200 | 280;
const bubbleSizes: readonly BubbleSize[] = [160, 200, 280];
const bubbleLabels: Record<BubbleSize, string> = { 160: 'S', 200: 'M', 280: 'L' };

/** The next live bubble size, cycling small → medium → large → small. */
export function nextBubbleSize(current: number): BubbleSize {
  const index = bubbleSizes.indexOf(current as BubbleSize);
  return bubbleSizes[(index + 1) % bubbleSizes.length];
}

export function bubbleSizeLabel(size: number): string {
  return bubbleLabels[size as BubbleSize] ?? 'M';
}

const warningText: Record<string, string> = {
  'mic-silent': 'Mic is silent — check your microphone',
  'camera-lost': 'Camera disconnected',
  'camera-warmup-failed': 'Camera did not start',
  'production-effect-unavailable': 'Camera effect is off for this take',
  'ended-early': 'Recording ended early — footage was saved',
};

/** Short bar text for an engine warning; the full message stays in the tooltip. */
export function liveWarningText(code?: string, message?: string): string {
  if (code && warningText[code]) return warningText[code];
  const text = (message || code || 'Recording warning').replace(/^Error: /, '').trim();
  return text.length > 48 ? text.slice(0, 47).trimEnd() + '…' : text;
}

/**
 * Remaining time before the configured limit stops the take, or undefined
 * when there is no limit. Uses recorded media time, which excludes pauses.
 */
export function timeLimitRemainingMs(limitMinutes: number, elapsedMediaMs: number) {
  if (!(limitMinutes > 0)) return undefined;
  return Math.max(0, limitMinutes * 60_000 - Math.max(0, elapsedMediaMs));
}

/** Warn in the last minute, or the last 20% of a short limit. */
export function timeLimitIsNear(limitMinutes: number, elapsedMediaMs: number) {
  const remaining = timeLimitRemainingMs(limitMinutes, elapsedMediaMs);
  if (remaining === undefined) return false;
  return remaining <= Math.min(60_000, limitMinutes * 60_000 * 0.2);
}

/** Meter fill (0…1) for a linear RMS value on a 60 dB scale. */
export function levelFraction(rms: number | undefined): number {
  if (rms === undefined || !Number.isFinite(rms) || rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-3, rms)) + 60) / 60));
}
