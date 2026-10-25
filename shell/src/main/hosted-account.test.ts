/// <reference lib="es2024.promise" />
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { HostedAccountController, hostedServiceURL, type HostedCredential } from './hosted-account';
const user = {id: 'user-fixture', tenantId: 'tenant-fixture', email: 'sam@example.test', name: 'Sam'};
const base = 'https://cloud.example.test', id = 'generated-link-fixture-12345', credential = 'test-only-native-session-credential-123456789';
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
async function until(check: () => boolean) {for (let i = 0; i < 100; i++) {if (check()) return; await new Promise(resolve => setImmediate(resolve));} throw Error('Account operation did not settle.');}
function deferred<T>() {return Promise.withResolvers<T>();}
function fixture(options: {holdClaim?: boolean; holdSave?: boolean; wrongAccount?: boolean; wrongLink?: boolean; logoutError?: boolean; saveError?: boolean; initial?: HostedCredential} = {}) {
  let saved: HostedCredential | undefined = options.initial, opened = '', startBody: any, claimBody: any;
  const calls: {url: string; init: RequestInit}[] = [], held = deferred<Response>(), saving = deferred<void>();
  const fetcher = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({url: String(url), init}); const path = new URL(String(url)).pathname;
    if (path === '/api/native/link/start') {startBody = JSON.parse(String(init.body)); return json({id, verificationUrl: `${options.wrongLink ? 'https://other.example.test' : base}/desktop/link/${id}`, expiresAt: new Date(Date.now() + 300000).toISOString()});}
    if (path.endsWith('/claim')) {claimBody = JSON.parse(String(init.body)); return options.holdClaim ? held.promise : json({status: 'connected', credential, deviceId: 'native-device', user, expiresAt: expiry()});}
    if (path === '/api/native/session') return json({user: options.wrongAccount ? {...user, tenantId: 'foreign-tenant'} : user, deviceId: 'native-device', expiresAt: expiry(), canUpload: false, usage: {}});
    if (path === '/api/native/logout') return options.logoutError ? json({error: {message: credential}}, 503) : json({ok: true});
    throw Error('Unexpected account route');
  };
  const controller = new HostedAccountController({load: async () => saved, save: async value => {if (options.saveError) throw Error('Atomic save refused before commit'); if (options.holdSave) await saving.promise; saved = structuredClone(value);}, clear: async () => {saved = undefined;}}, async url => {opened = url;}, () => {}, {fetch: fetcher as typeof fetch});
  return {controller, calls, held, saving, get saved() {return saved;}, get opened() {return opened;}, get startBody() {return startBody;}, get claimBody() {return claimBody;}};
}
describe('hosted Mac account connection', () => {
  it('uses PKCE and state, confirms native account, stores privately and projects no credential', async () => {
    const f = fixture(); await f.controller.initialize(); await f.controller.start(base); await until(() => f.controller.status().connected);
    expect(f.opened).toBe(`${base}/desktop/link/${id}`);
    expect(createHash('sha256').update(f.claimBody.verifier).digest('base64url')).toBe(f.startBody.challenge);
    expect(f.claimBody.state).toBe(f.startBody.state);
    expect(f.saved?.credential).toBe(credential); expect(JSON.stringify(f.controller.status())).not.toContain(credential); expect(JSON.stringify(f.controller)).not.toContain(credential);
    expect(f.calls.every(call => call.init.redirect === 'error' && call.init.credentials === 'omit' && call.init.signal)).toBe(true);
    expect((f.calls.find(call => call.url.endsWith('/session'))!.init.headers as any).Authorization).toBe(`Native ${credential}`);
    await f.controller.disconnect(); expect(f.controller.status().connected).toBe(false); expect(f.saved).toBeUndefined();
  });
  it('cancel rejects a late claim and never saves an issued credential', async () => {
    const f = fixture({holdClaim: true}); await f.controller.start(base); await until(() => !!f.claimBody); f.controller.cancel();
    f.held.resolve(json({status: 'connected', credential, deviceId: 'native-device', user, expiresAt: expiry()}));
    await new Promise(resolve => setImmediate(resolve)); expect(f.controller.status()).toMatchObject({pending: false, connected: false}); expect(f.saved).toBeUndefined();
  });
  it('refuses cancel, restart and disconnect during atomic persistence without claiming cancellation', async () => {
    const f = fixture({holdSave: true}); await f.controller.start(base); await until(() => f.controller.status().saving);
    expect(() => f.controller.cancel()).toThrow('being saved');
    await expect(f.controller.start(base)).rejects.toThrow('being saved');
    await expect(f.controller.disconnect()).rejects.toThrow('being saved');
    expect(f.controller.status()).toMatchObject({pending: true, saving: true, connected: false});
    f.saving.resolve(); await until(() => f.controller.status().connected);
    expect(f.saved?.credential).toBe(credential); expect(f.controller.status().saving).toBe(false);
  });
  it('failed atomic persistence keeps the previously connected authority and reports failure', async () => {
    const prior = {serviceURL: base, credential: 'test-only-previous-native-credential-123456789', deviceId: 'old-device', user: {...user, email: 'previous@example.test'}, expiresAt: expiry()};
    const f = fixture({initial: prior, saveError: true}); await f.controller.initialize(); await f.controller.start(base); await until(() => !f.controller.status().pending);
    expect(f.controller.status()).toMatchObject({connected: true, saving: false, email: 'previous@example.test'});
    expect(f.controller.status().error).toContain('not confirmed'); expect(f.saved).toEqual(prior);
    expect(f.controller.credential(base).credential).toBe(prior.credential);
  });
  it('a changed tenant during session confirmation cannot connect', async () => {
    const f = fixture({wrongAccount: true}); await f.controller.start(base); await until(() => !f.controller.status().pending); expect(f.saved).toBeUndefined(); expect(f.controller.status().connected).toBe(false);
  });
  it('rejects an off-origin verification URL before opening it', async () => {
    const f = fixture({wrongLink: true}); await expect(f.controller.start(base)).rejects.toThrow('invalid Mac connection link'); expect(f.opened).toBe(''); expect(f.saved).toBeUndefined();
  });
  it('failed revocation remains connected and never exposes the server-echoed credential', async () => {
    const f = fixture({logoutError: true}); await f.controller.start(base); await until(() => f.controller.status().connected);
    await expect(f.controller.disconnect()).rejects.not.toThrow(credential); expect(f.controller.status().connected).toBe(true); expect(f.saved?.credential).toBe(credential);
  });
  it('rejects unsafe service endpoints and limits local HTTP to explicit development', () => {
    for (const url of ['http://cloud.example.test', 'https://u:p@cloud.example.test', `${base}/other`, `${base}/?grant=hidden`, `${base}/#fragment`]) expect(() => hostedServiceURL(url)).toThrow();
    expect(hostedServiceURL('http://127.0.0.1:8787', true)).toBe('http://127.0.0.1:8787'); expect(() => hostedServiceURL('http://127.0.0.1:8787')).toThrow();
  });
});
