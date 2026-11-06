import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import {
  REQUIRED_TOKEN_PERMISSIONS,
  SHARE_SETUP_NAMES,
  shareSetupAccountsInputSchema,
  shareSetupRunInputSchema,
  shareSetupSteps,
  type CloudflareAccount,
  type ShareSetupProgress,
  type ShareSetupResult,
  type ShareSetupStep,
} from '../shared/share-setup';
import type { CloudSettings } from '../shared/contracts';

// Guided setup of the user's own share Worker from a pasted Cloudflare API token.
// The token and the generated Worker secrets stay in this process: they are never
// logged, never written in plain text and never returned to the renderer.

type Fetch = typeof fetch;
const API = 'https://api.cloudflare.com/client/v4';

export class ShareSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ShareSetupError';
  }
}

const permissionList = REQUIRED_TOKEN_PERMISSIONS.join('; ');
const errors = {
  invalidToken: () =>
    new ShareSetupError(
      'SETUP_INVALID_TOKEN',
      'Cloudflare did not accept this token. Copy it again from the API Tokens page and paste the whole value.',
    ),
  permission: () =>
    new ShareSetupError(
      'SETUP_PERMISSION_MISSING',
      `This token is missing a permission. Edit the token so it has: ${permissionList}. Then try again.`,
    ),
  noAccounts: () =>
    new ShareSetupError(
      'SETUP_NO_ACCOUNTS',
      'This token cannot see any Cloudflare account. Under Account Resources, include your account, then try again.',
    ),
  network: () =>
    new ShareSetupError(
      'SETUP_NETWORK',
      'Rushes could not reach Cloudflare. Check your internet connection and try again.',
      true,
    ),
  r2: () =>
    new ShareSetupError(
      'SETUP_R2_NOT_ENABLED',
      'R2 storage is not turned on for this account. In the Cloudflare dashboard, open R2 Object Storage and turn it on (Cloudflare asks for a payment method). Then choose Try again.',
      true,
    ),
  subdomainRequired: () =>
    new ShareSetupError(
      'SETUP_SUBDOMAIN_REQUIRED',
      'This account has no workers.dev address yet. Pick a name (lowercase letters, numbers and dashes) and Rushes will create it.',
    ),
  subdomainTaken: () =>
    new ShareSetupError(
      'SETUP_SUBDOMAIN_TAKEN',
      'That workers.dev name is taken or not allowed. Pick another name and try again.',
    ),
  bundle: () =>
    new ShareSetupError(
      'SETUP_WORKER_BUNDLE_MISSING',
      'The share Worker files are missing from this copy of Rushes. Reinstall Rushes, or build worker/ when running from source.',
    ),
  partial: (step: ShareSetupStep | undefined) =>
    new ShareSetupError(
      'SETUP_PARTIAL',
      `Setup stopped partway${step ? ` (${step})` : ''}. Your recordings on this Mac are not affected. Choose Try again: Rushes reuses the same Worker, bucket and database names and the Worker keys it saved.`,
      true,
    ),
  shareBusy: () =>
    new ShareSetupError(
      'SETUP_SHARE_IN_PROGRESS',
      'A recording is uploading right now. Wait for it to finish, then set up sharing.',
      true,
    ),
  save: () =>
    new ShareSetupError(
      'SETUP_SAVE_FAILED',
      'The Worker is running, but Rushes could not save its settings in macOS secure storage. Choose Try again.',
      true,
    ),
  running: () => new ShareSetupError('SETUP_RUNNING', 'Sharing setup is already running.', false),
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Issue messages are fixed strings from the schema; the input value is never echoed.
  throw new ShareSetupError(
    'SETUP_INVALID_INPUT',
    result.error.issues[0]?.message ?? 'Check the setup details.',
  );
}

export interface WorkerAssets {
  script: string;
  schemaSQL: string;
}
export interface DeployResultLike {
  workerURL: string;
  accountId: string;
  ownerToken: string;
}
export interface ShareSetupDeps {
  fetch?: Fetch;
  /** cloud's deployWorker, injected because the SDK is loaded at runtime. */
  deployWorker(input: Record<string, unknown>, fetcher: Fetch): Promise<DeployResultLike>;
  loadAssets(): Promise<WorkerAssets>;
  /** The app's current sharing settings (main process only). */
  current(): CloudSettings | Promise<CloudSettings>;
  /** The app's existing secure settings path (safeStorage). */
  save(settings: CloudSettings): Promise<unknown>;
  /** True while any share reserve/upload/publish job is running. */
  sharesBusy(): boolean;
  /** The app's existing connection test against the saved provider. */
  test(): Promise<{ ok?: boolean } | unknown>;
  emit(event: ShareSetupProgress): void;
  sleep?(ms: number): Promise<void>;
  healthAttempts?: number;
}

