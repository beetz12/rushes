import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  NOTICE_RETRY_MS,
  RELEASES_PAGE,
  UpdateChecker,
  compareVersions,
  detectChannel,
  newestRelease,
  safeReleaseURL,
  toRelease,
  type Channel,
} from '../src/main/update-check';
import { describeUpdateResult, updateActionSchema } from '../src/shared/updates';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function release(version: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/beetz12/rushes/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: `Rushes-${version}-arm64-unsigned-preview.zip`,
        browser_download_url: `https://github.com/beetz12/rushes/releases/download/v${version}/Rushes-${version}-arm64-unsigned-preview.zip`,
      },
      {
        name: `Rushes-${version}-arm64-unsigned-preview.dmg`,
        browser_download_url: `https://github.com/beetz12/rushes/releases/download/v${version}/Rushes-${version}-arm64-unsigned-preview.dmg`,
      },
    ],
    ...extra,
  };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    ...init,
  });
}

async function setup(
  options: {
    version?: string;
    channel?: Channel;
    responses?: Array<Response | Error>;
    busy?: () => boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'rushes-updates-'));
  roots.push(root);
  const statePath = join(root, 'updates.json');
  const queue = [...(options.responses ?? [])];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const notices: Array<{ title: string; click: () => void }> = [];
  const opened: string[] = [];
  const make = () =>
    new UpdateChecker({
      version: options.version ?? '0.1.0',
      channel: options.channel ?? 'stable',
      statePath,
      fetch,
      busy: options.busy ?? (() => false),
      notify: (title, _body, click) => {
        notices.push({ title, click });
        return true;
      },
      openExternal: (url) => opened.push(url),
    });
  return { statePath, fetch, requests, notices, opened, make, queue };
}

