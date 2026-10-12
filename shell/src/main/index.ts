import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  protocol,
  globalShortcut,
  dialog,
  shell,
  clipboard,
  screen,
  safeStorage,
  Notification,
  ClipboardItem,
} from 'electron';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { bubbleForCapture, globalCaptureArea } from '../shared/geometry';
import { EngineSupervisor } from './engine';
import { SharingService } from './sharing';
import { createShareDispatcher } from './share-dispatch';
import { AutoShare, ViewNotifications } from './share-lifecycle';
import { openInEditor, editorArguments } from './editor-handoff';
import { copyVideoFile } from './file-clipboard';
import { videoExportRequest } from '../shared/review-draft';
import { atomicJSON, atomicBytes } from './atomic';
import { OnboardingStore } from './onboarding-store';
import { CameraOverlayLifecycle, recoveredBubbleHidden } from './camera-overlay';
import { openAreaPicker } from './area-picker';
import { startShellServer } from './shell-server';
import { MediaRegistry, parseRange, mimeType } from './media';
import {
  requestSchema,
  windowSchema,
  recordingOptionsSchema,
  cloudSettingsSchema,
  shareCommands,
  defaultOptions,
  type RecordingOptions,
  type CloudSettings,
} from '../shared/contracts';
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rushes-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
const windows = new Map<string, BrowserWindow>();
const media = new MediaRegistry();
const exportedFiles = new Set<string>();
const userDir =
  process.env.RUSHES_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Rushes');
const onboarding = new OnboardingStore(join(userDir, 'onboarding.json'));
const cameraOverlay = new CameraOverlayLifecycle();
let startRequests = 0;
let bubbleSuppressed = false;
let bubbleWrites: Promise<unknown> = Promise.resolve();
let lastBubble = { center: [0.5, 0.5], size: 200, sizeFraction: undefined as number | undefined };
const recordingsRoot = process.env.RUSHES_RECORDINGS_ROOT ?? join(homedir(), 'Movies', 'Rushes');
const enginePath = app.isPackaged
  ? join(process.resourcesPath, 'bin', 'rushcore-engine')
  : (process.env.RUSHES_ENGINE_PATH ?? resolve(__dirname, '../../../.build/debug/rushcore-engine'));