export function workerAssetPaths(packaged: boolean, resourcesPath: string, sourceRoot: string) {
  const dir = packaged ? `${resourcesPath}/worker` : `${sourceRoot}/worker`;
  return {
    script: packaged ? `${dir}/worker.js` : `${dir}/dist/worker.js`,
    schema: `${dir}/schema.sql`,
  };
}
export async function readWorkerAssets(paths: { script: string; schema: string }) {
  try {
    return {
      script: await readFile(paths.script, 'utf8'),
      schemaSQL: await readFile(paths.schema, 'utf8'),
    };
  } catch {
    throw errors.bundle();
  }
}

async function cloudflare<T>(fetcher: Fetch, token: string, path: string): Promise<T | null> {
  let response: Response;
  try {
    response = await fetcher(API + path, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
  } catch {
    throw errors.network();
  }
  let body: { success?: boolean; result?: T; errors?: Array<{ code?: number }> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw errors.network();
  }
  if (response.ok && body.success) return body.result ?? null;
  // A missing workers.dev subdomain is a normal state, not a failure.
  if (response.status === 404 && body.errors?.some((e) => e.code === 10007)) return null;
  if (response.status === 401 || body.errors?.some((e) => [6003, 6111, 9109].includes(e.code!)))
    throw errors.invalidToken();
  if (response.status === 403 || body.errors?.some((e) => e.code === 10000))
    throw errors.permission();
  throw errors.partial(undefined);
}

export async function lookupSubdomain(token: string, accountId: string, fetcher: Fetch = fetch) {
  const result = await cloudflare<{ subdomain?: string }>(
    fetcher,
    token,
    `/accounts/${accountId}/workers/subdomain`,
  );
  return result?.subdomain || null;
}

export async function listAccounts(token: string, fetcher: Fetch = fetch) {
  const input = parse(shareSetupAccountsInputSchema, { token });
  const rows =
    (await cloudflare<Array<{ id: string; name: string }>>(
      fetcher,
      input.token,
      '/accounts?per_page=50',
    )) ?? [];
  const accounts: CloudflareAccount[] = [];
  for (const row of rows) {
    if (!/^[a-f0-9]{32}$/.test(row.id)) continue;
    accounts.push({
      id: row.id,
      name: String(row.name ?? row.id).slice(0, 200),
      subdomain: await lookupSubdomain(input.token, row.id, fetcher),
    });
  }
  if (!accounts.length) throw errors.noAccounts();
  return accounts;
}

/** Maps a Cloudflare request made by deployWorker to the wizard step it belongs to. */
function stepFor(url: string, method: string, workerURL: string): ShareSetupStep | undefined {
  if (url.startsWith(workerURL + '/')) return 'health';
  const path = new URL(url).pathname;
  if (path.endsWith('/r2/buckets')) return 'storage';
  if (path.includes('/d1/database')) return 'database';
  if (/\/workers\/scripts\/[^/]+$/.test(path) && method === 'PUT') return 'upload';
  if (/\/workers\/scripts\/[^/]+\/(subdomain|schedules)$/.test(path)) return 'publish';
  return undefined;
}

export class ShareSetup {
  private running = false;
  constructor(private deps: ShareSetupDeps) {}

  listAccounts(token: string) {
    return listAccounts(token, this.deps.fetch ?? fetch);
  }

  async run(value: unknown): Promise<ShareSetupResult> {
    if (this.running) throw errors.running();
    this.running = true;
    try {
      return await this.runOnce(value);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(value: unknown): Promise<ShareSetupResult> {
    const input = parse(shareSetupRunInputSchema, value);
    // Changing the Worker or its keys under a running upload would break that upload.
    if (this.deps.sharesBusy()) throw errors.shareBusy();
    const fetcher = this.deps.fetch ?? fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let current: ShareSetupStep | undefined;
    const advance = (step: ShareSetupStep) => {
      if (current && shareSetupSteps.indexOf(step) <= shareSetupSteps.indexOf(current)) return;
      if (current) this.deps.emit({ event: 'share-setup-progress', step: current, status: 'done' });
      current = step;
      this.deps.emit({ event: 'share-setup-progress', step, status: 'active' });
    };

    advance('check');
    const assets = await this.deps.loadAssets();
    const existing = await lookupSubdomain(input.token, input.accountId, fetcher);
    // Use the account's existing workers.dev name; never rename it. Create one only when absent.
    const subdomain = existing ?? input.subdomain;
    if (!subdomain) throw errors.subdomainRequired();
    const workerURL = `https://${SHARE_SETUP_NAMES.workerName}.${subdomain}.workers.dev`;

    // Keep the Worker keys stable: re-running setup for the Worker the app already uses
    // reuses its owner token and session secret, so live links, upload grants and unlock
    // cookies keep working. New keys only for a new Worker (or a key the app never knew).
    const previous = await this.deps.current();
    const same =
      previous.provider === 'worker' &&
      previous.accountId === input.accountId &&
      previous.workerURL === workerURL;
    const reuse = (key: string | undefined) =>
      same && key && key.length >= 32 ? key : randomBytes(32).toString('base64url');
    const next: CloudSettings = {
      provider: 'worker',
      workerURL,
      token: reuse(same ? previous.token : undefined),
      accountId: input.accountId,
      sessionSecret: reuse(same ? previous.sessionSecret : undefined),
    };

    let last: { method: string; path: string } | undefined;
    let saveFailed = false;
    const attempts = this.deps.healthAttempts ?? 10;
    const tracked: Fetch = async (request, init) => {
      const url = String(request);
      const method = init?.method ?? 'GET';
      const step = stepFor(url, method, workerURL);
      if (step) advance(step);
      if (step === 'upload') {
        last = { method, path: new URL(url).pathname };
        // The upload rebinds the Worker's keys. Save them first so the app never holds
        // a token the Worker rejects; put the old settings back if the upload is refused.
        try {
          await this.deps.save(next);
        } catch (error) {
          saveFailed = true;
          throw error;
        }
        const response = await fetcher(request, init);
        if (!response.ok) await this.deps.save(previous).catch(() => {});
        return response;
      }
      if (step !== 'health') {
        last = { method, path: new URL(url).pathname };
        return fetcher(request, init);
      }
      // A new workers.dev address can take a short while to answer. Retry only the checks,
      // each with its own timeout: a signal shared across attempts would already be spent.
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetcher(request, { ...init, signal: AbortSignal.timeout(15000) });
          if (response.ok || attempt >= attempts) return response;
        } catch (error) {
          if (attempt >= attempts) throw error;
        }
        await sleep(3000);
      }
    };

    let deployed: DeployResultLike;
    try {
      deployed = await this.deps.deployWorker(
        {
          accountId: input.accountId,
          apiToken: input.token,
          ...SHARE_SETUP_NAMES,
          workersSubdomain: subdomain,
          script: assets.script,
          schemaSQL: assets.schemaSQL,
          ownerToken: next.token,
          sessionSecret: next.sessionSecret,
        },
        tracked,
      );
    } catch (error) {
      throw saveFailed ? errors.save() : this.mapDeployError(error, last, current);
    }

    advance('save');
    try {
      await this.deps.save({ ...next, workerURL: deployed.workerURL, token: deployed.ownerToken });
    } catch {
      throw errors.save();
    }

    advance('test');
    let verified = false;
    try {
      verified = ((await this.deps.test()) as { ok?: boolean } | undefined)?.ok === true;
    } catch {}
    this.deps.emit({ event: 'share-setup-progress', step: 'test', status: 'done' });
    return { workerURL: deployed.workerURL, accountId: deployed.accountId, subdomain, verified };
  }

  private mapDeployError(
    error: unknown,
    last: { method: string; path: string } | undefined,
    step: ShareSetupStep | undefined,
  ) {
    if (error instanceof ShareSetupError) return error;
    const code = (error as { code?: unknown })?.code;
    const status = (error as { status?: unknown })?.status;
    if (code === 'R2_NOT_ENABLED') return errors.r2();
    if (code === 'CLOUDFLARE_NETWORK') return errors.network();
    if (code === 'CLOUDFLARE_API') {
      if (status === 401) return errors.invalidToken();
      if (status === 403) return errors.permission();
      if (last?.method === 'PUT' && last.path.endsWith('/workers/subdomain'))
        return errors.subdomainTaken();
    }
    // Never forward raw error text: it is replaced with a fixed, secret-free message.
    return errors.partial(step);
  }
}