describe('version comparison', () => {
  it.each([
    ['0.2.0', '0.1.0', 1],
    ['0.1.0', '0.2.0', -1],
    ['1.0.0', '1.0.0', 0],
    ['v1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.0-beta.2', 1],
    ['1.0.0-beta.10', '1.0.0-beta.2', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
    ['0.10.0', '0.9.9', 1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b)!)).toBe(sign);
  });
  it('rejects non-semver tags', () => {
    for (const bad of ['1.0', '01.0.0', '1.0.0-', '1.0.0-01', '1.0.0+', 'latest'])
      expect(compareVersions(bad, '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
    expect(compareVersions('preview-abc123', '0.1.0')).toBeUndefined();
    expect(
      toRelease(release('x', { tag_name: 'preview-0123456789ab' }), 'preview'),
    ).toBeUndefined();
  });
});

describe('release selection', () => {
  it('picks the arm64 dmg and the allowlisted release page', () => {
    expect(toRelease(release('0.2.0'), 'stable')).toEqual({
      version: '0.2.0',
      pageURL: 'https://github.com/beetz12/rushes/releases/tag/v0.2.0',
      assetURL:
        'https://github.com/beetz12/rushes/releases/download/v0.2.0/Rushes-0.2.0-arm64-unsigned-preview.dmg',
      prerelease: false,
    });
  });
  it('drops off-repo asset and page links', () => {
    const r = toRelease(
      release('0.2.0', {
        html_url: 'https://evil.example/beetz12/rushes/releases',
        assets: [
          { name: 'Rushes-0.2.0-arm64.dmg', browser_download_url: 'https://evil.example/x.dmg' },
        ],
      }),
      'stable',
    );
    expect(r?.pageURL).toBe(RELEASES_PAGE);
    expect(r?.assetURL).toBeUndefined();
  });
  it('ignores drafts always and prereleases unless this build is a preview', () => {
    expect(toRelease(release('0.3.0', { draft: true }), 'preview')).toBeUndefined();
    expect(toRelease(release('0.3.0', { prerelease: true }), 'stable')).toBeUndefined();
    expect(toRelease(release('0.3.0', { prerelease: true }), 'preview')?.version).toBe('0.3.0');
    const list = [
      release('0.2.0'),
      release('0.4.0', { draft: true }),
      release('0.3.0-beta.1', { prerelease: true }),
    ];
    expect(newestRelease(list, 'preview')?.version).toBe('0.3.0-beta.1');
    expect(newestRelease(list, 'stable')?.version).toBe('0.2.0');
  });
});

describe('URL allowlist', () => {
  it.each([
    ['https://github.com/beetz12/rushes/releases', true],
    ['https://github.com/beetz12/rushes/releases/tag/v1.0.0', true],
    ['https://github.com/beetz12/rushes/releases/../../other/repo', false],
    ['http://github.com/beetz12/rushes/releases', false],
    ['https://github.com.evil.example/beetz12/rushes/releases', false],
    ['https://user@github.com/beetz12/rushes/releases', false],
    ['https://github.com:8443/beetz12/rushes/releases', false],
    ['https://github.com/beetz12/rushes/releasesX', false],
    ['https://github.com/someone/rushes/releases', false],
    ['javascript:alert(1)', false],
    [42, false],
  ])('%s -> %s', (url, ok) => {
    expect(safeReleaseURL(url) !== undefined).toBe(ok);
  });
  it('never opens a link outside the release page', async () => {
    const t = await setup();
    await t.make().openRelease('https://evil.example/');
    expect(t.opened).toEqual([RELEASES_PAGE]);
  });
});

describe('build channel', () => {
  const exec = (stderr: string) => async () => ({ stdout: '', stderr });
  it('treats prerelease versions, dev builds and ad hoc signatures as previews', async () => {
    expect(
      await detectChannel('1.0.0-beta.1', { packaged: true, appPath: '/A', exec: exec('') }),
    ).toBe('preview');
    expect(await detectChannel('1.0.0', { packaged: false })).toBe('preview');
    expect(
      await detectChannel('1.0.0', {
        packaged: true,
        appPath: '/A',
        exec: exec('Signature=adhoc'),
      }),
    ).toBe('preview');
    const failing = async () => {
      throw new Error('codesign missing');
    };
    expect(await detectChannel('1.0.0', { packaged: true, appPath: '/A', exec: failing })).toBe(
      'preview',
    );
    expect(
      await detectChannel('1.0.0', {
        packaged: true,
        appPath: '/A',
        exec: exec('Authority=Developer ID Application: Someone (TEAM)\nAuthority=Apple Root CA'),
      }),
    ).toBe('stable');
  });
});

describe('checking', () => {
  it('reports a newer version, sending only a generic User-Agent', async () => {
    const t = await setup({ responses: [json(release('0.2.0'))] });
    const result = await t.make().checkNow();
    expect(result).toMatchObject({ state: 'available', release: { version: '0.2.0' } });
    expect(describeUpdateResult(result)).toBe('Version 0.2.0 is available.');
    expect(t.requests[0].url).toBe('https://api.github.com/repos/beetz12/rushes/releases/latest');
    const headers = t.requests[0].init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Rushes/0.1.0');
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'User-Agent', 'X-GitHub-Api-Version']);
    expect(t.requests[0].init.credentials).toBe('omit');
  });
  it.each(['0.1.0', '0.0.9'])('is up to date when the latest is %s', async (latest) => {
    const t = await setup({ responses: [json(release(latest))] });
    const result = await t.make().checkNow();
    expect(result.state).toBe('up-to-date');
    expect(describeUpdateResult(result)).toBe("You're up to date.");
  });
  it('is up to date when nothing is published yet', async () => {
    const t = await setup({ responses: [new Response('{}', { status: 404 })] });
    expect((await t.make().checkNow()).state).toBe('up-to-date');
  });
  it('preview builds read the release list, including prereleases', async () => {
    const t = await setup({
      channel: 'preview',
      responses: [json([release('0.1.0'), release('0.2.0-beta.1', { prerelease: true })])],
    });
    const result = await t.make().checkNow();
    expect(t.requests[0].url).toBe(
      'https://api.github.com/repos/beetz12/rushes/releases?per_page=20',
    );
    expect(result).toMatchObject({ state: 'available', release: { version: '0.2.0-beta.1' } });
  });
  it.each([
    ['malformed JSON', () => json('{not json')],
    ['unexpected shape', () => json({ message: 'hi' })],
    ['server error', () => new Response('', { status: 500 })],
    ['network error', () => new TypeError('fetch failed')],
  ])("says it couldn't check on %s", async (_name, response) => {
    const t = await setup({ responses: [response()] });
    const result = await t.make().checkNow();
    expect(result.state).toBe('error');
    expect(describeUpdateResult(result)).toBe("Couldn't check for updates. Try again later.");
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });
  it('reuses a 304 Not Modified answer through its saved ETag', async () => {
    const t = await setup({
      responses: [
        json(release('0.2.0'), { headers: { ETag: 'W/"abc"' } }),
        new Response(null, { status: 304 }),
      ],
    });
    await t.make().checkNow();
    const saved = JSON.parse(await readFile(t.statePath, 'utf8'));
    expect(saved.cache.etag).toBe('W/"abc"');
    // A fresh launch sends the saved ETag and keeps the cached answer.
    const result = await t.make().check();
    expect((t.requests[1].init.headers as Record<string, string>)['If-None-Match']).toBe('W/"abc"');
    expect(result).toMatchObject({ state: 'available', release: { version: '0.2.0' } });
  });
  it('shares one request between overlapping checks', async () => {
    const t = await setup({ responses: [json(release('0.2.0'))] });
    const checker = t.make();
    await Promise.all([checker.check(), checker.check(), checker.checkNow()]);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });
  it('falls back to defaults when the saved file is damaged', async () => {
    const t = await setup();
    await writeFile(t.statePath, '{broken');
    expect(await t.make().status()).toMatchObject({ automatic: true, current: '0.1.0' });
  });
});

