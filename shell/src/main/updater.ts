import * as updateFiles from 'node:fs/promises';
import * as updatePaths from 'node:path';
import type { AppUpdater } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { RELEASE_BYTES, ARTIFACT_BYTES, publicReleaseURL, releaseVersion, validateRelease, validateUpdatePolicy,
  type MacRelease } from '../../scripts/release-policy.mjs';

export type UpdateSnapshot = Readonly<{
  status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'restarting' | 'error';
  version?: string;
  transferred?: number;
  total?: number;
  deferred?: boolean;
  reason?: 'development' | 'unavailable' | 'failed';
}>;
type DriverEvent = { kind: 'error' } | { kind: 'progress'; transferred: number; total: number };
export interface UpdateDriver {
  check(): Promise<{ version: string; bytes: number } | null>;
  download(): Promise<void>;
  cancel(): void;
  install(): void;
  listen(listener: (event: DriverEvent) => void): () => void;
}
export interface UpdateCoordinator {
  // Only an affirmative idle reading authorizes work. Exceptions/unknown refuse.
  isBusy(): boolean;
  changed?(snapshot: UpdateSnapshot): void;
}
const CHECK_MS = 30_000, DOWNLOAD_MS = 10 * 60_000;

async function deadline<T>(work: () => Promise<T>, milliseconds: number, expired: () => void): Promise<T> {
  const expires = Date.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired(); reject(new Error('Update operation deadline exceeded.')); }, milliseconds);
    })]);
    if (Date.now() >= expires) throw new Error('Update operation deadline exceeded.');
    return value;
  } finally { clearTimeout(timer); }
}