const supervisor = new EngineSupervisor(
  enginePath,
  join(userDir, 'control.sock'),
  recordingsRoot,
  join(userDir, 'index.sqlite'),
);
let options: RecordingOptions = { ...defaultOptions };
let presets: Record<string, RecordingOptions> = {};
let tray: Tray;
let quitting = false;
let state = 'idle';
let currentId: string | undefined;
let automationChild: ChildProcess | undefined;
let engineReady = false;
const pendingURLs: string[] = [];
let promptScript = '';
let promptEnabled = false;
let drawingEnabled = false;
let cloudSettings: CloudSettings = { provider: 'none' };
let cloudGeneration = 0;
let viewNotifications: ViewNotifications | undefined;
const uiFile = join(__dirname, '../renderer/index.html');
const devURL = app.isPackaged
  ? undefined
  : z
      .url()
      .refine((value) => {
        const u = new URL(value);
        return ['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol === 'http:';
      }, 'Development renderer must use local HTTP')
      .optional()
      .parse(process.env.RUSHES_DEV_URL);
const broadcast = (event: Record<string, unknown>) => {
  for (const [view, window] of windows) {
    if (window.isDestroyed()) continue;
    if (
      event.event === 'camera-preview' &&
      (!['bubble', 'recorder'].includes(view) || !window.isVisible())
    )
      continue;
    window.webContents.send('rushes:event', event);
  }
};
function windowFor(view: string, extra: Electron.BrowserWindowConstructorOptions = {}) {
  const old = windows.get(view);
  if (old && !old.isDestroyed()) {
    old.show();
    old.focus();
    return old;
  }
  const compact = ['bar', 'bubble', 'area', 'teleprompter', 'drawing', 'drawing-tools'].includes(
    view,
  );
  const w = new BrowserWindow({
    width: view === 'bar' ? 800 : 1120,
    height: view === 'bar' ? 104 : 780,
    minWidth: view === 'bubble' ? 1 : compact ? 100 : 800,
    minHeight: view === 'bubble' ? 1 : compact ? 60 : 600,
    show: false,
    title: view === 'drawing' ? 'Rushes Drawing' : 'Rushes',
    backgroundColor: '#f7f8fa',
    titleBarStyle: compact ? 'default' : 'hiddenInset',
    frame: !compact,
    alwaysOnTop: compact,
    transparent: ['bubble', 'area', 'drawing', 'teleprompter'].includes(view),
    resizable: !compact,
    skipTaskbar: compact,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    ...extra,
  });
  windows.set(view, w);
  if (compact) {
    w.setContentProtection(view !== 'drawing');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setAlwaysOnTop(true, 'floating');
  }
  if (view === 'drawing') w.on('page-title-updated', (event) => event.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  let crashRestarts = 0;
  w.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting && details.reason !== 'clean-exit' && ++crashRestarts <= 3)
      w.webContents.reload();
  });
  w.on('closed', () => {
    if (windows.get(view) === w) windows.delete(view);
    if (view === 'recorder' && !captureBusy())
      void hideCameraBubble().catch((error) =>
        broadcast({ event: 'warning', message: String(error) }),
      );
    if (view === 'drawing' && drawingEnabled)
      void hideDrawing().catch((error) => broadcast({ event: 'warning', message: String(error) }));
  });
  if (view === 'recorder')
    w.on('hide', () => {
      if (!captureBusy())
        void hideCameraBubble().catch((error) =>
          broadcast({ event: 'warning', message: String(error) }),
        );
    });
  if (view === 'bubble' || view === 'bar') w.on('moved', () => rememberPosition(view, w));
  w.once('ready-to-show', () => {
    if (quitting || w.isDestroyed() || windows.get(view) !== w) return;
    if (['bubble', 'bar', 'teleprompter', 'drawing', 'drawing-tools'].includes(view))
      w.showInactive();
    else w.show();
  });
  const url = devURL ? `${devURL}/#${view}` : `${pathToFileURL(uiFile).toString()}#${view}`;
  void w.loadURL(url);
  return w;
}
function startAutomationHost() {
  if (
    !app.isPackaged ||
    process.env.RUSHES_SMOKE === '1' ||
    process.env.RUSHES_TEST_ENGINE_STUB === '1' ||
    automationChild
  )
    return;
  const executable = join(
    process.resourcesPath,
    '..',
    'Helpers',
    'RushesAutomation.app',
    'Contents',
    'MacOS',
    'RushesAutomation',
  );
  const child = spawn(executable, [], { stdio: ['ignore', 'ignore', 'pipe'] });
  automationChild = child;
  let warned = false;
  child.stderr?.on('data', () => {
    if (!warned) {
      warned = true;
      console.warn('[Rushes] Automation helper reported a diagnostic.');
    }
  });
  child.once('error', () => {
    if (automationChild === child) automationChild = undefined;
    broadcast({
      event: 'warning',
      code: 'automation-unavailable',
      message: 'Shortcuts support could not start. Reopen Rushes to retry.',
    });
  });
  child.once('exit', () => {
    if (automationChild === child) automationChild = undefined;
    if (!quitting)
      broadcast({
        event: 'warning',
        code: 'automation-stopped',
        message: 'Shortcuts support stopped. Reopen Rushes to reconnect.',
      });
  });
}
async function routeURL(url: string) {
  if (!engineReady) {
    pendingURLs.push(url);
    return;
  }
  try {
    await supervisor.client.request('url.open', { url });
    const live = await supervisor.client.request('status');
    state = live.state;
    if (['recording', 'paused', 'preparing'].includes(state)) bar();
    broadcast({ event: 'url-opened' });
  } catch (error) {
    windowFor('recorder');
    broadcast({ event: 'error', message: (error as Error).message });
  }
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  void routeURL(url);
});
async function showTeleprompter() {
  const config = await supervisor.client.request('teleprompter.get');
  promptScript = String(config.script ?? '');
  promptEnabled = config.enabled === true;
  if (!promptEnabled || !promptScript.trim())
    throw new Error('Save and enable a teleprompter script in Settings first.');
  await supervisor.client.request('teleprompter.start');
  const display = screen.getPrimaryDisplay().bounds;
  windowFor('teleprompter', {
    width: 600,
    height: 160,
    x: Math.round(display.x + (display.width - 600) / 2),
    y: display.y + 28,
    backgroundColor: '#00000000',
    focusable: false,
  });
}
async function hideDrawing() {
  drawingEnabled = false;
  await supervisor.client.request('drawing.hide').catch((error) => {
    if (supervisor.active) throw error;
  });
  windows.get('drawing')?.close();
  windows.get('drawing-tools')?.close();
}
async function showDrawing() {
  if (!supervisor.active || !currentId)
    throw new Error('Start a display or area recording before drawing.');
  const take = await supervisor.client.request('show', { id: currentId });
  if (!['display', 'area'].includes(take.manifest.sources?.mode))
    throw new Error('Drawing is available for display and area recordings.');
  const sourceId = take.manifest.sources?.displayId;
  const display =
    screen.getAllDisplays().find((item) => `display-${item.id}` === sourceId) ??
    screen.getPrimaryDisplay();
  const overlay = windowFor('drawing', {
    ...display.bounds,
    backgroundColor: '#00000000',
    focusable: true,
  });
  if (overlay.webContents.isLoading())
    await new Promise<void>((resolve) => overlay.webContents.once('did-finish-load', resolve));
  overlay.setTitle('Rushes Drawing');
  let candidate;
  for (let attempt = 0; attempt < 8; attempt++) {
    const targets = await supervisor.client.request('targets');
    candidate = targets.windows.find(
      (item: any) =>
        item.title === 'Rushes Drawing' && item.owningApplication === 'com.nexai.rushes',
    );
    if (candidate) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!candidate) {
    overlay.close();
    throw new Error('The native engine cannot identify the signed Rushes drawing window.');
  }
  try {
    await supervisor.client.request('drawing.show', { windowID: candidate.id });
    drawingEnabled = true;
    windowFor('drawing-tools', {
      width: 640,
      height: 88,
      x: display.workArea.x + 24,
      y: display.workArea.y + 24,
      focusable: true,
    });
  } catch (error) {
    overlay.close();
    throw error;
  }
}
function guard(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new Error('Untrusted IPC frame');
  const known = [...windows.values()].some((w) => w.webContents === event.sender);
  const url = new URL(frame.url);
  if (
    !known ||
    (devURL ? url.origin !== new URL(devURL).origin : decodeURIComponent(url.pathname) !== uiFile)
  )
    throw new Error('Untrusted IPC sender');
}
function handle(name: string, fn: (value: any) => any) {
  ipcMain.handle(name, async (event, value) => {
    guard(event);
    try {
      return await fn(value);
    } catch (error) {
      return {
        __rushesError: {
          code: typeof (error as any).code === 'string' ? (error as any).code : 'ipc-error',
          message: (error as Error).message ?? String(error),
        },
      };
    }
  });
}
const positionTimers = new Map<string, NodeJS.Timeout>();
let bubbleTimer: NodeJS.Timeout | undefined;
function placement(view: 'bubble' | 'bar', width: number, height: number) {
  const anchor = view === 'bubble' ? options.bubbleAnchor : options.barAnchor;
  const d =
      screen.getAllDisplays().find((d) => d.id === anchor?.displayId) ?? screen.getPrimaryDisplay(),
    bounds = d.workArea;
  const x = anchor
    ? anchor.horizontal === 'left'
      ? bounds.x + anchor.x
      : bounds.x + bounds.width - width - anchor.x
    : view === 'bubble'
      ? bounds.x + 32
      : bounds.x + (bounds.width - width) / 2;
  const y = anchor
    ? anchor.vertical === 'top'
      ? bounds.y + anchor.y
      : bounds.y + bounds.height - height - anchor.y
    : view === 'bubble'
      ? bounds.y + bounds.height - height - 160
      : bounds.y + bounds.height - height - 26;
  return {
    x: Math.round(Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width))),
    y: Math.round(Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height))),
  };
}
async function syncBubble() {
  const w = windows.get('bubble');
  if (!w || w.isDestroyed() || !supervisor.active) return;
  const capture = await supervisor.client.request('record.geometry');
  if (w.isDestroyed() || !supervisor.active) return;
  const current = w.getBounds();
  const geometry = bubbleForCapture(
    { x: current.x, y: current.y, size: options.bubbleSize },
    capture?.rect,
  );
  if (!geometry) return;
  if (
    ['x', 'y', 'width', 'height'].some(
      (key) =>
        current[key as keyof typeof current] !==
        geometry.bounds[key as keyof typeof geometry.bounds],
    )
  )
    w.setBounds(geometry.bounds);
  lastBubble = {
    center: geometry.center,
    size: options.bubbleSize,
    sizeFraction: geometry.sizeFraction,
  };
  const id = currentId;
  await queueBubbleWrite(async () => {
    if (
      w.isDestroyed() ||
      windows.get('bubble') !== w ||
      !supervisor.active ||
      bubbleSuppressed ||
      currentId !== id
    )
      return;
    await supervisor.client.request('record.bubble', { ...lastBubble, visible: true });
  });
}
function captureBusy() {
  return supervisor.active || startRequests > 0;
}
function queueBubbleWrite(write: () => Promise<void>) {
  const next = bubbleWrites.catch(() => {}).then(write);
  bubbleWrites = next;
  return next;
}
async function hideCameraBubble() {
  const generation = cameraOverlay.hide();
  const busy = captureBusy();
  const id = currentId;
  if (busy) bubbleSuppressed = true;
  windows.get('bubble')?.close();
  broadcast({ event: 'camera-preview-cleared' });
  await supervisor.client.request('camera.preview.subscribe', { enabled: false });
  if (busy) {
    await queueBubbleWrite(async () => {
      if (supervisor.active && currentId === id && cameraOverlay.sameGeneration(generation))
        await supervisor.client.request('record.bubble', { ...lastBubble, visible: false });
    });
  } else if (!captureBusy() && cameraOverlay.sameGeneration(generation)) {
    await supervisor.client.request('camera.preview.stop');
  }
}
function rememberPosition(view: 'bubble' | 'bar', w: BrowserWindow) {
  const bounds = w.getBounds(),
    display = screen.getDisplayMatching(bounds),
    d = display.workArea;
  const left = Math.max(0, bounds.x - d.x),
    right = Math.max(0, d.x + d.width - bounds.x - bounds.width),
    top = Math.max(0, bounds.y - d.y),
    bottom = Math.max(0, d.y + d.height - bounds.y - bounds.height);
  const anchor = {
    displayId: display.id,
    horizontal: left <= right ? 'left' : 'right',
    vertical: top <= bottom ? 'top' : 'bottom',
    x: Math.min(left, right),
    y: Math.min(top, bottom),
  } as const;
  options = { ...options, [view === 'bubble' ? 'bubbleAnchor' : 'barAnchor']: anchor };
  broadcast({ event: 'window-anchor', view, anchor });
  clearTimeout(positionTimers.get(view));
  positionTimers.set(
    view,
    setTimeout(
      () =>
        void writeOptions().catch((error) => broadcast({ event: 'error', message: String(error) })),
      300,
    ),
  );
  if (view === 'bubble' && supervisor.active) {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(
      () =>
        void syncBubble().catch((error) => broadcast({ event: 'warning', message: String(error) })),
      100,
    );
  }
}
function bar() {
  return windowFor('bar', { ...placement('bar', 800, 104), focusable: false });
}
function bubble() {
  return windowFor('bubble', {
    width: options.bubbleSize,
    height: options.bubbleSize,
    ...placement('bubble', options.bubbleSize, options.bubbleSize),
    focusable: false,
    backgroundColor: '#00000000',
  });
}
function showRecordingBubble(id: string) {
  if (bubbleSuppressed) return;
  return cameraOverlay
    .showWhenReady(
      async (current) => {
        const show = await supervisor.client.request('show', { id });
        if (
          !show.manifest.sources?.cameraId ||
          !current() ||
          currentId !== id ||
          !supervisor.active
        )
          return false;
        await supervisor.client.request('camera.preview.subscribe', { enabled: true });
        return current() && currentId === id && supervisor.active;
      },
      (hasCamera) => {
        if (hasCamera && !quitting && !bubbleSuppressed && currentId === id && supervisor.active) {
          bubble();
          void syncBubble().catch((error) =>
            broadcast({ event: 'warning', message: String(error) }),
          );
        }
      },
    )
    .catch((error) => broadcast({ event: 'warning', message: String(error) }));
}
async function requestControl(cmd: string, args: Record<string, unknown> = {}) {
  try {
    if (cmd === 'record.stop') await syncBubble();
    return await supervisor.client.request(cmd, args);
  } catch (error) {
    broadcast({ event: 'error', message: String(error), code: (error as { code?: string })?.code });
  }
}
function trayUpdate() {
  if (!tray) return;
  tray.setToolTip(state === 'idle' ? 'Rushes — ready to record' : `Rushes — ${state}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: state === 'idle' ? 'New recording' : 'Stop recording',
        click: () => {
          if (state === 'idle') windowFor('recorder');
          else void requestControl('record.stop');
        },
      },
      { label: 'My recordings', click: () => windowFor('library') },
      { label: 'Settings', click: () => windowFor('settings') },
      { type: 'separator' },
      { label: 'Quit Rushes', click: () => app.quit() },
    ]),
  );
}
async function readCloud() {
  try {
    const raw = await readFile(join(userDir, 'credentials.enc'));
    if (safeStorage.isEncryptionAvailable())
      cloudSettings = cloudSettingsSchema.parse(JSON.parse(safeStorage.decryptString(raw)));
  } catch {}
}
async function provider() {
  const settings = cloudSettings;
  if (settings.provider === 'none') throw new Error('Configure sharing in Settings first.');
  const sdkPath = app.isPackaged
    ? join(process.resourcesPath, 'cloud', 'index.js')
    : resolve(__dirname, '../../../cloud/dist/index.js');
  const sdk = await import(pathToFileURL(sdkPath).toString());
  const store = new sdk.JsonJobStore(join(userDir, 'share-jobs'));
  if (settings.provider === 'worker') return new sdk.WorkerProvider(settings, { store });
  const assetsDir = app.isPackaged
    ? join(process.resourcesPath, 'viewer')
    : resolve(__dirname, '../../../viewer/dist');
  const js = await readFile(join(assetsDir, 'viewer.js'), 'utf8');
  const css = await readFile(join(assetsDir, 'viewer.css'), 'utf8');
  return new sdk.BucketProvider(settings, { store, viewerAssets: { js, css } });
}
function configurationSummary(settings: CloudSettings) {
  return {
    provider: settings.provider,
    configured: settings.provider !== 'none',
    encrypted: safeStorage.isEncryptionAvailable(),
    ...(settings.provider === 'worker'
      ? { endpoint: settings.workerURL, accountId: settings.accountId }
      : settings.provider === 'bucket'
        ? { endpoint: settings.endpoint }
        : {}),
  };
}
async function persistedCloudSummary() {
  if (!safeStorage.isEncryptionAvailable())
    return { provider: 'none', configured: false, encrypted: false };
  try {
    const raw = await readFile(join(userDir, 'credentials.enc'));
    const saved = cloudSettingsSchema.parse(JSON.parse(safeStorage.decryptString(raw)));
    return configurationSummary(saved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { provider: 'none', configured: false, encrypted: true };
    throw e;
  }
}
async function saveCloud(value: unknown) {
  const parsed = cloudSettingsSchema.parse(value);
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('macOS secure credential storage is unavailable. Credentials were not saved.');
  await atomicBytes(
    join(userDir, 'credentials.enc'),
    safeStorage.encryptString(JSON.stringify(parsed)),
  );
  cloudSettings = parsed;
  cloudGeneration++;
  if (engineReady) void viewNotifications?.poll();
  const summary = {
    provider: parsed.provider,
    configured: parsed.provider !== 'none',
    encrypted: true,
    ...(parsed.provider === 'worker'
      ? { endpoint: parsed.workerURL, accountId: parsed.accountId }
      : parsed.provider === 'bucket'
        ? { endpoint: parsed.endpoint }
        : {}),
  };
  broadcast({ event: 'share-configured', ...summary });
  return summary;
}
async function writeOptions() {
  await atomicJSON(join(userDir, 'settings.json'), options);
}
async function ready() {
  await mkdir(userDir, { recursive: true, mode: 0o700 });
  await mkdir(recordingsRoot, { recursive: true });
  await media.allowRoot(recordingsRoot);
  try {
    options = recordingOptionsSchema.parse(
      JSON.parse(await readFile(join(userDir, 'settings.json'), 'utf8')),
    );
  } catch {}
  try {
    presets = z
      .record(z.string(), recordingOptionsSchema)
      .parse(JSON.parse(await readFile(join(userDir, 'presets.json'), 'utf8')));
  } catch {}
  await readCloud();
  protocol.handle('rushes-media', async (request) => {
    const path = media.get(request.url);
    if (!path) return new Response('Not found', { status: 404 });
    try {
      const info = await stat(path);
      let range;
      try {
        range = parseRange(request.headers.get('range'), info.size);
      } catch {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      }
      const start = range?.start ?? 0,
        end = range?.end ?? info.size - 1;
      const headers: Record<string, string> = {
        'Content-Type': mimeType(path),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'private,no-store',
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      return new Response(Readable.toWeb(createReadStream(path, { start, end })) as BodyInit, {
        status: range ? 206 : 200,
        headers,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAPUlEQVQ4T2NkoDJgpLJ5DKMGUhAGfAAYGDAwMPwHA/HMQA3DwMAAU4yBAQZGUYzM4BmGMBjOgO8ApoPh0B4Av3wEHzo1FWAAAAAASUVORK5CYII=',
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => {
    if (state === 'idle') windowFor('recorder');
    else void requestControl('record.stop');
  });
  trayUpdate();
  app.dock?.hide();
  if (app.isPackaged) app.setAsDefaultProtocolClient('rushes');
  handle('rushes:bootstrap', () => ({ options, enginePath, packaged: app.isPackaged }));
  handle('rushes:onboarding', async (value) => {
    const result = await onboarding.action(value);
    if (value !== 'get') {
      broadcast({ event: 'onboarding-changed', action: value, ...result });
      if (value === 'reset') windowFor('recorder');
    }
    return result;
  });
  handle('rushes:request', async (value) => {
    const request = requestSchema.parse(value);
    if (JSON.stringify(request.args).length > 2 * 1024 * 1024) throw new Error('Request too large');
    if (
      ['export', 'thumbnail', 'captions.export', 'chapters.export', 'diagnostics'].includes(
        request.cmd,
      )
    )
      throw new Error('Use the native save dialog for file output');
    if (request.cmd === 'camera.preview.start' && supervisor.active) {
      bubbleSuppressed = false;
      return cameraOverlay.showWhenReady(
        async (current) => {
          const live = await supervisor.client.request('status');
          const id = currentId ?? live.recording?.recordingID;
          if (!id || !supervisor.active || !current())
            throw new Error('The active take is no longer available for camera preview.');
          const take = await supervisor.client.request('show', { id });
          const camera = take.manifest.sources?.cameraId;
          if (!camera) throw new Error('This take has no camera track.');
          if (request.args.camera !== 'default' && request.args.camera !== camera)
            throw new Error('Keep the active recording camera selected until this take finishes.');
          if (!current() || !supervisor.active || currentId !== id) return;
          return supervisor.client.request('camera.preview.subscribe', { enabled: true });
        },
        () => {
          if (!quitting && supervisor.active) {
            bubble();
            void syncBubble();
          }
        },
      );
    }
    if (request.cmd === 'camera.preview.stop') return hideCameraBubble();
    if (request.cmd === 'camera.preview.start') {
      return cameraOverlay.showWhenReady(
        () => supervisor.client.request(request.cmd, request.args),
        () => {
          if (!quitting && !captureBusy() && windows.get('recorder')?.isVisible()) bubble();
        },
      );
    }
    if (request.cmd === 'record.stop') await syncBubble();
    if (request.cmd === 'camera.blur.set' && request.args.enabled === true)
      broadcast({ event: 'camera-preview-cleared' });
    if (request.cmd === 'record.start') {
      startRequests++;
      bubbleSuppressed = false;
      cameraOverlay.hide();
      windows.get('bubble')?.close();
    }
    let result;
    try {
      result = await supervisor.client.request(request.cmd, request.args);
    } finally {
      if (request.cmd === 'record.start') startRequests--;
    }
    if (request.cmd === 'permissions.settings' && result.url) {
      const u = new URL(result.url);
      if (u.protocol === 'x-apple.systempreferences:') await shell.openExternal(result.url);
    }
    if (request.cmd === 'teleprompter.set') {
      promptScript = String(request.args.script ?? '');
      promptEnabled = request.args.enabled === true;
      broadcast({ event: 'teleprompter-config', script: promptScript, enabled: promptEnabled });
      if (!promptEnabled) windows.get('teleprompter')?.close();
    }
    if (request.cmd === 'record.start') {
      windows.get('recorder')?.hide();
      bar();
    }
    return result;
  });
  handle('rushes:presets', async (value) => {
    const v = z
      .object({
        action: z.enum(['list', 'save', 'delete']),
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .refine((n) => !['__proto__', 'prototype', 'constructor'].includes(n))
          .optional(),
        options: recordingOptionsSchema.optional(),
      })
      .strict()
      .parse(value);
    if (v.action === 'save') {
      if (!v.name || !v.options) throw new Error('A preset needs a name and recording options');
      presets[v.name] = v.options;
    }
    if (v.action === 'delete' && v.name) delete presets[v.name];
    if (v.action !== 'list') await atomicJSON(join(userDir, 'presets.json'), presets);
    return presets;
  });
  handle('rushes:save-options', async (value) => {
    const next = recordingOptionsSchema.parse(value);
    if (next.editorCommandTemplate.trim()) editorArguments(next.editorCommandTemplate);
    options = next;
    await writeOptions();
  });
  handle('rushes:select-area', async (value) => {
    const local = z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict()
      .parse(value);
    const selector = windows.get('area');
    if (!selector || selector.isDestroyed()) throw new Error('Open the area selector first.');
    const bounds = selector.getContentBounds();
    const area = globalCaptureArea(local, bounds);
    if (!area) throw new Error('Select an area inside the display.');
    const source = `display-${screen.getDisplayMatching(bounds).id}`;
    options = { ...options, mode: 'area', source, area };
    await writeOptions();
    broadcast({ event: 'area-selected', area, source });
    selector.close();
  });
  handle('rushes:media', async (value) => media.allowFile(z.string().max(4000).parse(value)));
  handle('rushes:reveal', async (value) => {
    const path = z.string().parse(value);
    if (!exportedFiles.has(path)) {
      await media.allowFile(path);
    }
    shell.showItemInFolder(path);
  });
  handle('rushes:confirm', async (value) => {
    const message = z.string().max(500).parse(value);
    const r = await dialog.showMessageBox({
      type: 'question',
      message,
      buttons: ['Cancel', 'Continue'],
      defaultId: 0,
      cancelId: 0,
    });
    return r.response === 1;
  });
  handle('rushes:window', async (value) => {
    const v = windowSchema.parse(value);
    switch (v.action) {
      case 'library':
      case 'settings':
      case 'recorder':
        windowFor(v.action);
        return;
      case 'drawing':
        return showDrawing();
      case 'drawing-hide':
        return hideDrawing();
      case 'teleprompter':
        return showTeleprompter();
      case 'close':
        return windows.get('recorder')?.hide();
      case 'hide-bubble':
        return hideCameraBubble();
      case 'area': {
        if (captureBusy()) throw new Error('Stop the recording before selecting an area.');
        const existing = windows.get('area');
        if (existing && !existing.isDestroyed()) {
          existing.show();
          existing.focus();
          return;
        }
        const selected =
          screen.getAllDisplays().find((d) => `display-${d.id}` === options.source) ??
          screen.getPrimaryDisplay();
        const recorder = windows.get('recorder');
        openAreaPicker(
          selected.bounds,
          (config) => windowFor('area', config),
          recorder,
          () => !quitting && !captureBusy() && windows.get('recorder') === recorder,
        );
        return;
      }
      case 'cancel-area':
        windows.get('area')?.close();
        return;
      case 'bubble-size':
        options = recordingOptionsSchema.parse({ ...options, bubbleSize: v.value });
        windows.get('bubble')?.setSize(options.bubbleSize, options.bubbleSize);
        await writeOptions();
        if (supervisor.active) await syncBubble();
        return;
      case 'move-bubble': {
        const w = windows.get('bubble');
        if (w && v.x !== undefined && v.y !== undefined) {
          const b = screen.getDisplayNearestPoint({ x: v.x, y: v.y }).workArea;
          w.setPosition(
            Math.max(b.x, Math.min(v.x, b.x + b.width - options.bubbleSize)),
            Math.max(b.y, Math.min(v.y, b.y + b.height - options.bubbleSize)),
          );
        }
        return;
      }
      case 'relaunch':
        app.relaunch();
        app.quit();
        return;
      case 'acknowledgements':
        await shell.openPath(
          app.isPackaged
            ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md')
            : resolve(__dirname, '../../../THIRD_PARTY_NOTICES.md'),
        );
        return;
      case 'quit':
        app.quit();
        return;
    }
  });
  handle('rushes:copy-text', (value) => clipboard.writeText(z.string().max(20000).parse(value)));
  handle('rushes:drawing', async (value) => {
    const v = z
      .object({
        action: z.enum(['tool', 'undo', 'clear', 'pause']),
        tool: z.enum(['pen', 'highlighter', 'arrow', 'rectangle']).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        paused: z.boolean().optional(),
      })
      .strict()
      .parse(value);
    if (v.action === 'pause')
      windows.get('drawing')?.setIgnoreMouseEvents(v.paused === true, { forward: true });
    broadcast({ event: 'drawing-action', ...v });
  });
  const previewFile = async (value: unknown) => {
    const id = z.string().min(1).max(200).parse(value);
    const show = await supervisor.client.request('show', { id });
    const path = join(show.packagePath, 'renders', 'preview.mp4');
    await mkdir(dirname(path), { recursive: true });
    const result = await supervisor.client.request(
      'export',
      { id, preset: 'share', path },
      30 * 60 * 1000,
    );
    const url = await media.allowFile(path);
    return { ...result, url, path };
  };
  handle('rushes:preview-file', previewFile);
  handle('rushes:copy-video-file', async (value) => {
    const preview = await previewFile(value);
    return copyVideoFile(preview.path, (path) => media.allowFile(path), {
      write: (formats) => clipboard.write([new ClipboardItem(formats)]),
    });
  });
  const exportFile = async (value: unknown) => {
    const v = z
      .object({
        id: z.string().min(1).max(200),
        preset: z.enum([
          'share',
          'full',
          'youtube',
          'youtube-source',
          'audio',
          'audio-wav',
          'editor-tracks',
          'srt',
          'vtt',
          'txt',
          'thumbnail',
          'diagnostics',
          'chapters',
        ]),
        atMs: z.number().nonnegative().optional(),
      })
      .parse(value);
    const extension =
      v.preset === 'chapters'
        ? 'txt'
        : v.preset === 'audio-wav'
          ? 'wav'
          : v.preset === 'audio'
            ? 'm4a'
            : v.preset === 'full'
              ? 'mov'
              : v.preset === 'thumbnail'
                ? 'png'
                : ['srt', 'vtt', 'txt'].includes(v.preset)
                  ? v.preset
                  : v.preset === 'diagnostics'
                    ? 'zip'
                    : 'mp4';
    let path: string | undefined;
    if (v.preset === 'editor-tracks') {
      const d = await dialog.showOpenDialog({
        title: 'Export raw original tracks',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!d.canceled) path = join(d.filePaths[0], `Rushes-${v.id}`);
    } else {
      const d = await dialog.showSaveDialog({
        title: 'Export recording',
        defaultPath: `Rushes-${v.id}.${extension}`,
        filters: [{ name: 'Media', extensions: [extension] }],
      });
      if (!d.canceled) path = d.filePath;
    }
    if (!path) return { canceled: true };
    let result;
    if (['srt', 'vtt', 'txt'].includes(v.preset))
      result = await supervisor.client.request('captions.export', {
        id: v.id,
        format: v.preset,
        outputPath: path,
      });
    else if (v.preset === 'chapters')
      result = await supervisor.client.request('chapters.export', { id: v.id, outputPath: path });
    else if (v.preset === 'thumbnail')
      result = await supervisor.client.request('thumbnail', {
        id: v.id,
        path,
        width: 1280,
        height: 720,
        atMs: v.atMs ?? 0,
      });
    else if (v.preset === 'diagnostics')
      result = await supervisor.client.request('diagnostics', { id: v.id, path });
    else
      result = await supervisor.client.request(
        'export',
        videoExportRequest(v.id, v.preset, path),
        30 * 60 * 1000,
      );
    exportedFiles.add(path);
    return { ...result, path };
  };
  handle('rushes:export-file', exportFile);
  handle('rushes:open-editor', (value) =>
    openInEditor(z.string().min(1).max(200).parse(value), options.editorCommandTemplate, {
      show: (id) => supervisor.client.request('show', { id }),
      storageRoot: recordingsRoot,
      exportTracks: (id) => exportFile({ id, preset: 'editor-tracks' }),
      reveal: (path) => shell.showItemInFolder(path),
      launch: (executable, args) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(executable, args, { shell: false, detached: true, stdio: 'ignore' });
          child.once('error', () =>
            reject(
              Object.assign(
                new Error('The editor command could not start. Check its executable in Settings.'),
                { code: 'editor-launch-failed' },
              ),
            ),
          );
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
          child.once('exit', (code) => {
            if (code !== null && code !== 0)
              broadcast({
                event: 'warning',
                code: 'editor-command-failed',
                message: `The editor command exited with code ${code}. Check its arguments in Settings.`,
              });
          });
        }),
    }),
  );
  handle('rushes:cloud-settings', () => ({
    provider: cloudSettings.provider,
    configured: cloudSettings.provider !== 'none',
    encrypted: safeStorage.isEncryptionAvailable(),
    ...(cloudSettings.provider === 'bucket'
      ? { publicBaseURL: cloudSettings.publicBaseURL }
      : cloudSettings.provider === 'worker'
        ? { workerURL: cloudSettings.workerURL }
        : {}),
  }));
  handle('rushes:save-cloud', saveCloud);
  handle('rushes:test-cloud', async () => {
    const p = await provider();
    return p.setupCheck();
  });
  handle('rushes:copy-link', async (value) => {
    const url = z.url().parse(value);
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Invalid link');
    await clipboard.writeText(url);
  });
  const desktopNotification = (title: string, body: string) => {
    if (!quitting && Notification.isSupported()) new Notification({ title, body }).show();
  };
  const shareEvent = (event: Record<string, unknown>) => {
    broadcast(event);
    if (event.event === 'share-progress' && event.state === 'failed')
      desktopNotification(
        'Sharing needs a retry',
        'Your recording is kept on this Mac. Use Copy share link to retry.',
      );
    if (event.event === 'share-progress' && event.state === 'ready') void viewNotifications?.poll();
    if (event.event === 'share-link-copied')
      desktopNotification('Share link copied', 'The video is being prepared in the background.');
    if (event.code === 'auto-share-failed')
      desktopNotification('Automatic sharing failed', String(event.message));
  };
  const shares = new SharingService(
    supervisor.client,
    provider,
    () =>
      cloudSettings.provider === 'bucket'
        ? `bucket:${cloudSettings.endpoint}/${cloudSettings.bucket}`
        : cloudSettings.provider === 'worker'
          ? `worker:${cloudSettings.workerURL}`
          : 'none',
    shareEvent,
    () => cloudGeneration,
  );
  handle('rushes:share', async (value) => {
    const result = await shares.share(z.string().min(1).max(200).parse(value));
    await clipboard.writeText(result.url);
    return result;
  });
  const dispatchShare = createShareDispatcher(shares, {
    configuration: persistedCloudSummary,
    configure: saveCloud,
    setup: async () => (await provider()).setupCheck(),
    copy: async (url) => {
      await clipboard.writeText(url);
      void viewNotifications?.poll();
    },
  });
  handle('rushes:share-command', (value) => {
    const request = z
      .object({ cmd: z.enum(shareCommands), args: z.record(z.string(), z.json()).default({}) })
      .strict()
      .parse(value);
    return dispatchShare(request.cmd, request.args);
  });
  await startShellServer(join(userDir, 'shell.sock'), dispatchShare);
  const autoShare = new AutoShare(
    (id) => shares.share(id),
    (url) => clipboard.writeText(url),
    shareEvent,
  );
  viewNotifications = new ViewNotifications(
    () => shares.feedbackSnapshots(),
    broadcast,
    desktopNotification,
  );
  supervisor.client.on('event', async (e) => {
    broadcast(e);
    if (e.event === 'recording-started') {
      state = 'recording';
      currentId = e.recordingId;
      bar();
      if (promptEnabled)
        void showTeleprompter().catch((error) =>
          broadcast({ event: 'warning', message: String(error) }),
        );
      const id = currentId;
      if (!bubbleSuppressed && typeof id === 'string') void showRecordingBubble(id);
      else
        void queueBubbleWrite(async () => {
          if (currentId === id && supervisor.active)
            await supervisor.client.request('record.bubble', { ...lastBubble, visible: false });
        }).catch((error) => broadcast({ event: 'warning', message: String(error) }));
      void syncBubble().catch((error) => broadcast({ event: 'warning', message: String(error) }));
    }
    if (e.event === 'engine-reconnected' && !quitting) {
      const recoveredId = e.status?.recording?.recordingID;
      bubbleSuppressed = recoveredBubbleHidden(currentId, recoveredId, e.state, bubbleSuppressed);
      if (recoveredId !== currentId || e.state === 'idle' || e.state === 'preparing') {
        cameraOverlay.hide();
      }
      state = e.state;
      currentId = recoveredId;
      if (supervisor.active) {
        bar();
        if (typeof currentId === 'string') void showRecordingBubble(currentId);
      } else {
        cameraOverlay.hide();
        windows.get('bar')?.close();
        windows.get('bubble')?.close();
        windows.get('teleprompter')?.close();
        void hideDrawing().catch(() => {});
        broadcast({ event: 'camera-preview-cleared' });
      }
    }
    if (e.event === 'state-changed' && typeof e.state === 'string') {
      if (cameraOverlay.newTake(state, e.state)) {
        if (startRequests === 0) bubbleSuppressed = false;
        windows.get('bubble')?.close();
      }
      if (e.state === 'armed' && typeof e.recordingId === 'string') currentId = e.recordingId;
      state = e.state;
    }
    if (e.event === 'recording-stopped') {
      const stoppedId = e.recordingId ?? currentId;
      if (typeof stoppedId === 'string')
        void autoShare.recordingStopped(stoppedId, options.autoShare);
      state = 'idle';
      cameraOverlay.hide();
      bubbleSuppressed = false;
      broadcast({ event: 'camera-preview-cleared' });
      void hideDrawing().catch(() => {});
      windows.get('teleprompter')?.close();
      windows.get('bar')?.close();
      windows.get('bubble')?.close();
      void supervisor.client.request('camera.preview.stop').catch(() => {});
      const library = windowFor('library');
      const openReview = () =>
        library.webContents.send('rushes:event', {
          event: 'open-recording',
          id: e.recordingId ?? currentId,
        });
      if (library.webContents.isLoading())
        library.webContents.once('did-finish-load', () => setTimeout(openReview, 100));
      else openReview();
      currentId = undefined;
    }
    trayUpdate();
  });
  supervisor.client.on('engine-error', (e) => broadcast({ event: 'error', ...e }));
  supervisor.client.on('disconnected', () => {
    cameraOverlay.hide();
    windows.get('bubble')?.close();
    broadcast({ event: 'camera-preview-cleared' });
    broadcast({
      event: 'error',
      code: 'engine-disconnected',
      message: 'Native engine disconnected. Relaunch Rushes to reconnect.',
    });
  });
  try {
    await supervisor.start();
    engineReady = true;
    startAutomationHost();
    for (const url of pendingURLs.splice(0)) void routeURL(url);
    const live = await supervisor.client.request('status');
    state = live.state;
    supervisor.active = ['recording', 'paused', 'preparing', 'finishing'].includes(state);
    const prompt = await supervisor.client.request('teleprompter.get').catch(() => undefined);
    if (prompt) {
      promptScript = prompt.script ?? '';
      promptEnabled = prompt.enabled === true;
    }
    if (supervisor.active) {
      currentId = live.recording?.recordingID;
      bar();
      if (promptEnabled) void showTeleprompter().catch(() => {});
    }
    broadcast({ event: 'engine-ready' });
    viewNotifications.start();
    if (cloudSettings.provider !== 'none')
      void shares
        .resumePending()
        .catch((error) =>
          broadcast({ event: 'warning', code: 'share-resume-failed', message: String(error) }),
        );
    trayUpdate();
  } catch (error) {
    broadcast({ event: 'error', message: String(error) });
    void dialog.showMessageBox({
      type: 'error',
      message: 'The native recording engine could not start.',
      detail: `${String(error)}\nEngine: ${enginePath}`,
    });
  }
  screen.on('display-metrics-changed', () => {
    for (const view of ['bubble', 'bar'] as const) {
      const w = windows.get(view);
      if (w && !w.isDestroyed()) {
        const bounds = w.getBounds(),
          p = placement(view, bounds.width, bounds.height);
        w.setPosition(p.x, p.y);
      }
    }
  });
  windowFor('recorder');
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (state === 'idle') {
      const recorder = windowFor('recorder');
      const start = () => recorder.webContents.send('rushes:event', { event: 'hotkey-start' });
      if (recorder.webContents.isLoading())
        recorder.webContents.once('did-finish-load', () => setTimeout(start, 100));
      else start();
    } else void requestControl('record.stop');
  });
  globalShortcut.register(
    'CommandOrControl+Shift+P',
    () => void requestControl(state === 'paused' ? 'record.resume' : 'record.pause'),
  );
  globalShortcut.register('CommandOrControl+Shift+Escape', async () => {
    if (state === 'idle') return;
    const r = await dialog.showMessageBox({
      message: 'Discard this recording?',
      buttons: ['Keep recording', 'Discard'],
      cancelId: 0,
    });
    if (r.response === 1) await requestControl('record.discard');
  });
  if (process.env.RUSHES_SMOKE === '1') {
    setTimeout(async () => {
      try {
        const ping = await supervisor.client.request('ping');
        const status = await supervisor.client.request('status');
        const w = windows.get('recorder')!;
        const renderer = await w.webContents.executeJavaScript(
          `({title:document.title,text:document.body.innerText,api:typeof window.rushes,require:typeof window.require})`,
        );
        let cycle: any;
        const waitFor = async (predicate: () => Promise<boolean>) => {
          for (let i = 0; i < 80; i++) {
            if (await predicate()) return;
            await new Promise((r) => setTimeout(r, 100));
          }
          throw new Error('UI recording smoke state timed out');
        };

        if (process.env.RUSHES_SMOKE_EXTRAS === '1') {
          const settings = windowFor('settings');
          await waitFor(async () =>
            Boolean(
              await settings.webContents.executeJavaScript(
                `document.querySelector('.settings-grid')`,
              ),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          const checks = [];
          for (const width of [1120, 900]) {
            settings.setSize(width, 900);
            await new Promise((resolve) => setTimeout(resolve, 100));
            checks.push(
              await settings.webContents.executeJavaScript(
                `({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText})`,
              ),
            );
            if (process.env.RUSHES_SMOKE_SCREENSHOT)
              await writeFile(
                process.env.RUSHES_SMOKE_SCREENSHOT.replace('.png', '-' + width + '.png'),
                (await settings.webContents.capturePage()).toPNG(),
              );
          }
          if (checks.some((check: any) => check.scrollWidth > check.width))
            throw new Error('Settings overflow');
          cycle = { capture: 'none', settings: checks };
        }
        if (process.env.RUSHES_SMOKE_REVIEW_ID) {
          const id = process.env.RUSHES_SMOKE_REVIEW_ID;
          const library = windowFor('library');
          for (let i = 0; i < 50 && library.webContents.isLoading(); i++)
            await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 200));
          library.webContents.send('rushes:event', { event: 'open-recording', id });
          for (let i = 0; i < 50; i++) {
            const ready = await library.webContents.executeJavaScript(
              `!!document.querySelector('.player video')`,
            );
            if (ready) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          await new Promise((r) => setTimeout(r, 500));
          await library.webContents.executeJavaScript(
            `document.querySelectorAll('video,audio').forEach(el=>el.muted=true);document.querySelector('.player-play').click()`,
          );
          await new Promise((r) => setTimeout(r, 1000));
          const review = await library.webContents.executeJavaScript(
            `({text:document.body.innerText,media:[...document.querySelectorAll('video,audio')].map(el=>({src:el.src,ready:el.readyState,time:el.currentTime,duration:el.duration,error:el.error?.message}))})`,
          );
          if (review.media.some((el: any) => el.error || el.ready < 2))
            throw new Error('Real media playback failed: ' + JSON.stringify(review.media));
          cycle = { capture: 'read-only-real-package', id, review };
          if (process.env.RUSHES_SMOKE_SCREENSHOT)
            await writeFile(
              process.env.RUSHES_SMOKE_SCREENSHOT,
              (await library.webContents.capturePage()).toPNG(),
            );
        }
        if (process.env.RUSHES_SMOKE_RECORD_STUB === '1') {
          if (process.env.RUSHES_TEST_ENGINE_STUB !== '1')
            throw new Error('UI recording smoke requires explicit synthetic engine mode');
          await w.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start recording')).click()`,
          );
          await waitFor(async () => {
            const s = await supervisor.client.request('status');
            return s.state === 'recording';
          });
          await new Promise((r) => setTimeout(r, 1000));
          const control = windows.get('bar')!;
          await control.webContents.executeJavaScript(
            `document.querySelector('.stop-btn').click()`,
          );
          await waitFor(async () => {
            const s = await supervisor.client.request('status');
            return s.state === 'idle';
          });
          const list = await supervisor.client.request('list');
          if (!list.recordings.length) throw new Error('Stopped take missing from library');
          const library = windows.get('library')!;
          await waitFor(async () =>
            Boolean(
              await library.webContents.executeJavaScript(
                `document.querySelector('.recording-card')||document.querySelector('.player')`,
              ),
            ),
          );
          await library.webContents.executeJavaScript(
            `document.querySelector('.recording-open')?.click()`,
          );
          await waitFor(async () =>
            Boolean(
              await library.webContents.executeJavaScript(`document.querySelector('.player')`),
            ),
          );
          await new Promise((r) => setTimeout(r, 250));
          const review = await library.webContents.executeJavaScript(
            `({text:document.body.innerText,video:document.querySelector('video')?.src,ready:document.querySelector('video')?.readyState})`,
          );
          cycle = { capture: 'synthetic', recordings: list.recordings.length, review };
          if (process.env.RUSHES_SMOKE_SCREENSHOT)
            await writeFile(
              process.env.RUSHES_SMOKE_SCREENSHOT,
              (await library.webContents.capturePage()).toPNG(),
            );
        }
        if (process.env.RUSHES_SMOKE_SCREENSHOT && !cycle)
          await writeFile(
            process.env.RUSHES_SMOKE_SCREENSHOT,
            (await w.webContents.capturePage()).toPNG(),
          );
        console.log(
          'RUSHES_SMOKE ' +
            JSON.stringify({ ping, status, renderer, enginePath, packaged: app.isPackaged, cycle }),
        );
        app.quit();
      } catch (e) {
        console.error('RUSHES_SMOKE_FAILED', e);
        app.exit(1);
      }
    }, 5000);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((value) => value.startsWith('rushes:'));
    if (url) void routeURL(url);
    else windowFor('recorder');
  });
  void app.whenReady().then(ready);
}
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  cameraOverlay.hide();
  void supervisor
    .quit()
    .then(async () => {
      viewNotifications?.stop();
      await writeOptions().catch((error) =>
        console.error('[Rushes] Could not save window positions', String(error)),
      );
      globalShortcut.unregisterAll();
      automationChild?.kill('SIGTERM');
      automationChild = undefined;
      app.quit();
    })
    .catch((error) => {
      quitting = false;
      void dialog.showMessageBox({
        type: 'error',
        message: 'Rushes could not confirm that the recording finished.',
        detail: (error as Error).message,
      });
      if (supervisor.active) bar();
    });
});
