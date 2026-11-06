import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ShareSetup,
  listAccounts,
  readWorkerAssets,
  workerAssetPaths,
  type ShareSetupDeps,
} from '../src/main/share-setup';
import { cloudSettingsSchema, type CloudSettings } from '../src/shared/contracts';
import { REQUIRED_TOKEN_PERMISSIONS, shareSetupSteps } from '../src/shared/share-setup';

// These tests drive the real cloud deployWorker. scripts/check.sh builds cloud/ before
// shell/, so a missing build is a hard failure here, never a silent skip.
const cloudSDK = fileURLToPath(new URL('../../cloud/dist/index.js', import.meta.url));
if (!existsSync(cloudSDK))
  throw new Error(
    'cloud/dist/index.js is missing. Run `npm --prefix cloud run build` before the shell tests.',
  );
const { deployWorker } = (await import(/* @vite-ignore */ cloudSDK)) as {
  deployWorker: ShareSetupDeps['deployWorker'];
};

// Every Cloudflare response below is a local fixture. No real account or token is used.
const TOKEN = 'fixture-cloudflare-token-0123456789abcdef';
const ACCOUNT = 'c'.repeat(32);
const WORKER_URL = 'https://rushes-share.fixture-user.workers.dev';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Call = { method: string; url: string; body?: unknown };
function cloudflare(
  options: {
    subdomain?: string | null;
    r2?: boolean;
    denied?: RegExp;
    fail?: (call: Call) => Response | undefined;
    healthFailures?: number;
  } = {},
) {
  const state = {
    subdomain: options.subdomain === undefined ? 'fixture-user' : options.subdomain,
    buckets: [] as string[],
    databases: [] as Array<{ uuid: string; name: string }>,
    healthFailures: options.healthFailures ?? 0,
    calls: [] as Call[],
    /** OWNER_TOKEN / SESSION_SECRET of every accepted script upload, in order. */
    deployed: [] as Array<{ owner: string; session: string }>,
    /** Virtual time, advanced only by the setup's injected sleep. */
    now: 0,
  };
  // Honour AbortSignal the way fetch does. A timeout signal is modelled against the
  // virtual clock: 15 s after it was first used, it counts as aborted.
  const firstSeen = new WeakMap<AbortSignal, number>();
  const aborted = (signal?: AbortSignal | null) => {
    if (!signal) return false;
    if (signal.aborted) return true;
    if (!firstSeen.has(signal)) firstSeen.set(signal, state.now);
    return state.now - firstSeen.get(signal)! >= 15000;
  };
  const ok = (result: unknown) => Response.json({ success: true, result });
  const fail = (status: number, code: number) =>
    Response.json({ success: false, errors: [{ code, message: 'fixture' }] }, { status });
  const fetcher = (async (request: string | URL | Request, init: RequestInit = {}) => {
    if (aborted(init.signal)) throw new DOMException('The operation was aborted.', 'AbortError');
    const url = String(request),
      method = init.method ?? 'GET',
      parsed = new URL(url),
      path = parsed.pathname;
    const call = { method, url, body: init.body };
    state.calls.push(call);
    if (parsed.hostname.endsWith('.workers.dev')) {
      if (state.healthFailures-- > 0) return new Response('not yet', { status: 503 });
      return Response.json({ ok: true });
    }
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${TOKEN}`) return fail(400, 6003);
    if (options.denied?.test(path)) return fail(403, 10000);
    const injected = options.fail?.(call);
    if (injected) return injected;
    if (path === '/client/v4/accounts') return ok([{ id: ACCOUNT, name: 'Fixture account' }]);
    const base = `/client/v4/accounts/${ACCOUNT}`;
    if (path === base + '/workers/subdomain' && method === 'GET')
      return state.subdomain ? ok({ subdomain: state.subdomain }) : fail(404, 10007);
    if (path === base + '/workers/subdomain' && method === 'PUT') {
      state.subdomain = JSON.parse(String(init.body)).subdomain;
      return ok({ subdomain: state.subdomain });
    }
    if (path === base + '/r2/buckets') {
      if (options.r2 === false) return fail(403, 10042);
      if (method === 'POST') state.buckets.push(JSON.parse(String(init.body)).name);
      return ok({ buckets: state.buckets.map((name) => ({ name })) });
    }
    if (path === base + '/d1/database' && method === 'GET') return ok(state.databases);
    if (path === base + '/d1/database' && method === 'POST') {
      const db = { uuid: 'fixture-db-' + state.databases.length, name: 'rushes-share' };
      state.databases.push(db);
      return ok(db);
    }
    if (path === base + '/workers/scripts/rushes-share' && method === 'PUT') {
      const metadata = JSON.parse(await ((init.body as FormData).get('metadata') as Blob).text());
      const secret = (name: string) =>
        metadata.bindings.find((b: any) => b.type === 'secret_text' && b.name === name).text;
      state.deployed.push({ owner: secret('OWNER_TOKEN'), session: secret('SESSION_SECRET') });
    }
    return ok({});
  }) as typeof fetch;
  return { state, fetcher };
}

// A stand-in for Electron safeStorage plus the app's saveCloud: schema-validated,
// encrypted bytes written to credentials.enc, never plain text.
const fakeSafeStorage = {
  encryptString: (text: string) =>
    Buffer.from('enc1:' + Buffer.from(text).toString('base64').split('').reverse().join('')),
  decryptString: (bytes: Buffer) =>
    Buffer.from(bytes.toString().slice(5).split('').reverse().join(''), 'base64').toString(),
};
async function rig(
  cf: ReturnType<typeof cloudflare>,
  overrides: Partial<ShareSetupDeps> = {},
  previous: CloudSettings = { provider: 'none' },
) {
  const dir = await mkdtemp(join(tmpdir(), 'rushes-share-setup-'));
  roots.push(dir);
  const file = join(dir, 'credentials.enc');
  const events: unknown[] = [];
  const save = vi.fn(async (value: unknown) => {
    const parsed = cloudSettingsSchema.parse(value);
    await writeFile(file, fakeSafeStorage.encryptString(JSON.stringify(parsed)));
  });
  await save(previous);
  save.mockClear();
  const saved = async (): Promise<CloudSettings> =>
    cloudSettingsSchema.parse(JSON.parse(fakeSafeStorage.decryptString(await readFile(file))));
  const test = vi.fn(async () => ({ ok: true }));
  const deps: ShareSetupDeps = {
    fetch: cf.fetcher,
    deployWorker,
    loadAssets: async () => ({ script: 'export default {}', schemaSQL: 'SELECT 1;' }),
    current: saved,
    save,
    test,
    sharesBusy: () => false,
    emit: (event) => events.push(event),
    sleep: async (ms) => void (cf.state.now += ms),
    ...overrides,
  };
  return { file, saved, events, save, test, setup: new ShareSetup(deps) };
}
const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET' && !c.url.includes('.workers.dev'));
function captureConsole() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
    vi.spyOn(console, name).mockImplementation(() => {}),
  );
}
const failOnce = (match: (c: Call) => boolean, status = 500) => {
  let armed = true;
  return (c: Call) => {
    if (armed && match(c)) {
      armed = false;
      return Response.json({ success: false, errors: [{ code: 10013 }] }, { status });
    }
  };
};
const isScriptPut = (c: Call) => c.method === 'PUT' && c.url.endsWith('/scripts/rushes-share');

describe('token and account flow', () => {
  it('lists accounts with their workers.dev subdomain', async () => {
    const cf = cloudflare();
    expect(await listAccounts(TOKEN, cf.fetcher)).toEqual([
      { id: ACCOUNT, name: 'Fixture account', subdomain: 'fixture-user' },
    ]);
    expect(writes(cf.state.calls)).toEqual([]);
  });
  it('reports an account without a subdomain as null', async () => {
    const cf = cloudflare({ subdomain: null });
    expect((await listAccounts(TOKEN, cf.fetcher))[0].subdomain).toBeNull();
  });
  it('explains an invalid token without echoing it', async () => {
    const cf = cloudflare();
    const error = await listAccounts('wrong-token-value-0123456789', cf.fetcher).catch((e) => e);
    expect(error.code).toBe('SETUP_INVALID_TOKEN');
    expect(error.message).not.toContain('wrong-token-value');
  });
  it('rejects a malformed token before any request', async () => {
    const cf = cloudflare();
    const error = await listAccounts('short', cf.fetcher).catch((e) => e);
    expect(error.code).toBe('SETUP_INVALID_INPUT');
    expect(cf.state.calls).toEqual([]);
  });
  it('lists every required permission when one is missing', async () => {
    const cf = cloudflare({ denied: /workers\/subdomain/ });
    const error = await listAccounts(TOKEN, cf.fetcher).catch((e) => e);
    expect(error.code).toBe('SETUP_PERMISSION_MISSING');
    for (const permission of REQUIRED_TOKEN_PERMISSIONS)
      expect(error.message).toContain(permission);
  });
  it('maps a permission failure during deploy to the same guidance', async () => {
    const cf = cloudflare({ denied: /d1\/database/ });
    const { setup, save } = await rig(cf);
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_PERMISSION_MISSING');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('runSetup', () => {
  it('deploys, saves through the secure path, tests, and reports progress', async () => {
    const consoles = captureConsole();
    const cf = cloudflare({ healthFailures: 2 });
    const { setup, events, test, file, saved } = await rig(cf);
    const result = await setup.run({ token: TOKEN, accountId: ACCOUNT });
    expect(result).toEqual({
      workerURL: WORKER_URL,
      accountId: ACCOUNT,
      subdomain: 'fixture-user',
      verified: true,
    });
    const active = events.filter((e: any) => e.status === 'active').map((e: any) => e.step);
    expect(active).toEqual([...shareSetupSteps]);
    expect(events.at(-1)).toEqual({ event: 'share-setup-progress', step: 'test', status: 'done' });
    // Fresh 32-byte secrets reached the Worker and the encrypted settings only.
    expect(cf.state.deployed).toHaveLength(1);
    const { owner, session } = cf.state.deployed[0];
    expect(owner.length).toBeGreaterThanOrEqual(43);
    expect(owner).not.toBe(session);
    expect(await saved()).toEqual({
      provider: 'worker',
      workerURL: WORKER_URL,
      token: owner,
      accountId: ACCOUNT,
      sessionSecret: session,
    });
    const raw = (await readFile(file)).toString();
    expect(raw).not.toContain(owner);
    expect(raw).not.toContain(session);
    expect(test).toHaveBeenCalledTimes(1);
    const visible = JSON.stringify([result, events]);
    for (const secret of [TOKEN, owner, session]) expect(visible).not.toContain(secret);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });
  it('returns verified false when the follow-up connection test fails', async () => {
    const cf = cloudflare();
    const { setup } = await rig(cf, { test: async () => ({ ok: false }) });
    expect((await setup.run({ token: TOKEN, accountId: ACCOUNT })).verified).toBe(false);
  });
  it('refuses a second run while one is in progress', async () => {
    const cf = cloudflare();
    const { setup } = await rig(cf);
    const first = setup.run({ token: TOKEN, accountId: ACCOUNT });
    await expect(setup.run({ token: TOKEN, accountId: ACCOUNT })).rejects.toMatchObject({
      code: 'SETUP_RUNNING',
    });
    await first;
  });
  it('refuses to start while a share upload is in progress', async () => {
    const cf = cloudflare();
    const { setup, save } = await rig(cf, { sharesBusy: () => true });
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_SHARE_IN_PROGRESS');
    expect(error.message).toMatch(/uploading/);
    expect(cf.state.calls).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
  it('fails clearly when the bundled Worker files are missing', async () => {
    const paths = workerAssetPaths(true, '/nonexistent-resources', '/unused');
    expect(paths).toEqual({
      script: '/nonexistent-resources/worker/worker.js',
      schema: '/nonexistent-resources/worker/schema.sql',
    });
    await expect(readWorkerAssets(paths)).rejects.toMatchObject({
      code: 'SETUP_WORKER_BUNDLE_MISSING',
    });
  });
});

describe('health checks', () => {
  it('gives every retry its own timeout, so retries past 15 s still run', async () => {
    // Six failures: the seventh attempt starts 18 s after the first one.
    const cf = cloudflare({ healthFailures: 6 });
    const { setup } = await rig(cf);
    const result = await setup.run({ token: TOKEN, accountId: ACCOUNT });
    expect(result.verified).toBe(true);
    expect(cf.state.now).toBeGreaterThanOrEqual(18000);
  });
  it('treats a Worker that never answers as partial, not success', async () => {
    const cf = cloudflare({ healthFailures: 100 });
    const { setup } = await rig(cf, { healthAttempts: 3 });
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_PARTIAL');
  });
});

describe('Worker secrets on re-run', () => {
  it('reuses the saved owner token and session secret for the same Worker', async () => {
    const cf = cloudflare();
    const { setup } = await rig(cf);
    await setup.run({ token: TOKEN, accountId: ACCOUNT });
    await setup.run({ token: TOKEN, accountId: ACCOUNT });
    expect(cf.state.deployed).toHaveLength(2);
    expect(cf.state.deployed[1]).toEqual(cf.state.deployed[0]);
  });
  it('uses new secrets when the saved settings are for another provider', async () => {
    const cf = cloudflare();
    const { setup } = await rig(
      cf,
      {},
      {
        provider: 'worker',
        workerURL: 'https://other.example.workers.dev',
        token: 'x'.repeat(40),
        accountId: ACCOUNT,
      },
    );
    await setup.run({ token: TOKEN, accountId: ACCOUNT });
    expect(cf.state.deployed[0].owner).not.toBe('x'.repeat(40));
  });
  it('keeps the saved token equal to the deployed binding when a re-run fails after upload', async () => {
    // Same Worker configured by hand: owner token known, session secret not.
    const manual = {
      provider: 'worker' as const,
      workerURL: WORKER_URL,
      token: 'm'.repeat(40),
      accountId: ACCOUNT,
    };
    const cf = cloudflare({ fail: failOnce((c) => c.url.endsWith('/schedules')) });
    const { setup, saved } = await rig(cf, {}, manual);
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_PARTIAL');
    const live = cf.state.deployed.at(-1)!;
    expect(live.owner).toBe(manual.token);
    const now = await saved();
    expect(now).toMatchObject({
      provider: 'worker',
      token: live.owner,
      sessionSecret: live.session,
    });
    // The retry keeps the same keys, so live links and unlock cookies survive it.
    await setup.run({ token: TOKEN, accountId: ACCOUNT });
    expect(cf.state.deployed.at(-1)).toEqual(live);
    expect(await saved()).toMatchObject({ token: live.owner, sessionSecret: live.session });
  });
  it('restores the previous settings when the Worker upload is refused', async () => {
    const bucket: CloudSettings = {
      provider: 'bucket',
      endpoint: 'https://bucket.example',
      region: 'auto',
      bucket: 'fixture',
      publicBaseURL: 'https://media.example',
      accessKeyId: 'fixture-key',
      secretAccessKey: 'fixture-secret',
    };
    const cf = cloudflare({ fail: failOnce(isScriptPut) });
    const { setup, saved } = await rig(cf, {}, bucket);
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_PARTIAL');
    expect(cf.state.deployed).toEqual([]);
    expect(await saved()).toEqual(bucket);
  });
});

describe('R2 disabled', () => {
  it('stops before any write and explains the dashboard step', async () => {
    const cf = cloudflare({ r2: false });
    const { setup, save, events } = await rig(cf);
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_R2_NOT_ENABLED');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/R2 Object Storage/);
    expect(writes(cf.state.calls)).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});

describe('workers.dev subdomain', () => {
  it('asks for a name when the account has none, before any write', async () => {
    const cf = cloudflare({ subdomain: null });
    const { setup } = await rig(cf);
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_SUBDOMAIN_REQUIRED');
    expect(writes(cf.state.calls)).toEqual([]);
  });
  it('creates the chosen name only when none exists', async () => {
    const cf = cloudflare({ subdomain: null });
    const { setup } = await rig(cf);
    const result = await setup.run({ token: TOKEN, accountId: ACCOUNT, subdomain: 'My-Name' });
    expect(result.workerURL).toBe('https://rushes-share.my-name.workers.dev');
    expect(
      cf.state.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/workers/subdomain')),
    ).toHaveLength(1);
  });
  it('never renames an existing subdomain', async () => {
    const cf = cloudflare({ subdomain: 'existing-name' });
    const { setup } = await rig(cf);
    const result = await setup.run({ token: TOKEN, accountId: ACCOUNT, subdomain: 'other-name' });
    expect(result.subdomain).toBe('existing-name');
    expect(
      cf.state.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/workers/subdomain')),
    ).toBe(false);
  });
  it('explains a taken name', async () => {
    const cf = cloudflare({
      subdomain: null,
      fail: failOnce((c) => c.method === 'PUT' && c.url.endsWith('/workers/subdomain'), 409),
    });
    const { setup } = await rig(cf);
    const error = await setup
      .run({ token: TOKEN, accountId: ACCOUNT, subdomain: 'taken' })
      .catch((e) => e);
    expect(error.code).toBe('SETUP_SUBDOMAIN_TAKEN');
  });
  it('rejects an invalid name without a request', async () => {
    const cf = cloudflare({ subdomain: null });
    const { setup } = await rig(cf);
    const error = await setup
      .run({ token: TOKEN, accountId: ACCOUNT, subdomain: '-bad name' })
      .catch((e) => e);
    expect(error.code).toBe('SETUP_INVALID_INPUT');
    expect(cf.state.calls).toEqual([]);
  });
});

describe('partial deploy', () => {
  it('is safe to retry, reuses the same resources and says so truthfully', async () => {
    const cf = cloudflare({ fail: failOnce((c) => c.url.endsWith('/schedules')) });
    const { setup, events } = await rig(cf);
    const error = await setup.run({ token: TOKEN, accountId: ACCOUNT }).catch((e) => e);
    expect(error.code).toBe('SETUP_PARTIAL');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('publish');
    expect(error.message).not.toMatch(/nothing is lost/i);
    await setup.run({ token: TOKEN, accountId: ACCOUNT });
    expect(cf.state.buckets).toEqual(['rushes-media']);
    expect(cf.state.databases).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});
