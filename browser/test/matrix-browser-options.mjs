// Explicit test-browser configuration; never imported by the application.
export function configureMatrixBrowser(options, { platform, sourceMode, browserMode = 'headless', videoBuffer = 'default' }) {
  if (!['headless', 'headful'].includes(browserMode)) throw new Error('Matrix browser mode must be headless or headful');
  if (!['default', 'cpu'].includes(videoBuffer)) throw new Error('Matrix video buffer must be default or cpu');
  if (videoBuffer === 'cpu' && (platform !== 'darwin' || sourceMode !== 'native-reference'))
    throw new Error('CPU FileFake buffers require Mac native-reference mode');
  if (browserMode === 'headful') options.delete('headless');
  if (videoBuffer === 'cpu') options.set('disable-video-capture-use-gpu-memory-buffer', true);
  return { browserMode, videoBuffer };
}