describe('schedule and notices', () => {
  it('first checks a minute after launch, then daily, without retrying failures', async () => {
    vi.useFakeTimers();
    const t = await setup({ responses: [new TypeError('offline'), json(release('0.1.0'))] });
    const checker = t.make();
    await checker.status();
    checker.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(t.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    checker.stop();
  });
  it('skips scheduled checks when automatic checking is off', async () => {
    vi.useFakeTimers();
    const t = await setup();
    const checker = t.make();
    await checker.setAutomatic(false);
    await checker.status();
    checker.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(t.fetch).not.toHaveBeenCalled();
    expect((await t.make().status()).automatic).toBe(false);
    checker.stop();
  });
  it('shows one notice per version, across restarts, and the click opens the release page', async () => {
    vi.useFakeTimers();
    const t = await setup({
      responses: [json(release('0.2.0')), json(release('0.2.0')), json(release('0.2.0'))],
    });
    const first = t.make();
    await first.status();
    first.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(t.notices.map((n) => n.title)).toEqual(['Rushes 0.2.0 is available']);
    t.notices[0].click();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.opened).toEqual(['https://github.com/beetz12/rushes/releases/tag/v0.2.0']);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    first.stop();
    await first.flushed();
    expect(t.fetch).toHaveBeenCalledTimes(2);
    const restarted = t.make();
    await restarted.status();
    restarted.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    restarted.stop();
    expect(t.fetch).toHaveBeenCalledTimes(3);
    expect(t.notices).toHaveLength(1);
  });
  it('defers the notice while recording or counting down, without new requests', async () => {
    vi.useFakeTimers();
    let busy = true;
    const t = await setup({ responses: [json(release('0.2.0'))], busy: () => busy });
    const checker = t.make();
    await checker.status();
    checker.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(t.notices).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(NOTICE_RETRY_MS * 3);
    expect(t.notices).toHaveLength(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(NOTICE_RETRY_MS);
    expect(t.notices).toHaveLength(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    checker.stop();
  });
  it('a manual check counts as seen, so no notice follows for that version', async () => {
    vi.useFakeTimers();
    const t = await setup({ responses: [json(release('0.2.0')), json(release('0.2.0'))] });
    const checker = t.make();
    await checker.checkNow();
    await checker.status();
    checker.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(t.notices).toHaveLength(0);
    checker.stop();
  });
});

describe('settings actions', () => {
  it('accepts only known actions', () => {
    expect(updateActionSchema.safeParse({ action: 'check' }).success).toBe(true);
    expect(updateActionSchema.safeParse({ action: 'set-automatic', enabled: false }).success).toBe(
      true,
    );
    expect(
      updateActionSchema.safeParse({ action: 'open-release', url: 'https://evil' }).success,
    ).toBe(false);
    expect(updateActionSchema.safeParse({ action: 'download' }).success).toBe(false);
  });
});
