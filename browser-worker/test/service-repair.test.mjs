import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import {
  mkdtemp as makeFixtureDirectory,
  readFile as readFixtureFile,
  rm as removeFixtureDirectory,
} from 'node:fs/promises';
import { tmpdir as temporaryLocation } from 'node:os';
import { join as fixtureLocation } from 'node:path';
import {
  fixture,
  D1Fixture,
  newRecording,
  storedChunk,
  finalInput,
  ready,
  uploaded,
} from './fixtures.mjs';
const use = (fn) => async () => {
  const f = await fixture();
  try {
    await fn(f);
  } finally {
    f.close();
  }
};
async function draft(f, id = 'repair-draft') {
  const recording = await newRecording(f, 'alpha', id),
    chunk = await storedChunk(f, recording),
    input = finalInput(recording, chunk, f.now());
  input.manifest.id = id;
  return { recording, input };
}
const finish = (f, d) =>
  f.request(`/api/recordings/${d.recording.id}/finalize`, f.auth('alpha', 'POST', d.input));
async function maintain(f) {
  delete f.env.STRIPE_SECRET_KEY;
  let p;
  await f.worker.scheduled({}, f.env, {
    waitUntil(value) {
      p = value;
    },
  });
  return p;
}
function breakMapping(f, breakErrorWrite = false) {
  const original = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    const statement = original(sql);
    if (
      sql.startsWith('UPDATE recordings SET stream_uid=') ||
      (breakErrorWrite && sql.startsWith("UPDATE recordings SET error='STREAM_CREATE_UNCERTAIN'"))
    )
      statement.run = async () => {
        throw new Error('synthetic post-create database write loss');
      };
    return statement;
  };
}
test(
  'mapping and error-write failures leave durable quarantine until exact provider cleanup succeeds',
  use(async (f) => {
    const d = await draft(f);
    breakMapping(f, true);
    assert.equal((await finish(f, d)).status, 503);
    const row = f.db.db.prepare('SELECT * FROM recordings WHERE id=?').get(d.recording.id);
    assert.equal(row.error, null);
    assert.equal(row.stream_uid, null);
    assert.ok(row.provision_id);
    assert.equal(row.finalize_hash.startsWith('v2:'), true);
    assert.equal(f.providers.videos.size, 1);
    assert.equal((await finish(f, d)).status, 503);
    assert.equal(f.providers.created.length, 1);
    f.advance(25 * 3600000);
    f.providers.deleteFail = true;
    const held = await maintain(f);
    assert.equal(held.pending, 1);
    assert.equal(
      f.db.db.prepare('SELECT state FROM recordings WHERE id=?').get(d.recording.id).state,
      'deleting',
    );
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      600,
    );
    assert.equal(f.providers.videos.size, 1);
    f.providers.deleteFail = false;
    assert.equal((await maintain(f)).complete, 1);
    assert.equal(f.providers.videos.size, 0);
    assert.equal(
      f.db.db.prepare('SELECT state,provision_id FROM recordings WHERE id=?').get(d.recording.id)
        .state,
      'deleted',
    );
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      0,
    );
  }),
);
test('a real process termination after provider creation recovers from the persisted marker without any catch write', async () => {
  const folder = await makeFixtureDirectory(
      fixtureLocation(temporaryLocation(), 'rushes-creation-stop-'),
    ),
    dbPath = fixtureLocation(folder, 'db.sqlite'),
    providerPath = fixtureLocation(folder, 'provider.json');
  const child = fork(new URL('./crash-fixture.mjs', import.meta.url), [dbPath, providerPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stderr.on('data', (v) => (output += v));
  let resumed;
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`crash fixture did not reach boundary: ${output}`)),
        10000,
      );
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`crash fixture exited early: ${output}`)));
      child.once('message', (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    const ended = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal((await ended).signal, 'SIGKILL');
    const f = await fixture();
    f.db.close();
    resumed = new D1Fixture('', dbPath);
    f.env.DB = resumed;
    const cloud = JSON.parse(await readFixtureFile(providerPath, 'utf8'));
    f.providers.videos = new Map(cloud.videos);
    f.raw.objects = new Map(
      cloud.raw.map(([key, value]) => [key, { ...value, bytes: new Uint8Array(value.bytes) }]),
    );
    const row = resumed.db
      .prepare('SELECT state,error,stream_uid,provision_id FROM recordings WHERE id=?')
      .get(ready.id);
    assert.equal(row.state, 'uploading');
    assert.equal(row.error, null);
    assert.equal(row.stream_uid, null);
    assert.ok(row.provision_id);
    assert.equal(f.providers.videos.size, 1);
    f.advance(25 * 3600000);
    assert.equal((await maintain(f)).complete, 1);
    assert.equal(f.providers.videos.size, 0);
    assert.equal(f.raw.objects.size, 0);
    assert.equal(
      resumed.db.prepare('SELECT state FROM recordings WHERE id=?').get(ready.id).state,
      'deleted',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    resumed?.close();
    await removeFixtureDirectory(folder, { recursive: true, force: true });
  }
});
for (const outcome of ['503', 'malformed', 'transport'])
  test(
    `uncertain ${outcome} response after creation cannot create another asset on retry`,
    use(async (f) => {
      const d = await draft(f),
        original = f.runtime.fetch;
      let fault = true;
      f.runtime.fetch = async (url, options) => {
        const r = await original(url, options);
        if (String(url).includes('direct_user=true') && fault) {
          fault = false;
          if (outcome === '503')
            return new Response('synthetic upstream error after side effect', { status: 503 });
          if (outcome === 'malformed')
            return new Response(null, {
              status: 201,
              headers: { Location: r.headers.get('location') },
            });
          throw new Error('synthetic lost connection after side effect');
        }
        return r;
      };
      assert.equal((await finish(f, d)).status, 503);
      assert.equal((await finish(f, d)).status, 503);
      assert.equal(f.providers.created.length, 1);
      assert.equal(f.providers.videos.size, 1);
      assert.ok(
        f.db.db.prepare('SELECT provision_id FROM recordings WHERE id=?').get(d.recording.id)
          .provision_id,
      );
      f.advance(25 * 3600000);
      assert.equal((await maintain(f)).complete, 1);
      assert.equal(f.providers.videos.size, 0);
    }),
  );
