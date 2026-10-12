import { z } from 'zod';

import {
  Config,
  Env,
  Runtime,
  Failure,
  needDB,
  response,
  absent,
  json,
  origin,
  iso,
  limited,
  month,
} from './platform';

import { Auth } from './auth';

import { digest, equal, random, passwordHash, sign, verify, cookie, setCookie } from './crypto';

import {
  Row,
  recording,
  tenant,
  canView,
  currentPeriod,
  idSchema,
  recordedCreator,
} from './records';

import { StreamProvider } from './providers';

import { prepareBudget, reserveOperation } from './budget';

const shareInput = z
  .object({
    password: z.string().min(1).max(256).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

type Share = {
  id: string;
  tenant_id: string;
  recording_id: string;
  password_hash: string | null;
  password_salt: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  policy_version: number;
};

const unlockSchema = z
  .object({
    share: idSchema,
    tenant: idSchema,
    recording: idSchema,
    policy: z.number().int(),
    expiry: z.number().int(),
  })
  .strict();

function unlockCookie(id: string) {
  return `rushes-share-${id}`;
}
export async function setShare(
  request: Request,
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  runtime: Runtime,
) {
  const row = await recording(env, auth.user.tenantId, id),
    t = await tenant(env, auth.user.tenantId);
  if (row.state !== 'ready' || !canView(t, runtime.now()))
    throw new Failure(
      409,
      'SHARE_NOT_READY',
      'A ready video and active viewing entitlement are required.',
    );
  const input = await json(request, shareInput);
  const expiry = input.expiresAt ? Date.parse(input.expiresAt) : null;
  if (expiry !== null && (expiry <= runtime.now() || expiry > runtime.now() + 365 * 86400000))
    throw new Failure(400, 'SHARE_EXPIRY', 'Choose an expiry within the next year.');
  const salt = input.password ? random() : null,
    hash = input.password ? await passwordHash(input.password, salt!) : null;
  await needDB(env)
    .prepare(
      'INSERT INTO shares(id,tenant_id,recording_id,password_hash,password_salt,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,recording_id) DO UPDATE SET password_hash=excluded.password_hash,password_salt=excluded.password_salt,expires_at=excluded.expires_at,revoked_at=NULL,policy_version=policy_version+1',
    )
    .bind(crypto.randomUUID(), auth.user.tenantId, id, hash, salt, expiry)
    .run();
  const share = await needDB(env)
    .prepare('SELECT id FROM shares WHERE tenant_id=? AND recording_id=?')
    .bind(auth.user.tenantId, id)
    .first<{ id: string }>();
  return response({
    id: share!.id,
    url: `${c.PUBLIC_BASE_URL}/s/${share!.id}`,
    expiresAt: iso(expiry),
  });
}
export async function revokeShare(env: Env, auth: Auth, id: string, now: number) {
  await recording(env, auth.user.tenantId, id);
  await needDB(env)
    .prepare(
      'UPDATE shares SET revoked_at=?,policy_version=policy_version+1 WHERE tenant_id=? AND recording_id=?',
    )
    .bind(now, auth.user.tenantId, id)
    .run();
  return response({ ok: true });
}
async function policy(env: Env, id: string, now: number) {
  const s = await needDB(env)
    .prepare(
      'SELECT * FROM shares WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
    )
    .bind(id, now)
    .first<Share>();
  if (!s) absent();
  const row = await recording(env, s.tenant_id, s.recording_id);
  const t = await tenant(env, s.tenant_id);
  if (row.state !== 'ready' || !canView(t, now)) absent();
  return { share: s, row };
}
export async function shareDetail(env: Env, id: string, now: number) {
  const { share: s, row } = await policy(env, id, now);
  return response({
    id: s.id,
    title: row.title,
    durationMs: row.duration_ms,
    passwordRequired: Boolean(s.password_hash),
    expiresAt: iso(s.expires_at),
  });
}
export async function unlock(request: Request, c: Config, env: Env, id: string, runtime: Runtime) {
  origin(request, c);
  const { share: s } = await policy(env, id, runtime.now());
  const input = await json(request, z.object({ password: z.string().max(256) }).strict(), 2048);
  await limited(
    needDB(env),
    `unlock:${id}:${await digest(request.headers.get('cf-connecting-ip') ?? 'unknown')}`,
    runtime.now(),
    5,
    600000,
  );
  await limited(needDB(env), `unlock-share:${id}`, runtime.now(), 60, 3600000);
  if (
    s.password_hash &&
    (!s.password_salt ||
      !equal(await passwordHash(input.password, s.password_salt), s.password_hash))
  )
    throw new Failure(403, 'SHARE_PASSWORD', 'That password did not match.');
  const expiry = Math.min(runtime.now() + 15 * 60000, s.expires_at ?? Infinity);
  const grant = await sign(c.SESSION_SECRET!, {
    share: s.id,
    tenant: s.tenant_id,
    recording: s.recording_id,
    policy: s.policy_version,
    expiry,
  });
  return response({ ok: true }, 200, {
    'Set-Cookie': setCookie(
      unlockCookie(id),
      grant,
      (expiry - runtime.now()) / 1000,
      `/api/shares/${id}`,
    ),
  });
}
export async function publicPlayback(
  request: Request,
  c: Config,
  env: Env,
  id: string,
  runtime: Runtime,
) {
  origin(request, c);
  await json(request, z.object({}).strict(), 2048);
  const { share: s, row } = await policy(env, id, runtime.now());
  if (s.password_hash) {
    const token = cookie(request, unlockCookie(id));
    if (!token)
      throw new Failure(403, 'SHARE_PASSWORD_REQUIRED', 'Enter the share password before playing.');
    const grant = await verify(c.SESSION_SECRET!, token, unlockSchema);
    if (
      grant.share !== id ||
      grant.tenant !== s.tenant_id ||
      grant.recording !== s.recording_id ||
      grant.policy !== s.policy_version ||
      grant.expiry <= runtime.now()
    )
      throw new Failure(403, 'SHARE_UNLOCK_EXPIRED', 'Unlock this share again before playing.');
  }
  return playback(request, c, env, row, runtime, s.expires_at ?? undefined, false, {
    id: s.id,
    version: s.policy_version,
  });
}
export async function ownerPlayback(
  request: Request,
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  runtime: Runtime,
) {
  const row = await recording(env, auth.user.tenantId, id);
  const token = request.headers.get('x-csrf-token');
  if (
    !token ||
    !equal(await digest(token), auth.csrfHash) ||
    new URL(request.url).origin !== c.PUBLIC_BASE_URL ||
    (request.headers.get('sec-fetch-site') &&
      request.headers.get('sec-fetch-site') !== 'same-origin')
  )
    throw new Failure(403, 'CSRF', 'Refresh the account page before requesting playback.');
  return playback(request, c, env, row, runtime);
}
async function playback(
  request: Request,
  c: Config,
  env: Env,
  row: Row,
  runtime: Runtime,
  policyExpiry?: number,
  download = false,
  shareScope?: { id: string; version: number },
) {
  if (c.DELIVERY_ENABLED !== 'true')
    throw new Failure(503, 'DELIVERY_DISABLED', 'Cloud playback is currently paused.');
  const t = await tenant(env, row.tenant_id);
  if (row.state !== 'ready' || !row.stream_uid || !canView(t, runtime.now())) absent();
  const now = runtime.now();
  await prepareBudget(c, env, now);
  const db = needDB(env);
  await limited(db, `playback:${t.id}`, now, 30);
  let viewer = cookie(request, '__Host-rushes-viewer');
  if (!viewer || !/^[A-Za-z0-9_-]{43}$/.test(viewer)) viewer = random();
  const viewerHash = await digest(
    `${download ? random() : viewer}:${request.headers.get('cf-connecting-ip') ?? ''}`,
  );
  let deadline = Math.min(now + row.duration_ms + 120000, now + 720000);
  deadline = Math.min(
    deadline,
    policyExpiry ?? Infinity,
    t.grace_through ?? Infinity,
    t.status === 'active' ? (t.paid_through ?? Infinity) : Infinity,
  );
  if (deadline <= now) absent();
  let deliveryId: string;
  let newlyReserved = false;
  {
    const period = await currentPeriod(env, t, now);
    deliveryId = crypto.randomUUID();
    try {
      await db.batch([
        db
          .prepare('UPDATE budget_months SET operation_units=operation_units+1 WHERE month_start=?')
          .bind(month(now).start),
        db
          .prepare(
            'INSERT INTO deliveries(id,tenant_id,recording_id,viewer_hash,period_start,seconds,expires_at,created_at,budget_month) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            deliveryId,
            t.id,
            row.id,
            viewerHash,
            period,
            Math.ceil(row.duration_ms / 1000),
            deadline,
            now,
            month(now).start,
          ),
      ]);
      newlyReserved = true;
    } catch (error) {
      const message = String(error);
      if (message.includes('APPLICATION_BUDGET'))
        throw new Failure(
          429,
          'APPLICATION_BUDGET',
          'The modeled application budget reserve has been reached.',
        );
      if (message.includes('DELIVERY_QUOTA') || message.includes('DELIVERY_CONCURRENCY'))
        throw new Failure(
          429,
          message.includes('DELIVERY_QUOTA') ? 'DELIVERY_QUOTA' : 'DELIVERY_CONCURRENCY',
          'The playback allowance or concurrent viewer limit has been reached.',
        );
      throw error;
    }
  }
  const expires = download ? Math.min(deadline, now + 300000) : deadline;
  let url: string;
  try {
    url = await new StreamProvider(c, runtime).playback(
      row.stream_uid,
      expires,
      request.headers.get('cf-connecting-ip'),
      download,
    );
    const fresh = await recording(env, row.tenant_id, row.id);
    if (
      fresh.state !== 'ready' ||
      fresh.stream_uid !== row.stream_uid ||
      !canView(await tenant(env, row.tenant_id), runtime.now())
    )
      absent();
    if (shareScope) {
      const valid = await db
        .prepare(
          'SELECT id FROM shares WHERE id=? AND tenant_id=? AND recording_id=? AND policy_version=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
        )
        .bind(shareScope.id, row.tenant_id, row.id, shareScope.version, runtime.now())
        .first();
      if (!valid) absent();
    }
    await db
      .prepare('UPDATE deliveries SET issued=1 WHERE id=? AND tenant_id=?')
      .bind(deliveryId, t.id)
      .run();
  } catch (error) {
    if (newlyReserved)
      await db
        .prepare('DELETE FROM deliveries WHERE id=? AND tenant_id=? AND issued=0')
        .bind(deliveryId, t.id)
        .run();
    throw error;
  }
  return response({ ...(download ? { status: 'ready' } : {}), url, expiresAt: iso(expires) }, 200, {
    'Set-Cookie': setCookie('__Host-rushes-viewer', viewer, 86400),
  });
}

export async function exportRecording(
  request: Request,
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  runtime: Runtime,
) {
  const row = await recording(env, auth.user.tenantId, id),
    t = await tenant(env, row.tenant_id);
  if (c.DELIVERY_ENABLED !== 'true')
    throw new Failure(503, 'DELIVERY_DISABLED', 'Cloud export is currently paused.');
  if (row.state !== 'ready' || !row.stream_uid || !canView(t, runtime.now())) absent();
  await json(request, z.object({}).strict(), 2048);
  await limited(needDB(env), `export:${t.id}`, runtime.now(), 10, 3600000);
  await reserveOperation(c, env, runtime.now());
  const provider = new StreamProvider(c, runtime),
    video = await provider.get(row.stream_uid);
  if (!video?.requireSignedURLs || video.creator !== (await recordedCreator(row)))
    throw new Failure(
      503,
      'STREAM_OWNERSHIP',
      'The private provider association could not be confirmed.',
    );
  if (!(await provider.download(row.stream_uid))) return response({ status: 'processing' }, 202);
  return playback(request, c, env, row, runtime, undefined, true);
}
