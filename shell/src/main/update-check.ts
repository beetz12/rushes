// Tells people when a newer Rushes release exists. It never downloads or runs anything:
// preview builds are ad hoc signed, so in-place updates cannot work until notarized builds exist.
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJSON } from './atomic';
import type { UpdateRelease, UpdateResult, UpdateStatus } from '../shared/updates';

export const RELEASES_PAGE = 'https://github.com/beetz12/rushes/releases';
const API = 'https://api.github.com/repos/beetz12/rushes/releases';
const REPO_PATH = '/beetz12/rushes/releases';
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const NOTICE_RETRY_MS = 60_000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REMEMBERED = 20;

export type Channel = 'stable' | 'preview';
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// --- versions ---------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const NUMBER = /^(?:0|[1-9]\d*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;

// MAJOR.MINOR.PATCH, an optional -prerelease and an optional +build, with an optional leading "v".
export function parseSemver(value: string): Semver | undefined {
  let rest = value.trim().replace(/^v/, '');
  const plus = rest.indexOf('+');
  if (plus >= 0) {
    if (
      !rest
        .slice(plus + 1)
        .split('.')
        .every((part) => IDENTIFIER.test(part))
    )
      return undefined;
    rest = rest.slice(0, plus);
  }
  const dash = rest.indexOf('-');
  const core = dash >= 0 ? rest.slice(0, dash) : rest;
  const pre = dash >= 0 ? rest.slice(dash + 1).split('.') : [];
  const numbers = core.split('.');
  if (numbers.length !== 3 || !numbers.every((part) => NUMBER.test(part))) return undefined;
  if (pre.some((part) => !IDENTIFIER.test(part) || (/^\d+$/.test(part) && !NUMBER.test(part))))
    return undefined;
  const [major, minor, patch] = numbers.map(Number);
  return { major, minor, patch, pre };
}

