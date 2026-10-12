import { Config, Env, Runtime, Failure, needDB, needRaw, response } from './platform';

import { Auth } from './auth';

import { recording, Row, rawPrefix } from './records';

import { StreamProvider } from './providers';

export async function deleteRaw(env: Env, row: Row) {
  const db = needDB(env),
    active = await db
      .prepare('SELECT COUNT(*) AS n FROM active_writes WHERE tenant_id=? AND recording_id=?')
      .bind(row.tenant_id, row.id)
      .first<{ n: number }>();
  if (active?.n)
    throw new Failure(
      503,
      'RAW_DELETE_BUSY',
      'An original upload is still closing. Cleanup will retry.',
    );
  const prefix = rawPrefix(row.tenant_id, row.id),
    bucket = needRaw(env);
  for (let page = 0; page < 100; page++) {
    const objects = await bucket.list({ prefix });
    if (objects.objects.some((o) => !o.key.startsWith(prefix)))
      throw new Failure(503, 'RAW_SCOPE', 'The storage provider returned an invalid object scope.');
    if (objects.objects.length) await bucket.delete(objects.objects.map((o) => o.key));
    if (!objects.truncated && !objects.objects.length) break;
    if (page === 99)
      throw new Failure(503, 'RAW_DELETE_PENDING', 'Original storage cleanup has not completed.');
  }
  const remaining = await bucket.list({ prefix });
  if (remaining.objects.length || remaining.truncated)
    throw new Failure(503, 'RAW_DELETE_PENDING', 'Original storage cleanup has not completed.');
  await db.batch([
    db
      .prepare('DELETE FROM chunks WHERE tenant_id=? AND recording_id=?')
      .bind(row.tenant_id, row.id),
    db
      .prepare('UPDATE recordings SET raw_expired=1 WHERE tenant_id=? AND id=?')
      .bind(row.tenant_id, row.id),
  ]);
}
export async function finishDelete(c: Config, env: Env, row: Row, runtime: Runtime) {
  if (row.provision_id && row.provision_until && row.provision_until > runtime.now())
    throw new Failure(503, 'PROVISION_PENDING', 'The provider upload creation has not settled.');
  if (row.error === 'STREAM_CREATE_UNCERTAIN') {
    const provider = new StreamProvider(c, runtime);
    const associated = await provider.findCreated(`${row.tenant_id}:${row.id}`);
    for (const video of associated) await provider.remove(video.uid);
    const again = await provider.findCreated(`${row.tenant_id}:${row.id}`);
    if (again.length)
      throw new Failure(
        503,
        'PROVIDER_ASSOCIATION_PENDING',
        'Provider association cleanup has not completed.',
      );
  }
  if (row.stream_uid) await new StreamProvider(c, runtime).remove(row.stream_uid);
  await deleteRaw(env, row);
  const db = needDB(env);
  await db.batch([
    db
      .prepare(
        "UPDATE upload_reservations SET state='released' WHERE tenant_id=? AND recording_id=? AND state='reserved'",
      )
      .bind(row.tenant_id, row.id),
    db
      .prepare(
        "UPDATE tenants SET retained_seconds=retained_seconds-COALESCE((SELECT actual_seconds FROM upload_reservations WHERE tenant_id=? AND recording_id=? AND state='settled'),0) WHERE id=? AND EXISTS(SELECT 1 FROM recordings WHERE tenant_id=? AND id=? AND state='deleting')",
      )
      .bind(row.tenant_id, row.id, row.tenant_id, row.tenant_id, row.id),
    db
      .prepare(
        "UPDATE recordings SET state='deleted',stream_uid=NULL,upload_url=NULL,manifest=NULL,error=NULL,cleanup_error=NULL,updated_at=? WHERE tenant_id=? AND id=? AND state='deleting'",
      )
      .bind(runtime.now(), row.tenant_id, row.id),
  ]);
}
export async function deleteRecording(
  c: Config,
  env: Env,
  auth: Auth,
  id: string,
  runtime: Runtime,
) {
  const row = await recording(env, auth.user.tenantId, id, true);
  if (row.state === 'deleted') return response({ state: 'deleted' });
  const db = needDB(env);
  await db.batch([
    db
      .prepare(
        "UPDATE recordings SET state='deleting',updated_at=? WHERE tenant_id=? AND id=? AND state!='deleted'",
      )
      .bind(runtime.now(), row.tenant_id, row.id),
    db
      .prepare(
        'UPDATE shares SET revoked_at=?,policy_version=policy_version+1 WHERE tenant_id=? AND recording_id=?',
      )
      .bind(runtime.now(), row.tenant_id, row.id),
  ]);
  try {
    await finishDelete(c, env, { ...row, state: 'deleting' }, runtime);
    return response({ state: 'deleted' });
  } catch (error) {
    await db
      .prepare(
        "UPDATE recordings SET cleanup_error=? WHERE tenant_id=? AND id=? AND state='deleting'",
      )
      .bind(error instanceof Failure ? error.code : 'CLEANUP_RETRY', row.tenant_id, row.id)
      .run();
    return response({ state: 'deleting' }, 202);
  }
}
export async function cleanup(c: Config, env: Env, runtime: Runtime) {
  const db = needDB(env),
    now = runtime.now();
  await db.batch([
    db
      .prepare('DELETE FROM sessions WHERE expires_at<? OR revoked_at IS NOT NULL')
      .bind(now - 86400000),
    db.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window<?').bind(now - 48 * 3600000),
    db.prepare('DELETE FROM active_writes WHERE expires_at<?').bind(now),
  ]);
  const rows = (
    await db
      .prepare(
        "SELECT r.* FROM recordings r JOIN tenants t ON t.id=r.tenant_id WHERE r.state!='deleted' AND (r.state='deleting' OR (r.state IN ('draft','uploading','processing','failed') AND r.updated_at<=?) OR (r.raw_expired=0 AND r.created_at<=?) OR (t.status='canceled' AND t.grace_through IS NOT NULL AND t.grace_through<=?)) ORDER BY r.updated_at LIMIT 100",
      )
      .bind(now - 86400000, now - 7 * 86400000, now)
      .all<Row>()
  ).results;
  let complete = 0,
    pending = 0;
  for (const row of rows) {
    const t = await db
      .prepare('SELECT status,grace_through FROM tenants WHERE id=?')
      .bind(row.tenant_id)
      .first<{ status: string; grace_through: number | null }>();
    const retire =
      row.state === 'deleting' ||
      (['draft', 'uploading', 'processing', 'failed'].includes(row.state) &&
        row.updated_at <= now - 86400000) ||
      (t?.grace_through !== null &&
        (t?.grace_through ?? Infinity) <= now &&
        t?.status === 'canceled');
    try {
      if (retire) {
        await db.batch([
          db
            .prepare(
              "UPDATE recordings SET state='deleting' WHERE tenant_id=? AND id=? AND state!='deleted'",
            )
            .bind(row.tenant_id, row.id),
          db
            .prepare(
              'UPDATE shares SET revoked_at=?,policy_version=policy_version+1 WHERE tenant_id=? AND recording_id=?',
            )
            .bind(now, row.tenant_id, row.id),
        ]);
        await finishDelete(c, env, { ...row, state: 'deleting' }, runtime);
      } else await deleteRaw(env, row);
      complete++;
    } catch (error) {
      pending++;
      await db
        .prepare('UPDATE recordings SET cleanup_error=? WHERE tenant_id=? AND id=?')
        .bind(error instanceof Failure ? error.code : 'CLEANUP_RETRY', row.tenant_id, row.id)
        .run();
    }
  }
  return { inspected: rows.length, complete, pending };
}
