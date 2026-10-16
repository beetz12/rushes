import { z } from 'zod';

import type { Account, SessionResponse } from '../../browser/src/contracts';

import {
  Config,
  Env,
  Runtime,
  Failure,
  needDB,
  googleReady,
  limited,
  month,
  origin,
  response,
} from './platform';

import { bytes64, from64, random, digest, equal, cookie, setCookie } from './crypto';

const sessionCookie = '__Host-rushes-session';

const csrfCookie = '__Host-rushes-csrf';

const stateCookie = '__Host-rushes-oauth';

const tokenReply = z.object({ id_token: z.string().min(20).max(16384) });

const jwtHeader = z.object({
  alg: z.literal('RS256'),
  kid: z.string().min(1).max(256),
  typ: z.string().optional(),
});

const claims = z.object({
  iss: z.enum(['https://accounts.google.com', 'accounts.google.com']),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  azp: z.string().optional(),
  exp: z.number().int(),
  iat: z.number().int(),
  sub: z.string().min(1).max(255),
  email: z.email().max(320),
  email_verified: z.literal(true),
  nonce: z.string(),
  name: z.string().max(200).optional(),
});

const jwks = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal('RSA'),
        kid: z.string(),
        n: z.string(),
        e: z.string(),
        alg: z.literal('RS256').optional(),
        use: z.literal('sig').optional(),
      }),
    )
    .max(50),
});

export type Auth = {
  user: Account;
  sessionHash: string;
  csrfHash: string;
  createdAt: number;
  absoluteExpiry: number;
  familyId: string;
};

