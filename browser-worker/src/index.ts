import { z } from 'zod';

import {
  Env,
  Runtime,
  Config,
  config,
  googleReady,
  billingReady,
  streamReady,
  hosting,
  BROWSER_LIMITS,
  needDB,
  Failure,
  response,
  secure,
  json,
  absent,
} from './platform';

import { authenticate, csrf, session, logout, googleStart, googleCallback } from './auth';

import {
  library,
  create,
  recording,
  detail,
  grant,
  putChunk,
  chunks,
  chunkDescription,
  finalized,
  processRecording,
  downloadChunk,
  idSchema,
} from './records';

import {
  setShare,
  revokeShare,
  shareDetail,
  unlock,
  publicPlayback,
  ownerPlayback,
  exportRecording,
} from './shares';

import { checkout, portal, webhook, reconcile } from './billing';

import { cleanup, deleteRecording } from './cleanup';

async function route(
  request: Request,
  c: Config,
  env: Env,
  runtime: Runtime,
  acquireRawSlot: () => () => void,
) {
  const path = new URL(request.url).pathname,
    method = request.method;

  if (path === '/api/config' && method === 'GET')
    return response({
      revision: c.REVISION,
      googleConfigured: googleReady(c, env),
      billingConfigured: billingReady(c),
      streamConfigured: streamReady(c, env),
      captureEnabled: true,
      hostingEnabled: hosting(c, env),
      signupEnabled: c.SIGNUP_ENABLED === 'true',
      priceUSD: BROWSER_LIMITS.monthlyPriceUSD,
      limits: BROWSER_LIMITS,
    });

  if (path === '/api/session' && method === 'GET') return session(request, env, runtime);

  if (path === '/auth/google/start' && method === 'GET')
    return googleStart(request, c, env, runtime);

  if (path === '/auth/google/callback' && method === 'GET')
    return googleCallback(request, c, env, runtime);

  if (path === '/api/billing/webhook' && method === 'POST')
    return webhook(request, c, env, runtime);

  const shared = path.match(/^\/api\/shares\/([A-Za-z0-9_-]+)(?:\/(unlock|playback))?$/);
  if (shared) {
    idSchema.parse(shared[1]);
    if (!shared[2] && method === 'GET') return shareDetail(env, shared[1], runtime.now());
    if (shared[2] === 'unlock' && method === 'POST')
      return unlock(request, c, env, shared[1], runtime);
    if (shared[2] === 'playback' && method === 'POST')
      return publicPlayback(request, c, env, shared[1], runtime);
    absent();
  }
  if (path.startsWith('/api/')) {
    const auth = await authenticate(request, env, runtime);
    if (!['GET', 'HEAD'].includes(method)) await csrf(request, c, auth!);

    if (path === '/api/logout' && method === 'POST') {
      await json(request, z.object({}).strict(), 2048);
      return logout(request, c, env, runtime);
    }
    if (path === '/api/billing/checkout' && method === 'POST') {
      await json(request, z.object({}).strict(), 2048);
      return checkout(c, env, auth!, runtime);
    }
    if (path === '/api/billing/portal' && method === 'POST') {
      await json(request, z.object({}).strict(), 2048);
      return portal(c, env, auth!, runtime);
    }
    if (path === '/api/recordings') {
      if (method === 'GET') return library(c, env, auth!, runtime.now(), request);
      if (method === 'POST') return create(request, c, env, auth!, runtime);
      absent();
    }
    const raw = path.match(
      /^\/api\/recordings\/([A-Za-z0-9_-]+)\/chunks\/([A-Za-z0-9_-]+)\/(\d+)$/,
    );
    if (raw && method === 'GET')
      return downloadChunk(request, env, auth!, raw[1], raw[2], raw[3], runtime);
    if (raw && method === 'PUT') {
      const release = acquireRawSlot();
      try {
        return await putChunk(request, c, env, auth!, raw[1], raw[2], raw[3], runtime);
      } finally {
        release();
      }
    }

    const match = path.match(
      /^\/api\/recordings\/([A-Za-z0-9_-]+)(?:\/(chunks\/grant|chunks|finalize|process|playback|share|export))?$/,
    );
    if (match) {
      const id = match[1],
        action = match[2];
      idSchema.parse(id);
      if (!action && method === 'DELETE') return deleteRecording(c, env, auth!, id, runtime);
      const row = await recording(env, auth!.user.tenantId, id);
      if (!action && method === 'GET') return response(await detail(c, env, row));
      if (!action && method === 'PATCH') {
        const input = await json(
          request,
          z.object({ title: z.string().trim().min(1).max(200) }).strict(),
          4096,
        );
        await needDB(env)
          .prepare('UPDATE recordings SET title=?,updated_at=? WHERE tenant_id=? AND id=?')
          .bind(input.title, runtime.now(), row.tenant_id, id)
          .run();
        return response(await detail(c, env, await recording(env, row.tenant_id, id)));
      }
      if (action === 'chunks/grant' && method === 'POST')
        return grant(request, c, env, auth!, id, runtime);
      if (action === 'chunks' && method === 'GET')
        return response({ chunks: (await chunks(env, row.tenant_id, id)).map(chunkDescription) });
      if (action === 'finalize' && method === 'POST')
        return finalized(request, c, env, auth!, id, runtime);
      if (action === 'process' && method === 'POST') {
        await json(request, z.object({}).strict(), 2048);
        return response(await detail(c, env, await processRecording(c, env, row, runtime)));
      }
      if (action === 'export' && method === 'POST')
        return exportRecording(request, c, env, auth!, id, runtime);
      if (action === 'playback' && method === 'GET')
        return ownerPlayback(request, c, env, auth!, id, runtime);
      if (action === 'share' && method === 'POST')
        return setShare(request, c, env, auth!, id, runtime);
      if (action === 'share' && method === 'DELETE')
        return revokeShare(env, auth!, id, runtime.now());
    }
    absent();
  }
  if (path.startsWith('/auth/')) absent();
  if (method !== 'GET' && method !== 'HEAD') absent();
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Rushes browser assets are not configured.', { status: 503 });
}
export function createWorker(
  runtime: Runtime = { fetch: globalThis.fetch.bind(globalThis), now: () => Date.now() },
) {
  let rawBodies = 0;
  const acquireRawSlot = () => {
    if (rawBodies >= 1)
      throw new Failure(
        429,
        'RAW_CONCURRENCY',
        'Another original upload is in progress. Retry this chunk shortly.',
      );
    rawBodies++;
    return () => {
      rawBodies--;
    };
  };
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const c = config(env);
        if (c.PUBLIC_BASE_URL && new URL(request.url).origin !== c.PUBLIC_BASE_URL)
          throw new Failure(
            403,
            'ORIGIN',
            'This service is available only on its configured origin.',
          );
        return secure(await route(request, c, env, runtime, acquireRawSlot));
      } catch (error) {
        if (error instanceof Failure)
          return secure(
            response({ error: { code: error.code, message: error.message } }, error.status),
          );
        if (error instanceof z.ZodError)
          return secure(
            response(
              { error: { code: 'INVALID_REQUEST', message: 'The request is invalid.' } },
              400,
            ),
          );
        return secure(
          response(
            {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'The service could not complete this request. Please retry.',
              },
            },
            503,
          ),
        );
      }
    },
    async scheduled(
      _controller: unknown,
      env: Env,
      ctx: { waitUntil(promise: Promise<unknown>): void },
    ) {
      const c = config(env);
      if (!env.DB || !env.RAW) return;
      ctx.waitUntil(
        (async () => {
          const result = await cleanup(c, env, runtime);
          let billingChecked = 0,
            billingPending = 0;
          if (billingReady(c)) {
            const rows = (
              await needDB(env)
                .prepare(
                  'SELECT id FROM tenants WHERE stripe_customer IS NOT NULL ORDER BY updated_at LIMIT 25',
                )
                .all<{ id: string }>()
            ).results;
            const outcomes = await Promise.allSettled(
              rows.map((row) => reconcile(c, env, row.id, runtime)),
            );
            billingChecked = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
            billingPending = outcomes.length - billingChecked;
          }
          const summary = { ...result, billingChecked, billingPending };
          console.log(
            JSON.stringify({ service: 'rushes-browser', job: 'maintenance', ...summary }),
          );
          return summary;
        })(),
      );
    },
  };
}
export default createWorker();
