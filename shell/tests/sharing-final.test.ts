import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fixtures from 'node:fs/promises';
import * as fixturePaths from 'node:path';
import * as fixtureHost from 'node:os';
import { createConnection } from 'node:net';
import { SharingService, type ShareProvider } from '../src/main/sharing';
import { createShareDispatcher } from '../src/main/share-dispatch';
import { startShellServer } from '../src/main/shell-server';
import { AutoShare, ViewNotifications } from '../src/main/share-lifecycle';
import { defaultOptions, recordingOptionsSchema } from '../src/shared/contracts';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fixtures.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fixtures.mkdtemp(
    fixturePaths.join(fixtureHost.tmpdir(), 'rushes-final-share-'),
  );
  roots.push(root);
  const reservation = {
    id: 'stable-id',
    url: 'https://example.invalid/s/stable-id',
    manifest: { status: 'processing' },
  };
  const feedback = {
    views: 4,
    comments: [
      {
        id: 'comment',
        name: 'Viewer',
        body: 'Helpful',
        timestampMs: 83000,
        createdAt: '2026-10-11T12:00:00Z',
      },
    ],
    reactions: [{ kind: 'like' as const, count: 2 }],
  };
  const provider: ShareProvider = {
    reserve: vi.fn(async () => reservation),
    upload: vi.fn(async (_share, input) => ({
      file: input.kind + '-abcd',
      bytes: 10,
      sha256: 'abcd',
      kind: input.kind,
    })),
    publish: vi.fn(async (share, input) => ({
      ...share,
      manifest: { ...share.manifest, ...input, status: 'ready' },
    })),
    updateMetadata: vi.fn(async (share) => share),
    delete: vi.fn(async () => {}),
    setupCheck: vi.fn(async () => ({ ok: true })),
    getPolicy: vi.fn(async () => ({ protected: true, expiresAt: null })),
    updatePolicy: vi.fn(async () => ({ protected: true, expiresAt: null })),
    feedback: vi.fn(async () => feedback),
  };
  const engine = {
    request: vi.fn(async (cmd: string) => {
      if (cmd === 'show')
        return {
          packagePath: root,
          manifest: { title: 'Fixture', clock: { durationNs: 3000000000 } },
        };
      if (cmd === 'list') return { recordings: [{ id: 'take', folder: root, title: 'Fixture' }] };
      if (cmd === 'share.assets')
        return {
          videoPath: root + '/video',
          posterPath: root + '/poster',
          captionsPath: root + '/projected.vtt',
          width: 640,
          height: 480,
          durationMs: 3000,
          title: 'Fixture',
          chapters: [],
          cacheKey: 'render-key',
          editRevision: 3,
          editSnapshot: { clips: [{ sourceStartMs: 100, sourceEndMs: 3100 }], revision: 3 },
        };
      throw new Error('Unsupported fixture command');
    }),
  };
  let identity = 'worker:fixture',
    version = 0;
  const events = vi.fn();
  const service = new SharingService(
    engine,
    async () => provider,
    () => identity,
    events,
    () => version,
  );
  const copy = vi.fn();
  const dispatch = createShareDispatcher(service, {
    copy,
    configure: vi.fn(),
    configuration: vi.fn(),
    setup: vi.fn(),
  });
  return {
    root,
    reservation,
    provider,
    engine,
    events,
    service,
    dispatch,
    copy,
    changeProvider: (next = identity) => {
      identity = next;
      version++;
    },
  };
}
async function socketRequest(path: string, value: object, splitAt?: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path);
    client.setEncoding('utf8');
    client.setTimeout(2000, () => {
      client.destroy();
      reject(new Error('Fixture socket deadline'));
    });
    client.once('error', reject);
    let buffer = '';
    client.once('connect', () => {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (splitAt === undefined) client.write(bytes);
      else {
        client.write(bytes.subarray(0, splitAt));
        setTimeout(() => client.write(bytes.subarray(splitAt)), 10);
      }
    });
    client.on('data', (data) => {
      buffer += data;
      if (buffer.includes('\n')) {
        client.destroy();
        resolve(JSON.parse(buffer.trim()));
      }
    });
  });
}

