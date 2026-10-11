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
} from 'electron';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { EngineSupervisor } from './engine';
import { SharingService } from './sharing';
import { atomicJSON, atomicBytes } from './atomic';
import { startShellServer } from './shell-server';
import { MediaRegistry, parseRange, mimeType } from './media';
import {
  requestSchema,
  windowSchema,
  recordingOptionsSchema,
  cloudSettingsSchema,
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
let cloudSettings: CloudSettings = { provider: 'none' };
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
  const compact = ['bar', 'bubble', 'area'].includes(view);
  const w = new BrowserWindow({
    width: view === 'bar' ? 680 : 1120,
    height: view === 'bar' ? 104 : 780,
    minWidth: compact ? 100 : 800,
    minHeight: compact ? 60 : 600,
    show: false,
    title: 'Rushes',
    backgroundColor: '#f7f8fa',
    titleBarStyle: compact ? 'default' : 'hiddenInset',
    frame: !compact,
    alwaysOnTop: compact,
    transparent: view === 'bubble' || view === 'area',
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
    w.setContentProtection(true);
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setAlwaysOnTop(true, 'floating');
  }
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('closed', () => windows.delete(view));
  if (view === 'bubble')
    w.on('moved', () => {
      if (!supervisor.active) return;
      const bounds = w.getBounds(),
        d = screen.getDisplayMatching(bounds).bounds;
      void supervisor.client
        .request('record.bubble', {
          center: [
            (bounds.x + bounds.width / 2 - d.x) / d.width,
            (bounds.y + bounds.height / 2 - d.y) / d.height,
          ],
          size: options.bubbleSize,
          visible: true,
        })
        .catch(() => {});
    });
  w.once('ready-to-show', () => {
    if (view === 'bubble' || view === 'bar') w.showInactive();
    else w.show();
  });
  const url = devURL ? `${devURL}/#${view}` : `${pathToFileURL(uiFile).toString()}#${view}`;
  void w.loadURL(url);
  return w;
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
function bar() {
  const bounds = screen.getPrimaryDisplay().workArea;
  return windowFor('bar', {
    x: Math.round(bounds.x + (bounds.width - 680) / 2),
    y: Math.round(bounds.y + bounds.height - 130),
    focusable: false,
  });
}
function bubble() {
  const b = screen.getPrimaryDisplay().workArea;
  return windowFor('bubble', {
    width: options.bubbleSize,
    height: options.bubbleSize,
    x: b.x + 32,
    y: b.y + b.height - options.bubbleSize - 160,
    focusable: false,
    backgroundColor: '#00000000',
  });
}
async function requestControl(cmd: string, args: Record<string, unknown> = {}) {
  try {
    return await supervisor.client.request(cmd, args);
  } catch (error) {
    broadcast({ event: 'error', message: String(error) });
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
  if (cloudSettings.provider === 'none') throw new Error('Configure sharing in Settings first.');
  const sdkPath = app.isPackaged
    ? join(process.resourcesPath, 'cloud', 'index.js')
    : resolve(__dirname, '../../../cloud/dist/index.js');
  const sdk = await import(pathToFileURL(sdkPath).toString());
  const store = new sdk.JsonJobStore(join(userDir, 'share-jobs'));
  if (cloudSettings.provider === 'worker') return new sdk.WorkerProvider(cloudSettings, { store });
  const assetsDir = app.isPackaged
    ? join(process.resourcesPath, 'viewer')
    : resolve(__dirname, '../../../viewer/dist');
  const js = await readFile(join(assetsDir, 'viewer.js'), 'utf8');
  const css = await readFile(join(assetsDir, 'viewer.css'), 'utf8');
  return new sdk.BucketProvider(cloudSettings, { store, viewerAssets: { js, css } });
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
  handle('rushes:bootstrap', () => ({ options, enginePath, packaged: app.isPackaged }));
  handle('rushes:request', async (value) => {
    const request = requestSchema.parse(value);
    if (JSON.stringify(request.args).length > 2 * 1024 * 1024) throw new Error('Request too large');
    if (['export', 'thumbnail', 'captions.export', 'diagnostics'].includes(request.cmd))
      throw new Error('Use the native save dialog for file output');
    const result = await supervisor.client.request(request.cmd, request.args);
    if (request.cmd === 'permissions.settings' && result.url) {
      const u = new URL(result.url);
      if (u.protocol === 'x-apple.systempreferences:') await shell.openExternal(result.url);
    }
    if (['transcript.run', 'meta.set', 'meta.generate'].includes(request.cmd) && request.args.id)
      void shares
        .enrich(String(request.args.id))
        .catch((error) =>
          broadcast({ event: 'warning', code: 'share-enrichment-pending', message: String(error) }),
        );
    if (request.cmd === 'camera.preview.start') {
      bubble();
    }
    if (request.cmd === 'camera.preview.stop') windows.get('bubble')?.close();
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
    options = recordingOptionsSchema.parse(value);
    await writeOptions();
  });
  handle('rushes:select-area', async (value) => {
    const area = z
      .object({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .parse(value);
    options = { ...options, mode: 'area', area };
    await writeOptions();
    broadcast({ event: 'area-selected', area });
    windows.get('area')?.close();
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
      case 'close':
        return windows.get('recorder')?.hide();
      case 'area': {
        const selected =
          screen.getAllDisplays().find((d) => `display-${d.id}` === options.source) ??
          screen.getPrimaryDisplay();
        const b = selected.bounds;
        windowFor('area', { ...b, fullscreen: true, backgroundColor: '#00000000' });
        return;
      }
      case 'cancel-area':
        windows.get('area')?.close();
        return;
      case 'bubble-size':
        options = recordingOptionsSchema.parse({ ...options, bubbleSize: v.value });
        windows.get('bubble')?.setSize(options.bubbleSize, options.bubbleSize);
        await writeOptions();
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
  handle('rushes:export-file', async (value) => {
    const v = z
      .object({
        id: z.string().min(1).max(200),
        preset: z.enum([
          'share',
          'full',
          'youtube',
          'audio',
          'audio-wav',
          'editor-tracks',
          'srt',
          'vtt',
          'txt',
          'thumbnail',
          'diagnostics',
        ]),
        atMs: z.number().nonnegative().optional(),
      })
      .parse(value);
    const extension =
      v.preset === 'audio-wav'
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
        title: 'Export editor tracks',
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
        { id: v.id, preset: v.preset === 'audio-wav' ? 'audio' : v.preset, path },
        30 * 60 * 1000,
      );
    exportedFiles.add(path);
    return { ...result, path };
  });
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
    clipboard.writeText(url);
  });
  const shares = new SharingService(
    supervisor.client,
    provider,
    () =>
      cloudSettings.provider === 'bucket'
        ? `bucket:${cloudSettings.endpoint}/${cloudSettings.bucket}`
        : cloudSettings.provider === 'worker'
          ? `worker:${cloudSettings.workerURL}`
          : 'none',
    broadcast,
  );
  handle('rushes:share', async (value) => {
    const result = await shares.share(z.string().min(1).max(200).parse(value));
    clipboard.writeText(result.url);
    return result;
  });
  await startShellServer(join(userDir, 'shell.sock'), async (cmd, args) => {
    if (cmd === 'share.configuration') return persistedCloudSummary();
    if (cmd === 'share.configure') return saveCloud(args);
    if (cmd === 'share.setup') return (await provider()).setupCheck();
    const id = z.string().min(1).max(200).parse(args.id);
    if (cmd === 'share') {
      const result = await shares.share(id);
      clipboard.writeText(result.url);
      return result;
    }
    if (cmd === 'share.enrich') return shares.enrich(id);
    return shares.unshare(id);
  });
  supervisor.client.on('event', async (e) => {
    broadcast(e);
    if (e.event === 'recording-started') {
      state = 'recording';
      currentId = e.recordingId;
      bar();
    }
    if (e.event === 'state-changed' && typeof e.state === 'string') state = e.state;
    if (e.event === 'recording-stopped') {
      state = 'idle';
      windows.get('bar')?.close();
      windows.get('bubble')?.close();
      const library = windowFor('library');
      const openReview = () =>
        library.webContents.send('rushes:event', {
          event: 'open-recording',
          id: e.recordingId ?? currentId,
        });
      if (library.webContents.isLoading())
        library.webContents.once('did-finish-load', () => setTimeout(openReview, 100));
      else openReview();
    }
    trayUpdate();
  });
  supervisor.client.on('engine-error', (e) => broadcast({ event: 'error', ...e }));
  supervisor.client.on('disconnected', () =>
    broadcast({
      event: 'error',
      message: 'Native engine disconnected. Relaunch Rushes to reconnect.',
    }),
  );
  try {
    await supervisor.start();
    const live = await supervisor.client.request('status');
    state = live.state;
    supervisor.active = ['recording', 'paused', 'preparing', 'finishing'].includes(state);
    if (supervisor.active) {
      currentId = live.recording?.recordingID;
      bar();
    }
    broadcast({ event: 'engine-ready' });
    trayUpdate();
  } catch (error) {
    broadcast({ event: 'error', message: String(error) });
    void dialog.showMessageBox({
      type: 'error',
      message: 'The native recording engine could not start.',
      detail: `${String(error)}\nEngine: ${enginePath}`,
    });
  }
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
          const waitFor = async (predicate: () => Promise<boolean>) => {
            for (let i = 0; i < 80; i++) {
              if (await predicate()) return;
              await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error('UI recording smoke state timed out');
          };
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
            `document.querySelector('.recording-card')?.click()`,
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
  app.on('second-instance', () => windowFor('recorder'));
  void app.whenReady().then(ready);
}
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void supervisor.quit().finally(() => {
    globalShortcut.unregisterAll();
    app.quit();
  });
});
