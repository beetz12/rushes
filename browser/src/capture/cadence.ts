// Admit at most one real frame per nominal cadence bucket. Relative buckets
// tolerate capture-clock jitter without imposing a fresh full interval after
// every admitted timestamp (which would repeatedly discard near-30fps frames).
export function createFrameCadence(fps: number): (timestamp: number) => boolean {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 30) throw new Error('Unsupported composition cadence.');
  let origin: number | undefined;
  let latest = -1;
  return timestamp => {
    if (!Number.isFinite(timestamp)) return false;
    origin ??= timestamp;
    const bucket = Math.round((timestamp - origin) * fps / 1_000_000);
    if (bucket <= latest) return false;
    latest = bucket; return true;
  };
}
