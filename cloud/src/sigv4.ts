import { createHash, createHmac } from 'node:crypto';
export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Uint8Array, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export interface SigningCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
/** AWS SigV4: URI encoded once, query keys/values encoded and byte-sorted. */
export function signV4(input: { method: string; url: URL; headers?: Record<string,string>; body?: Uint8Array | string; region: string; service?: string; credentials: SigningCredentials; now?: Date }): { headers: Record<string,string>; canonicalRequest: string; signature: string } {
  const { credentials, url } = input;
  const timestamp = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const headers: Record<string,string> = { host: url.host, 'x-amz-date': timestamp, 'x-amz-content-sha256': sha256(input.body ?? '') };
  for (const [key,value] of Object.entries(input.headers ?? {})) headers[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams].map(([k,v]) => [encode(k), encode(v)]).sort((a,b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('&');
  const path = url.pathname.split('/').map(segment => encode(decodeURIComponent(segment))).join('/');
  const canonicalRequest = [input.method.toUpperCase(), path, query, names.map(n => `${n}:${headers[n]}\n`).join(''), names.join(';'), headers['x-amz-content-sha256']].join('\n');
  const service = input.service ?? 's3';
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), input.region), service), 'aws4_request');
  const signature = hmac(key, ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n')).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { headers, canonicalRequest, signature };
}
/** Deliberately never includes queries, credentials, headers or arbitrary provider bodies. */
export function redactURL(value: string): string { try { const u = new URL(value); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return '[invalid URL]'; } }
