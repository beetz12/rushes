import { test } from 'node:test';

import assert from 'node:assert/strict';

import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';

import {
  fixture,
  newRecording,
  storedChunk,
  uploaded,
  ready,
  finalInput,
  bytes,
  sha,
  webhookOptions,
  subscription,
} from './fixtures.mjs';

const error = async (r, code, status) => {
  assert.equal(r.status, status);
  assert.equal((await r.json()).error.code, code);
};

const use = (fn) => async () => {
  const f = await fixture();
  try {
    await fn(f);
  } finally {
    f.close();
  }
};

test(
  'unconfigured service serves capture assets and honest config while hosting stays closed',
  use(async (f) => {
    for (const k of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'SESSION_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_ID',
      'STRIPE_WEBHOOK_SECRET',
      'CLOUDFLARE_API_TOKEN',
    ])
      delete f.env[k];
    const config = await (await f.request('/api/config')).json();
    assert.equal(config.captureEnabled, true);
    assert.equal(config.hostingEnabled, false);
    assert.equal(config.googleConfigured, false);
    assert.match(await (await f.request('/')).text(), /local capture/);
    assert.equal((await f.request('/api/recordings', { method: 'POST' })).status, 401);
    assert.equal((await f.request('/auth/google/start')).status, 503);
  }),
);

test(
  'every recording route rejects swapped tenant ids and private anonymous access',
  use(async (f) => {
    const a = await newRecording(f),
      b = await newRecording(f, 'beta');
    const routes = [
      ['GET', ''],
      ['PATCH', '', { title: 'Stolen' }],
      ['DELETE', ''],
      [
        'POST',
        '/chunks/grant',
        { track: 'screen', sequence: 0, bytes: 8, sha256: sha(bytes), mimeType: 'video/webm' },
      ],
      ['GET', '/chunks'],
      ['POST', '/finalize', {}],
      ['POST', '/process', {}],
      ['GET', '/playback'],
      ['POST', '/share', {}],
      ['DELETE', '/share'],
      ['PUT', '/chunks/screen/0'],
    ];
    for (const [method, suffix, body] of routes) {
      assert.equal(
        (await f.request(`/api/recordings/${a.id}${suffix}`, f.auth('beta', method, body))).status,
        404,
        `${method} ${suffix}`,
      );
      assert.equal(
        (await f.request(`/api/recordings/${b.id}${suffix}`, f.auth('alpha', method, body))).status,
        404,
      );
    }
    assert.equal((await f.request(`/api/recordings/${a.id}`)).status, 401);
    const library = await (await f.request('/api/recordings', f.auth())).json();
    assert.deepEqual(
      library.recordings.map((r) => r.id),
      [a.id],
    );
    assert.equal((await f.request('/api/test-login', { method: 'POST' })).status, 401);
  }),
);

test(
  'mutations require CSRF and origin; logout revokes opaque session',
  use(async (f) => {
    const a = await newRecording(f);
    const options = f.auth('alpha', 'PATCH', { title: 'Changed' });
    delete options.headers['X-CSRF-Token'];
    await error(await f.request(`/api/recordings/${a.id}`, options), 'CSRF', 403);
    options.headers['X-CSRF-Token'] = f.users.alpha.csrf;
    options.headers.Origin = 'https://evil.example';
    await error(await f.request(`/api/recordings/${a.id}`, options), 'ORIGIN', 403);
    assert.equal((await f.request('/api/logout', f.auth('alpha', 'POST', {}))).status, 200);
    assert.equal((await f.request('/api/recordings', f.auth())).status, 401);
    assert.deepEqual(await (await f.request('/api/session', f.auth())).json(), {
      user: null,
      csrfToken: null,
    });
  }),
);

test(
  'session rotates after six hours and old cookie loses authority',
  use(async (f) => {
    f.advance(7 * 3600000);
    const r = await f.request('/api/session', f.auth());
    assert.equal(r.status, 200);
    const value = await r.json();
    assert.notEqual(value.csrfToken, f.users.alpha.csrf);
    assert.equal(r.headers.getSetCookie().length, 2);
    assert.ok(
      r.headers
        .getSetCookie()
        .every((v) => v.includes('Secure') && v.includes('HttpOnly') && v.includes('SameSite=Lax')),
    );
    const updated = f.auth();
    updated.headers.Cookie = r.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    updated.headers['X-CSRF-Token'] = value.csrfToken;
    assert.equal((await f.request('/api/recordings', updated)).status, 200);
    assert.equal((await f.request('/api/recordings', f.auth())).status, 401);
  }),
);

test(
  'create is idempotent within tenant and account ids are never client authority',
  use(async (f) => {
    const a = await newRecording(f, 'alpha', 'same-draft');
    const again = await newRecording(f, 'alpha', 'same-draft');
    const b = await newRecording(f, 'beta', 'same-draft');
    assert.equal(again.id, a.id);
    assert.notEqual(b.id, a.id);
    await error(
      await f.request(
        '/api/recordings',
        f.auth('alpha', 'POST', {
          clientId: 'inject',
          title: 'x',
          mode: 'screen',
          tenantId: 'beta',
        }),
      ),
      'INVALID_REQUEST',
      400,
    );
  }),
);

