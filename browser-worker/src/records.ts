import { z } from 'zod';

import type {
  RecordingDetail,
  RecordingSummary,
  DraftManifest,
  ChunkDescriptor,
  Usage,
  Subscription,
  UploadGrant,
} from '../../browser/src/contracts';

import {
  BROWSER_LIMITS,
  Config,
  Env,
  Runtime,
  Failure,
  needDB,
  needRaw,
  absent,
  json,
  response,
  iso,
  month,
  hosting,
  quotaFailure,
  limited,
  bodyBytes,
} from './platform';

import { Auth } from './auth';

import { sign, verify, digest, equal, bytes64, from64, creatorKey } from './crypto';

import { StreamProvider } from './providers';

import { prepareBudget, reserveOperation, budgetSnapshot } from './budget';

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

const track = z.enum(['screen', 'camera', 'microphone', 'tab-audio', 'composed']);

const mode = z.enum(['screen', 'camera', 'screen-camera']);

const mime = z
  .string()
  .max(128)
  .regex(/^(video|audio)\/webm(?:;\s*codecs=[A-Za-z0-9., _-]+)?$/i);

const descriptor = z
  .object({
    track,
    sequence: z.number().int().min(0).max(9999),
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: mime,
    checkpointMs: z.number().finite().min(0).max(900000),
  })
  .strict();

