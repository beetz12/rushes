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