test(
  'grants verify actual size, MIME, digest, container, expiry and persistent ack',
  use(async (f) => {
    const a = await newRecording(f),
      desc = { track: 'screen', sequence: 0, bytes: 8, sha256: sha(bytes), mimeType: 'video/webm' };
    const grant = await (
      await f.request(`/api/recordings/${a.id}/chunks/grant`, f.auth('alpha', 'POST', desc))
    ).json();
    const put = (body = bytes, type = desc.mimeType) => {
      const o = f.auth('alpha', 'PUT');
      o.headers.Authorization = `Upload ${grant.token}`;
      o.headers['Content-Type'] = type;
      o.body = body;
      return f.request(new URL(grant.url).pathname, o);
    };
    await error(await put(bytes, 'text/plain'), 'UPLOAD_MIME', 400);
    await error(await put(bytes.subarray(0, 7)), 'UPLOAD_SIZE', 400);
    const other = new Uint8Array(bytes);
    other[7] = 9;
    await error(await put(other), 'UPLOAD_DIGEST', 400);
    await error(await put(new Uint8Array(9)), 'BODY_TOO_LARGE', 413);
    assert.equal((await put()).status, 200);
    assert.equal((await put()).status, 200);
    assert.equal(f.raw.objects.size, 1);
    const conflicts = { ...desc, sha256: sha(other) };
    await error(
      await f.request(`/api/recordings/${a.id}/chunks/grant`, f.auth('alpha', 'POST', conflicts)),
      'CHUNK_CONFLICT',
      409,
    );
    const usage = await (await f.request('/api/recordings', f.auth())).json();
    assert.equal(usage.usage.rawBytes, 8);
    assert.equal(usage.usage.reservedRawBytes, 0);
    f.advance(16 * 60000);
    await error(await put(), 'UPLOAD_EXPIRED', 401);
  }),
);

test(
  'only persisted R2 bytes acknowledge; persistence failure retries same grant',
  use(async (f) => {
    const a = await newRecording(f);
    f.raw.headFail = true;
    await assert.rejects(() => storedChunk(f, a), /put 503/);
    const chunks = await (await f.request(`/api/recordings/${a.id}/chunks`, f.auth())).json();
    assert.equal(chunks.chunks.length, 0);
    f.raw.headFail = false;
    await storedChunk(f, a);
    assert.equal(f.raw.objects.size, 1);
  }),
);

test(
  'simultaneous raw grants cannot both spend the final bytes',
  use(async (f) => {
    const a = await newRecording(f);
    f.db.db.prepare('UPDATE tenants SET raw_bytes=? WHERE id=?').run(2 * 1024 ** 3 - 8, 'alpha');
    const desc = {
      track: 'screen',
      sequence: 0,
      bytes: 8,
      sha256: sha(bytes),
      mimeType: 'video/webm',
    };
    const results = await Promise.all([
      f.request(`/api/recordings/${a.id}/chunks/grant`, f.auth('alpha', 'POST', desc)),
      f.request(
        `/api/recordings/${a.id}/chunks/grant`,
        f.auth('alpha', 'POST', { ...desc, track: 'camera' }),
      ),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
    assert.equal(
      f.db.db.prepare('SELECT reserved_raw_bytes FROM tenants WHERE id=?').get('alpha')
        .reserved_raw_bytes,
      8,
    );
  }),
);

test(
  'finalize creates one private constrained tus resource, independent of claimed duration',
  use(async (f) => {
    const u = await uploaded(f);
    assert.equal(f.providers.created.length, 1);
    const h = new Headers(f.providers.created[0].headers);
    assert.equal(h.get('Upload-Length'), '8');
    assert.equal(h.get('Tus-Resumable'), '1.0.0');
    assert.match(h.get('Upload-Metadata'), /requiresignedurls/);
    assert.match(h.get('Upload-Metadata'), /maxDurationSeconds NjAw/);
    assert.equal(
      (
        await f.request(
          `/api/recordings/${u.recording.id}/finalize`,
          f.auth('alpha', 'POST', u.input),
        )
      ).status,
      200,
    );
    assert.equal(f.providers.created.length, 1);
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      600,
    );
    const pending = await (
      await f.request(`/api/recordings/${u.recording.id}/process`, f.auth('alpha', 'POST', {}))
    ).json();
    assert.equal(pending.state, 'processing');
    assert.equal(pending.durationMs, 0);
  }),
);

test(
  'last upload and retained quota are atomic under racing finalization',
  use(async (f) => {
    const a = await newRecording(f, 'alpha', 'draft-a'),
      b = await newRecording(f, 'alpha', 'draft-b');
    const ca = await storedChunk(f, a),
      cb = await storedChunk(f, b);
    const pa = finalInput(a, ca, f.now());
    pa.manifest.id = 'draft-a';
    const pb = finalInput(b, cb, f.now());
    pb.manifest.id = 'draft-b';
    f.db.db
      .prepare(
        'INSERT INTO quota_periods(tenant_id,period_start,upload_seconds) SELECT id,period_start,5400 FROM tenants WHERE id=?',
      )
      .run('alpha');
    const results = await Promise.all([
      f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', pa)),
      f.request(`/api/recordings/${b.id}/finalize`, f.auth('alpha', 'POST', pb)),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
    assert.equal(f.providers.created.length, 1);
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      600,
    );
  }),
);

test(
  'Stream failures retain safe reservation; definite failure can retry without double allocation',
  use(async (f) => {
    f.providers.createFail = true;
    const a = await newRecording(f, 'alpha', 'retry-draft'),
      c = await storedChunk(f, a),
      input = finalInput(a, c, f.now());
    input.manifest.id = 'retry-draft';
    assert.equal(
      (await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input))).status,
      503,
    );
    f.providers.createFail = false;
    assert.equal(
      (await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input))).status,
      200,
    );
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      600,
    );
  }),
);

test(
  'expired tus URL replaces mapped provider UID only after verified deletion',
  use(async (f) => {
    const u = await uploaded(f);
    f.advance(86400001);
    f.db.db.prepare('UPDATE sessions SET expires_at=?').run(f.now() + 86400000);
    f.providers.deleteFail = true;
    await error(
      await f.request(
        `/api/recordings/${u.recording.id}/finalize`,
        f.auth('alpha', 'POST', u.input),
      ),
      'STREAM_DELETE_PENDING',
      503,
    );
    assert.equal(f.providers.created.length, 1);
    f.providers.deleteFail = false;
    const r = await f.request(
      `/api/recordings/${u.recording.id}/finalize`,
      f.auth('alpha', 'POST', u.input),
    );
    assert.equal(r.status, 200);
    const next = (await r.json()).upload;
    assert.notEqual(next.uid, u.grant.uid);
    assert.equal(f.providers.videos.has(u.grant.uid), false);
    assert.equal(f.providers.videos.has(next.uid), true);
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      600,
    );
  }),
);

