export function reviewVideoSources(
  hasScreen: boolean,
  hasCamera: boolean,
  layout: string,
  overlayVisible: boolean,
) {
  const cameraPrimary = hasCamera && (!hasScreen || layout === 'camera-only');
  return {
    cameraPrimary,
    screen: hasScreen && !cameraPrimary,
    camera: hasCamera && (cameraPrimary || (layout !== 'screen-only' && overlayVisible)),
  };
}

/** True while the person had turned the camera off with the live bubble's ×. */
export function cameraOffAt(ranges: unknown, sourceMs: number): boolean {
  if (!Array.isArray(ranges) || !Number.isFinite(sourceMs)) return false;
  return ranges.some(
    (range) =>
      Array.isArray(range) &&
      range.length === 2 &&
      sourceMs >= Number(range[0]) &&
      sourceMs < Number(range[1]),
  );
}

/** Where a recording's camera bubble sits when nothing else says: bottom-left, like the live bubble. */
export const DEFAULT_BUBBLE_CENTER: [number, number] = [0.12, 0.82];
