import { z } from 'zod';

import { Failure } from './platform';

const encoder = new TextEncoder();

export function bytes64(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function from64(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Failure(401, 'INVALID_TOKEN', 'The token is invalid.');
  try {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new Failure(401, 'INVALID_TOKEN', 'The token is invalid.');
  }
}
export function random() {
  return bytes64(crypto.getRandomValues(new Uint8Array(32)));
}
export async function digest(value: string | Uint8Array) {
  const out = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value),
    ),
  );
  const alphabet = '0123456789abcdef';
  let encoded = '';
  for (const octet of out) {
    encoded += alphabet[octet >>> 4] + alphabet[octet & 15];
  }
  return encoded;
}
export async function hmac(secret: string, payload: string) {
  const encodedSecret = encoder.encode(secret);
  const algorithm: HmacImportParams = { hash: 'SHA-256', name: 'HMAC' };
  const authenticatorKey = await crypto.subtle.importKey('raw', encodedSecret, algorithm, false, [
    'sign',
  ]);
  const signed = await crypto.subtle.sign(
    algorithm.name,
    authenticatorKey,
    encoder.encode(payload),
  );
  return new Uint8Array(signed);
}
export function equal(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export async function sign(secret: string, value: unknown) {
  const body = bytes64(encoder.encode(JSON.stringify(value)));
  return `${body}.${bytes64(await hmac(secret, body))}`;
}
export async function verify<T>(secret: string, token: string, schema: z.ZodType<T>): Promise<T> {
  if (token.length > 16384) throw new Failure(401, 'INVALID_TOKEN', 'The token is invalid.');
  const parts = token.split('.');
  if (parts.length !== 2 || !equal(bytes64(await hmac(secret, parts[0])), parts[1]))
    throw new Failure(401, 'INVALID_TOKEN', 'The token is invalid.');
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(from64(parts[0]))));
  } catch {
    throw new Failure(401, 'INVALID_TOKEN', 'The token is invalid.');
  }
}
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return bytes64(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: from64(salt), iterations: 100000 },
        key,
        256,
      ),
    ),
  );
}
export function cookie(request: Request, name: string) {
  const parts = (request.headers.get('cookie') ?? '').split(';').map((v) => v.trim());
  const values = parts.filter((p) => p.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
export function setCookie(name: string, value: string, maxAge: number, path = '/') {
  return `${name}=${value}; Path=${path}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Secure; HttpOnly; SameSite=Lax`;
}