test(
  'provider readiness/duration/privacy/creator decide ready; repeated checks settle once',
  use(async (f) => {
    const u = await uploaded(f),
      v = f.providers.videos.get(u.grant.uid);
    v.readyToStream = true;
    v.status.state = 'ready';
    v.duration = 601;
    await error(
      await f.request(`/api/recordings/${u.recording.id}/process`, f.auth('alpha', 'POST', {})),
      'PROVIDER_DURATION',
      422,
    );
    v.duration = 12.5;
    v.requireSignedURLs = false;
    await error(
      await f.request(`/api/recordings/${u.recording.id}/process`, f.auth('alpha', 'POST', {})),
      'STREAM_OWNERSHIP',
      503,
    );
    v.requireSignedURLs = true;
    v.creator = 'beta:other';
    await error(
      await f.request(`/api/recordings/${u.recording.id}/process`, f.auth('alpha', 'POST', {})),
      'STREAM_OWNERSHIP',
      503,
    );
    v.creator = `alpha:${u.recording.id}`;
    for (let i = 0; i < 2; i++) {
      const r = await f.request(
        `/api/recordings/${u.recording.id}/process`,
        f.auth('alpha', 'POST', {}),
      );
      assert.equal(r.status, 200);
      assert.equal((await r.json()).durationMs, 12500);
    }
    const q = f.db.db.prepare('SELECT * FROM quota_periods WHERE tenant_id=?').get('alpha');
    assert.equal(q.upload_seconds, 13);
    assert.equal(q.reserved_seconds, 0);
    assert.equal(
      f.db.db.prepare('SELECT retained_seconds FROM tenants WHERE id=?').get('alpha')
        .retained_seconds,
      13,
    );
  }),
);

test(
  'share requires explicit publication; password cookie is scoped, expires and invalidates on policy change',
  use(async (f) => {
    const u = await ready(f);
    assert.equal(u.recording.shareId, null);
    const created = await (
      await f.request(
        `/api/recordings/${u.recording.id}/share`,
        f.auth('alpha', 'POST', {
          password: 'fixture-password',
          expiresAt: new Date(f.now() + 600000).toISOString(),
        }),
      )
    ).json();
    const id = created.id;
    assert.equal((await (await f.request(`/api/shares/${id}`)).json()).passwordRequired, true);
    const post = {
      method: 'POST',
      headers: { Origin: f.env.PUBLIC_BASE_URL, 'Content-Type': 'application/json' },
      body: '{}',
    };
    await error(
      await f.request(`/api/shares/${id}/playback`, post),
      'SHARE_PASSWORD_REQUIRED',
      403,
    );
    const denied = { ...post, body: JSON.stringify({ password: 'wrong' }) };
    await error(await f.request(`/api/shares/${id}/unlock`, denied), 'SHARE_PASSWORD', 403);
    const unlock = await f.request(`/api/shares/${id}/unlock`, {
      ...post,
      body: JSON.stringify({ password: 'fixture-password' }),
    });
    assert.equal(unlock.status, 200);
    const cookie = unlock.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`Path=/api/shares/${id}`));
    const play = await f.request(`/api/shares/${id}/playback`, {
      ...post,
      headers: { ...post.headers, Cookie: cookie.split(';')[0] },
    });
    assert.equal(play.status, 200);
    assert.equal(f.providers.tokens[0].downloadable, false);
    assert.ok(f.providers.tokens[0].exp * 1000 <= f.now() + 300000);
    await f.request(
      `/api/recordings/${u.recording.id}/share`,
      f.auth('alpha', 'POST', { password: 'replacement' }),
    );
    await error(
      await f.request(`/api/shares/${id}/playback`, {
        ...post,
        headers: { ...post.headers, Cookie: cookie.split(';')[0] },
      }),
      'SHARE_UNLOCK_EXPIRED',
      403,
    );
    await f.request(`/api/recordings/${u.recording.id}/share`, f.auth('alpha', 'DELETE'));
    assert.equal((await f.request(`/api/shares/${id}`)).status, 404);
  }),
);

test(
  'delivery concurrency and monthly quota cannot overspend, each new token reserves delivery, kill switch stops grants',
  use(async (f) => {
    const u = await ready(f);
    f.db.db
      .prepare('UPDATE quota_periods SET delivery_seconds=? WHERE tenant_id=?')
      .run(59990, 'alpha');
    const route = `/api/recordings/${u.recording.id}/playback`;
    const requests = await Promise.all([f.request(route, f.auth()), f.request(route, f.auth())]);
    assert.deepEqual(requests.map((r) => r.status).sort(), [200, 429]);
    const good = requests.find((r) => r.status === 200),
      viewer = good.headers.get('set-cookie').split(';')[0];
    const options = f.auth();
    options.headers.Cookie += `; ${viewer}`;
    await error(await f.request(route, options), 'DELIVERY_QUOTA', 429);
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .delivery_seconds,
      60000,
    );
    f.env.DELIVERY_ENABLED = 'false';
    await error(await f.request(route, options), 'DELIVERY_DISABLED', 503);
  }),
);

