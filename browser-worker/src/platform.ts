import { z } from 'zod';

import { BROWSER_LIMITS } from '../../browser/src/contracts';

export type Statement = {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
};

export type Database = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ success: boolean; meta: { changes: number } }[]>;
};

export type ObjectInfo = {
  key: string;
  size: number;
  customMetadata?: Record<string, string>;
  body?: ReadableStream<Uint8Array>;
};

export type Bucket = {
  put(
    key: string,
    bytes: Uint8Array,
    options?: { httpMetadata?: { contentType: string }; customMetadata?: Record<string, string> },
  ): Promise<ObjectInfo | null>;
  head(key: string): Promise<ObjectInfo | null>;
  get(key: string): Promise<ObjectInfo | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
};

export type Env = Record<string, unknown> & {
  DB?: Database;
  RAW?: Bucket;
  ASSETS?: { fetch(request: Request): Promise<Response> };
};

export type Runtime = { fetch: typeof fetch; now: () => number };

const toggle = z.enum(['true', 'false']).default('false');

const settings = z.object({
  PUBLIC_BASE_URL: z.url().optional(),
  REVISION: z.string().max(128).default('unconfigured'),
  GOOGLE_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  INVITE_EMAILS: z.string().max(8192).default(''),
  ACCOUNT_CAP: z.coerce.number().int().min(1).max(25).default(25),
  SIGNUP_ENABLED: toggle,
  HOSTING_ENABLED: toggle,
  DELIVERY_ENABLED: toggle,
  STRIPE_LIVE_ENABLED: toggle,
  PILOT_BUDGET_USD: z.coerce.number().min(5).max(100).default(100),
  PILOT_WARNING_USD: z.coerce.number().min(0).max(100).default(75),
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/)
    .optional(),
  STRIPE_PRICE_ID: z
    .string()
    .regex(/^price_[A-Za-z0-9]+$/)
    .optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(16).optional(),
  CLOUDFLARE_ACCOUNT_ID: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  CLOUDFLARE_API_TOKEN: z.string().min(20).optional(),
  STREAM_CUSTOMER_CODE: z
    .string()
    .regex(/^[a-z0-9]+$/)
    .optional(),
});

export type Config = z.infer<typeof settings>;

export function config(env: Env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = settings.safeParse(present);
  if (!parsed.success)
    throw new Failure(503, 'CONFIGURATION', 'The service configuration is invalid.');
  const c = parsed.data;
  if (c.PUBLIC_BASE_URL) {
    const u = new URL(c.PUBLIC_BASE_URL);
    if (
      u.protocol !== 'https:' ||
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw new Failure(503, 'CONFIGURATION', 'An HTTPS application origin is required.');
    c.PUBLIC_BASE_URL = u.origin;
  }
  if (c.STRIPE_SECRET_KEY?.startsWith('sk_live_') && c.STRIPE_LIVE_ENABLED !== 'true')
    throw new Failure(503, 'LIVE_BILLING_DISABLED', 'Live payments are disabled.');
  return c;
}
export function googleReady(c: Config, env: Env) {
  return Boolean(
    c.PUBLIC_BASE_URL && c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.SESSION_SECRET && env.DB,
  );
}
export function billingReady(c: Config) {
  return Boolean(c.STRIPE_SECRET_KEY && c.STRIPE_PRICE_ID && c.STRIPE_WEBHOOK_SECRET);
}
export function streamReady(c: Config, env: Env) {
  return Boolean(
    c.CLOUDFLARE_ACCOUNT_ID &&
    c.CLOUDFLARE_API_TOKEN &&
    c.STREAM_CUSTOMER_CODE &&
    env.RAW &&
    env.DB,
  );
}
export function hosting(c: Config, env: Env) {
  return (
    c.HOSTING_ENABLED === 'true' && googleReady(c, env) && billingReady(c) && streamReady(c, env)
  );
}
export function needDB(env: Env): Database {
  if (!env.DB) throw new Failure(503, 'CONFIGURATION', 'Account storage is not configured.');
  return env.DB;
}
export function needRaw(env: Env): Bucket {
  if (!env.RAW)
    throw new Failure(503, 'CONFIGURATION', 'Private recovery storage is not configured.');
  return env.RAW;
}
export class Failure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function bad(message = 'The request is invalid.'): never {
  throw new Failure(400, 'INVALID_REQUEST', message);
}
export function absent(): never {
  throw new Failure(404, 'NOT_FOUND', 'The resource was not found.');
}
export async function bodyBytes(envelope: Request, byteCeiling: number): Promise<Uint8Array> {
  const length = envelope.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > byteCeiling))
    throw new Failure(413, 'BODY_TOO_LARGE', 'The request body exceeds the limit.');
  if (!envelope.body) return new Uint8Array();
  const reader = envelope.body.getReader();
  const deadline = AbortSignal.timeout(45000);
  const stopRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  deadline.addEventListener('abort', stopRead, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > byteCeiling) {
        await reader.cancel();
        throw new Failure(413, 'BODY_TOO_LARGE', 'The request body exceeds the limit.');
      }
      parts.push(item.value);
    }
  } finally {
    deadline.removeEventListener('abort', stopRead);
    reader.releaseLock();
  }
  if (deadline.aborted)
    throw new Failure(
      408,
      'BODY_TIMEOUT',
      'The request body did not finish in time. Retry the saved chunk.',
    );
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export async function json<T>(
  request: Request,
  schema: z.ZodType<T>,
  max = 2 * 1024 * 1024,
): Promise<T> {
  if (!request.headers.get('content-type')?.split(';')[0].trim().toLowerCase().endsWith('/json'))
    bad('A JSON body is required.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(await bodyBytes(request, max)));
  } catch (e) {
    if (e instanceof Failure) throw e;
    bad();
  }
  const r = schema.safeParse(value);
  if (!r.success) bad();
  return r.data;
}
export function iso(time: number | null) {
  return time === null ? null : new Date(time).toISOString();
}
export function month(now: number) {
  const d = new Date(now);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}