describe('closed private sharing dispatch and policy', () => {
  it('reads actual share status over the socket without deleting or modifying the published state', async () => {
    const rig = await fixture();
    await rig.service.share('take', true);
    const path = fixturePaths.join(rig.root, 'share', 'state.json');
    const before = await fixtures.readFile(path, 'utf8');
    const socketPath = fixturePaths.join(rig.root, 'shell.sock');
    const server = await startShellServer(socketPath, rig.dispatch);
    try {
      expect(
        await socketRequest(socketPath, {
          id: 'status',
          cmd: 'share.status',
          args: { id: 'take' },
        }),
      ).toEqual({
        id: 'status',
        ok: true,
        result: { id: 'take', state: 'ready', providerMatches: true, url: rig.reservation.url },
      });
      const invalid = await socketRequest(socketPath, {
        id: 'bad',
        cmd: 'share.unknown',
        args: { id: 'take' },
      });
      expect(invalid.ok).toBe(false);
      await expect(rig.dispatch('share.unknown', { id: 'take' })).rejects.toMatchObject({
        code: 'unknown-command',
      });
      expect(rig.provider.delete).not.toHaveBeenCalled();
      expect(await fixtures.readFile(path, 'utf8')).toBe(before);
      expect(rig.copy).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('passes flat set/change/remove policy to the stable share and never persists or returns a clear password', async () => {
    const rig = await fixture();
    await rig.service.share('take', true);
    const path = fixturePaths.join(rig.root, 'share', 'state.json');
    const before = await fixtures.readFile(path, 'utf8');
    const secret = 'only-in-transit-🔑';
    vi.mocked(rig.provider.updatePolicy!).mockResolvedValueOnce({
      protected: true,
      expiresAt: null,
      password: secret,
    } as any);
    expect(await rig.dispatch('share.policy.set', { id: 'take', password: secret })).toEqual({
      protected: true,
      expiresAt: null,
    });
    expect(rig.provider.updatePolicy).toHaveBeenLastCalledWith('stable-id', { password: secret });
    expect(await rig.dispatch('share.policy.get', { id: 'take' })).toEqual({
      protected: true,
      expiresAt: null,
    });
    const expiresAt = '2099-01-01T12:00:00Z';
    await rig.dispatch('share.policy.set', { id: 'take', expiresAt });
    expect(rig.provider.updatePolicy).toHaveBeenLastCalledWith('stable-id', { expiresAt });
    await rig.dispatch('share.policy.set', { id: 'take', password: null, expiresAt: null });
    expect(rig.provider.updatePolicy).toHaveBeenLastCalledWith('stable-id', {
      password: null,
      expiresAt: null,
    });
    expect(await fixtures.readFile(path, 'utf8')).toBe(before);
    expect(JSON.stringify(rig.events.mock.calls)).not.toContain(secret);
    expect(rig.provider.publish).toHaveBeenCalledTimes(1);
    expect(JSON.parse(before).reservation.manifest.captions).toEqual([
      { file: 'captions-abcd', lang: 'en' },
    ]);
    vi.mocked(rig.provider.updatePolicy!).mockRejectedValueOnce(
      new Error('provider echoed ' + secret),
    );
    await expect(
      rig.dispatch('share.policy.set', { id: 'take', password: secret }),
    ).rejects.toThrow('Could not read or update link access');
    expect(await fixtures.readFile(path, 'utf8')).toBe(before);
  });
  it('decodes a Unicode password split inside its UTF-8 bytes over the real socket', async () => {
    const rig = await fixture();
    await rig.service.share('take', true);
    const socketPath = fixturePaths.join(rig.root, 'unicode.sock');
    const server = await startShellServer(socketPath, rig.dispatch);
    try {
      const password = '測試🔑abcdefgh';
      const request = { id: 'unicode', cmd: 'share.policy.set', args: { id: 'take', password } };
      const splitAt = Buffer.from(JSON.stringify(request)).indexOf(Buffer.from('🔑')) + 2;
      const result = await socketRequest(socketPath, request, splitAt);
      expect(result.ok).toBe(true);
      expect(rig.provider.updatePolicy).toHaveBeenLastCalledWith('stable-id', { password });
      expect(JSON.stringify(result)).not.toContain(password);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('protects a new reservation before clipboard exposure and rejects unsupported bucket policy', async () => {
    const rig = await fixture();
    await rig.dispatch('share', {
      id: 'take',
      password: 'first-password',
      expiresAt: '2099-01-01T00:00:00Z',
      wait: true,
    });
    expect(rig.provider.reserve).toHaveBeenCalledWith({
      title: 'Fixture',
      durationMs: 3000,
      password: 'first-password',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(rig.copy).toHaveBeenCalledWith(rig.reservation.url);
    expect(
      await fixtures.readFile(fixturePaths.join(rig.root, 'share', 'state.json'), 'utf8'),
    ).not.toContain('first-password');
    const bucket = await fixture();
    bucket.changeProvider('bucket:fixture');
    const unsupported = () => {
      throw Object.assign(new Error('Unsupported bucket feature'), {
        code: 'SHARE_FEATURE_UNSUPPORTED',
      });
    };
    bucket.provider.getPolicy = vi.fn(unsupported);
    bucket.provider.updatePolicy = vi.fn(unsupported);
    bucket.provider.feedback = vi.fn(unsupported);
    await expect(
      bucket.dispatch('share', { id: 'take', password: 'no-downgrade' }),
    ).rejects.toMatchObject({ code: 'share-feature-unsupported' });
    expect(bucket.provider.reserve).not.toHaveBeenCalled();
    await bucket.service.share('take', true);
    await expect(bucket.service.getPolicy('take')).rejects.toMatchObject({
      code: 'share-feature-unsupported',
    });
    await expect(bucket.service.feedback('take')).rejects.toMatchObject({
      code: 'share-feature-unsupported',
    });
  });
  it('rejects invalid policy and provider changes, including credentials changed during an owner read', async () => {
    const rig = await fixture();
    await rig.service.share('take', true);
    await expect(
      rig.dispatch('share.policy.set', { id: 'take', password: 'short' }),
    ).rejects.toThrow();
    await expect(
      rig.dispatch('share.policy.set', { id: 'take', expiresAt: '2000-01-01T00:00:00Z' }),
    ).rejects.toThrow();
    expect(rig.provider.updatePolicy).not.toHaveBeenCalled();
    let finish!: (value: any) => void;
    vi.mocked(rig.provider.feedback!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = rig.service.feedback('take');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    rig.changeProvider();
    finish({ views: 100, comments: [], reactions: [] });
    await expect(pending).rejects.toMatchObject({ code: 'share-provider-mismatch' });
    rig.changeProvider('worker:another-account');
    await expect(rig.service.getPolicy('take')).rejects.toMatchObject({
      code: 'share-provider-mismatch',
    });
    expect((await rig.service.status('take')).providerMatches).toBe(false);
  });
  it('polls authenticated feedback and never fabricates zero views from a failed owner response', async () => {
    const rig = await fixture();
    await rig.service.share('take', true);
    expect(await rig.dispatch('share.feedback', { id: 'take' })).toMatchObject({
      views: 4,
      comments: [{ timestampMs: 83000 }],
    });
    expect(rig.provider.feedback).toHaveBeenCalledWith('stable-id');
    vi.mocked(rig.provider.feedback!).mockRejectedValueOnce(
      new Error('Sensitive remote diagnostic'),
    );
    expect(await rig.service.feedbackSnapshots()).toEqual([]);
    expect(rig.events).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'share-feedback-poll-failed' }),
    );
    expect(JSON.stringify(rig.events.mock.calls)).not.toContain('Sensitive remote diagnostic');
    expect((await rig.service.feedbackSnapshots())[0].feedback.views).toBe(4);
    rig.changeProvider('worker:other');
    expect(await rig.service.feedbackSnapshots()).toEqual([]);
  });
});

describe('automatic sharing and new-play notifications', () => {
  it('defaults auto-share off, copies a reserved URL before background rendering, surfaces failures and allows manual retry', async () => {
    const { autoShare: _autoShare, ...legacy } = defaultOptions;
    expect(recordingOptionsSchema.parse(legacy).autoShare).toBe(false);
    const rig = await fixture();
    let rejectRender!: (error: Error) => void;
    const original = rig.engine.request.getMockImplementation()!;
    rig.engine.request.mockImplementationOnce(original);
    rig.engine.request.mockImplementation(async (cmd) => {
      if (cmd === 'share.assets')
        return new Promise((_resolve, reject) => {
          rejectRender = reject;
        });
      return original(cmd);
    });
    const auto = new AutoShare((id) => rig.service.share(id), rig.copy, rig.events);
    await auto.recordingStopped('off', false);
    expect(rig.provider.reserve).not.toHaveBeenCalled();
    await auto.recordingStopped('take', true);
    expect(rig.copy).toHaveBeenCalledWith(rig.reservation.url);
    expect(rig.provider.upload).not.toHaveBeenCalled();
    expect(
      rig.events.mock.calls.find(([value]) => value.event === 'share-link-copied')?.[0].elapsedMs,
    ).toBeLessThan(2000);
    await auto.recordingStopped('take', true);
    expect(rig.provider.reserve).toHaveBeenCalledTimes(1);
    rejectRender(new Error('Fixture render failed'));
    await vi.waitFor(() =>
      expect(rig.events).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'share-progress', state: 'failed' }),
      ),
    );
    rig.engine.request.mockImplementation(original);
    expect(await rig.dispatch('share', { id: 'take', wait: true })).toMatchObject({
      state: 'ready',
    });
    expect(rig.provider.reserve).toHaveBeenCalledTimes(1);
  });
  it('reports automatic reservation failure without copying and permits a user initiated share later', async () => {
    const rig = await fixture();
    vi.mocked(rig.provider.reserve).mockRejectedValueOnce(new Error('Fixture network failure'));
    const auto = new AutoShare((id) => rig.service.share(id), rig.copy, rig.events);
    await auto.recordingStopped('take', true);
    expect(rig.copy).not.toHaveBeenCalled();
    expect(rig.events).toHaveBeenCalledWith(expect.objectContaining({ code: 'auto-share-failed' }));
    expect(await rig.dispatch('share', { id: 'take', wait: true })).toMatchObject({
      state: 'ready',
    });
  });
  it('baselines historical views, polls every 5 minutes, deduplicates and keeps counts through failed polls', async () => {
    vi.useFakeTimers();
    let views = 12;
    const load = vi.fn(async () => [
      {
        key: 'worker:owner:share',
        id: 'take',
        title: 'Fixture',
        feedback: { views, comments: [], reactions: [] },
      },
    ]);
    const emit = vi.fn(),
      notify = vi.fn();
    const poller = new ViewNotifications(load, emit, notify);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
    views = 14;
    await vi.advanceTimersByTimeAsync(299999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith('Fixture', '2 new plays · 14 total');
    await poller.poll();
    expect(notify).toHaveBeenCalledTimes(1);
    load.mockRejectedValueOnce(new Error('Fixture network failure'));
    await poller.poll();
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'share-feedback-poll-failed' }),
    );
    views = 1;
    await poller.poll();
    views = 14;
    await poller.poll();
    expect(notify).toHaveBeenCalledTimes(1);
    views = 15;
    await poller.poll();
    expect(notify).toHaveBeenLastCalledWith('Fixture', '1 new play · 15 total');
    poller.stop();
    await vi.advanceTimersByTimeAsync(300000);
    expect(load).toHaveBeenCalledTimes(7);
  });
  it('does not notify from a request completing after Quit and gives a new provider a silent baseline', async () => {
    let release!: (value: any) => void;
    const load = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          release = resolve;
        }),
    );
    const emit = vi.fn(),
      notify = vi.fn();
    const poller = new ViewNotifications(load, emit, notify);
    const pending = poller.poll();
    poller.stop();
    release([
      {
        key: 'old-provider',
        id: 'take',
        title: 'Fixture',
        feedback: { views: 200, comments: [], reactions: [] },
      },
    ]);
    await pending;
    expect(emit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const restarted = new ViewNotifications(
      async () => [
        {
          key: 'new-provider',
          id: 'take',
          title: 'Fixture',
          feedback: { views: 1000, comments: [], reactions: [] },
        },
      ],
      emit,
      notify,
    );
    await restarted.poll();
    expect(notify).not.toHaveBeenCalled();
  });
});