test(
  'deletion revokes immediately and releases quota only after Stream and R2 read-back',
  use(async (f) => {
    const u = await ready(f);
    const share = await (
      await f.request(`/api/recordings/${u.recording.id}/share`, f.auth('alpha', 'POST', {}))
    ).json();
    f.raw.failDelete = true;
    const r = await f.request(`/api/recordings/${u.recording.id}`, f.auth('alpha', 'DELETE'));
    assert.equal(r.status, 202);
    assert.equal((await r.json()).state, 'deleting');
    assert.equal((await f.request(`/api/shares/${share.id}`)).status, 404);
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth())).status,
      404,
    );
    assert.equal(
      f.db.db.prepare('SELECT retained_seconds FROM tenants WHERE id=?').get('alpha')
        .retained_seconds,
      10,
    );
    f.raw.failDelete = false;
    const done = await f.request(`/api/recordings/${u.recording.id}`, f.auth('alpha', 'DELETE'));
    assert.equal((await done.json()).state, 'deleted');
    const t = f.db.db.prepare('SELECT * FROM tenants WHERE id=?').get('alpha');
    assert.equal(t.raw_bytes, 0);
    assert.equal(t.retained_seconds, 0);
    assert.equal(f.raw.objects.size, 0);
    assert.equal(f.providers.videos.size, 0);
  }),
);

test(
  'cleanup uses exact trusted tenant prefix and controlled raw/cancellation/abandoned clocks',
  use(async (f) => {
    const u = await ready(f);
    // This clock fixture controls entitlement directly; billing reconciliation has separate tests.
    delete f.env.STRIPE_SECRET_KEY;
    const foreign = 't/beta/r/foreign/bytes';
    await f.raw.put(foreign, bytes);
    const run = async () => {
      let p;
      await f.worker.scheduled({}, f.env, {
        waitUntil(value) {
          p = value;
        },
      });
      return p;
    };
    f.db.db
      .prepare('UPDATE recordings SET created_at=? WHERE tenant_id=? AND id=?')
      .run(f.now() - 7 * 86400000, 'alpha', u.recording.id);
    await run();
    assert.equal(f.raw.objects.has(foreign), true);
    assert.equal(f.providers.videos.size, 1);
    assert.equal(
      f.db.db.prepare('SELECT raw_bytes FROM tenants WHERE id=?').get('alpha').raw_bytes,
      0,
    );
    f.db.db
      .prepare("UPDATE tenants SET status='canceled',grace_through=? WHERE id=?")
      .run(f.now() + 1, 'alpha');
    await run();
    assert.equal(f.providers.videos.size, 1);
    f.advance(2);
    await run();
    assert.equal(f.providers.videos.size, 0);
    assert.equal(f.raw.objects.has(foreign), true);
  }),
);

test(
  'late raw PUT and deletion cannot leave a deleted object untracked',
  use(async (f) => {
    const a = await newRecording(f),
      desc = { track: 'screen', sequence: 0, bytes: 8, sha256: sha(bytes), mimeType: 'video/webm' };
    const g = await (
      await f.request(`/api/recordings/${a.id}/chunks/grant`, f.auth('alpha', 'POST', desc))
    ).json();
    let release, entered;
    const blocked = new Promise((r) => {
      release = r;
    });
    const began = new Promise((r) => {
      entered = r;
    });
    f.raw.beforePut = async () => {
      entered();
      await blocked;
    };
    const o = f.auth('alpha', 'PUT');
    o.headers.Authorization = `Upload ${g.token}`;
    o.headers['Content-Type'] = desc.mimeType;
    o.body = bytes;
    const put = f.request(new URL(g.url).pathname, o);
    await began;
    const del = await f.request(`/api/recordings/${a.id}`, f.auth('alpha', 'DELETE'));
    assert.equal(del.status, 202);
    release();
    assert.equal((await put).status, 409);
    f.raw.beforePut = null;
    assert.equal(
      (await (await f.request(`/api/recordings/${a.id}`, f.auth('alpha', 'DELETE'))).json()).state,
      'deleted',
    );
    assert.equal(f.raw.objects.size, 0);
  }),
);

test(
  'Checkout selects $15 server price and ignores submitted price; redirect grants nothing',
  use(async (f) => {
    f.db.db.prepare("UPDATE tenants SET status='none',paid_through=NULL WHERE id=?").run('alpha');
    await error(
      await f.request('/api/billing/checkout', f.auth('alpha', 'POST', { price: 'price_evil' })),
      'INVALID_REQUEST',
      400,
    );
    assert.equal(
      (await f.request('/api/billing/checkout', f.auth('alpha', 'POST', {}))).status,
      200,
    );
    const sent = f.providers.stripe.find((v) => v.url.includes('/checkout/sessions'));
    const body = new URLSearchParams(sent.options.body);
    assert.equal(body.get('line_items[0][price]'), 'price_fixture');
    assert.equal(body.get('customer'), 'cus_alpha');
    assert.equal(body.get('mode'), 'subscription');
    await f.request('/?billing=return');
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'none',
    );
    assert.equal((await f.request('/api/billing/portal', f.auth('alpha', 'POST', {}))).status, 200);
  }),
);

test(
  'webhook validates raw signatures, deduplicates, reconciles latest state and retries provider failure',
  use(async (f) => {
    const event = {
      id: 'evt_one',
      type: 'customer.subscription.updated',
      livemode: false,
      data: { object: { customer: 'cus_alpha' } },
    };
    const bad = webhookOptions(f, event);
    bad.body += ' ';
    await error(await f.request('/api/billing/webhook', bad), 'WEBHOOK_SIGNATURE', 400);
    f.providers.stripeFail = true;
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, event))).status, 503);
    assert.equal(
      f.db.db.prepare('SELECT status FROM webhook_events WHERE id=?').get('evt_one').status,
      'pending',
    );
    f.providers.stripeFail = false;
    f.providers.subscriptions = [subscription(f)];
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, event))).status, 200);
    const calls = f.providers.stripe.length;
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, event))).status, 200);
    assert.equal(f.providers.stripe.length, calls);
    f.providers.subscriptions = [
      subscription(f, {
        status: 'past_due',
        latest_invoice: { status: 'open', amount_paid: 0, currency: 'usd', customer: 'cus_alpha' },
      }),
    ];
    const older = { ...event, id: 'evt_older', type: 'invoice.paid' };
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, older))).status, 200);
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'past_due',
    );
    await error(
      await f.request(
        '/api/recordings',
        f.auth('alpha', 'POST', { clientId: 'unpaid-draft', title: 'x', mode: 'screen' }),
      ),
      'SUBSCRIPTION_REQUIRED',
      402,
    );
  }),
);