export async function fetchMacRelease(base: string, fetcher: typeof fetch = fetch, timeoutMs = 15_000): Promise<MacRelease> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) throw new Error('Invalid release request bound.');
  const directory = publicReleaseURL(base), controller = new AbortController();
  const until = Date.now() + timeoutMs;
  const current = () => { if (controller.signal.aborted || Date.now() >= until) throw new Error('Release feed deadline exceeded.'); };
  try { return await deadline(async () => {
    current();
    const response = await fetcher(new URL('latest-mac.json', directory), { signal: controller.signal,
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    current();
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw new Error('Release feed did not return JSON.');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RELEASE_BYTES)) throw new Error('Release feed is too large.');
    if (!response.body) throw new Error('Release feed body is missing.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        current(); const item = await reader.read(); current();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > RELEASE_BYTES) throw new Error('Release feed is too large.');
        chunks.push(item.value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    current();
    return validateRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }, timeoutMs, () => controller.abort()); }
  finally { controller.abort(); }
}

export class ReleaseUpdates {
  private value: UpdateSnapshot;
  private epoch = 0;
  private active: number | undefined;
  private closed = false;
  private restartLock = false;
  private nativeStarted = false;
  private first?: ReturnType<typeof setTimeout>;
  private repeat?: ReturnType<typeof setInterval>;
  private detach: () => void = () => undefined;
  constructor(private driver: UpdateDriver | undefined, private coordinator: UpdateCoordinator,
    reason: 'development' | 'unavailable' = 'unavailable') {
    this.value = Object.freeze(driver ? { status: 'idle' } : { status: 'disabled', reason });
    if (driver) this.detach = driver.listen(event => {
      if (this.closed) return;
      if (event.kind === 'error') { this.fail(); return; }
      if (this.value.status !== 'downloading') return;
      if (!Number.isSafeInteger(event.transferred) || event.transferred < 0 || event.transferred > (this.value.total ?? 0)
        || !Number.isSafeInteger(event.total) || event.total < 0 || (event.total !== 0 && event.total !== this.value.total)) {
        this.fail(); return;
      }
      this.publish({ ...this.value, transferred: event.transferred });
    });
  }
  snapshot(): UpdateSnapshot { return this.value; }
  get blocksCapture(): boolean { return this.restartLock; }
  private idle(): boolean {
    try { return this.coordinator.isBusy() === false; } catch { return false; }
  }
  private publish(value: UpdateSnapshot) {
    this.value = Object.freeze(value);
    try { this.coordinator.changed?.(this.value); } catch { /* The current snapshot remains available to the coordinator. */ }
  }
  private valid(token: number): boolean { return !this.closed && !this.restartLock && this.epoch === token; }
  private fail() {
    this.epoch++; this.driver?.cancel();
    // Mac's committed native quit/install callback has no safe cancellation API.
    if (!this.nativeStarted) this.restartLock = false;
    this.publish(this.nativeStarted ? { status: 'restarting', version: this.value.version, reason: 'failed' }
      : { status: 'error', reason: 'failed' });
  }
  start() {
    if (!this.driver || this.closed || this.repeat) return;
    this.first = setTimeout(() => { void this.check(); }, 15_000);
    this.repeat = setInterval(() => { void this.check(); }, 6 * 60 * 60_000);
    this.first.unref?.(); this.repeat.unref?.();
  }
  activityChanged() {
    if (this.closed || this.restartLock || this.idle()) return;
    if (this.value.status === 'checking' || this.value.status === 'downloading') {
      this.epoch++; this.driver?.cancel(); this.publish({ status: 'idle', deferred: true });
    }
  }
  async check(): Promise<UpdateSnapshot> {
    if (!this.driver || this.closed || this.restartLock || this.active !== undefined || this.value.status === 'downloaded') return this.value;
    if (!this.idle()) { this.publish({ status: 'idle', deferred: true }); return this.value; }
    const token = ++this.epoch; this.active = token; this.publish({ status: 'checking' });
    try {
      const available = await deadline(() => this.driver!.check(), CHECK_MS, () => this.driver?.cancel());
      if (!this.valid(token)) return this.value;
      if (!available) { this.publish({ status: 'idle' }); return this.value; }
      releaseVersion(available.version);
      if (!Number.isSafeInteger(available.bytes) || available.bytes <= 0 || available.bytes > ARTIFACT_BYTES)
        throw new Error('Invalid checked update size.');
      if (!this.idle()) { this.publish({ status: 'idle', deferred: true }); return this.value; }
      this.publish({ status: 'downloading', version: available.version, total: available.bytes, transferred: 0 });
      await deadline(() => this.driver!.download(), DOWNLOAD_MS, () => this.driver?.cancel());
      if (!this.valid(token)) return this.value;
      if (!this.idle()) { this.publish({ status: 'idle', deferred: true }); return this.value; }
      this.publish({ status: 'downloaded', version: available.version });
    } catch { if (this.valid(token)) this.fail(); }
    finally { if (this.active === token) this.active = undefined; }
    return this.value;
  }
  restart(): UpdateSnapshot {
    if (!this.driver || this.closed || this.restartLock || this.active !== undefined || this.value.status !== 'downloaded') return this.value;
    if (!this.idle()) return this.value;
    this.restartLock = true; this.publish({ status: 'restarting', version: this.value.version });
    const notified = this.snapshot();
    if (this.closed || notified.status !== 'restarting' || !this.idle()) {
      this.restartLock = false;
      if (!this.closed && notified.status === 'restarting') this.publish({ status: 'downloaded', version: notified.version });
      return this.value;
    }
    this.nativeStarted = true;
    try { this.driver.install(); } catch { this.fail(); }
    return this.value;
  }
  close() {
    this.closed = true; this.epoch++; clearTimeout(this.first); clearInterval(this.repeat);
    this.driver?.cancel(); this.detach();
    // Do not clear blocksCapture after a committed native restart.
  }
}

type UpstreamInfo = NonNullable<Awaited<ReturnType<AppUpdater['checkForUpdates']>>>['updateInfo'];
export function releaseUpdateInfo(manifest: MacRelease): UpstreamInfo {
  const zip = manifest.files.find(file => file.url.endsWith('.zip'))!;
  return { ...manifest, files: manifest.files.map(file => ({ ...file })), path: zip.url, sha512: zip.sha512 };
}
export function checkedUpdateInfo(value: UpstreamInfo): MacRelease {
  const { path, sha512, ...rest } = value;
  const manifest = validateRelease(rest), zip = manifest.files.find(file => file.url.endsWith('.zip'))!;
  if (path !== zip.url || sha512 !== zip.sha512) throw new Error('Legacy update fields differ from the checked ZIP.');
  return manifest;
}

async function policyAt(resourcesPath: string) {
  const file = await updateFiles.open(updatePaths.join(resourcesPath, 'RushesUpdates.json'), 'r');
  try {
    const bytes = Buffer.alloc(4097), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 4096) throw new Error('Packaged update policy is too large.');
    return validateUpdatePolicy(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')));
  } finally { await file.close(); }
}

export async function createAppUpdater(input: UpdateCoordinator & { packaged: boolean; resourcesPath: string }): Promise<ReleaseUpdates> {
  if (!input.packaged || process.platform !== 'darwin') return new ReleaseUpdates(undefined, input, 'development');
  const expires = Date.now() + 15_000;
  try {
    const policy = await policyAt(input.resourcesPath);
    if (Date.now() >= expires) throw new Error('Update initialization expired.');
    if (!policy.enabled) return new ReleaseUpdates(undefined, input, 'development');
    const baseURL = policy.feedURL;
    const imported = await import('electron-updater'), sdk = imported.default ?? imported;
    if (Date.now() >= expires) throw new Error('Update initialization expired.');
    class PublicMacFeed extends sdk.Provider<UpstreamInfo> {
      constructor(_options: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) { super(runtime); }
      async getLatestVersion(): Promise<UpstreamInfo> {
        const manifest = await fetchMacRelease(baseURL);
        return releaseUpdateInfo(manifest);
      }
      resolveFiles(info: UpstreamInfo) {
        const manifest = checkedUpdateInfo(info);
        return manifest.files.map(file => ({ url: new URL(file.url, baseURL), info: { ...file } }));
      }
    }
    const upstream = new sdk.MacUpdater({ provider: 'custom', updateProvider: PublicMacFeed });
    upstream.autoDownload = false; upstream.autoInstallOnAppQuit = false;
    upstream.allowPrerelease = false; upstream.allowDowngrade = false;
    upstream.disableDifferentialDownload = true;
    let cancellation: NonNullable<Awaited<ReturnType<AppUpdater['checkForUpdates']>>>['cancellationToken'] | undefined;
    let checked: MacRelease | undefined;
    const driver: UpdateDriver = {
      async check() {
        const result = await upstream.checkForUpdates(); cancellation = result?.cancellationToken;
        if (!result?.isUpdateAvailable) { checked = undefined; return null; }
        checked = checkedUpdateInfo(result.updateInfo);
        return { version: checked.version, bytes: checked.files.find(file => file.url.endsWith('.zip'))!.size };
      },
      async download() {
        if (!checked || !cancellation) throw new Error('No checked update is available.');
        const manifest = checked, token = cancellation;
        const files = await upstream.downloadUpdate(token);
        const expected = manifest.files.find(file => file.url.endsWith('.zip'))!.size;
        if (files.length !== 1 || (await updateFiles.stat(files[0])).size !== expected) throw new Error('Downloaded update length differs from its manifest.');
      },
      cancel() { cancellation?.cancel(); },
      install() { upstream.quitAndInstall(); },
      listen(listener) {
        const error = () => listener({ kind: 'error' });
        const progress = (value: { transferred: number; total: number }) => listener({ kind: 'progress', transferred: value.transferred, total: value.total });
        upstream.on('error', error); upstream.on('download-progress', progress);
        return () => { upstream.removeListener('error', error); upstream.removeListener('download-progress', progress); };
      },
    };
    return new ReleaseUpdates(driver, input);
  } catch { return new ReleaseUpdates(undefined, input, 'unavailable'); }
}
