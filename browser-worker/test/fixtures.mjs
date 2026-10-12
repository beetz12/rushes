import { DatabaseSync } from 'node:sqlite';

import { readFile } from 'node:fs/promises';

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { createWorker } from '../dist/worker.js';

export class D1Fixture {
  constructor(sql, filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(sql);
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    let args = [];
    const execute = () => {
      const result = stmt.run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    return {
      bind(...values) {
        args = values;
        return this;
      },
      async first(column) {
        const row = stmt.get(...args);
        return row ? (column ? row[column] : row) : null;
      },
      async all() {
        return { results: stmt.all(...args) };
      },
      async run() {
        return execute();
      },
      execute,
    };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((s) => s.execute());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
export class R2Fixture {
  objects = new Map();
  failPut = false;
  failDelete = false;
  headFail = false;
  extraList = false;
  beforePut = null;

  async put(key, value, options = {}) {
    if (this.beforePut) await this.beforePut(key);
    if (this.failPut) throw new Error('fixture failed put');
    const bytes = new Uint8Array(value);
    this.objects.set(key, {
      key,
      size: bytes.length,
      bytes,
      customMetadata: options.customMetadata,
    });
    return this.head(key);
  }
  async head(key) {
    if (this.headFail) return null;
    const v = this.objects.get(key);
    return v ? { key: v.key, size: v.size, customMetadata: v.customMetadata } : null;
  }
  async get(key) {
    const v = this.objects.get(key);
    return v
      ? {
          key: v.key,
          size: v.size,
          customMetadata: v.customMetadata,
          body: new ReadableStream({
            start(c) {
              c.enqueue(v.bytes);
              c.close();
            },
          }),
        }
      : null;
  }
  async delete(keys) {
    if (this.failDelete) return;
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list({ prefix }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
    if (this.extraList) keys.push('t/other/r/other/foreign');
    return { objects: keys.map((key) => ({ key })), truncated: false };
  }
}
export class Providers {
  videos = new Map();
  created = [];
  removed = [];
  tokens = [];
  stripe = [];
  next = 0;
  createFail = false;
  uncertainCreate = false;
  deleteFail = false;
  statusFail = false;
  stripeFail = false;
  charge = {
    id: 'ch_fixture',
    customer: 'cus_alpha',
    refunded: false,
    disputed: false,
    amount_refunded: 0,
  };
  subscriptions = [];
  googleToken = null;
  jwks = null;
  downloadReady = true;
  downloads = [];

  async fetch(input, options = {}) {
    const u = new URL(String(input));
    if (u.hostname === 'oauth2.googleapis.com')
      return Response.json({ id_token: this.googleToken });
    if (u.hostname === 'www.googleapis.com') return Response.json(this.jwks);
    if (u.hostname === 'api.stripe.com') {
      this.stripe.push({ url: u.href, options });
      if (this.stripeFail) return new Response('unavailable', { status: 503 });
      if (u.pathname.startsWith('/v1/prices/'))
        return Response.json({
          id: 'price_fixture',
          active: true,
          currency: 'usd',
          unit_amount: 1500,
          livemode: false,
          recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        });
      if (u.pathname === '/v1/customers') return Response.json({ id: 'cus_created' });
      if (u.pathname === '/v1/checkout/sessions')
        return Response.json({ url: 'https://checkout.stripe.com/c/pay/fixture' });
      if (u.pathname === '/v1/billing_portal/sessions')
        return Response.json({ url: 'https://billing.stripe.com/p/session/fixture' });
      if (u.pathname === '/v1/subscriptions')
        return Response.json({ data: this.subscriptions, has_more: false });
      if (u.pathname.startsWith('/v1/charges/')) return Response.json(this.charge);
      throw new Error(`unhandled Stripe fixture ${u}`);
    }
    if (u.hostname !== 'api.cloudflare.com') throw new Error(`unhandled fixture provider ${u}`);
    if (u.searchParams.has('direct_user')) {
      this.created.push(options);
      if (this.createFail)
        return Response.json(
          { success: false, errors: [{ code: 10004, message: 'Fixture invalid upload request' }] },
          { status: 400 },
        );
      const id = (++this.next).toString(16).padStart(32, '0');
      const metadata = new Headers(options.headers).get('Upload-Metadata');
      const creator = atob(
        metadata
          .split(',')
          .find((p) => p.startsWith('creator '))
          .slice(8),
      );
      this.videos.set(id, {
        uid: id,
        creator,
        readyToStream: false,
        duration: 0,
        requireSignedURLs: true,
        status: { state: 'pendingupload' },
      });
      if (this.uncertainCreate) throw new Error('connection lost after creating media');
      return new Response(null, {
        status: 201,
        headers: { Location: `https://upload.cloudflarestream.com/${id}`, 'stream-media-id': id },
      });
    }
    if (u.searchParams.has('creator')) {
      return Response.json({
        success: true,
        total: [...this.videos.values()].filter((v) => v.creator === u.searchParams.get('creator'))
          .length,
        result: [...this.videos.values()].filter(
          (v) => v.creator === u.searchParams.get('creator'),
        ),
      });
    }
    const match = u.pathname.match(/\/stream\/([a-f0-9]{32})(\/token|\/downloads)?$/);
    if (!match) throw new Error(`unhandled Stream fixture ${u}`);
    const id = match[1];
    if (match[2] === '/downloads') {
      this.downloads.push(id);
      return Response.json({
        success: true,
        result: { default: { status: this.downloadReady ? 'ready' : 'inprogress' } },
      });
    }
    if (match[2]) {
      this.tokens.push(JSON.parse(options.body));
      return Response.json({
        success: true,
        result: { token: 'fixture-signed-token-with-provider-authorization' },
      });
    }
    if (options.method === 'DELETE') {
      this.removed.push(id);
      if (!this.deleteFail) this.videos.delete(id);
      return Response.json({ success: true });
    }
    if (this.statusFail) return new Response('unavailable', { status: 503 });
    const video = this.videos.get(id);
    return video
      ? Response.json({ success: true, result: video })
      : new Response('not found', { status: 404 });
  }
}
const sha = (value) => createHash('sha256').update(value).digest('hex');

export { sha };

export async function fixture(options = {}) {
  const db = new D1Fixture(
      options.schema ?? (await readFile(new URL('../schema.sql', import.meta.url), 'utf8')),
    ),
    raw = new R2Fixture(),
    providers = new Providers();
  if (
    !db.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .some((v) => v.name === 'family_id')
  )
    db.db.exec(
      await readFile(new URL('../migrations/0003_session_families.sql', import.meta.url), 'utf8'),
    );
  let now = Date.UTC(2026, 9, 12, 16);
  const runtime = { now: () => now, fetch: providers.fetch.bind(providers) },
    worker = createWorker(runtime);
  const env = {
    DB: db,
    RAW: raw,
    ASSETS: {
      fetch: async () =>
        new Response('<html>Rushes local capture</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    },
    PUBLIC_BASE_URL: 'https://rushes.example',
    REVISION: 'fixture-revision',
    GOOGLE_CLIENT_ID: 'fixture-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'fixture-google-client-secret',
    SESSION_SECRET: 'fixture-opaque-session-secret-'.padEnd(48, 's'),
    INVITE_EMAILS: 'alpha@example.com,beta@example.com',
    ACCOUNT_CAP: '25',
    SIGNUP_ENABLED: 'true',
    HOSTING_ENABLED: 'true',
    DELIVERY_ENABLED: 'true',
    PILOT_BUDGET_USD: '100',
    PILOT_WARNING_USD: '75',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_PRICE_ID: 'price_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture_signed_webhook_secret',
    STRIPE_LIVE_ENABLED: 'false',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'fixture-private-cloudflare-token',
    STREAM_CUSTOMER_CODE: 'fixture',
  };
  db.db.prepare('INSERT INTO budget_months(month_start) VALUES(?)').run(Date.UTC(2026, 9, 1));
  db.db
    .prepare(
      'INSERT INTO budget_settings(id,cap_cents,warning_cents,month_start) VALUES(1,10000,7500,?)',
    )
    .run(Date.UTC(2026, 9, 1));
  const request = (path, options = {}) =>
    worker.fetch(new Request(env.PUBLIC_BASE_URL + path, options), env);
  const users = {};
  for (const name of ['alpha', 'beta']) {
    const tenant = name,
      account = `account-${name}`,
      token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(32).toString('base64url');
    db.db
      .prepare(
        'INSERT INTO tenants(id,status,paid_through,period_start,period_end,updated_at,stripe_customer) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        tenant,
        'active',
        now + 30 * 86400000,
        now - 86400000,
        now + 30 * 86400000,
        now,
        `cus_${name}`,
      );
    db.db
      .prepare(
        'INSERT INTO accounts(id,tenant_id,google_subject,email,name,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(account, tenant, `google-${name}`, `${name}@example.com`, name, now);
    const family = `family-${name}`;
    db.db
      .prepare(
        'INSERT INTO session_families(id,account_id,current_token_hash,absolute_expiry) VALUES(?,?,?,?)',
      )
      .run(family, account, sha(token), now + 14 * 86400000);
    db.db
      .prepare(
        'INSERT INTO sessions(token_hash,account_id,csrf_hash,created_at,expires_at,absolute_expiry,family_id) VALUES(?,?,?,?,?,?,?)',
      )
      .run(sha(token), account, sha(csrf), now, now + 86400000, now + 14 * 86400000, family);
    users[name] = {
      tenant,
      account,
      token,
      csrf,
      cookie: `__Host-rushes-session=${token}; __Host-rushes-csrf=${csrf}`,
    };
  }
  const auth = (user = 'alpha', method = 'GET', body) => ({
    method,
    headers: {
      Cookie: users[user].cookie,
      'X-CSRF-Token': users[user].csrf,
      Origin: env.PUBLIC_BASE_URL,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    env,
    db,
    raw,
    providers,
    worker,
    runtime,
    request,
    auth,
    users,
    advance(ms) {
      now += ms;
    },
    now: () => now,
    close: () => db.close(),
  };
}
export async function newRecording(
  f,
  user = 'alpha',
  clientId = `draft-${randomBytes(4).toString('hex')}`,
) {
  const r = await f.request(
    '/api/recordings',
    f.auth(user, 'POST', { clientId, title: 'Fixture recording', mode: 'screen-camera' }),
  );
  if (r.status !== 200) throw new Error(`create ${r.status} ${await r.text()}`);
  return r.json();
}
export const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

export async function storedChunk(f, recording, user = 'alpha', track = 'composed', sequence = 0) {
  const descriptor = {
    track,
    sequence,
    bytes: bytes.length,
    sha256: sha(bytes),
    mimeType: 'video/webm;codecs=vp8,opus',
  };
  const r = await f.request(
    `/api/recordings/${recording.id}/chunks/grant`,
    f.auth(user, 'POST', descriptor),
  );
  if (r.status !== 200) throw new Error(`grant ${r.status} ${await r.text()}`);
  const grant = await r.json();
  const options = f.auth(user, 'PUT');
  options.headers.Authorization = `Upload ${grant.token}`;
  options.headers['Content-Type'] = descriptor.mimeType;
  options.body = bytes;
  const put = await f.request(new URL(grant.url).pathname, options);
  if (put.status !== 200) throw new Error(`put ${put.status} ${await put.text()}`);
  return { ...descriptor, checkpointMs: 10000 };
}
export function finalInput(recording, descriptor, now) {
  return {
    manifest: {
      schema: 'rushes.browser-recording/1',
      id: recording.manifest?.id ?? 'unused',
      title: recording.title,
      createdAt: new Date(now).toISOString(),
      mode: 'screen-camera',
      state: 'complete',
      durationMs: 10000,
      epochMs: 0,
      tracks: [
        {
          kind: descriptor.track,
          mimeType: descriptor.mimeType,
          startOffsetMs: 0,
          chunks: [descriptor],
          bytes: descriptor.bytes,
        },
      ],
      pauses: [],
      events: [],
      bubble: { x: 0.8, y: 0.8, size: 0.2 },
      lastCheckpointMs: 10000,
      persistent: true,
      backupFolder: false,
      cloudRecordingId: recording.id,
    },
    composed: { bytes: descriptor.bytes, sha256: descriptor.sha256, mimeType: descriptor.mimeType },
  };
}
export async function uploaded(f, user = 'alpha') {
  const clientId = `draft-${randomBytes(4).toString('hex')}`,
    recording = await newRecording(f, user, clientId),
    chunk = await storedChunk(f, recording, user);
  const input = finalInput(recording, chunk, f.now());
  input.manifest.id = clientId;
  const r = await f.request(
    `/api/recordings/${recording.id}/finalize`,
    f.auth(user, 'POST', input),
  );
  if (r.status !== 200) throw new Error(`finalize ${r.status} ${await r.text()}`);
  return { recording, chunk, input, grant: (await r.json()).upload };
}
export async function ready(f, user = 'alpha', duration = 10) {
  const u = await uploaded(f, user);
  const video = f.providers.videos.get(u.grant.uid);
  video.readyToStream = true;
  video.duration = duration;
  video.status.state = 'ready';
  const r = await f.request(`/api/recordings/${u.recording.id}/process`, f.auth(user, 'POST', {}));
  if (r.status !== 200) throw new Error(`process ${r.status} ${await r.text()}`);
  return { ...u, recording: await r.json() };
}
export function webhookOptions(f, event, timestamp = Math.floor(f.now() / 1000)) {
  const body = JSON.stringify(event),
    signature = createHmac('sha256', f.env.STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': `t=${timestamp},v1=${signature}`,
    },
    body,
  };
}
export function subscription(f, overrides = {}) {
  return {
    id: 'sub_fixture',
    customer: 'cus_alpha',
    status: 'active',
    current_period_start: Math.floor((f.now() - 86400000) / 1000),
    current_period_end: Math.floor((f.now() + 30 * 86400000) / 1000),
    items: { data: [{ price: { id: 'price_fixture' }, quantity: 1 }] },
    latest_invoice: {
      id: 'in_fixture',
      status: 'paid',
      amount_paid: 1500,
      currency: 'usd',
      customer: 'cus_alpha',
      charge: 'ch_fixture',
    },
    ...overrides,
  };
}