test(
  'refund/dispute state stays suspended despite later subscription events',
  use(async (f) => {
    f.providers.subscriptions = [subscription(f)];
    f.providers.charge.amount_refunded = 1500;
    const event = {
      id: 'evt_refund',
      type: 'charge.refunded',
      livemode: false,
      data: { object: { id: 'ch_fixture', customer: 'cus_alpha' } },
    };
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, event))).status, 200);
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'suspended',
    );
    assert.equal(
      (
        await f.request(
          '/api/billing/webhook',
          webhookOptions(f, {
            ...event,
            id: 'evt_updated',
            type: 'customer.subscription.updated',
            data: { object: { customer: 'cus_alpha' } },
          }),
        )
      ).status,
      200,
    );
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'suspended',
    );
  }),
);

async function identity(f, overrides = {}, badSignature = false) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    publicKey = pair.publicKey.export({ format: 'jwk' });
  f.providers.jwks = { keys: [{ ...publicKey, kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
  const start = await f.request('/auth/google/start');
  const u = new URL(start.headers.get('location'));
  const state = u.searchParams.get('state'),
    nonce = u.searchParams.get('nonce'),
    now = Math.floor(f.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    aud: f.env.GOOGLE_CLIENT_ID,
    exp: now + 3600,
    iat: now,
    sub: 'new-google-subject',
    email: 'alpha@example.com',
    email_verified: true,
    nonce,
    name: 'Alpha',
    ...overrides,
  };
  const encoded = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
  ].join('.');
  const key = badSignature
    ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    : pair.privateKey;
  f.providers.googleToken = `${encoded}.${rsaSign('RSA-SHA256', Buffer.from(encoded), key).toString('base64url')}`;
  return {
    state,
    nonce,
    start,
    request: () =>
      f.request(`/auth/google/callback?state=${state}&code=fixture-code`, {
        headers: { Cookie: `__Host-rushes-oauth=${state}` },
      }),
  };
}
test(
  'OIDC verifies RSA signature, issuer, audience, nonce, expiry and email; state consumed exactly once',
  use(async (f) => {
    const login = await identity(f);
    const start = new URL(login.start.headers.get('location'));
    assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
    const result = await login.request();
    assert.equal(result.status, 302);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 3);
    await error(await login.request(), 'OIDC_STATE', 401);
  }),
);

for (const [label, claims, signature] of [
  ['issuer', { iss: 'https://evil.example' }, false],
  ['audience', { aud: 'other-client' }, false],
  ['nonce', { nonce: 'other-nonce' }, false],
  ['expiry', { exp: 1 }, false],
  ['email', { email_verified: false }, false],
  ['signature', {}, true],
])
  test(
    `OIDC rejects invalid ${label}`,
    use(async (f) => {
      const login = await identity(f, claims, signature);
      assert.equal((await login.request()).status, 401);
      assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2);
    }),
  );

test(
  'invite list and account cap restrict valid verified identities',
  use(async (f) => {
    const outsider = await identity(f, { email: 'outsider@example.com' });
    await error(await outsider.request(), 'INVITE_REQUIRED', 403);
    f.env.ACCOUNT_CAP = '2';
    const full = await identity(f);
    await error(await full.request(), 'ACCOUNT_CAP', 403);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 2);
  }),
);

test(
  'retained raw downloads are private, tenant scoped, bounded and integrity checked',
  use(async (f) => {
    const a = await newRecording(f);
    await storedChunk(f, a, 'alpha', 'screen');
    const path = `/api/recordings/${a.id}/chunks/screen/0`;
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, f.auth('beta'))).status, 404);
    const partial = f.auth();
    partial.headers.Range = 'bytes=2-5';
    const r = await f.request(path, partial);
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 2-5/8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes.slice(2, 6));
    partial.headers.Range = 'bytes=0-100';
    assert.equal((await f.request(path, partial)).status, 416);
    const value = [...f.raw.objects.values()][0];
    value.bytes[7] = 9;
    await error(await f.request(path, f.auth()), 'CHUNK_CORRUPT', 503);
  }),
);

test(
  'owner composed export waits for provider, supports grace, reserves delivery and keeps provider download private',
  use(async (f) => {
    const u = await ready(f),
      path = `/api/recordings/${u.recording.id}/export`;
    assert.equal((await f.request(path, { method: 'POST' })).status, 401);
    assert.equal((await f.request(path, f.auth('beta', 'POST', {}))).status, 404);
    f.providers.downloadReady = false;
    const pending = await f.request(path, f.auth('alpha', 'POST', {}));
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { status: 'processing' });
    assert.equal(f.providers.tokens.length, 0);
    f.providers.downloadReady = true;
    f.db.db
      .prepare("UPDATE tenants SET status='canceled',grace_through=? WHERE id=?")
      .run(f.now() + 30 * 86400000, 'alpha');
    const exported = await f.request(path, f.auth('alpha', 'POST', {}));
    assert.equal(exported.status, 200);
    const grant = await exported.json();
    assert.equal(grant.status, 'ready');
    assert.match(grant.url, /\/downloads\/default\.mp4$/);
    assert.equal(f.providers.tokens[0].downloadable, true);
    assert.ok(Date.parse(grant.expiresAt) <= f.now() + 300000);
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .delivery_seconds,
      10,
    );
    f.db.db
      .prepare('UPDATE quota_periods SET delivery_seconds=? WHERE tenant_id=?')
      .run(60000, 'alpha');
    await error(await f.request(path, f.auth('alpha', 'POST', {})), 'DELIVERY_QUOTA', 429);
    f.db.db.prepare('UPDATE tenants SET grace_through=? WHERE id=?').run(f.now() - 1, 'alpha');
    assert.equal((await f.request(path, f.auth('alpha', 'POST', {}))).status, 404);
  }),
);