const manifestSchema = z
  .object({
    schema: z.literal('rushes.browser-recording/1'),
    id: idSchema,
    title: z.string().max(200),
    createdAt: z.iso.datetime(),
    mode,
    state: z.literal('complete'),
    durationMs: z.number().finite().positive().max(600000),
    epochMs: z.number().finite().nonnegative(),
    tracks: z
      .array(
        z
          .object({
            kind: track,
            mimeType: mime,
            startOffsetMs: z.number().finite().min(0).max(600000),
            chunks: z.array(descriptor).min(1).max(10000),
            bytes: z.number().int().positive().max(BROWSER_LIMITS.activeRawBytes),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    pauses: z
      .array(
        z
          .object({
            startMs: z.number().finite().nonnegative(),
            endMs: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(200),
    events: z
      .array(
        z
          .object({
            timeMs: z.number().finite().nonnegative(),
            kind: z.string().max(100),
            message: z.string().max(1000).optional(),
          })
          .strict(),
      )
      .max(2000),
    bubble: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        size: z.number().finite().positive(),
      })
      .strict(),
    lastCheckpointMs: z.number().finite().min(0).max(900000),
    persistent: z.boolean(),
    backupFolder: z.boolean(),
    recoveryNote: z.string().max(2000).optional(),
    cloudRecordingId: idSchema.optional(),
    upload: z
      .object({
        url: z.url(),
        uid: z.string(),
        offset: z.number().nonnegative(),
        expiresAt: z.iso.datetime(),
      })
      .optional(),
  })
  .strict();

const finalizeSchema = z
  .object({
    manifest: manifestSchema,
    composed: z
      .object({
        bytes: z.number().int().positive().max(BROWSER_LIMITS.activeRawBytes),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mimeType: mime,
      })
      .strict(),
  })
  .strict();

const capability = z
  .object({
    tenant: idSchema,
    recording: idSchema,
    track,
    sequence: z.number().int(),
    bytes: z.number().int(),
    digest: z.string(),
    mime: z.string(),
    method: z.literal('PUT'),
    expiry: z.number().int(),
  })
  .strict();

export type Tenant = {
  id: string;
  status: Subscription['status'];
  paid_through: number | null;
  grace_through: number | null;
  period_start: number;
  period_end: number;
  raw_bytes: number;
  reserved_raw_bytes: number;
  retained_seconds: number;
  reserved_retained_seconds: number;
  stripe_customer: string | null;
  suspended_by_operator: number;
};

export type Row = {
  id: string;
  tenant_id: string;
  client_id: string;
  title: string;
  mode: z.infer<typeof mode>;
  state: RecordingSummary['state'];
  created_at: number;
  updated_at: number;
  duration_ms: number;
  manifest: string | null;
  finalize_hash: string | null;
  composed_bytes: number | null;
  composed_digest: string | null;
  stream_uid: string | null;
  upload_url: string | null;
  upload_expiry: number | null;
  error: string | null;
  provision_id: string | null;
  provision_until: number | null;
  raw_expired: number;
};

export type Chunk = {
  tenant_id: string;
  recording_id: string;
  track: ChunkDescriptor['track'];
  sequence: number;
  bytes: number;
  digest: string;
  mime: string;
  state: 'granted' | 'stored';
  expires_at: number;
  checkpoint_ms: number;
};

export function rawPrefix(tenant: string, id: string) {
  idSchema.parse(tenant);
  idSchema.parse(id);
  return `t/${tenant}/r/${id}/`;
}
export function rawKey(c: Pick<Chunk, 'tenant_id' | 'recording_id' | 'track' | 'sequence'>) {
  return `${rawPrefix(c.tenant_id, c.recording_id)}${c.track}/${c.sequence}`;
}
export async function tenant(env: Env, id: string) {
  const t = await needDB(env).prepare('SELECT * FROM tenants WHERE id=?').bind(id).first<Tenant>();
  if (!t) absent();
  return t;
}
export function subscription(t: Tenant, now: number): Subscription {
  return {
    status: t.status,
    paidThrough: iso(t.paid_through),
    graceThrough: iso(t.grace_through),
    canUpload: !t.suspended_by_operator && t.status === 'active' && (t.paid_through ?? 0) > now,
  };
}
export async function uploadAllowed(c: Config, env: Env, id: string, now: number) {
  if (!hosting(c, env))
    throw new Failure(
      503,
      'HOSTING_DISABLED',
      'Cloud hosting is not enabled yet. Local recording and download are available.',
    );
  const t = await tenant(env, id);
  if (t.suspended_by_operator)
    throw new Failure(403, 'ACCOUNT_SUSPENDED', 'Cloud access for this account is suspended.');
  if (!subscription(t, now).canUpload)
    throw new Failure(
      402,
      'SUBSCRIPTION_REQUIRED',
      'An active paid Rushes subscription is required for cloud upload.',
    );
  return t;
}
export function canView(t: Tenant, now: number) {
  return (
    !t.suspended_by_operator &&
    t.status !== 'suspended' &&
    ((t.status === 'active' && (t.paid_through ?? 0) > now) || (t.grace_through ?? 0) > now)
  );
}
export async function currentPeriod(env: Env, t: Tenant, now: number) {
  const p = t.period_end > now ? t.period_start : month(now).start;
  await needDB(env)
    .prepare('INSERT INTO quota_periods(tenant_id,period_start) VALUES(?,?) ON CONFLICT DO NOTHING')
    .bind(t.id, p)
    .run();
  return p;
}
export async function usage(env: Env, t: Tenant, now: number): Promise<Usage> {
  const period = await currentPeriod(env, t, now),
    q = await needDB(env)
      .prepare('SELECT * FROM quota_periods WHERE tenant_id=? AND period_start=?')
      .bind(t.id, period)
      .first<{ upload_seconds: number; reserved_seconds: number; delivery_seconds: number }>();
  return {
    uploadSeconds: q!.upload_seconds,
    reservedSeconds: q!.reserved_seconds,
    retainedSeconds: t.retained_seconds,
    deliverySeconds: q!.delivery_seconds,
    rawBytes: t.raw_bytes,
    reservedRawBytes: t.reserved_raw_bytes,
    periodStart: iso(period)!,
    subscription: subscription(t, now),
  };
}
export async function recording(env: Env, tenantId: string, id: string, allowDeleted = false) {
  const row = await needDB(env)
    .prepare('SELECT * FROM recordings WHERE tenant_id=? AND id=?')
    .bind(tenantId, id)
    .first<Row>();
  if (!row || (!allowDeleted && (row.state === 'deleted' || row.state === 'deleting'))) absent();
  return row;
}
export async function chunks(env: Env, t: string, id: string) {
  return (
    await needDB(env)
      .prepare(
        "SELECT * FROM chunks WHERE tenant_id=? AND recording_id=? AND state='stored' ORDER BY track,sequence",
      )
      .bind(t, id)
      .all<Chunk>()
  ).results;
}
export function chunkDescription(c: Chunk): ChunkDescriptor {
  return {
    track: c.track,
    sequence: c.sequence,
    bytes: c.bytes,
    sha256: c.digest,
    mimeType: c.mime,
    checkpointMs: c.checkpoint_ms,
  };
}
export async function summary(env: Env, row: Row): Promise<RecordingSummary> {
  const share = await needDB(env)
    .prepare('SELECT id FROM shares WHERE tenant_id=? AND recording_id=? AND revoked_at IS NULL')
    .bind(row.tenant_id, row.id)
    .first<{ id: string }>();
  const total = await needDB(env)
    .prepare(
      "SELECT COALESCE(SUM(bytes),0) AS bytes FROM chunks WHERE tenant_id=? AND recording_id=? AND state='stored'",
    )
    .bind(row.tenant_id, row.id)
    .first<{ bytes: number }>();
  return {
    id: row.id,
    title: row.title,
    createdAt: iso(row.created_at)!,
    mode: row.mode,
    state: row.state,
    durationMs: row.duration_ms,
    bytes: total?.bytes ?? 0,
    error: row.error,
    shareId: share?.id ?? null,
    shareURL: null,
  };
}
export async function detail(c: Config, env: Env, row: Row): Promise<RecordingDetail> {
  const value = await summary(env, row);
  if (value.shareId && c.PUBLIC_BASE_URL)
    value.shareURL = `${c.PUBLIC_BASE_URL}/s/${value.shareId}`;
  return {
    ...value,
    manifest: row.manifest ? (JSON.parse(row.manifest) as DraftManifest) : null,
    chunks: (await chunks(env, row.tenant_id, row.id)).map(chunkDescription),
  };
}
const libraryCursor = z
  .object({ createdAt: z.number().int().nonnegative().max(253402300799999), id: idSchema })
  .strict();
export async function library(c: Config, env: Env, auth: Auth, now: number, request: Request) {
  const encoded = new URL(request.url).searchParams.get('cursor');
  let boundary: z.infer<typeof libraryCursor> | null = null;
  if (encoded) {
    try {
      if (encoded.length > 512) throw new Error('cursor');
      boundary = libraryCursor.parse(JSON.parse(new TextDecoder().decode(from64(encoded))));
    } catch {
      throw new Failure(
        400,
        'INVALID_CURSOR',
        'The library cursor is invalid. Refresh the library.',
      );
    }
  }
  const bindings: unknown[] = [auth.user.tenantId];
  let clause = '';
  if (boundary) {
    clause = ' AND (r.created_at<? OR (r.created_at=? AND r.id<?))';
    bindings.push(boundary.createdAt, boundary.createdAt, boundary.id);
  }
  const page = (
    await needDB(env)
      .prepare(
        `SELECT r.*,s.id AS share_id,COALESCE(SUM(ch.bytes),0) AS total_bytes FROM recordings r LEFT JOIN shares s ON s.tenant_id=r.tenant_id AND s.recording_id=r.id AND s.revoked_at IS NULL LEFT JOIN chunks ch ON ch.tenant_id=r.tenant_id AND ch.recording_id=r.id AND ch.state='stored' WHERE r.tenant_id=? AND r.state!='deleted'${clause} GROUP BY r.tenant_id,r.id ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,
      )
      .bind(...bindings)
      .all<Row & { share_id: string | null; total_bytes: number }>()
  ).results;
  const rows = page.slice(0, 50),
    last = rows.at(-1);
  const nextCursor =
    page.length > 50 && last
      ? bytes64(
          new TextEncoder().encode(JSON.stringify({ createdAt: last.created_at, id: last.id })),
        )
      : null;
  return response({
    recordings: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: iso(r.created_at)!,
      mode: r.mode,
      state: r.state,
      durationMs: r.duration_ms,
      bytes: r.total_bytes,
      error: r.error,
      shareId: r.share_id,
      shareURL: r.share_id && c.PUBLIC_BASE_URL ? `${c.PUBLIC_BASE_URL}/s/${r.share_id}` : null,
    })),
    usage: await usage(env, await tenant(env, auth.user.tenantId), now),
    applicationBudget: await budgetSnapshot(c, env, now),
    nextCursor,
  });
}
export async function create(request: Request, c: Config, env: Env, auth: Auth, runtime: Runtime) {
  await uploadAllowed(c, env, auth.user.tenantId, runtime.now());
  const input = await json(
    request,
    z.object({ clientId: idSchema, title: z.string().trim().min(1).max(200), mode }).strict(),
  );
  const db = needDB(env);
  const existing = await db
    .prepare('SELECT * FROM recordings WHERE tenant_id=? AND client_id=?')
    .bind(auth.user.tenantId, input.clientId)
    .first<Row>();
  if (existing) {
    if (existing.mode !== input.mode)
      throw new Failure(
        409,
        'CLIENT_ID_CONFLICT',
        'This draft identifier already belongs to a different recording.',
      );
    if (existing.state === 'deleted' || existing.state === 'deleting')
      throw new Failure(409, 'RECORDING_DELETED', 'This cloud recording has been deleted.');
    return response(await detail(c, env, existing));
  }
  await limited(db, `record:${auth.user.tenantId}`, runtime.now(), 30, 3600000);
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO recordings(id,tenant_id,client_id,title,mode,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM recordings WHERE tenant_id=? AND state IN ('draft','uploading','processing'))<3 ON CONFLICT(tenant_id,client_id) DO NOTHING",
    )
    .bind(
      id,
      auth.user.tenantId,
      input.clientId,
      input.title,
      input.mode,
      runtime.now(),
      runtime.now(),
      auth.user.tenantId,
    )
    .run();
  const row = await db
    .prepare('SELECT * FROM recordings WHERE tenant_id=? AND client_id=?')
    .bind(auth.user.tenantId, input.clientId)
    .first<Row>();
  if (!row)
    throw new Failure(
      429,
      'UPLOAD_CONCURRENCY',
      'Finish or remove an existing upload before creating another.',
    );
  return response(await detail(c, env, row));
}
export async function grant(
  request: Request,
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  runtime: Runtime,
) {
  await recording(env, auth.user.tenantId, id);
  await uploadAllowed(c, env, auth.user.tenantId, runtime.now());
  await prepareBudget(c, env, runtime.now());
  const input = await json(request, descriptor.omit({ checkpointMs: true }));
  const db = needDB(env);
  await limited(db, `grant:${auth.user.tenantId}`, runtime.now(), 240);
  const expires = runtime.now() + 15 * 60000;
  try {
    await db
      .prepare(
        "INSERT INTO chunks(tenant_id,recording_id,track,sequence,bytes,digest,mime,state,expires_at) VALUES(?,?,?,?,?,?,?,'granted',?) ON CONFLICT DO NOTHING",
      )
      .bind(
        auth.user.tenantId,
        id,
        input.track,
        input.sequence,
        input.bytes,
        input.sha256,
        input.mimeType,
        expires,
      )
      .run();
  } catch (error) {
    quotaFailure(error);
  }
  const row = await db
    .prepare('SELECT * FROM chunks WHERE tenant_id=? AND recording_id=? AND track=? AND sequence=?')
    .bind(auth.user.tenantId, id, input.track, input.sequence)
    .first<Chunk>();
  if (!row)
    throw new Failure(503, 'CHUNK_RESERVATION', 'The chunk reservation could not be confirmed.');
  if (row.bytes !== input.bytes || row.digest !== input.sha256 || row.mime !== input.mimeType)
    throw new Failure(409, 'CHUNK_CONFLICT', 'This sequence already has different bytes.');
  if (row.state === 'granted')
    await db
      .prepare(
        "UPDATE chunks SET expires_at=? WHERE tenant_id=? AND recording_id=? AND track=? AND sequence=? AND state='granted'",
      )
      .bind(expires, auth.user.tenantId, id, input.track, input.sequence)
      .run();
  const token = await sign(c.SESSION_SECRET!, {
    tenant: auth.user.tenantId,
    recording: id,
    track: input.track,
    sequence: input.sequence,
    bytes: input.bytes,
    digest: input.sha256,
    mime: input.mimeType,
    method: 'PUT',
    expiry: expires,
  });
  return response({
    url: `${c.PUBLIC_BASE_URL}/api/recordings/${id}/chunks/${input.track}/${input.sequence}`,
    token,
    expiresAt: iso(expires),
    acknowledged: row.state === 'stored',
  });
}
export async function putChunk(
  request: Request,
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  kind: string,
  seq: string,
  runtime: Runtime,
) {
  const row = await recording(env, auth.user.tenantId, id);
  await uploadAllowed(c, env, auth.user.tenantId, runtime.now());
  const token = request.headers.get('authorization')?.match(/^Upload ([A-Za-z0-9_.-]+)$/)?.[1];
  if (!token || !c.SESSION_SECRET)
    throw new Failure(401, 'UPLOAD_GRANT', 'A valid upload grant is required.');
  const g = await verify(c.SESSION_SECRET, token, capability);
  if (g.expiry <= runtime.now())
    throw new Failure(401, 'UPLOAD_EXPIRED', 'Request a fresh upload grant.');
  if (
    g.tenant !== auth.user.tenantId ||
    g.recording !== id ||
    g.track !== kind ||
    String(g.sequence) !== seq ||
    g.method !== request.method
  )
    absent();
  if (request.headers.get('content-type') !== g.mime)
    throw new Failure(400, 'UPLOAD_MIME', 'The chunk content type does not match its grant.');
  const db = needDB(env);
  const chunk = await db
    .prepare('SELECT * FROM chunks WHERE tenant_id=? AND recording_id=? AND track=? AND sequence=?')
    .bind(g.tenant, id, g.track, g.sequence)
    .first<Chunk>();
  if (!chunk || chunk.digest !== g.digest || chunk.bytes !== g.bytes || chunk.mime !== g.mime)
    absent();
  if (chunk.state === 'granted' && row.state !== 'draft')
    throw new Failure(409, 'RECORDING_CLOSED', 'This recording no longer accepts original chunks.');
  const writeId = chunk.state === 'granted' ? crypto.randomUUID() : null;
  if (writeId)
    try {
      await db
        .prepare('INSERT INTO active_writes(id,tenant_id,recording_id,expires_at) VALUES(?,?,?,?)')
        .bind(writeId, g.tenant, id, runtime.now() + 86400000)
        .run();
    } catch (error) {
      quotaFailure(error);
    }
  try {
    const bytes = await bodyBytes(request, Math.min(g.bytes, 16 * 1024 * 1024));
    if (bytes.length !== g.bytes)
      throw new Failure(400, 'UPLOAD_SIZE', 'The chunk size does not match its grant.');
    if (!equal(await digest(bytes), g.digest))
      throw new Failure(400, 'UPLOAD_DIGEST', 'The chunk digest does not match its grant.');
    if (
      g.sequence === 0 &&
      (bytes.length < 4 ||
        bytes[0] !== 0x1a ||
        bytes[1] !== 0x45 ||
        bytes[2] !== 0xdf ||
        bytes[3] !== 0xa3)
    )
      throw new Failure(400, 'UPLOAD_CONTAINER', 'The first chunk must contain a WebM header.');
    const bucket = needRaw(env),
      key = rawKey(chunk);
    if (chunk.state === 'stored') {
      const saved = await bucket.head(key);
      if (!saved || saved.size !== g.bytes || saved.customMetadata?.sha256 !== g.digest)
        throw new Failure(503, 'CHUNK_MISSING', 'The saved chunk could not be confirmed.');
      return response({ acknowledged: true });
    }
    await reserveOperation(c, env, runtime.now());
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: g.mime },
      customMetadata: { sha256: g.digest, tenant: g.tenant, recording: id },
    });
    const stored = await bucket.head(key);
    if (!stored || stored.size !== g.bytes || stored.customMetadata?.sha256 !== g.digest)
      throw new Failure(503, 'CHUNK_PERSISTENCE', 'The saved chunk could not be confirmed.');
    const accepted = await db
      .prepare(
        "UPDATE chunks SET state='stored',stored_at=? WHERE tenant_id=? AND recording_id=? AND track=? AND sequence=? AND state='granted' AND EXISTS(SELECT 1 FROM recordings WHERE tenant_id=? AND id=? AND state='draft')",
      )
      .bind(runtime.now(), g.tenant, id, g.track, g.sequence, g.tenant, id)
      .run();
    if (!accepted.meta.changes) {
      const final = await db
        .prepare(
          'SELECT state FROM chunks WHERE tenant_id=? AND recording_id=? AND track=? AND sequence=?',
        )
        .bind(g.tenant, id, g.track, g.sequence)
        .first<{ state: string }>();
      if (final?.state !== 'stored')
        throw new Failure(
          409,
          'RECORDING_CLOSED',
          'The recording stopped accepting chunks during upload.',
        );
    }
    return response({ acknowledged: true });
  } finally {
    if (writeId)
      await db
        .prepare('DELETE FROM active_writes WHERE id=? AND tenant_id=? AND recording_id=?')
        .bind(writeId, g.tenant, id)
        .run();
  }
}
export async function finalized(
  request: Request,
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  runtime: Runtime,
) {
  let row = await recording(env, auth.user.tenantId, id);
  const t = await uploadAllowed(c, env, auth.user.tenantId, runtime.now());
  const input = await json(request, finalizeSchema);
  if (
    input.manifest.id !== row.client_id ||
    input.manifest.mode !== row.mode ||
    (input.manifest.cloudRecordingId && input.manifest.cloudRecordingId !== id)
  )
    throw new Failure(400, 'MANIFEST_SCOPE', 'The manifest does not match this recording.');
  const trackKinds = input.manifest.tracks.map((t) => t.kind);
  if (new Set(trackKinds).size !== trackKinds.length || !trackKinds.includes('composed'))
    throw new Failure(
      400,
      'MANIFEST_TRACKS',
      'One composed track and distinct originals are required.',
    );
  const stored = await chunks(env, t.id, id);
  const flattened = input.manifest.tracks.flatMap((t) => t.chunks);
  if (flattened.length !== stored.length)
    throw new Failure(409, 'CHUNKS_INCOMPLETE', 'Persist every original chunk before finalizing.');
  for (const tr of input.manifest.tracks) {
    if (
      tr.bytes !== tr.chunks.reduce((n, v) => n + v.bytes, 0) ||
      tr.chunks.some(
        (v, i) => v.track !== tr.kind || v.sequence !== i || v.mimeType !== tr.mimeType,
      )
    )
      throw new Failure(
        400,
        'MANIFEST_SEQUENCE',
        'Track chunks must be ordered, contiguous and consistent.',
      );
    for (const v of tr.chunks) {
      const found = stored.find((s) => s.track === v.track && s.sequence === v.sequence);
      if (
        !found ||
        found.digest !== v.sha256 ||
        found.bytes !== v.bytes ||
        found.mime !== v.mimeType
      )
        throw new Failure(
          409,
          'MANIFEST_DIGEST',
          'The manifest does not match the stored original chunks.',
        );
    }
  }
  const composite = input.manifest.tracks.find((t) => t.kind === 'composed')!;
  if (composite.bytes !== input.composed.bytes || composite.mimeType !== input.composed.mimeType)
    throw new Failure(
      400,
      'COMPOSED_METADATA',
      'The composed file does not match its original track.',
    );
  for (const pause of input.manifest.pauses)
    if (pause.endMs < pause.startMs)
      throw new Failure(400, 'MANIFEST_PAUSE', 'Pause intervals are invalid.');
  const normalized = {
    ...input,
    manifest: { ...input.manifest, upload: undefined, cloudRecordingId: id },
  };
  const contentHash = await digest(JSON.stringify(normalized));
  const hash = `v2:${contentHash}`;
  if (
    row.finalize_hash &&
    (row.finalize_hash.startsWith('v2:') ? row.finalize_hash.slice(3) : row.finalize_hash) !==
      contentHash
  )
    throw new Failure(
      409,
      'FINALIZE_CONFLICT',
      'This upload was already finalized with different content.',
    );
  if (row.state === 'ready')
    throw new Failure(409, 'ALREADY_READY', 'This video is ready in your library.');
  if (row.error === 'STREAM_CREATE_UNCERTAIN' || row.provision_id)
    throw new Failure(
      503,
      'STREAM_CREATE_UNCERTAIN',
      'The previous provider association requires recovery before another upload can be issued.',
    );
  const provider = new StreamProvider(c, runtime);
  if (row.stream_uid && row.upload_url && row.upload_expiry) {
    if (row.upload_expiry > runtime.now())
      return response({
        upload: { uid: row.stream_uid, url: row.upload_url, expiresAt: iso(row.upload_expiry) },
        state: 'uploading',
      });
    const old = await provider.get(row.stream_uid);
    if (old?.readyToStream) {
      await processRecording(c, env, row, runtime);
      throw new Failure(409, 'ALREADY_READY', 'This video is ready in your library.');
    }
    if (old) await provider.remove(row.stream_uid);
    const cleared = await needDB(env)
      .prepare(
        "UPDATE recordings SET stream_uid=NULL,upload_url=NULL,upload_expiry=NULL,provision_id=NULL,provision_until=NULL,error=NULL WHERE tenant_id=? AND id=? AND stream_uid=? AND state IN ('uploading','processing','failed')",
      )
      .bind(t.id, id, row.stream_uid)
      .run();
    if (!cleared.meta.changes)
      throw new Failure(409, 'UPLOAD_BUSY', 'Another upload recovery is in progress.');
    row = await recording(env, t.id, id);
  }
  await prepareBudget(c, env, runtime.now());
  const db = needDB(env),
    period = await currentPeriod(env, t, runtime.now()),
    lease = crypto.randomUUID(),
    expiry = runtime.now() + 86400000;

  if (row.state === 'draft') {
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO upload_reservations(tenant_id,recording_id,period_start,reserved_seconds,state,expires_at) VALUES(?,?,?,600,'reserved',?)",
          )
          .bind(t.id, id, period, expiry),
        db
          .prepare(
            "UPDATE recordings SET state='uploading',manifest=?,finalize_hash=?,composed_bytes=?,composed_digest=?,composed_mime=?,updated_at=? WHERE tenant_id=? AND id=? AND state='draft'",
          )
          .bind(
            JSON.stringify(normalized.manifest),
            hash,
            input.composed.bytes,
            input.composed.sha256,
            input.composed.mimeType,
            runtime.now(),
            t.id,
            id,
          ),
      ]);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint'))
        throw new Failure(409, 'UPLOAD_BUSY', 'This upload is already being finalized.');
      quotaFailure(error);
    }
  }
  const reservation = await db
    .prepare('SELECT state FROM upload_reservations WHERE tenant_id=? AND recording_id=?')
    .bind(t.id, id)
    .first<{ state: string }>();
  if (reservation?.state !== 'reserved')
    throw new Failure(
      409,
      'UPLOAD_EXPIRED',
      'This upload reservation has closed. Keep the local draft and start a new cloud recording.',
    );
  const claimed = await db
    .prepare(
      "UPDATE recordings SET provision_id=?,provision_until=?,state='uploading',updated_at=? WHERE tenant_id=? AND id=? AND stream_uid IS NULL AND state IN ('uploading','failed') AND provision_id IS NULL",
    )
    .bind(lease, expiry, runtime.now(), t.id, id)
    .run();
  if (!claimed.meta.changes)
    throw new Failure(
      409,
      'UPLOAD_BUSY',
      'Upload provisioning is in progress. Please retry shortly.',
    );

  let upload: UploadGrant;
  try {
    await reserveOperation(c, env, runtime.now());
    upload = await provider.create(
      input.composed.bytes,
      expiry,
      await recordedCreator({ ...row, finalize_hash: row.finalize_hash ?? hash }),
    );
  } catch (error) {
    const uncertain = !(
      error instanceof Failure &&
      ['STREAM_CREATE_REJECTED', 'APPLICATION_BUDGET'].includes(error.code)
    );
    await db
      .prepare(
        "UPDATE recordings SET state='failed',error=?,provision_id=?,provision_until=? WHERE tenant_id=? AND id=? AND provision_id=?",
      )
      .bind(
        uncertain ? 'STREAM_CREATE_UNCERTAIN' : 'STREAM_CREATE',
        uncertain ? lease : null,
        uncertain ? expiry : null,
        t.id,
        id,
        lease,
      )
      .run();
    throw error;
  }
  try {
    const saved = await db
      .prepare(
        "UPDATE recordings SET stream_uid=?,upload_url=?,upload_expiry=?,provision_id=NULL,provision_until=NULL,error=NULL,state='uploading',updated_at=? WHERE tenant_id=? AND id=? AND provision_id=? AND state='uploading'",
      )
      .bind(upload.uid, upload.url, expiry, runtime.now(), t.id, id, lease)
      .run();
    if (!saved.meta.changes) {
      await provider.remove(upload.uid);
      throw new Failure(
        409,
        'UPLOAD_CANCELED',
        'This upload was canceled while it was being provisioned.',
      );
    }
    await db
      .prepare(
        "UPDATE upload_reservations SET expires_at=? WHERE tenant_id=? AND recording_id=? AND state='reserved'",
      )
      .bind(expiry, t.id, id)
      .run();
  } catch (error) {
    // Provider creation already happened. Its durable lease is the fallback even
    // if every subsequent database write fails or this isolate is terminated.
    try {
      await db
        .prepare(
          "UPDATE recordings SET error='STREAM_CREATE_UNCERTAIN',state=CASE WHEN state='deleting' THEN state ELSE 'failed' END,stream_uid=COALESCE(stream_uid,?),provision_id=COALESCE(provision_id,?),provision_until=MAX(COALESCE(provision_until,0),?) WHERE tenant_id=? AND id=? AND state!='deleted' AND (provision_id=? OR stream_uid=?)",
        )
        .bind(upload.uid, lease, expiry, t.id, id, lease, upload.uid)
        .run();
    } catch {
      throw new Failure(
        503,
        'STREAM_CREATE_UNCERTAIN',
        'Provider creation could not be mapped durably. The saved creation marker requires reconciliation.',
      );
    }
    if (error instanceof Failure && error.code === 'UPLOAD_CANCELED') throw error;
    throw new Failure(
      503,
      'STREAM_CREATE_UNCERTAIN',
      'Provider creation could not be confirmed durably. Keep the local draft while cleanup reconciles it.',
    );
  }
  return response({ upload, state: 'uploading' });
}
export async function processRecording(c: Config, env: Env, row: Row, runtime: Runtime) {
  if (row.state === 'ready') return row;
  if (!row.stream_uid)
    throw new Failure(
      409,
      'UPLOAD_NOT_STARTED',
      'Start the composed upload before checking processing.',
    );
  const v = await new StreamProvider(c, runtime).get(row.stream_uid);
  if (!v) throw new Failure(503, 'STREAM_MISSING', 'The provider upload could not be found.');
  if (!v.requireSignedURLs || v.creator !== (await recordedCreator(row)))
    throw new Failure(
      503,
      'STREAM_OWNERSHIP',
      'The private provider association could not be confirmed.',
    );
  if (v.status?.state === 'error') {
    await needDB(env)
      .prepare(
        "UPDATE recordings SET state='failed',error='STREAM_PROCESSING',updated_at=? WHERE tenant_id=? AND id=? AND stream_uid=? AND state IN ('uploading','processing')",
      )
      .bind(runtime.now(), row.tenant_id, row.id, row.stream_uid)
      .run();
    return recording(env, row.tenant_id, row.id);
  }
  if (!v.readyToStream || v.status?.state !== 'ready') {
    await needDB(env)
      .prepare(
        "UPDATE recordings SET state='processing',updated_at=? WHERE tenant_id=? AND id=? AND stream_uid=? AND state='uploading'",
      )
      .bind(runtime.now(), row.tenant_id, row.id, row.stream_uid)
      .run();
    return recording(env, row.tenant_id, row.id);
  }
  if (!v.duration || v.duration <= 0 || v.duration > BROWSER_LIMITS.maxTakeSeconds)
    throw new Failure(
      422,
      'PROVIDER_DURATION',
      'The provider duration exceeds this recording allowance.',
    );
  const actual = Math.ceil(v.duration),
    db = needDB(env);
  const changed = await db
    .prepare(
      "UPDATE upload_reservations SET state='settled',actual_seconds=? WHERE tenant_id=? AND recording_id=? AND state='reserved' AND EXISTS(SELECT 1 FROM recordings WHERE tenant_id=? AND id=? AND state IN ('uploading','processing','failed'))",
    )
    .bind(actual, row.tenant_id, row.id, row.tenant_id, row.id)
    .run();
  if (!changed.meta.changes) {
    const settled = await db
      .prepare(
        'SELECT state,actual_seconds FROM upload_reservations WHERE tenant_id=? AND recording_id=?',
      )
      .bind(row.tenant_id, row.id)
      .first<{ state: string; actual_seconds: number }>();
    if (settled?.state !== 'settled' || settled.actual_seconds !== actual)
      throw new Failure(409, 'RESERVATION_CLOSED', 'The upload allowance is no longer reserved.');
  }
  await db
    .prepare(
      "UPDATE recordings SET state='ready',duration_ms=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND stream_uid=? AND state IN ('uploading','processing','failed')",
    )
    .bind(Math.round(v.duration * 1000), runtime.now(), row.tenant_id, row.id, row.stream_uid)
    .run();
  return recording(env, row.tenant_id, row.id);
}

export async function downloadChunk(
  request: Request,
  env: Env,
  auth: Auth,
  id: string,
  kind: string,
  sequence: string,
  runtime: Runtime,
) {
  const row = await recording(env, auth.user.tenantId, id);
  const t = await tenant(env, row.tenant_id);
  if (!canView(t, runtime.now()))
    throw new Failure(
      403,
      'EXPORT_GRACE_EXPIRED',
      'The account viewing and export grace has ended.',
    );
  if (!track.safeParse(kind).success || !/^\d+$/.test(sequence) || Number(sequence) > 9999)
    absent();
  const chunk = await needDB(env)
    .prepare(
      "SELECT * FROM chunks WHERE tenant_id=? AND recording_id=? AND track=? AND sequence=? AND state='stored'",
    )
    .bind(t.id, id, kind, Number(sequence))
    .first<Chunk>();
  if (!chunk) absent();
  await limited(needDB(env), `raw-download:${t.id}`, runtime.now(), 120);
  const object = await needRaw(env).get(rawKey(chunk));
  if (
    !object?.body ||
    object.size !== chunk.bytes ||
    object.customMetadata?.sha256 !== chunk.digest
  )
    throw new Failure(503, 'CHUNK_MISSING', 'The retained original could not be confirmed.');
  const data = await bodyBytes(
    new Request('https://internal.example', {
      method: 'POST',
      body: object.body,
      duplex: 'half',
    } as RequestInit),
    chunk.bytes,
  );
  if (data.length !== chunk.bytes || !equal(await digest(data), chunk.digest))
    throw new Failure(
      503,
      'CHUNK_CORRUPT',
      'The retained original did not pass its integrity check.',
    );
  let start = 0,
    end = data.length - 1,
    status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) throw new Failure(416, 'INVALID_RANGE', 'Request a single bounded byte range.');
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      end >= data.length
    )
      throw new Failure(416, 'INVALID_RANGE', 'The requested byte range is outside this chunk.');
    status = 206;
  }
  const headers: Record<string, string> = {
    'Content-Type': chunk.mime,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${id}-${kind}-${sequence}.webm"`,
    'Cache-Control': 'private,no-store',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
  return new Response(data.slice(start, end + 1), { status, headers });
}

export async function recordedCreator(row: Pick<Row, 'tenant_id' | 'id' | 'finalize_hash'>) {
  return row.finalize_hash?.startsWith('v2:')
    ? creatorKey(row.tenant_id, row.id)
    : `${row.tenant_id}:${row.id}`;
}