test(
  'creator lookup must prove complete coverage before releasing the creation reservation',
  use(async (f) => {
    const d = await draft(f);
    breakMapping(f, true);
    await finish(f, d);
    const original = f.runtime.fetch;
    f.runtime.fetch = async (url, options) => {
      if (String(url).includes('include_counts=true'))
        return Response.json({ success: true, total: 1, result: [] });
      return original(url, options);
    };
    f.advance(25 * 3600000);
    assert.equal((await maintain(f)).pending, 1);
    assert.equal(f.providers.videos.size, 1);
    assert.equal(
      f.db.db.prepare('SELECT reserved_seconds FROM quota_periods WHERE tenant_id=?').get('alpha')
        .reserved_seconds,
      600,
    );
  }),
);
test(
  'real UUID ownership tags fit Stream64-character limit and provider status verifies the same key',
  use(async (f) => {
    const tenant = 'a0000000-0000-4000-8000-000000000001';
    f.db.db
      .prepare(
        'INSERT INTO tenants(id,status,paid_through,period_start,period_end,updated_at) SELECT ?,status,paid_through,period_start,period_end,updated_at FROM tenants WHERE id=?',
      )
      .run(tenant, 'alpha');
    f.db.db.prepare('UPDATE accounts SET tenant_id=? WHERE id=?').run(tenant, 'account-alpha');
    const u = await uploaded(f);
    const value = f.providers.videos.get(u.grant.uid);
    assert.match(value.creator, /^[a-f0-9]{64}$/);
    assert.ok(`${tenant}:${u.recording.id}`.length > 64);
    value.readyToStream = true;
    value.duration = 10;
    value.status.state = 'ready';
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/process`, f.auth('alpha', 'POST', {})))
        .status,
      200,
    );
  }),
);
async function rollover(f, oldFails) {
  const a = await ready(f),
    b = await ready(f, 'beta'),
    oct = Date.UTC(2026, 9, 1),
    nov = Date.UTC(2026, 10, 1);
  f.advance(nov - 1000 - f.now());
  f.db.db
    .prepare('UPDATE sessions SET expires_at=?,absolute_expiry=?')
    .run(f.now() + 86400000, f.now() + 86400000);
  f.db.db.prepare('UPDATE session_families SET absolute_expiry=?').run(f.now() + 86400000);
  f.db.db
    .prepare('UPDATE tenants SET paid_through=?,period_end=?')
    .run(f.now() + 86400000, f.now() + 86400000);
  const prepare = f.db.prepare.bind(f.db),
    batch = f.db.batch.bind(f.db);
  f.db.prepare = (sql) => {
    const s = prepare(sql);
    s.probeSQL = sql;
    return s;
  };
  let resume, announce;
  const blocked = new Promise((r) => (announce = r)),
    gate = new Promise((r) => (resume = r));
  let stop = true;
  f.db.batch = async (statements) => {
    if (stop && statements.some((s) => s.probeSQL.startsWith('INSERT INTO deliveries'))) {
      stop = false;
      announce();
      await gate;
    }
    return batch(statements);
  };
  const fetch = f.runtime.fetch;
  f.runtime.fetch = (url, options) =>
    String(url).includes(`/stream/${oldFails ? a.grant.uid : b.grant.uid}/token`)
      ? Promise.resolve(new Response('synthetic failed token mint', { status: 503 }))
      : fetch(url, options);
  const old = f.request(`/api/recordings/${a.recording.id}/playback`, f.auth());
  await blocked;
  f.advance(2000);
  assert.equal(
    (await f.request(`/api/recordings/${b.recording.id}/playback`, f.auth('beta'))).status,
    oldFails ? 200 : 503,
  );
  resume();
  assert.equal((await old).status, oldFails ? 503 : 200);
  assert.equal(
    f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(oct)
      .delivery_seconds,
    oldFails ? 0 : 10,
  );
  assert.equal(
    f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(nov)
      .delivery_seconds,
    oldFails ? 10 : 0,
  );
}
test(
  'failed old-month delivery releases the same immutable month across rollover',
  use((f) => rollover(f, true)),
);
test(
  'successful old-month delivery and failed new-month delivery keep both ledgers correct',
  use((f) => rollover(f, false)),
);
test('explicit upgrade replaces existing buggy triggers, repairs the reserve ledger and rejects negative counters', async () => {
  const legacy = await readFixtureFile(
      new URL('../migrations/0001_browser_service.sql', import.meta.url),
      'utf8',
    ),
    upgrade = await readFixtureFile(
      new URL('../migrations/0002_provider_budget_safety.sql', import.meta.url),
      'utf8',
    ),
    f = await fixture({ schema: legacy });
  try {
    const u = await ready(f),
      oct = Date.UTC(2026, 9, 1),
      nov = Date.UTC(2026, 10, 1);
    f.db.db.prepare('INSERT INTO budget_months(month_start) VALUES(?)').run(nov);
    f.db.db.prepare('UPDATE budget_settings SET month_start=?').run(nov);
    const fetch = f.runtime.fetch;
    f.runtime.fetch = (url, options) =>
      String(url).endsWith('/token')
        ? Promise.resolve(new Response('synthetic failed mint', { status: 503 }))
        : fetch(url, options);
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth())).status,
      503,
    );
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(oct)
        .delivery_seconds,
      -10,
    );
    f.db.db.exec(upgrade);
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(oct)
        .delivery_seconds,
      0,
    );
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(nov)
        .delivery_seconds,
      0,
    );
    f.runtime.fetch = fetch;
    assert.equal(
      (await f.request(`/api/recordings/${u.recording.id}/playback`, f.auth())).status,
      200,
    );
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(oct)
        .delivery_seconds,
      10,
    );
    assert.equal(
      f.db.db.prepare('SELECT delivery_seconds FROM budget_months WHERE month_start=?').get(nov)
        .delivery_seconds,
      0,
    );
    assert.throws(
      () =>
        f.db.db
          .prepare('UPDATE budget_months SET delivery_seconds=-1 WHERE month_start=?')
          .run(oct),
      /INVALID_BUDGET_LEDGER/,
    );
    assert.throws(
      () =>
        f.db.db.prepare('UPDATE budget_months SET operation_units=-1 WHERE month_start=?').run(oct),
      /INVALID_BUDGET_LEDGER/,
    );
    assert.throws(
      () =>
        f.db.db.prepare('UPDATE budget_months SET raw_peak_bytes=-1 WHERE month_start=?').run(oct),
      /INVALID_BUDGET_LEDGER/,
    );
  } finally {
    f.close();
  }
});
function rotatedCookies(response, csrfToken) {
  return {
    method: 'GET',
    headers: {
      Cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
      'X-CSRF-Token': csrfToken,
    },
  };
}
test(
  'logout revokes a family rotated while its revocation is pending, including late response cookies',
  use(async (f) => {
    f.advance(7 * 3600000);
    const prepare = f.db.prepare.bind(f.db);
    let signal, release;
    const blocked = new Promise((r) => (signal = r)),
      gate = new Promise((r) => (release = r));
    let pause = true;
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.startsWith('UPDATE session_families SET revoked_at=') && pause) {
        pause = false;
        const run = statement.run.bind(statement);
        statement.run = async () => {
          signal();
          await gate;
          return run();
        };
      }
      return statement;
    };
    const logout = f.request('/api/logout', f.auth('alpha', 'POST', {}));
    await blocked;
    const rotation = await f.request('/api/session', f.auth());
    assert.equal(rotation.status, 200);
    const body = await rotation.json(),
      replacement = rotatedCookies(rotation, body.csrfToken);
    release();
    assert.equal((await logout).status, 200);
    assert.equal((await f.request('/api/session', replacement)).headers.getSetCookie().length, 0);
    assert.equal((await (await f.request('/api/session', replacement)).json()).user, null);
    assert.equal((await f.request('/api/recordings', replacement)).status, 401);
  }),
);
test(
  'CSRF-valid ancestor logout still revokes the current family after a rotation committed first',
  use(async (f) => {
    f.advance(7 * 3600000);
    const rotation = await f.request('/api/session', f.auth());
    const body = await rotation.json(),
      replacement = rotatedCookies(rotation, body.csrfToken);
    assert.equal((await f.request('/api/recordings', replacement)).status, 200);
    assert.equal((await f.request('/api/logout', f.auth('alpha', 'POST', {}))).status, 200);
    assert.equal((await f.request('/api/recordings', replacement)).status, 401);
    assert.equal((await (await f.request('/api/session', replacement)).json()).user, null);
  }),
);
test(
  'a rotation with stale authenticated snapshot cannot mint after family logout commits',
  use(async (f) => {
    f.advance(7 * 3600000);
    const prepare = f.db.prepare.bind(f.db),
      batch = f.db.batch.bind(f.db);
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      statement.rotationSQL = sql;
      return statement;
    };
    let signal, release;
    const blocked = new Promise((r) => (signal = r)),
      gate = new Promise((r) => (release = r));
    let pause = true;
    f.db.batch = async (statements) => {
      if (
        pause &&
        statements.some((s) =>
          s.rotationSQL.startsWith('UPDATE session_families SET current_token_hash='),
        )
      ) {
        pause = false;
        signal();
        await gate;
      }
      return batch(statements);
    };
    const refresh = f.request('/api/session', f.auth());
    await blocked;
    assert.equal((await f.request('/api/logout', f.auth('alpha', 'POST', {}))).status, 200);
    release();
    const response = await refresh;
    assert.equal(response.status, 401);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(
      f.db.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id=?').get('account-alpha')
        .n,
      1,
    );
    assert.equal((await f.request('/api/recordings', f.auth())).status, 401);
  }),
);
test(
  'concurrent rotations have one successful successor and cannot create parallel active tokens',
  use(async (f) => {
    f.advance(7 * 3600000);
    const responses = await Promise.all([
      f.request('/api/session', f.auth()),
      f.request('/api/session', f.auth()),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
    const active = f.db.db
      .prepare(
        'SELECT COUNT(*) AS n FROM sessions s JOIN session_families f ON f.id=s.family_id WHERE s.account_id=? AND f.revoked_at IS NULL AND f.current_token_hash=s.token_hash AND s.revoked_at IS NULL',
      )
      .get('account-alpha');
    assert.equal(active.n, 1);
  }),
);
test('session-family migration rejects old lineage and requires a fresh login', async () => {
  const legacy = await readFixtureFile(
      new URL('../migrations/0001_browser_service.sql', import.meta.url),
      'utf8',
    ),
    upgrade = await readFixtureFile(
      new URL('../migrations/0003_session_families.sql', import.meta.url),
      'utf8',
    );
  const db = new D1Fixture(legacy);
  try {
    db.db
      .prepare('INSERT INTO tenants(id,period_start,period_end,updated_at) VALUES(?,?,?,?)')
      .run('tenant', 0, 1, 0);
    db.db
      .prepare(
        'INSERT INTO accounts(id,tenant_id,google_subject,email,name,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run('account', 'tenant', 'subject', 'a@example.com', 'a', 0);
    db.db
      .prepare(
        'INSERT INTO sessions(token_hash,account_id,csrf_hash,created_at,expires_at,absolute_expiry) VALUES(?,?,?,?,?,?)',
      )
      .run('old-token', 'account', 'old-csrf', 0, 9999999999999, 9999999999999);
    db.db.exec(upgrade);
    const old = db.db.prepare('SELECT revoked_at,family_id FROM sessions').get();
    assert.ok(old.revoked_at !== null);
    assert.equal(old.family_id, null);
    assert.throws(
      () =>
        db.db
          .prepare(
            'INSERT INTO sessions(token_hash,account_id,csrf_hash,created_at,expires_at,absolute_expiry) VALUES(?,?,?,?,?,?)',
          )
          .run('stale-writer', 'account', 'csrf', 0, 1, 1),
      /SESSION_FAMILY_REQUIRED/,
    );
  } finally {
    db.close();
  }
});
test(
  'public billingMode distinguishes validated test, explicitly enabled live and unconfigured billing',
  use(async (f) => {
    assert.equal((await (await f.request('/api/config')).json()).billingMode, 'test');
    f.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    f.env.STRIPE_LIVE_ENABLED = 'true';
    assert.equal((await (await f.request('/api/config')).json()).billingMode, 'live');
    f.env.STRIPE_LIVE_ENABLED = 'false';
    assert.equal((await f.request('/api/config')).status, 503);
    delete f.env.STRIPE_SECRET_KEY;
    assert.equal((await (await f.request('/api/config')).json()).billingMode, 'unconfigured');
  }),
);