test(
  'private owner export rejects altered provider privacy and no public share export exists',
  use(async (f) => {
    const u = await ready(f),
      path = `/api/recordings/${u.recording.id}/export`;
    f.providers.videos.get(u.grant.uid).requireSignedURLs = false;
    await error(await f.request(path, f.auth('alpha', 'POST', {})), 'STREAM_OWNERSHIP', 503);
    assert.equal(f.providers.tokens.length, 0);
    assert.equal(
      (
        await f.request('/api/shares/arbitrary/export', {
          method: 'POST',
          headers: { Origin: f.env.PUBLIC_BASE_URL, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
  }),
);

test(
  'retained quota, delivery concurrency and kill switches independently fail closed',
  use(async (f) => {
    const a = await newRecording(f, 'alpha', 'retained-draft'),
      c = await storedChunk(f, a),
      input = finalInput(a, c, f.now());
    input.manifest.id = 'retained-draft';
    f.db.db.prepare('UPDATE tenants SET retained_seconds=? WHERE id=?').run(17401, 'alpha');
    await error(
      await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input)),
      'RETAINED_QUOTA',
      429,
    );
    assert.equal(f.providers.created.length, 0);
    f.db.db.prepare('UPDATE tenants SET retained_seconds=0 WHERE id=?').run('alpha');
    const r = await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input));
    const u = (await r.json()).upload;
    const v = f.providers.videos.get(u.uid);
    v.readyToStream = true;
    v.status.state = 'ready';
    v.duration = 10;
    await f.request(`/api/recordings/${a.id}/process`, f.auth('alpha', 'POST', {}));
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.request(`/api/recordings/${a.id}/playback`, f.auth())),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 429]);
    f.env.HOSTING_ENABLED = 'false';
    await error(
      await f.request(
        '/api/recordings',
        f.auth('alpha', 'POST', { clientId: 'stopped', title: 'x', mode: 'screen' }),
      ),
      'HOSTING_DISABLED',
      503,
    );
    f.env.STRIPE_SECRET_KEY = 'sk_live_fake';
    await error(await f.request('/api/config'), 'LIVE_BILLING_DISABLED', 503);
  }),
);

test(
  'unknown Stream creation stays quarantined, then scheduled exact-creator cleanup releases held reservation',
  use(async (f) => {
    f.providers.uncertainCreate = true;
    const a = await newRecording(f, 'alpha', 'uncertain-draft'),
      c = await storedChunk(f, a),
      input = finalInput(a, c, f.now());
    input.manifest.id = 'uncertain-draft';
    assert.equal(
      (await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input))).status,
      503,
    );
    f.providers.uncertainCreate = false;
    await error(
      await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input)),
      'STREAM_CREATE_UNCERTAIN',
      503,
    );
    assert.equal(f.providers.created.length, 1);
    f.advance(86400001);
    let pending;
    await f.worker.scheduled({}, f.env, {
      waitUntil(p) {
        pending = p;
      },
    });
    await pending;
    assert.equal(f.providers.videos.size, 0);
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      0,
    );
    assert.equal(
      f.db.db.prepare('SELECT state FROM recordings WHERE tenant_id=? AND id=?').get('alpha', a.id)
        .state,
      'deleted',
    );
  }),
);

test(
  'scheduled cleanup retains failure for retry and rejects out-of-prefix object lists',
  use(async (f) => {
    const a = await newRecording(f);
    await storedChunk(f, a);
    f.db.db
      .prepare('UPDATE recordings SET updated_at=? WHERE tenant_id=? AND id=?')
      .run(f.now() - 86400000, 'alpha', a.id);
    f.raw.extraList = true;
    let p;
    await f.worker.scheduled({}, f.env, {
      waitUntil(v) {
        p = v;
      },
    });
    const result = await p;
    assert.equal(result.pending, 1);
    assert.equal(
      f.db.db.prepare('SELECT state FROM recordings WHERE tenant_id=? AND id=?').get('alpha', a.id)
        .state,
      'deleting',
    );
    assert.equal(f.raw.objects.size, 1);
    f.raw.extraList = false;
    await f.worker.scheduled({}, f.env, {
      waitUntil(v) {
        p = v;
      },
    });
    assert.equal((await p).complete, 1);
    assert.equal(f.raw.objects.size, 0);
  }),
);

test(
  'billing cancellation grants exactly thirty days; failed renewal grants seven and auth-required invoice stays unpaid',
  use(async (f) => {
    f.providers.subscriptions = [
      subscription(f, {
        status: 'canceled',
        canceled_at: Math.floor(f.now() / 1000),
        latest_invoice: null,
      }),
    ];
    const event = {
      id: 'evt_cancel',
      type: 'customer.subscription.deleted',
      livemode: false,
      data: { object: { customer: 'cus_alpha' } },
    };
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, event))).status, 200);
    let row = f.db.db.prepare('SELECT * FROM tenants WHERE id=?').get('alpha');
    assert.equal(row.status, 'canceled');
    assert.equal(row.grace_through, f.now() + 30 * 86400000);
    f.providers.subscriptions = [
      subscription(f, {
        status: 'incomplete',
        latest_invoice: { status: 'open', amount_paid: 0, currency: 'usd', customer: 'cus_alpha' },
      }),
    ];
    assert.equal(
      (
        await f.request(
          '/api/billing/webhook',
          webhookOptions(f, {
            ...event,
            id: 'evt_authfailed',
            type: 'invoice.payment_action_required',
          }),
        )
      ).status,
      200,
    );
    row = f.db.db.prepare('SELECT * FROM tenants WHERE id=?').get('alpha');
    assert.equal(row.status, 'past_due');
    assert.equal(row.grace_through, row.paid_through + 7 * 86400000);
    assert.equal(
      (await (await f.request('/api/recordings', f.auth())).json()).usage.subscription.canUpload,
      false,
    );
  }),
);