export function response(value: unknown, status = 200, headers?: HeadersInit) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json;charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(value), { status, headers: h });
}
export function secure(response: Response): Response {
  const h = new Headers(response.headers);
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: https://*.cloudflarestream.com; frame-src https://*.cloudflarestream.com; connect-src 'self' https://*.videodelivery.net https://*.cloudflarestream.com https://upload.cloudflarestream.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  return new Response(response.body, { status: response.status, headers: h });
}
export async function limited(
  db: Database,
  key: string,
  now: number,
  max: number,
  windowMs = 60000,
) {
  const window = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      'INSERT INTO rate_limits(key,window,attempts) VALUES(?,?,1) ON CONFLICT(key,window) DO UPDATE SET attempts=attempts+1 RETURNING attempts',
    )
    .bind(key, window)
    .first<{ attempts: number }>();
  if (!row || row.attempts > max)
    throw new Failure(429, 'RATE_LIMIT', 'Please wait before trying again.');
}
export function origin(request: Request, c: Config) {
  if (
    !c.PUBLIC_BASE_URL ||
    new URL(request.url).origin !== c.PUBLIC_BASE_URL ||
    request.headers.get('origin') !== c.PUBLIC_BASE_URL
  )
    throw new Failure(403, 'ORIGIN', 'This request must come from the Rushes application.');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    throw new Failure(403, 'ORIGIN', 'This request must come from the Rushes application.');
}
export function quotaFailure(error: unknown): never {
  const s = String(error);
  if (s.includes('SUBSCRIPTION_REQUIRED'))
    throw new Failure(
      402,
      'SUBSCRIPTION_REQUIRED',
      'The account entitlement changed before this reservation.',
    );
  for (const code of [
    'RAW_QUOTA',
    'UPLOAD_QUOTA',
    'RETAINED_QUOTA',
    'DELIVERY_QUOTA',
    'DELIVERY_CONCURRENCY',
    'APPLICATION_BUDGET',
    'RAW_CONCURRENCY',
  ])
    if (s.includes(code))
      throw new Failure(
        429,
        code,
        'The account allowance or concurrent playback limit has been reached.',
      );
  if (s.includes('CHUNK_CONFLICT'))
    throw new Failure(409, 'CHUNK_CONFLICT', 'This chunk already has different content.');
  if (s.includes('RECORDING_CLOSED'))
    throw new Failure(
      409,
      'RECORDING_CLOSED',
      'This recording is no longer accepting original chunks.',
    );
  throw error;
}
export { BROWSER_LIMITS };
