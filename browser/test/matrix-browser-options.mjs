// Explicit test-browser configuration; never imported by the application.
export function configureMatrixBrowser(options, { platform, sourceMode, browserMode = 'headless', videoBuffer = 'default', videoEncoder = 'default' }) {
  if (!['headless', 'headful'].includes(browserMode)) throw new Error('Matrix browser mode must be headless or headful');
  if (!['default', 'cpu'].includes(videoBuffer)) throw new Error('Matrix video buffer must be default or cpu');
  if (videoBuffer === 'cpu' && (platform !== 'darwin' || sourceMode !== 'native-reference'))
    throw new Error('CPU FileFake buffers require Mac native-reference mode');
  if (!['default', 'software-diagnostic'].includes(videoEncoder)) throw new Error('Unknown matrix video encoder policy');
  if (videoEncoder === 'software-diagnostic' && (platform !== 'win32' || sourceMode !== 'native-reference'
    || browserMode !== 'headful' || videoBuffer !== 'default'))
    throw new Error('Software encoder diagnosis requires headful Windows native-reference with default capture buffers');
  if (videoEncoder === 'default' && options.has('disable-accelerated-video-encode')) throw new Error('Unmarked software encoder flag');
  if (browserMode === 'headful') options.delete('headless');
  if (videoBuffer === 'cpu') options.set('disable-video-capture-use-gpu-memory-buffer', true);
  if (videoEncoder === 'software-diagnostic') options.set('disable-accelerated-video-encode', true);
  return { browserMode, videoBuffer, ...(videoEncoder === 'software-diagnostic' ? { videoEncoder } : {}) };
}