test(
  'modeled app budget rolls back new storage slots atomically and deletion still works',
  use(async (f) => {
    const a = await newRecording(f, 'alpha', 'budget-draft'),
      chunk = await storedChunk(f, a),
      input = finalInput(a, chunk, f.now());
    input.manifest.id = 'budget-draft';
    f.env.PILOT_BUDGET_USD = '5.02';
    await error(
      await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input)),
      'APPLICATION_BUDGET',
      429,
    );
    assert.equal(f.providers.created.length, 0);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM upload_reservations').get().n, 0);
    assert.equal(
      f.db.db.prepare('SELECT state FROM recordings WHERE tenant_id=? AND id=?').get('alpha', a.id)
        .state,
      'draft',
    );
    assert.equal(
      (await (await f.request(`/api/recordings/${a.id}`, f.auth('alpha', 'DELETE'))).json()).state,
      'deleted',
    );
    assert.equal(
      f.db.db.prepare('SELECT raw_bytes FROM tenants WHERE id=?').get('alpha').raw_bytes,
      0,
    );
  }),
);

test(
  'global final-budget delivery race cannot overspend across different tenants',
  use(async (f) => {
    const a = await ready(f, 'alpha', 600),
      b = await ready(f, 'beta', 600);
    f.env.PILOT_BUDGET_USD = '10.03';
    const results = await Promise.all([
      f.request(`/api/recordings/${a.recording.id}/playback`, f.auth()),
      f.request(`/api/recordings/${b.recording.id}/playback`, f.auth('beta')),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
    const failed = results.find((r) => r.status === 429);
    assert.equal((await failed.json()).error.code, 'APPLICATION_BUDGET');
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months').get().delivery_seconds,
      600,
    );
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 1);
  }),
);