// Semantic Versioning 2.0.0 precedence. Returns <0, 0 or >0; undefined if either side is not semver.
export function compareVersions(a: string, b: string): number | undefined {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return undefined;
  for (const key of ['major', 'minor', 'patch'] as const)
    if (x[key] !== y[key]) return x[key] - y[key];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// --- URL allowlist ----------------------------------------------------------

function githubURL(value: unknown, prefix: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
  if (url.port || url.username || url.password) return undefined;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return undefined;
  return url.href;
}

// Only this repository's release pages may ever be opened in the browser.
export function safeReleaseURL(value: unknown): string | undefined {
  return githubURL(value, REPO_PATH);
}

function safeAssetURL(value: unknown): string | undefined {
  return githubURL(value, REPO_PATH + '/download');
}

// --- release parsing --------------------------------------------------------

const releaseSchema = z.object({
  tag_name: z.string().max(200),
  html_url: z.string().max(2000).optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z
    .array(z.object({ name: z.string().max(500), browser_download_url: z.string().max(2000) }))
    .max(200)
    .optional(),
});

const ASSET_NAME = /^Rushes-.+-arm64(?:-[a-z-]+)?\.dmg$/;

export function toRelease(value: unknown, channel: Channel): UpdateRelease | undefined {
  const parsed = releaseSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const release = parsed.data;
  if (release.draft === true) return undefined;
  const prerelease = release.prerelease === true;
  if (prerelease && channel !== 'preview') return undefined;
  const version = release.tag_name.replace(/^v/, '');
  if (!parseSemver(version)) return undefined;
  const asset = release.assets
    ?.filter((a) => ASSET_NAME.test(a.name))
    .map((a) => safeAssetURL(a.browser_download_url))
    .find(Boolean);
  return {
    version,
    pageURL: safeReleaseURL(release.html_url) ?? RELEASES_PAGE,
    ...(asset ? { assetURL: asset } : {}),
    prerelease,
  };
}

export function newestRelease(values: unknown[], channel: Channel): UpdateRelease | undefined {
  let best: UpdateRelease | undefined;
  for (const value of values) {
    const release = toRelease(value, channel);
    if (release && (!best || (compareVersions(release.version, best.version) ?? 0) > 0))
      best = release;
  }
  return best;
}

// --- build channel ----------------------------------------------------------

type Exec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

// A build is a preview unless it is a packaged, Developer ID signed app with a plain version.
export async function detectChannel(
  version: string,
  options: { packaged: boolean; appPath?: string; exec?: Exec },
): Promise<Channel> {
  if (parseSemver(version)?.pre.length) return 'preview';
  if (!options.packaged || !options.appPath || !options.exec) return 'preview';
  try {
    const { stdout, stderr } = await options.exec('/usr/bin/codesign', [
      '-dv',
      '--verbose=2',
      options.appPath,
    ]);
    return /^Authority=Developer ID Application:/m.test(stderr + '\n' + stdout)
      ? 'stable'
      : 'preview';
  } catch {
    return 'preview';
  }
}

// --- saved state ------------------------------------------------------------

const releaseRecordSchema = z
  .object({
    version: z.string().max(200),
    pageURL: z.string().max(2000),
    assetURL: z.string().max(2000).optional(),
    prerelease: z.boolean(),
  })
  .strict();

const stateSchema = z
  .object({
    version: z.literal(1),
    automatic: z.boolean(),
    notified: z.array(z.string().max(200)).max(MAX_REMEMBERED),
    cache: z
      .object({
        url: z.string().max(2000),
        etag: z.string().max(200),
        release: releaseRecordSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
type SavedState = z.infer<typeof stateSchema>;
const defaults = (): SavedState => ({ version: 1, automatic: true, notified: [] });

// --- checker ----------------------------------------------------------------

export interface UpdateCheckerOptions {
  version: string;
  channel: Channel | (() => Promise<Channel>);
  statePath: string;
  fetch: Fetch;
  // True while a recording, countdown or start is in progress: notices wait until it ends.
  busy: () => boolean;
  // Shows a desktop notice; returns false if it could not be shown.
  notify: (title: string, body: string, onClick: () => void) => boolean;
  openExternal: (url: string) => unknown;
  now?: () => number;
  timeoutMs?: number;
}

export class UpdateChecker {
  private saved?: SavedState;
  private loading?: Promise<SavedState>;
  private writes: Promise<unknown> = Promise.resolve();
  private inflight?: Promise<UpdateResult>;
  private last?: UpdateResult;
  private channel?: Channel;
  private pending?: UpdateRelease;
  private firstTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private options: UpdateCheckerOptions) {}

  start() {
    this.stopped = false;
    if (this.firstTimer || this.interval) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      void this.scheduled();
      this.interval = setInterval(() => void this.scheduled(), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.firstTimer);
    clearInterval(this.interval);
    clearTimeout(this.noticeTimer);
    this.firstTimer = this.interval = this.noticeTimer = undefined;
  }

  // Resolves once saved preferences reach disk.
  async flushed() {
    await this.writes.catch(() => {});
  }

  async status(): Promise<UpdateStatus> {
    const saved = await this.load();
    return {
      automatic: saved.automatic,
      current: this.options.version,
      ...(this.channel ? { channel: this.channel } : {}),
      checking: this.inflight !== undefined,
      ...(this.last ? { last: this.last } : {}),
    };
  }

  async setAutomatic(enabled: boolean): Promise<UpdateStatus> {
    await this.save((state) => ({ ...state, automatic: enabled }));
    return this.status();
  }

  // Manual "Check now": shows the result in Settings; the person has seen it, so no notice follows.
  async checkNow(): Promise<UpdateResult> {
    const result = await this.check();
    if (result.state === 'available') await this.remember(result.release.version);
    return result;
  }

  async openRelease(url?: string) {
    const target =
      safeReleaseURL(url) ??
      (this.last?.state === 'available' ? this.last.release.pageURL : undefined) ??
      RELEASES_PAGE;
    const safe = safeReleaseURL(target);
    if (!safe) throw new Error('Refusing to open a link outside the Rushes releases page');
    await this.options.openExternal(safe);
  }

  // One network request at a time; failures wait for the next daily check, never a retry loop.
  check(): Promise<UpdateResult> {
    this.inflight ??= this.request().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async scheduled() {
    if (this.stopped) return;
    const saved = await this.load();
    if (!saved.automatic) return;
    const result = await this.check();
    if (result.state !== 'available') return;
    if ((await this.load()).notified.includes(result.release.version)) return;
    this.pending = result.release;
    this.showPending();
  }

  private showPending() {
    const release = this.pending;
    if (!release || this.stopped) return;
    if (this.options.busy()) {
      // Never interrupt a recording or countdown; try again later without touching the network.
      this.noticeTimer ??= setTimeout(() => {
        this.noticeTimer = undefined;
        this.showPending();
      }, NOTICE_RETRY_MS);
      return;
    }
    this.pending = undefined;
    const shown = this.options.notify(
      `Rushes ${release.version} is available`,
      'Click to open the release page. Updates are installed by hand for now.',
      () => void this.openRelease(release.pageURL).catch(() => {}),
    );
    if (shown) void this.remember(release.version).catch(() => {});
  }

  private async remember(version: string) {
    await this.save((state) =>
      state.notified.includes(version)
        ? state
        : { ...state, notified: [...state.notified, version].slice(-MAX_REMEMBERED) },
    );
  }

  private async request(): Promise<UpdateResult> {
    const checkedAt = (this.options.now ?? Date.now)();
    let result: UpdateResult;
    try {
      const release = await this.latest();
      const current = this.options.version;
      result =
        release && (compareVersions(release.version, current) ?? 0) > 0
          ? { state: 'available', checkedAt, release }
          : { state: 'up-to-date', checkedAt };
    } catch (error) {
      result = {
        state: 'error',
        checkedAt,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.last = result;
    return result;
  }

  private async latest(): Promise<UpdateRelease | undefined> {
    const channel = (this.channel ??=
      typeof this.options.channel === 'function'
        ? await this.options.channel()
        : this.options.channel);
    // GitHub's /latest skips drafts and prereleases; preview builds read the short list instead.
    const url = channel === 'stable' ? `${API}/latest` : `${API}?per_page=20`;
    const saved = await this.load();
    const cached = saved.cache?.url === url ? saved.cache : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // A generic product name and version only: no identifiers, no telemetry.
      'User-Agent': `Rushes/${this.options.version}`,
    };
    if (cached) headers['If-None-Match'] = cached.etag;
    const response = await this.options.fetch(url, {
      method: 'GET',
      headers,
      credentials: 'omit',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (response.status === 304 && cached) return cached.release ?? undefined;
    // No published release yet.
    if (response.status === 404 && channel === 'stable') return undefined;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('Release information was too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('Release information was not valid JSON');
    }
    if (channel === 'preview' && !Array.isArray(body))
      throw new Error('Release list had an unexpected shape');
    if (channel === 'stable' && !releaseSchema.safeParse(body).success)
      throw new Error('Release information had an unexpected shape');
    const release = Array.isArray(body)
      ? newestRelease(body.slice(0, 100), channel)
      : toRelease(body, channel);
    const etag = response.headers.get('etag');
    if (etag && etag.length <= 200)
      await this.save((state) => ({ ...state, cache: { url, etag, release: release ?? null } }));
    return release;
  }

  private load(): Promise<SavedState> {
    if (this.saved) return Promise.resolve(this.saved);
    this.loading ??= this.read().then((value) => (this.saved = value));
    return this.loading;
  }

  private async read(): Promise<SavedState> {
    try {
      const info = await lstat(this.options.statePath);
      if (!info.isFile() || info.size > 64 * 1024) return defaults();
      return stateSchema.parse(JSON.parse(await readFile(this.options.statePath, 'utf8')));
    } catch {
      // Missing or damaged update preferences fall back to defaults; updates are never critical.
      return defaults();
    }
  }

  private save(change: (state: SavedState) => SavedState): Promise<void> {
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        const next = change(await this.load());
        if (next === this.saved) return;
        this.saved = next;
        await atomicJSON(this.options.statePath, next);
      });
    this.writes = operation;
    return operation;
  }
}
