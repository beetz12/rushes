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
import { isPrimaryView, windowKey, type PrimaryView } from '../shared/navigation';
import { unwrapNativeResponse } from '../shared/native-result';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { bubbleForCapture, globalCaptureArea } from '../shared/geometry';
import { EngineSupervisor } from './engine';
import { SharingService } from './sharing';
import { HostedAccountController, hostedServiceURL } from './hosted-account';
import { createAppUpdater, type ReleaseUpdates, type UpdateSnapshot } from './updater';
import { UpdateRestartGate } from './update-restart';
import { createShareDispatcher } from './share-dispatch';
import { AutoShare, ViewNotifications } from './share-lifecycle';
import { openInEditor, editorArguments } from './editor-handoff';
import { copyVideoFile } from './file-clipboard';
import { videoExportRequest } from '../shared/review-draft';
import { atomicJSON, atomicBytes } from './atomic';
import { OnboardingStore } from './onboarding-store';
import { CameraOverlayLifecycle, recoveredBubbleHidden } from './camera-overlay';
import { IdleCameraPreview } from './idle-camera-preview';
import { IdleCapturePreflight } from './idle-capture-preflight';
import { finishPreviewCleanup } from './preview-cleanup';
import { PrimaryNavigation, PrimaryWindowGeometry, windowPresentation } from './primary-window';
import { DraftExitRequests } from './draft-exit';
import { PreviewFrames } from './preview-frames';
import {
  CountdownSignals,
  RecordingStartup,
  RecordingWindowLifecycle,
  NativeStatusRequests,
  AppQuitGate,
  recordingStoppedActions,
  recoverIdleRecorder,
  type StartupAttempt,
} from './recording-controls';
import { openAreaPicker } from './area-picker';
import { startShellServer } from './shell-server';
import { MediaRegistry, parseRange, mimeType } from './media';
import {
  requestSchema,
  windowSchema,
  recordingOptionsSchema,
  exportPresetSchema,
  cloudSettingsSchema,
  shareCommands,
  defaultOptions,
  preflightInputs,
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
let primaryView: PrimaryView = 'recorder';
const primaryGeometry = new PrimaryWindowGeometry();
const primaryNavigation = new PrimaryNavigation();
let primaryBoundsTimer: ReturnType<typeof setTimeout> | undefined;
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
let selectedReviewId: string | undefined;
let automationChild: ChildProcess | undefined;
let engineReady = false;
let appUpdates: ReleaseUpdates | undefined;
let updateRestart: UpdateRestartGate | undefined;
let updatePreparing = false;
const pendingURLs: string[] = [];
let promptScript = '';
let promptEnabled = false;
let drawingEnabled = false;
let cloudSettings: CloudSettings = { provider: 'none' };
let cloudGeneration = 0;
let activeShares: SharingService | undefined;
const hostedAccount = new HostedAccountController({
  load: async () => {
    const bytes = await readFile(join(userDir, 'hosted-session.enc'));
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable.');
    return JSON.parse(safeStorage.decryptString(bytes));
  },
  save: async (account) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. The account was not saved.');
    await atomicBytes(join(userDir, 'hosted-session.enc'), safeStorage.encryptString(JSON.stringify(account)));
  },
  clear: async () => {await unlink(join(userDir, 'hosted-session.enc')).catch(error => {if (error.code !== 'ENOENT') throw error;});},
}, url => shell.openExternal(url), () => {
  cloudGeneration++;
  activeShares?.cancelForConfigurationChange();
  broadcast({event: 'cloud-account-changed', ...hostedAccount.status()});
}, {allowLocalHTTP: !app.isPackaged});
function hostedIdentity(serviceURL: string) {
  try {const account = hostedAccount.credential(serviceURL); return `hosted:${account.serviceURL}:${account.user.tenantId}:${account.user.id}`;}
  catch {return `hosted:${serviceURL}:unconnected`;}
}
let viewNotifications: ViewNotifications | undefined;
const countdownSignals = new CountdownSignals();
const recordingWindows = new RecordingWindowLifecycle();
const recordingStartup = new RecordingStartup();
const statusRequests = new NativeStatusRequests();
const quitGate = new AppQuitGate();
const draftExit = new DraftExitRequests((token) => {
  const window = windows.get('recorder');
  if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) {
    draftExit.reply(token);
    return;
  }
  window.webContents.send('rushes:event', { event: 'flush-draft', token });
});
const previewFrames = new PreviewFrames();
const idlePreview = new IdleCameraPreview({
  allowed: () => engineReady && !quitting && !captureBusy() && recorderVisible(),
  start: (camera) => supervisor.client.request('camera.preview.start', { camera }),
  stop: () =>
    supervisor.active ? Promise.resolve() : supervisor.client.request('camera.preview.stop'),
  clear: () => {
    previewFrames.clear();
    broadcast({ event: 'camera-preview-cleared' });
  },
  show: (acknowledgment) => {
    previewFrames.install(acknowledgment);
  },
});
let feedbackRefresh = 0;
const idleCapture = new IdleCapturePreflight({
  allowed: () => engineReady && !quitting && !captureBusy() && recorderVisible(),
  start: (selectionToken, selectionRevision, args) =>
    supervisor.client.request('capture.preflight.start', {
      ...args,
      selectionToken,
      selectionRevision,
    }),
  stop: async (selectionToken, selectionRevision) => {
    const value = await supervisor.client.request('capture.preflight.stop', {
      selectionToken,
      selectionRevision,
    });
    if (!z.object({ quiescent: z.boolean() }).parse(value).quiescent)
      throw Object.assign(new Error('Input preview cleanup is still pending.'), {
        code: 'preflight-busy',
      });
    return value;
  },
  snapshot: (previewToken) =>
    supervisor.client.request('capture.preflight.snapshot', { previewToken }),
  clear: () => broadcast({ event: 'preflight-cleared' }),
  ready: (result) => broadcast({ event: 'preflight-ready', result }),
  image: (result) => broadcast({ event: 'screen-preview', result }),
  error: (error) =>
    broadcast({
      event: 'preflight-error',
      message: String(error),
      code: (error as { code?: string })?.code,
    }),
});
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
  if (event.event === 'microphone-level' && !idleCapture.acceptsLevel(event.result)) return;
  if (event.event === 'camera-preview' && !supervisor.active && !idlePreview.acceptsFrames) return;
  if (event.event === 'camera-preview' && !previewFrames.accepts(event.result ?? event)) return;
  for (const [view, window] of windows) {
    if (window.isDestroyed()) continue;
    if (
      event.event === 'camera-preview' &&
      (!['bubble', 'recorder'].includes(view) || !window.isVisible() || window.isMinimized())
    )
      continue;
    window.webContents.send('rushes:event', event);
  }
};
function windowFor(
  view: string,
  extra: Electron.BrowserWindowConstructorOptions = {},
  notify = true,
) {
  const primary = isPrimaryView(view);
  const key = windowKey(view);
  if (primary) {
    primaryNavigation.select(view);
    primaryView = view;
  }
  const old = windows.get(key);
  if (old && !old.isDestroyed()) {
    if (primary) {
      if (primaryGeometry.mode !== windowPresentation(view)) {
        const selected = primaryGeometry.select(view, old.getNormalBounds(), primaryWorkAreas());
        if (old.isFullScreen()) old.setFullScreen(false);
        if (old.isMaximized()) old.unmaximize();
        old.setMinimumSize(selected.minimum.width, selected.minimum.height);
        old.setBounds(selected.bounds);
      }
      const navigate = () => {
        if (!old.isDestroyed() && windows.get(key) === old && primaryView === view)
          old.webContents.send('rushes:event', { event: 'navigate', view });
      };
      if (notify) {
        if (old.webContents.isLoading()) old.webContents.once('did-finish-load', navigate);
        else navigate();
      }
      if (view !== 'recorder' && !captureBusy())
        void hideCameraBubble().catch((error) =>
          broadcast({ event: 'warning', message: String(error) }),
        );
    }
    if (old.isMinimized()) old.restore();
    old.show();
    old.focus();
    if (view === 'recorder') void syncIdlePreview();
    return old;
  }
  const compact = ['bar', 'bubble', 'area', 'teleprompter', 'drawing', 'drawing-tools'].includes(
    view,
  );
  const primaryLayout = primary
    ? primaryGeometry.select(view, undefined, primaryWorkAreas())
    : undefined;
  const w = new BrowserWindow({
    ...(primaryLayout?.bounds ?? {
      width: view === 'bar' ? 800 : 1120,
      height: view === 'bar' ? 104 : 780,
    }),
    minWidth: primaryLayout?.minimum.width ?? (view === 'bubble' ? 1 : compact ? 100 : 800),
    minHeight: primaryLayout?.minimum.height ?? (view === 'bubble' ? 1 : compact ? 60 : 600),
    show: false,
    title: view === 'drawing' ? 'Rushes Drawing' : 'Rushes',
    backgroundColor: '#f7f8fa',
    titleBarStyle: compact ? 'default' : 'hidden',
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
      // Only local app code runs here; native countdown events must also sound
      // when a take is started through the registered keyboard shortcut.
      autoplayPolicy: 'no-user-gesture-required',
    },
    ...extra,
  });
  windows.set(key, w);
  if (primary && process.platform === 'darwin') w.setWindowButtonVisibility(false);
  if (compact) {
    // The transient picker contains only selection controls and closes before capture.
    // Protecting a display-sized transparent window obscures desktop screenshots.
    w.setContentProtection(!['drawing', 'area'].includes(view));
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setAlwaysOnTop(true, 'floating');
  }
  if (view === 'drawing' || view === 'area')
    w.on('page-title-updated', (event) => event.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  let crashRestarts = 0;
  w.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting && details.reason !== 'clean-exit' && ++crashRestarts <= 3)
      w.webContents.reload();
  });
  w.on('closed', () => {
    if (windows.get(key) === w) windows.delete(key);
    if (primary && !captureBusy())
      void hideCameraBubble().catch((error) =>
        broadcast({ event: 'warning', message: String(error) }),
      );
    if (view === 'drawing' && drawingEnabled)
      void hideDrawing().catch((error) => broadcast({ event: 'warning', message: String(error) }));
  });
  if (primary) {
    const remember = () => {
      if (w.isDestroyed() || w.isMaximized() || w.isFullScreen()) return;
      primaryGeometry.remember(w.getNormalBounds());
      clearTimeout(primaryBoundsTimer);
      primaryBoundsTimer = setTimeout(
        () =>
          void atomicJSON(join(userDir, 'primary-window.json'), primaryGeometry.snapshot()).catch(
            (error) => console.error('[Rushes] Window position save failed', String(error)),
          ),
        200,
      );
    };
    w.on('moved', remember);
    w.on('resized', remember);
    w.on('close', (event) => {
      remember();
      if (!quitting) {
        event.preventDefault();
        w.hide();
        if (!captureBusy())
          void hideCameraBubble().catch((error) =>
            broadcast({ event: 'warning', message: String(error) }),
          );
      }
    });
    w.on('show', () => void syncIdlePreview());
    w.on('hide', () => {
      if (!captureBusy())
        void hideCameraBubble().catch((error) =>
          broadcast({ event: 'warning', message: String(error) }),
        );
    });
    w.on('minimize', () => {
      if (!captureBusy())
        void hideCameraBubble().catch((error) =>
          broadcast({ event: 'warning', message: String(error) }),
        );
    });
    const reportWindowState = () =>
      w.webContents.send('rushes:event', {
        event: 'main-window-state',
        maximized: w.isMaximized() || w.isFullScreen(),
      });
    w.on('maximize', reportWindowState);
    w.on('unmaximize', reportWindowState);
    w.on('enter-full-screen', reportWindowState);
    w.on('leave-full-screen', reportWindowState);
  }
  if (view === 'bubble' || view === 'bar') w.on('moved', () => rememberPosition(view, w));
  w.once('ready-to-show', () => {
    if (quitting || w.isDestroyed() || windows.get(key) !== w) return;
    if (['bubble', 'bar', 'teleprompter', 'drawing', 'drawing-tools'].includes(view))
      w.showInactive();
    else w.show();
  });
  const url = devURL ? `${devURL}/#${view}` : `${pathToFileURL(uiFile).toString()}#${view}`;
  void w.loadURL(url);
  return w;
}
function primaryWorkAreas() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)].map(
    (display) => display.workArea,
  );
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
    // Native admission protects URL starts; keep Stop/Pause routes available.
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
function recordingBusy() {
  return supervisor.active || startRequests > 0 || ['preparing', 'armed', 'recording', 'paused', 'finishing'].includes(state);
}
function captureBusy() {
  return recordingBusy() || updatePreparing || appUpdates?.blocksCapture === true || supervisor.updateHoldPending;
}
function updateBusy() {
  return !engineReady || !supervisor.client.connected || recordingBusy() || state !== 'idle' || quitting || hostedAccount.status().pending;
}
function updateSnapshot(): UpdateSnapshot & {nativeHoldPending: boolean} {
  return {...(appUpdates?.snapshot() ?? {status: 'disabled' as const, reason: 'unavailable' as const}), nativeHoldPending: supervisor.updateHoldPending};
}
function queueBubbleWrite(write: () => Promise<void>) {
  const next = bubbleWrites.catch(() => {}).then(write);
  bubbleWrites = next;
  return next;
}
async function hideCameraBubble() {
  ++feedbackRefresh;
  const feedbackStopped = idleCapture.stop();
  void feedbackStopped.catch(() => {});
  const generation = cameraOverlay.hide();
  const cameraToken = previewFrames.currentToken;
  idlePreview.invalidate();
  const busy = recordingBusy();
  const id = currentId;
  if (busy) bubbleSuppressed = true;
  windows.get('bubble')?.close();
  broadcast({ event: 'camera-preview-cleared' });
  await finishPreviewCleanup([
    () => feedbackStopped,
    () =>
      cameraToken
        ? supervisor.client.request('camera.preview.subscribe', {
            enabled: false,
            previewToken: cameraToken,
          })
        : Promise.resolve(),
    async () => {
      if (busy) {
        await queueBubbleWrite(async () => {
          if (supervisor.active && currentId === id && cameraOverlay.sameGeneration(generation))
            await supervisor.client.request('record.bubble', { ...lastBubble, visible: false });
        });
      } else if (!recordingBusy() && cameraOverlay.sameGeneration(generation))
        await idlePreview.stop();
    },
  ]);
}
async function syncIdlePreview() {
  void syncIdleCapture();
  const camera = options.camera;
  if (camera === 'none' || !engineReady || captureBusy() || quitting || !recorderVisible()) return;
  const generation = cameraOverlay.begin();
  try {
    const permissions = await supervisor.client.request('permissions.check');
    if (
      permissions.camera !== 'granted' ||
      !cameraOverlay.current(generation) ||
      options.camera !== camera ||
      captureBusy() ||
      !recorderVisible()
    )
      return;
    await idlePreview.select(camera);
  } catch (error) {
    if (!captureBusy() && recorderVisible())
      broadcast({
        event: 'warning',
        message: String(error),
        code: (error as { code?: string })?.code,
      });
  }
}
async function syncIdleCapture() {
  const generation = ++feedbackRefresh;
  if (!engineReady || quitting || captureBusy() || !recorderVisible()) return;
  const selection = preflightInputs(options);
  try {
    const live = await supervisor.client.request('status');
    if (
      generation !== feedbackRefresh ||
      !recorderVisible() ||
      captureBusy() ||
      quitting ||
      live.state !== 'idle'
    )
      return;
    const permissions = live.permissions ?? (await supervisor.client.request('permissions.check'));
    if (generation !== feedbackRefresh || !recorderVisible() || captureBusy() || quitting) return;
    const inputs: Record<string, unknown> = {
      ...selection,
      mic: permissions.microphone === 'granted' ? selection.mic : 'none',
    };
    if (permissions.screen !== 'granted') {
      delete inputs.display;
      delete inputs.window;
      delete inputs.area;
    }
    if (inputs.mic === 'none' && !inputs.display && !inputs.window) {
      await idleCapture.stop();
      return;
    }
    await idleCapture.select(inputs);
  } catch (error) {
    if (generation === feedbackRefresh && recorderVisible() && !captureBusy())
      broadcast({
        event: 'preflight-error',
        message: String(error),
        code: (error as { code?: string })?.code,
      });
  }
}
function recorderVisible() {
  const recorder = windows.get('recorder');
  return (
    primaryView === 'recorder' &&
    !!recorder &&
    !recorder.isDestroyed() &&
    recorder.isVisible() &&
    !recorder.isMinimized()
  );
}
function clearCountdown() {
  countdownSignals.cancel();
  broadcast({ event: 'countdown-cleared' });
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
  const frameGeneration = previewFrames.clear();
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
        const acknowledgment = await supervisor.client.request('camera.preview.subscribe', {
          enabled: true,
        });
        if (!current() || currentId !== id || !supervisor.active) return false;
        return previewFrames.install(acknowledgment, frameGeneration);
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
function openReviewWindow(id: string) {
  selectedReviewId = id;
  const window = windowFor('review');
  const current = primaryNavigation.checkpoint();
  const open = () => {
    if (
      !quitting &&
      current() &&
      primaryView === 'review' &&
      selectedReviewId === id &&
      !window.isDestroyed()
    )
      window.webContents.send('rushes:event', { event: 'open-recording', id });
  };
  if (window.webContents.isLoading())
    window.webContents.once('did-finish-load', () => setTimeout(open, 100));
  else open();
}
async function requestControl(cmd: string, args: Record<string, unknown> = {}) {
  try {
    if (['record.stop', 'record.cancel', 'record.discard'].includes(cmd)) clearCountdown();
    if (
      ['record.stop', 'record.cancel', 'record.discard'].includes(cmd) &&
      recordingStartup.cancelBeforeIssue()
    )
      return { state: 'idle' };
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
  if (settings.provider === 'hosted') {
    const account = hostedAccount.credential(settings.serviceURL);
    return new sdk.HostedProvider({serviceURL: account.serviceURL, credential: account.credential}, {store, allowLocalHTTP: !app.isPackaged});
  }
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
    configured: settings.provider !== 'none' && (settings.provider !== 'hosted' || (hostedAccount.status().connected && !hostedAccount.status().pending && hostedAccount.status().serviceURL === settings.serviceURL)),
    encrypted: safeStorage.isEncryptionAvailable(),
    ...(settings.provider === 'hosted'
      ? {endpoint: settings.serviceURL}
      : settings.provider === 'worker'
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
  if (parsed.provider === 'hosted') {parsed.serviceURL = hostedServiceURL(parsed.serviceURL, !app.isPackaged); hostedAccount.credential(parsed.serviceURL);}
  hostedAccount.cancel();
  activeShares?.cancelForConfigurationChange();
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
    ...(parsed.provider === 'hosted'
      ? {endpoint: parsed.serviceURL}
      : parsed.provider === 'worker'
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
    primaryGeometry.restore(
      JSON.parse(await readFile(join(userDir, 'primary-window.json'), 'utf8')),
    );
  } catch {}
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
  await hostedAccount.initialize();
  await readCloud();
  void createAppUpdater({packaged: app.isPackaged, resourcesPath: process.resourcesPath, isBusy: updateBusy,
    changed: snapshot => broadcast({event: 'app-update', ...snapshot})}).then(updater => {
      if (quitting) {updater.close(); return;}
      appUpdates = updater;
      updateRestart = new UpdateRestartGate({snapshot: updateSnapshot, recordingBusy: updateBusy,
        flush: () => finishPreviewCleanup([() => draftExit.flush(), () => hideCameraBubble(), () => idlePreview.stop()]),
        acquire: token => supervisor.acquireUpdateHold(token), release: hold => supervisor.releaseUpdateHold(hold),
        restart: () => updater.restart(), committed: () => updater.blocksCapture,
        preparing: value => {updatePreparing = value; broadcast({event: 'app-update-preparing', active: value});}});
      updater.start(); broadcast({event: 'app-update', ...updater.snapshot()});
    }).catch(() => broadcast({event: 'app-update', status: 'disabled', reason: 'unavailable'}));
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
  handle('rushes:bootstrap', () => ({
    options,
    enginePath,
    packaged: app.isPackaged,
    primaryView,
    reviewId: selectedReviewId,
    inputPreflight: idleCapture.currentAcknowledgment,
  }));
  handle('rushes:open-recording', async (value) => {
    const id = z.string().min(1).max(200).parse(value);
    await supervisor.client.request('show', { id });
    selectedReviewId = id;
    const window = windowFor('review');
    window.webContents.send('rushes:event', { event: 'open-recording', id });
  });
  handle('rushes:restore-primary-view', (value) => {
    const view = z.enum(['recorder', 'review', 'editor', 'library', 'settings']).parse(value);
    windowFor(view, {}, false);
  });
  handle('rushes:draft-flushed', (value) => {
    const result = z
      .object({ token: z.uuid(), error: z.string().max(2000).optional() })
      .strict()
      .parse(value);
    draftExit.reply(result.token, result.error);
  });
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
      const frameGeneration = previewFrames.clear();
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
          const acknowledgment = await supervisor.client.request('camera.preview.subscribe', {
            enabled: true,
          });
          if (!current() || !supervisor.active || currentId !== id) return;
          return previewFrames.install(acknowledgment, frameGeneration)
            ? acknowledgment
            : undefined;
        },
        (acknowledgment) => {
          if (acknowledgment && !quitting && supervisor.active) {
            bubble();
            void syncBubble();
          }
        },
      );
    }
    if (request.cmd === 'camera.preview.stop') return hideCameraBubble();
    if (request.cmd === 'camera.preview.start') {
      cameraOverlay.begin();
      return idlePreview.select(
        z
          .string()
          .min(1)
          .max(300)
          .parse(request.args.camera ?? 'default'),
      );
    }
    if (['record.stop', 'record.cancel', 'record.discard'].includes(request.cmd)) clearCountdown();
    if (
      ['record.stop', 'record.cancel', 'record.discard'].includes(request.cmd) &&
      recordingStartup.cancelBeforeIssue()
    )
      return { state: 'idle' };
    if (request.cmd === 'record.stop') await syncBubble();
    if (request.cmd === 'camera.blur.set' && request.args.enabled === true)
      broadcast({ event: 'camera-preview-cleared' });
    let startAttempt: StartupAttempt | undefined;
    if (request.cmd === 'record.start') {
      if (updatePreparing || appUpdates?.blocksCapture || supervisor.updateHoldPending) throw new Error('Rushes is preparing an update. Wait for the restart before recording.');
      statusRequests.changed();
      startAttempt = recordingStartup.begin();
      startRequests++;
      bubbleSuppressed = false;
      cameraOverlay.hide();
      windows.get('bubble')?.close();
    }
    let result;
    try {
      // Finish idle warm-up before native acquisition takes over the camera.
      if (startAttempt) {
        ++feedbackRefresh;
        await idleCapture.stop();
        await idlePreview.stop();
        recordingStartup.issue(startAttempt);
      }
      result =
        request.cmd === 'status'
          ? await statusRequests.read(() => supervisor.client.request(request.cmd, request.args))
          : await supervisor.client.request(request.cmd, request.args);
      if (request.cmd === 'status') {
        const previous = state;
        state = result.state;
        supervisor.active = ['preparing', 'armed', 'recording', 'paused', 'finishing'].includes(
          state,
        );
        if (state === 'idle' && previous !== 'idle') void syncIdlePreview();
      }
    } catch (error) {
      if (request.cmd === 'record.start') clearCountdown();
      throw error;
    } finally {
      if (request.cmd === 'record.start') {
        if (startAttempt) recordingStartup.finish(startAttempt);
        startRequests--;
        if (!supervisor.active) void syncIdlePreview();
      }
    }
    if (request.cmd === 'permissions.settings' && result.url) {
      const u = new URL(result.url);
      if (u.protocol === 'x-apple.systempreferences:') await shell.openExternal(result.url);
    }
    if (['permissions.request', 'permissions.check'].includes(request.cmd)) void syncIdlePreview();
    if (request.cmd === 'teleprompter.set') {
      promptScript = String(request.args.script ?? '');
      promptEnabled = request.args.enabled === true;
      broadcast({ event: 'teleprompter-config', script: promptScript, enabled: promptEnabled });
      if (!promptEnabled) windows.get('teleprompter')?.close();
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
    const previousCamera = options.camera;
    const previousInputs = JSON.stringify(preflightInputs(options));
    options = next.mode === 'camera-only' ? { ...next, systemAudio: false } : next;
    if (previousInputs !== JSON.stringify(preflightInputs(options))) {
      ++feedbackRefresh;
      void idleCapture.stop().catch(() => {});
    }
    await writeOptions();
    if (options.camera !== previousCamera && !captureBusy()) {
      if (options.camera === 'none') await hideCameraBubble();
      else void syncIdlePreview();
    }
    void syncIdlePreview();
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
    void syncIdleCapture();
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
      case 'review':
      case 'editor':
        windowFor(v.action);
        return;
      case 'drawing':
        return showDrawing();
      case 'drawing-hide':
        return hideDrawing();
      case 'teleprompter':
        return showTeleprompter();
      case 'close':
        windows.get('recorder')?.hide();
        if (!captureBusy()) await hideCameraBubble();
        return;
      case 'minimize':
        windows.get('recorder')?.minimize();
        if (!captureBusy()) await hideCameraBubble();
        return;
      case 'maximize': {
        const window = windows.get('recorder');
        if (!window || window.isDestroyed()) return;
        if (window.isFullScreen()) window.setFullScreen(false);
        else if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        return;
      }
      case 'window-state': {
        const window = windows.get('recorder');
        return { maximized: !!window && (window.isMaximized() || window.isFullScreen()) };
      }
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
        preset: exportPresetSchema,
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
        title: 'Save separate original screen, camera and audio files',
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
    ...configurationSummary(cloudSettings),
    ...(cloudSettings.provider === 'bucket'
      ? {publicBaseURL: cloudSettings.publicBaseURL}
      : cloudSettings.provider === 'worker'
        ? {workerURL: cloudSettings.workerURL}
        : cloudSettings.provider === 'hosted' ? {serviceURL: cloudSettings.serviceURL} : {}),
  }));
  handle('rushes:hosted-account', async (value) => {
    const input = z.discriminatedUnion('action', [
      z.object({action: z.literal('status')}).strict(),
      z.object({action: z.literal('connect'), serviceURL: z.string().min(1).max(2048)}).strict(),
      z.object({action: z.literal('cancel')}).strict(),
      z.object({action: z.literal('disconnect')}).strict(),
    ]).parse(value);
    if (input.action === 'connect') return hostedAccount.start(input.serviceURL);
    if (input.action === 'disconnect') return hostedAccount.disconnect();
    if (input.action === 'cancel') hostedAccount.cancel();
    return hostedAccount.status();
  });
  handle('rushes:updates', async value => {
    const action = z.enum(['status', 'check', 'restart', 'recover']).parse(value);
    if (action === 'check' && appUpdates) {await appUpdates.check(); return updateSnapshot();}
    if (action === 'restart' && updateRestart) {await updateRestart.run(); return updateSnapshot();}
    if (action === 'recover' && updateRestart) {await updateRestart.recover(); return updateSnapshot();}
    return updateSnapshot();
  });
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
          : cloudSettings.provider === 'hosted' ? hostedIdentity(cloudSettings.serviceURL) : 'none',
    shareEvent,
    () => cloudGeneration,
  );
  activeShares = shares;
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
    if (e.event === 'microphone-level') {
      broadcast(e);
      return;
    }
    if (
      ['state-changed', 'recording-started', 'recording-stopped', 'engine-reconnected'].includes(
        e.event,
      )
    )
      statusRequests.changed();
    appUpdates?.activityChanged();
    const countdownCurrent = countdownSignals.current(e);
    const tick = recordingStartup.canceling ? undefined : countdownSignals.event(e);
    if (e.event !== 'countdown' || (countdownCurrent && !recordingStartup.canceling))
      broadcast(tick === undefined ? e : { ...e, tick });
    if (e.event === 'recording-started') {
      state = 'recording';
      currentId = e.recordingId;
      idlePreview.invalidate();
      ++feedbackRefresh;
      idleCapture.invalidate();
      recordingWindows.event(e, () => {
        for (const view of ['recorder', 'library', 'settings']) {
          const window = windows.get(view);
          if (window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
            window.minimize();
        }
      });
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
      const previousId = currentId;
      ++feedbackRefresh;
      idleCapture.invalidate();
      previewFrames.clear();
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
        if (e.state === 'idle' && primaryView === 'recorder') {
          const navigationCurrent = primaryNavigation.checkpoint();
          try {
            await recoverIdleRecorder(previousId, {
              current: () =>
                navigationCurrent() &&
                !quitting &&
                !captureBusy() &&
                !currentId &&
                primaryView === 'recorder',
              show: (id) => statusRequests.read(() => supervisor.client.request('show', { id })),
              open: openReviewWindow,
              rearm: syncIdlePreview,
            });
          } catch (error) {
            if (
              !['not-found', 'status-superseded'].includes((error as { code?: string }).code ?? '')
            )
              broadcast({
                event: 'warning',
                message:
                  'Your saved take is in My recordings. Review could not reopen automatically.',
              });
          }
        }
      }
    }
    if (e.event === 'state-changed' && typeof e.state === 'string') {
      if (cameraOverlay.newTake(state, e.state)) {
        idlePreview.invalidate();
        ++feedbackRefresh;
        idleCapture.invalidate();
        if (startRequests === 0) bubbleSuppressed = false;
        windows.get('bubble')?.close();
      }
      if (e.state === 'armed' && typeof e.recordingId === 'string') currentId = e.recordingId;
      state = e.state;
    }
    if (e.event === 'recording-stopped') {
      const actions = recordingStoppedActions(e);
      const stoppedId = e.recordingId ?? currentId;
      if (actions.view === 'review')
        selectedReviewId = typeof stoppedId === 'string' ? stoppedId : undefined;
      if (actions.autoShare && typeof stoppedId === 'string')
        void autoShare.recordingStopped(stoppedId, options.autoShare);
      state = 'finishing';
      supervisor.active = true;
      previewFrames.clear();
      cameraOverlay.hide();
      bubbleSuppressed = false;
      broadcast({ event: 'camera-preview-cleared' });
      void hideDrawing().catch(() => {});
      windows.get('teleprompter')?.close();
      windows.get('bar')?.close();
      windows.get('bubble')?.close();
      void supervisor.client.request('camera.preview.stop').catch(() => {});
      if (actions.view === 'review' && typeof stoppedId === 'string') openReviewWindow(stoppedId);
      else windowFor(actions.view);
      currentId = undefined;
    }
    appUpdates?.activityChanged();
    trayUpdate();
  });
  supervisor.client.on('engine-error', (e) => broadcast({ event: 'error', ...e }));
  supervisor.client.on('disconnected', () => {
    appUpdates?.activityChanged();
    statusRequests.changed();
    clearCountdown();
    idlePreview.invalidate();
    ++feedbackRefresh;
    idleCapture.invalidate();
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
    void syncIdlePreview();
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
        if (process.env.RUSHES_SMOKE_WINDOWS === '1') {
          await waitFor(async () =>
            Boolean(
              await w.webContents.executeJavaScript(`document.querySelector('.window-chrome')`),
            ),
          );
          const rendererToken = await w.webContents.executeJavaScript(
            `window.__windowProbe = crypto.randomUUID()`,
          );
          if (process.env.RUSHES_TEST_ENGINE_STUB === '1') {
            unwrapNativeResponse(
              await w.webContents.executeJavaScript(
                `window.rushes.request('camera.preview.start', {camera:'camera-diagnostic'})`,
              ),
            );
            if (BrowserWindow.getAllWindows().length !== 1)
              throw new Error('Idle camera preview opened an extra window');
          }
          const views = [];
          for (const view of ['library', 'settings', 'recorder', 'library', 'recorder']) {
            const selected = windowFor(view);
            if (selected !== w) throw new Error('Navigation created a second main window.');
            await waitFor(
              async () =>
                (await w.webContents.executeJavaScript(`document.documentElement.dataset.view`)) ===
                view,
            );
            if ((await w.webContents.executeJavaScript(`window.__windowProbe`)) !== rendererToken)
              throw new Error('Navigation reloaded the main renderer.');
            if (
              BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length !== 1
            )
              throw new Error('Navigation retained a duplicate window.');
            views.push(view);
          }
          const chrome = await w.webContents.executeJavaScript(`({
            drag: getComputedStyle(document.querySelector('.window-chrome')).getPropertyValue('-webkit-app-region'),
            controls: [...document.querySelectorAll('.window-control')].map(button => ({
              label:button.getAttribute('aria-label'), width:button.getBoundingClientRect().width, height:button.getBoundingClientRect().height,
              region:getComputedStyle(button).getPropertyValue('-webkit-app-region'), radius:getComputedStyle(button).borderRadius
            }))
          })`);
          if (
            chrome.drag !== 'drag' ||
            chrome.controls.length !== 3 ||
            chrome.controls.some(
              (button: any) =>
                button.width !== button.height ||
                button.width !== 14 ||
                button.region !== 'no-drag',
            )
          )
            throw new Error('Window drag or circle geometry is invalid.');
          const before = w.getBounds();
          w.setPosition(before.x + 40, before.y + 30);
          const moved = w.getBounds();
          if (!w.isMovable() || moved.x === before.x || moved.y === before.y)
            throw new Error('Main window cannot move.');
          await w.webContents.executeJavaScript(
            `document.querySelector('.window-maximize').click()`,
          );
          await waitFor(async () => w.isMaximized());
          await w.webContents.executeJavaScript(
            `document.querySelector('.window-maximize').click()`,
          );
          await waitFor(async () => !w.isMaximized());
          await w.webContents.executeJavaScript(
            `document.querySelector('.window-minimize').click()`,
          );
          await waitFor(async () => w.isMinimized());
          app.emit('activate');
          await waitFor(async () => !w.isMinimized());
          await w.webContents.executeJavaScript(`document.querySelector('.window-close').click()`);
          await waitFor(async () => !w.isVisible());
          app.emit('activate');
          await waitFor(async () => w.isVisible());
          if (process.env.RUSHES_SMOKE_SCREENSHOT)
            await writeFile(
              process.env.RUSHES_SMOKE_SCREENSHOT,
              (await w.webContents.capturePage()).toPNG(),
            );
          cycle = {
            views,
            chrome,
            movable: w.isMovable(),
            before,
            moved,
            windows: BrowserWindow.getAllWindows().length,
          };
        }

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
          if (process.env.RUSHES_SMOKE_CAMERA_REVIEW === '1')
            await waitFor(async () =>
              Boolean(
                await library.webContents.executeJavaScript(
                  `document.querySelector('.review-camera')?.readyState >= 2`,
                ),
              ),
            );
          await library.webContents.executeJavaScript(
            `window.__reviewPlaybackFailures=[];window.__reviewPauses=[];document.querySelectorAll('video,audio').forEach(el=>{el.muted=true;const play=el.play.bind(el);el.play=()=>play().catch(error=>{window.__reviewPlaybackFailures.push({kind:el.tagName,name:error.name,message:error.message});throw error});const pause=el.pause.bind(el);el.pause=()=>{window.__reviewPauses.push({kind:el.tagName,time:el.currentTime,stack:new Error().stack});pause()}});document.querySelector('.player-play').click()`,
          );
          await new Promise((r) => setTimeout(r, 1000));
          const review = await library.webContents.executeJavaScript(
            `({media:[...document.querySelectorAll('video,audio')].map(el=>({kind:el.tagName,src:el.src,ready:el.readyState,time:el.currentTime,duration:el.duration,paused:el.paused,error:el.error?.message})),playbackFailures:window.__reviewPlaybackFailures,pauses:window.__reviewPauses,camera:(()=>{const video=document.querySelector('.review-camera');if(!video)return null;const r=video.getBoundingClientRect(),p=document.querySelector('.player').getBoundingClientRect();return {width:r.width,height:r.height,playerWidth:p.width,playerHeight:p.height}})()})`,
          );
          if (review.media.some((el: any) => el.error || el.ready < 2))
            throw new Error('Real media playback failed: ' + JSON.stringify(review.media));
          if (
            process.env.RUSHES_SMOKE_CAMERA_REVIEW === '1' &&
            (!review.camera ||
              review.camera.width !== review.camera.playerWidth ||
              review.camera.height !== review.camera.playerHeight ||
              review.media.filter((el: any) => el.kind === 'VIDEO').length !== 1 ||
              review.media.some((el: any) => el.time < 0.2 || el.paused) ||
              Math.max(...review.media.map((el: any) => el.time)) -
                Math.min(...review.media.map((el: any) => el.time)) >
                0.12)
          )
            throw new Error(
              'Camera-only review is blank, cropped, out of sync or not advancing: ' +
                JSON.stringify(review),
            );
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
          windowFor('library');
          await waitFor(
            async () =>
              (await w.webContents.executeJavaScript(`document.documentElement.dataset.view`)) ===
              'library',
          );
          w.webContents.send('rushes:event', { event: 'hotkey-start' });
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
          const library = windows.get('recorder')!;
          if (library !== w) throw new Error('Stopped take opened a second main window');
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
          if (BrowserWindow.getAllWindows().length !== 1)
            throw new Error('Stopped take retained a second window');
          cycle = {
            ...cycle,
            capture: 'synthetic',
            recordings: list.recordings.length,
            review,
            reviewWindows: BrowserWindow.getAllWindows().length,
          };
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
  app.on('activate', () => {
    if (!engineReady || quitting || (captureBusy() && state !== 'finishing')) return;
    const main = windows.get('recorder');
    if (!main || main.isDestroyed() || !main.isVisible() || main.isMinimized())
      windowFor(primaryView);
  });
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((value) => value.startsWith('rushes:'));
    if (url) void routeURL(url);
    else windowFor('recorder');
  });
  void app.whenReady().then(ready);
}
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  const action = quitGate.request();
  if (action === 'exit') return;
  event.preventDefault();
  if (action === 'wait') return;
  quitting = true;
  appUpdates?.close();
  ++feedbackRefresh;
  cameraOverlay.hide();
  void finishPreviewCleanup([() => draftExit.flush(), () => hideCameraBubble()])
    .then(() => supervisor.quit())
    .then(async () => {
      viewNotifications?.stop();
      await writeOptions().catch((error) =>
        console.error('[Rushes] Could not save window positions', String(error)),
      );
      clearTimeout(primaryBoundsTimer);
      await atomicJSON(join(userDir, 'primary-window.json'), primaryGeometry.snapshot()).catch(
        () => {},
      );
      globalShortcut.unregisterAll();
      automationChild?.kill('SIGTERM');
      automationChild = undefined;
      quitGate.confirm();
      app.quit();
    })
    .catch((error) => {
      quitting = false;
      quitGate.failed();
      void dialog.showMessageBox({
        type: 'error',
        message:
          (error as { code?: string })?.code === 'draft-save-failed'
            ? 'Rushes could not save the current edit. Retry before quitting.'
            : (error as { code?: string })?.code === 'preflight-busy'
              ? 'Rushes is still closing an input preview. Try Quit again in a moment.'
              : 'Rushes could not confirm that the recording finished.',
        detail: (error as Error).message,
      });
      if (supervisor.active) bar();
    });
});