export async function authenticate(
  request: Request,
  env: Env,
  runtime: Runtime,
  required = true,
  ancestorForLogout = false,
): Promise<Auth | null> {
  const token = cookie(request, sessionCookie);
  if (!token || !env.DB) {
    if (required) throw new Failure(401, 'SIGN_IN_REQUIRED', 'Sign in to use cloud hosting.');
    return null;
  }
  const hash = await digest(token);
  const predicate = ancestorForLogout
    ? ''
    : ' AND s.revoked_at IS NULL AND s.expires_at>? AND f.current_token_hash=s.token_hash';
  const bindings: unknown[] = [hash, runtime.now(), runtime.now()];
  if (!ancestorForLogout) bindings.push(runtime.now());
  const row = await env.DB.prepare(
    `SELECT a.id,a.tenant_id,a.email,a.name,s.csrf_hash,s.created_at,s.absolute_expiry,s.family_id FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN session_families f ON f.id=s.family_id AND f.account_id=s.account_id WHERE s.token_hash=? AND s.absolute_expiry>? AND f.absolute_expiry>? AND f.revoked_at IS NULL${predicate}`,
  )
    .bind(...bindings)
    .first<{
      id: string;
      tenant_id: string;
      email: string;
      name: string;
      csrf_hash: string;
      created_at: number;
      absolute_expiry: number;
      family_id: string;
    }>();
  if (!row) {
    if (required) throw new Failure(401, 'SESSION_EXPIRED', 'Sign in again to continue.');
    return null;
  }
  return {
    user: { id: row.id, tenantId: row.tenant_id, email: row.email, name: row.name },
    sessionHash: hash,
    csrfHash: row.csrf_hash,
    createdAt: row.created_at,
    absoluteExpiry: row.absolute_expiry,
    familyId: row.family_id,
  };
}
export async function csrf(request: Request, c: Config, auth: Auth) {
  origin(request, c);
  const token = request.headers.get('x-csrf-token');
  if (!token || !equal(await digest(token), auth.csrfHash))
    throw new Failure(403, 'CSRF', 'Refresh the account page before trying again.');
}
async function newSession(
  db: ReturnType<typeof needDB>,
  accountId: string,
  now: number,
  absolute = now + 14 * 86400000,
  old?: Auth,
) {
  const token = random(),
    csrfToken = random();
  const hash = await digest(token);
  const familyId = old?.familyId ?? crypto.randomUUID();
  const parent = old
    ? db
        .prepare(
          'UPDATE session_families SET current_token_hash=? WHERE id=? AND account_id=? AND current_token_hash=? AND revoked_at IS NULL AND absolute_expiry>? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND family_id=? AND revoked_at IS NULL AND expires_at>?)',
        )
        .bind(hash, familyId, accountId, old.sessionHash, now, old.sessionHash, familyId, now)
    : db
        .prepare(
          'INSERT INTO session_families(id,account_id,current_token_hash,absolute_expiry) VALUES(?,?,?,?)',
        )
        .bind(familyId, accountId, hash, absolute);
  const statements = [
    parent,
    db
      .prepare(
        'INSERT INTO sessions(token_hash,account_id,csrf_hash,created_at,expires_at,absolute_expiry,family_id) SELECT ?,?,?,?,?,?,id FROM session_families WHERE id=? AND account_id=? AND current_token_hash=? AND revoked_at IS NULL AND absolute_expiry>=?',
      )
      .bind(
        hash,
        accountId,
        await digest(csrfToken),
        now,
        Math.min(now + 86400000, absolute),
        absolute,
        familyId,
        accountId,
        hash,
        absolute,
      ),
  ];
  if (old)
    statements.push(
      db
        .prepare(
          'UPDATE sessions SET revoked_at=? WHERE token_hash=? AND family_id=? AND EXISTS(SELECT 1 FROM session_families WHERE id=? AND current_token_hash=?)',
        )
        .bind(now, old.sessionHash, familyId, familyId, hash),
    );
  const result = await db.batch(statements);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1)
    throw new Failure(
      401,
      'SESSION_ROTATED',
      'This login changed or signed out while the session refreshed. Sign in again.',
    );
  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    setCookie(sessionCookie, token, Math.min(86400, (absolute - now) / 1000)),
  );
  headers.append(
    'Set-Cookie',
    setCookie(csrfCookie, csrfToken, Math.min(86400, (absolute - now) / 1000)),
  );
  return { headers, csrfToken };
}
export async function session(request: Request, env: Env, runtime: Runtime) {
  const auth = await authenticate(request, env, runtime, false);
  if (!auth) return response({ user: null, csrfToken: null } satisfies SessionResponse);
  const raw = cookie(request, csrfCookie);
  if (
    runtime.now() - auth.createdAt > 6 * 3600000 ||
    !raw ||
    !equal(await digest(raw), auth.csrfHash)
  ) {
    const rotated = await newSession(
      needDB(env),
      auth.user.id,
      runtime.now(),
      auth.absoluteExpiry,
      auth,
    );
    return response(
      { user: auth.user, csrfToken: rotated.csrfToken } satisfies SessionResponse,
      200,
      rotated.headers,
    );
  }
  return response({ user: auth.user, csrfToken: raw } satisfies SessionResponse);
}
export async function logout(request: Request, c: Config, env: Env, runtime: Runtime) {
  const auth = await authenticate(request, env, runtime, true, true);
  await csrf(request, c, auth!);
  const changed = await needDB(env)
    .prepare(
      'UPDATE session_families SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND account_id=?',
    )
    .bind(runtime.now(), auth!.familyId, auth!.user.id)
    .run();
  if (!changed.meta.changes)
    throw new Failure(401, 'SESSION_EXPIRED', 'This login no longer exists.');
  const headers = new Headers();
  headers.append('Set-Cookie', setCookie(sessionCookie, '', 0));
  headers.append('Set-Cookie', setCookie(csrfCookie, '', 0));
  return response({ ok: true }, 200, headers);
}
export async function verifyGoogle(idToken: string, c: Config, nonce: string, runtime: Runtime) {
  const parts = idToken.split('.');
  if (parts.length !== 3)
    throw new Failure(401, 'OIDC_TOKEN', 'Google did not return a valid identity token.');
  let header: z.infer<typeof jwtHeader>, payload: z.infer<typeof claims>;
  try {
    header = jwtHeader.parse(JSON.parse(new TextDecoder().decode(from64(parts[0]))));
    payload = claims.parse(JSON.parse(new TextDecoder().decode(from64(parts[1]))));
  } catch {
    throw new Failure(401, 'OIDC_CLAIMS', 'The Google identity claims are invalid.');
  }
  const now = Math.floor(runtime.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    !audiences.includes(c.GOOGLE_CLIENT_ID!) ||
    (audiences.length > 1 && payload.azp !== c.GOOGLE_CLIENT_ID) ||
    (payload.azp && payload.azp !== c.GOOGLE_CLIENT_ID) ||
    payload.exp <= now ||
    payload.iat > now + 60 ||
    payload.iat < now - 3600 ||
    payload.exp - payload.iat > 7200 ||
    !equal(payload.nonce, nonce)
  )
    throw new Failure(401, 'OIDC_CLAIMS', 'The Google identity claims are invalid.');
  const keysResponse = await runtime.fetch('https://www.googleapis.com/oauth2/v3/certs', {
    signal: AbortSignal.timeout(10000),
  });
  if (!keysResponse.ok)
    throw new Failure(
      503,
      'OIDC_PROVIDER',
      'Google identity verification is temporarily unavailable.',
    );
  const keys = jwks.safeParse(await keysResponse.json());
  if (!keys.success)
    throw new Failure(
      503,
      'OIDC_PROVIDER',
      'Google identity verification is temporarily unavailable.',
    );
  const key = keys.data.keys.find((k) => k.kid === header.kid);
  if (!key) throw new Failure(401, 'OIDC_SIGNATURE', 'The Google identity signature is invalid.');
  try {
    const rsa = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      rsa,
      from64(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new Error('signature');
  } catch {
    throw new Failure(401, 'OIDC_SIGNATURE', 'The Google identity signature is invalid.');
  }
  return payload;
}
export async function googleStart(request: Request, c: Config, env: Env, runtime: Runtime) {
  if (!googleReady(c, env))
    throw new Failure(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured yet.');
  const db = needDB(env);
  await limited(
    db,
    `login:${await digest(request.headers.get('cf-connecting-ip') ?? 'unknown')}`,
    runtime.now(),
    10,
    600000,
  );
  const state = random(),
    nonce = random(),
    verifier = random();
  await db
    .prepare('INSERT INTO oauth_states(state_hash,nonce,verifier,expires_at) VALUES(?,?,?,?)')
    .bind(await digest(state), nonce, verifier, runtime.now() + 600000)
    .run();
  const challenge = bytes64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: c.GOOGLE_CLIENT_ID!,
    redirect_uri: `${c.PUBLIC_BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: u.href,
      'Set-Cookie': setCookie(stateCookie, state, 600),
      'Cache-Control': 'no-store',
    },
  });
}
export async function googleCallback(request: Request, c: Config, env: Env, runtime: Runtime) {
  if (!googleReady(c, env))
    throw new Failure(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured yet.');
  const u = new URL(request.url),
    state = u.searchParams.get('state'),
    code = u.searchParams.get('code');
  if (!state || !code || code.length > 4096 || !equal(cookie(request, stateCookie) ?? '', state))
    throw new Failure(401, 'OIDC_STATE', 'Sign-in expired. Please start again.');
  const db = needDB(env);
  const saved = await db
    .prepare(
      'DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING nonce,verifier',
    )
    .bind(await digest(state), runtime.now())
    .first<{ nonce: string; verifier: string }>();
  if (!saved) throw new Failure(401, 'OIDC_STATE', 'Sign-in expired. Please start again.');
  const exchangeForm = new URLSearchParams();
  exchangeForm.set('code', code);
  exchangeForm.set('client_id', c.GOOGLE_CLIENT_ID!);
  exchangeForm.set('client_secret', c.GOOGLE_CLIENT_SECRET!);
  exchangeForm.set('redirect_uri', `${c.PUBLIC_BASE_URL}/auth/google/callback`);
  exchangeForm.set('grant_type', 'authorization_code');
  exchangeForm.set('code_verifier', saved.verifier);
  const exchangeHeaders = new Headers();
  exchangeHeaders.set('Content-Type', 'application/x-www-form-urlencoded');
  const tokenResponse = await runtime.fetch('https://oauth2.googleapis.com/token', {
    body: exchangeForm,
    headers: exchangeHeaders,
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok)
    throw new Failure(401, 'OIDC_EXCHANGE', 'Google sign-in could not be completed.');
  const reply = tokenReply.safeParse(await tokenResponse.json());
  if (!reply.success)
    throw new Failure(401, 'OIDC_EXCHANGE', 'Google sign-in could not be completed.');
  const identity = await verifyGoogle(reply.data.id_token, c, saved.nonce, runtime);
  const email = identity.email.toLowerCase();
  if (
    !c.INVITE_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(email)
  )
    throw new Failure(403, 'INVITE_REQUIRED', 'Rushes cloud hosting is currently invite-only.');
  let account = await db
    .prepare('SELECT id,tenant_id FROM accounts WHERE google_subject=?')
    .bind(identity.sub)
    .first<{ id: string; tenant_id: string }>();
  if (!account) {
    if (c.SIGNUP_ENABLED !== 'true')
      throw new Failure(403, 'SIGNUP_DISABLED', 'New cloud accounts are currently paused.');
    const id = crypto.randomUUID(),
      tenantId = crypto.randomUUID(),
      period = month(runtime.now());
    await db.batch([
      db
        .prepare(
          'INSERT INTO tenants(id,period_start,period_end,updated_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM accounts)<? AND NOT EXISTS(SELECT 1 FROM accounts WHERE google_subject=?)',
        )
        .bind(tenantId, period.start, period.end, runtime.now(), c.ACCOUNT_CAP, identity.sub),
      db
        .prepare(
          'INSERT INTO accounts(id,tenant_id,google_subject,email,name,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tenants WHERE id=?) AND (SELECT COUNT(*) FROM accounts)<? ON CONFLICT(google_subject) DO NOTHING',
        )
        .bind(
          id,
          tenantId,
          identity.sub,
          email,
          identity.name ?? email,
          runtime.now(),
          tenantId,
          c.ACCOUNT_CAP,
        ),
    ]);
    account = await db
      .prepare('SELECT id,tenant_id FROM accounts WHERE google_subject=?')
      .bind(identity.sub)
      .first<{ id: string; tenant_id: string }>();
    if (!account)
      throw new Failure(403, 'ACCOUNT_CAP', 'The pilot account limit has been reached.');
  }
  await db
    .prepare('UPDATE accounts SET email=?,name=? WHERE id=?')
    .bind(email, identity.name ?? email, account.id)
    .run();
  const created = await newSession(db, account.id, runtime.now());
  created.headers.append('Set-Cookie', setCookie(stateCookie, '', 0));
  created.headers.set('Location', `${c.PUBLIC_BASE_URL}/`);
  return new Response(null, { status: 302, headers: created.headers });
}