test(
  'failed provider playback releases unused tenant and modeled delivery reservation',
  use(async (f) => {
    const u = await ready(f);
    const original = f.providers.fetch.bind(f.providers);
    f.runtime.fetch = async (url, options) =>
      String(url).endsWith('/token')
        ? new Response('unavailable', { status: 503 })
        : original(url, options);
    await error(
      await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth()),
      'STREAM_PLAYBACK',
      503,
    );
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .delivery_seconds,
      0,
    );
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months').get().delivery_seconds,
      0,
    );
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 0);
  }),
);
test(
  'ten-minute playback token covers the whole clip with a bounded twelve-minute expiry',
  use(async (f) => {
    const u = await ready(f, 'alpha', 600);
    const result = await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth());
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.equal(Date.parse(value.expiresAt), f.now() + 720000);
    assert.equal(f.providers.tokens[0].exp * 1000, f.now() + 720000);
    assert.equal(f.providers.tokens[0].downloadable, false);
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .delivery_seconds,
      600,
    );
  }),
);
test(
  'past-due access expires after seven days without premature deletion before final cancellation',
  use(async (f) => {
    const u = await ready(f);
    delete f.env.STRIPE_SECRET_KEY;
    f.db.db
      .prepare("UPDATE tenants SET status='past_due',paid_through=?,grace_through=? WHERE id=?")
      .run(f.now() - 8 * 86400000, f.now() - 86400000, 'alpha');
    let p;
    await f.worker.scheduled({}, f.env, {
      waitUntil(value) {
        p = value;
      },
    });
    await p;
    assert.equal(f.providers.videos.size, 1);
    assert.equal(
      f.db.db
        .prepare('SELECT state FROM recordings WHERE tenant_id=? AND id=?')
        .get('alpha', u.recording.id).state,
      'ready',
    );
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth())).status,
      404,
    );
  }),
);
test(
  'scheduled billing repair reconciles current provider state and reports unavailable providers for retry',
  use(async (f) => {
    f.providers.subscriptions = [
      subscription(f, {
        status: 'past_due',
        latest_invoice: { status: 'open', amount_paid: 0, currency: 'usd', customer: 'cus_alpha' },
      }),
    ];
    let p;
    await f.worker.scheduled({}, f.env, {
      waitUntil(value) {
        p = value;
      },
    });
    await p;
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'past_due',
    );
    f.providers.stripeFail = true;
    await f.worker.scheduled({}, f.env, {
      waitUntil(value) {
        p = value;
      },
    });
    const result = await p;
    assert.equal(result.billingPending, 2);
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'past_due',
    );
  }),
);
test(
  'operator suspension survives paid subscription reconciliation and revokes future media access',
  use(async (f) => {
    const u = await ready(f);
    f.providers.subscriptions = [subscription(f)];
    f.db.db
      .prepare("UPDATE tenants SET suspended_by_operator=1,status='suspended' WHERE id=?")
      .run('alpha');
    const event = {
      id: 'evt_operator',
      type: 'invoice.paid',
      livemode: false,
      data: { object: { customer: 'cus_alpha' } },
    };
    assert.equal((await f.request('/api/billing/webhook', webhookOptions(f, event))).status, 200);
    assert.equal(
      f.db.db.prepare('SELECT status FROM tenants WHERE id=?').get('alpha').status,
      'suspended',
    );
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth())).status,
      404,
    );
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/export`, f.auth('alpha', 'POST', {})))
        .status,
      404,
    );
    await error(
      await f.request(
        '/api/recordings',
        f.auth('alpha', 'POST', { clientId: 'suspended-draft', title: 'x', mode: 'screen' }),
      ),
      'ACCOUNT_SUSPENDED',
      403,
    );
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}`, f.auth('alpha', 'DELETE'))).status,
      200,
    );
  }),
);
test(
  'blank optional provider settings preserve local capture and disabled cloud defaults',
  use(async (f) => {
    for (const key of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_ID',
      'STRIPE_WEBHOOK_SECRET',
      'CLOUDFLARE_API_TOKEN',
    ])
      f.env[key] = '';
    const result = await f.request('/api/config');
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.equal(value.captureEnabled, true);
    assert.equal(value.hostingEnabled, false);
    assert.equal(value.googleConfigured, false);
    assert.equal((await f.request('/')).status, 200);
  }),
);
test(
  'in-flight raw upload cap bounds body buffers and keeps rejected chunks safely retryable',
  use(async (f) => {
    const a = await newRecording(f),
      b = await newRecording(f);
    const descriptor = {
      track: 'composed',
      sequence: 0,
      bytes: 8,
      sha256: sha(bytes),
      mimeType: 'video/webm',
    };
    const ga = await (
        await f.request(`/api/recordings/${a.id}/chunks/grant`, f.auth('alpha', 'POST', descriptor))
      ).json(),
      gb = await (
        await f.request(`/api/recordings/${b.id}/chunks/grant`, f.auth('alpha', 'POST', descriptor))
      ).json();
    const options = (g) => {
      const o = f.auth('alpha', 'PUT');
      o.headers.Authorization = `Upload ${g.token}`;
      o.headers['Content-Type'] = descriptor.mimeType;
      o.body = bytes;
      return o;
    };
    let release, entered;
    const blocked = new Promise((r) => (release = r)),
      started = new Promise((r) => (entered = r));
    f.raw.beforePut = async () => {
      entered();
      await blocked;
    };
    const first = f.request(new URL(ga.url).pathname, options(ga));
    await started;
    await error(await f.request(new URL(gb.url).pathname, options(gb)), 'RAW_CONCURRENCY', 429);
    release();
    assert.equal((await first).status, 200);
    f.raw.beforePut = null;
    assert.equal((await f.request(new URL(gb.url).pathname, options(gb))).status, 200);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM active_writes').get().n, 0);
    assert.equal(f.raw.objects.size, 2);
  }),
);
test(
  'private library pages beyond five hundred short videos with stable ties and no cross-tenant scope from cursor',
  use(async (f) => {
    const put = f.db.db.prepare(
      "INSERT INTO recordings(id,tenant_id,client_id,title,mode,state,created_at,updated_at,duration_ms) VALUES(?,?,?,?,'screen','ready',?,?,1000)",
    );
    f.db.db.exec('BEGIN');
    for (let i = 0; i < 601; i++) {
      const id = `r-${String(i).padStart(6, '0')}`;
      for (const user of ['alpha', 'beta'])
        put.run(id, user, `local-${id}`, `${user}-${id}`, f.now() - Math.floor(i / 3), f.now());
    }
    f.db.db.exec('COMMIT');
    const ids = [];
    let cursor = null,
      initial = null;
    do {
      const path = cursor
        ? `/api/recordings?cursor=${encodeURIComponent(cursor)}`
        : '/api/recordings';
      const response = await f.request(path, f.auth());
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.ok(value.recordings.length <= 50);
      assert.ok(value.recordings.every((r) => r.title.startsWith('alpha-')));
      ids.push(...value.recordings.map((r) => r.id));
      cursor = value.nextCursor;
      if (!initial) initial = cursor;
    } while (cursor);
    assert.equal(ids.length, 601);
    assert.equal(new Set(ids).size, 601);
    const expected = f.db.db
      .prepare('SELECT id FROM recordings WHERE tenant_id=? ORDER BY created_at DESC,id DESC')
      .all('alpha')
      .map((r) => r.id);
    assert.deepEqual(ids, expected);
    const beta = await (
      await f.request(`/api/recordings?cursor=${initial}`, f.auth('beta'))
    ).json();
    assert.ok(beta.recordings.every((r) => r.title.startsWith('beta-')));
    await error(
      await f.request('/api/recordings?cursor=not-json', f.auth()),
      'INVALID_CURSOR',
      400,
    );
    const injected = Buffer.from(
      JSON.stringify({ createdAt: f.now(), id: 'r-999999', tenant: 'beta' }),
    ).toString('base64url');
    await error(
      await f.request(`/api/recordings?cursor=${injected}`, f.auth()),
      'INVALID_CURSOR',
      400,
    );
  }),
);
test(
  'forward schema and manual isolated rollback work on real SQLite',
  use(async (f) => {
    const { readFile } = await import('node:fs/promises');
    const rollback = await readFile(
      new URL('../migrations/rollback/0001_browser_service.sql', import.meta.url),
      'utf8',
    );
    f.db.db.exec(rollback);
    const remaining = f.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    assert.deepEqual(remaining, []);
  }),
);
test(
  'returned cloud manifest does not trust client-supplied upload address or provider uid',
  use(async (f) => {
    const a = await newRecording(f, 'alpha', 'manifest-draft'),
      c = await storedChunk(f, a),
      input = finalInput(a, c, f.now());
    input.manifest.id = 'manifest-draft';
    input.manifest.upload = {
      url: 'https://evil.example/upload',
      uid: 'not-provider-authority',
      offset: 0,
      expiresAt: new Date(f.now() + 600000).toISOString(),
    };
    assert.equal(
      (await f.request(`/api/recordings/${a.id}/finalize`, f.auth('alpha', 'POST', input))).status,
      200,
    );
    const detail = await (await f.request(`/api/recordings/${a.id}`, f.auth())).json();
    assert.equal(detail.manifest.upload, undefined);
    assert.equal(detail.manifest.cloudRecordingId, a.id);
  }),
);
