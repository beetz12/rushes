import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const userSchema = z.object({id: z.string().min(1).max(128), tenantId: z.string().min(1).max(128), email: z.string().email().max(320), name: z.string().max(160)});
const accountSchema = z.object({serviceURL: z.string().url(), credential: z.string().min(32).max(512), deviceId: z.string().min(1).max(128), user: userSchema, expiresAt: z.string().datetime()}).strict();
export type HostedCredential = z.infer<typeof accountSchema>;
export type HostedAccountStatus = {connected: boolean; pending: boolean; saving: boolean; serviceURL?: string; email?: string; name?: string; expiresAt?: string; error?: string};
export interface HostedCredentialStore {load(): Promise<unknown>; save(account: HostedCredential): Promise<void>; clear(): Promise<void>}
export function hostedServiceURL(value: string, allowLocalHTTP = false): string {
  const url = new URL(value);
  const noPrivateParts = (['username', 'password', 'search', 'hash'] as const).every(key => url[key].length === 0);
  const localDevelopment = allowLocalHTTP && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
  if (!noPrivateParts || url.pathname !== '/' || !(url.protocol === 'https:' || localDevelopment)) throw Error('Use the HTTPS address of your Rushes Cloud service.');
  return url.origin;
}
async function boundedJSON(response: Response) {
  if (Number(response.headers.get('Content-Length')) > 16384) throw Error('Cloud account response is too large.');
  if (!response.body) throw Error('Cloud account returned an empty response.');
  const reader = response.body.getReader(), blocks: Uint8Array[] = []; let size = 0;
  try {
    let packet = await reader.read();
    while (!packet.done) {
      blocks.push(packet.value); size += packet.value.byteLength;
      if (size > 16384) throw Error('Cloud account response is too large.');
      packet = await reader.read();
    }
  }
  finally {await reader.cancel().catch(() => {});}
  return JSON.parse(Buffer.concat(blocks).toString('utf8')) as unknown;
}
export class HostedAccountController {
  #account?: HostedCredential;
  private generation = 0;
  private saving = false;
  private pending?: AbortController;
  private error?: string;
  private commits: Promise<void> = Promise.resolve();
  constructor(private store: HostedCredentialStore, private open: (url: string) => Promise<void>, private changed: () => void, private options: {fetch?: typeof fetch; allowLocalHTTP?: boolean; wait?: (signal: AbortSignal) => Promise<void>; now?: () => number} = {}) {}
  private now() {return this.options.now?.() ?? Date.now();}
  async initialize() {
    try {const account = accountSchema.parse(await this.store.load()); hostedServiceURL(account.serviceURL, this.options.allowLocalHTTP); if (Date.parse(account.expiresAt) > this.now()) this.#account = account;}
    catch {this.#account = undefined;}
  }
  status(): HostedAccountStatus {
    const account = this.#account && Date.parse(this.#account.expiresAt) > this.now() ? this.#account : undefined;
    return {connected: !!account, pending: !!this.pending, saving: this.saving, ...(account ? {serviceURL: account.serviceURL, email: account.user.email, name: account.user.name, expiresAt: account.expiresAt} : {}), ...(this.error ? {error: this.error} : {})};
  }
  credential(serviceURL: string): HostedCredential {
    if (this.pending) throw Error('Finish or cancel the account connection before sharing.');
    if (!this.#account || this.#account.serviceURL !== hostedServiceURL(serviceURL, this.options.allowLocalHTTP) || Date.parse(this.#account.expiresAt) <= this.now()) throw Error('Connect your Rushes Cloud account in Settings before sharing.');
    return structuredClone(this.#account);
  }
  private async request(base: string, path: string, body?: unknown, signal?: AbortSignal, credential?: string) {
    const response = await (this.options.fetch ?? fetch)(`${base}${path}`, {method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', headers: {Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(credential ? {Authorization: `Native ${credential}`} : {})}, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
    // A provider response may echo sensitive request fields. Expose no raw body on failure.
    if (!response.ok) throw Error(response.status === 401 || response.status === 410 ? 'This cloud connection expired or was revoked. Connect again in Settings.' : `Rushes Cloud could not complete the account request (HTTP ${response.status}).`);
    return boundedJSON(response);
  }
  async start(serviceURL: string): Promise<HostedAccountStatus> {
    const base = hostedServiceURL(serviceURL, this.options.allowLocalHTTP);
    this.cancel(); const generation = this.generation, controller = new AbortController(); this.pending = controller; this.error = undefined; this.changed();
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    try {
      const link = z.object({id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), verificationUrl: z.string().url(), expiresAt: z.string().datetime()}).parse(await this.request(base, '/api/native/link/start', {challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Rushes on Mac'}, controller.signal));
      if (generation !== this.generation || controller.signal.aborted) return this.status();
      if (link.verificationUrl !== `${base}/desktop/link/${link.id}` || Date.parse(link.expiresAt) <= this.now()) throw Error('Rushes Cloud returned an invalid Mac connection link.');
      await this.open(link.verificationUrl);
      if (generation !== this.generation || controller.signal.aborted) return this.status();
      void this.poll(base, link.id, verifier, state, Math.min(Date.parse(link.expiresAt), this.now() + 300000), generation, controller);
      return this.status();
    } catch (value) {
      if (generation === this.generation) {this.pending = undefined; this.error = controller.signal.aborted ? undefined : value instanceof Error ? value.message : 'Cloud connection could not start.'; this.changed();}
      if (!controller.signal.aborted) throw value;
      return this.status();
    }
  }
  private async poll(base: string, id: string, verifier: string, state: string, until: number, generation: number, controller: AbortController) {
    try {
      for (let attempt = 0; attempt < 150 && this.now() < until; attempt++) {
        if (generation !== this.generation || controller.signal.aborted) return;
        const result = await this.request(base, `/api/native/link/${id}/claim`, {verifier, state}, controller.signal) as Record<string, unknown>;
        if (generation !== this.generation || controller.signal.aborted) return;
        if (result.status === 'pending') {await (this.options.wait ? this.options.wait(controller.signal) : delay(2000, undefined, {signal: controller.signal})); continue;}
        if (result.status !== 'connected') throw Error('Rushes Cloud returned an invalid connection response.');
        const candidate = accountSchema.parse({serviceURL: base, credential: result.credential, deviceId: result.deviceId, user: result.user, expiresAt: result.expiresAt});
        if (Date.parse(candidate.expiresAt) <= this.now() || Date.parse(candidate.expiresAt) > this.now() + 14 * 86400000 + 60000) throw Error('Invalid cloud session lifetime.');
        const profile = z.object({user: userSchema, deviceId: z.string(), expiresAt: z.string().datetime()}).parse(await this.request(base, '/api/native/session', undefined, controller.signal, candidate.credential));
        if (profile.user.id !== candidate.user.id || profile.user.tenantId !== candidate.user.tenantId || profile.deviceId !== candidate.deviceId || Date.parse(profile.expiresAt) <= this.now()) throw Error('The cloud account changed during connection. Start again.');
        this.commits = this.commits.catch(() => {}).then(async () => {
          if (generation !== this.generation || controller.signal.aborted) return;
          // Atomic persistence is the connection commit. Refuse cancellation while
          // it is in flight; a failed rollback must never masquerade as cancellation.
          this.saving = true; this.changed();
          try {
            await this.store.save(candidate);
            this.#account = candidate; this.pending = undefined; this.error = undefined;
          } finally {this.saving = false; this.changed();}
        });
        await this.commits; return;
      }
      throw Error('The Mac connection request expired. Start a new connection in Settings.');
    } catch {
      if (generation === this.generation && !controller.signal.aborted) {this.pending = undefined; this.error = 'Cloud connection was not confirmed. Try connecting again in Settings.'; this.changed();}
    }
  }
  cancel() {if (this.saving) throw Error('The connection is being saved. Wait, then use Disconnect if needed.'); this.generation++; this.pending?.abort(); this.pending = undefined; this.changed();}
  async disconnect() {
    this.cancel(); await this.commits;
    const account = this.#account;
    if (!account) return this.status();
    await this.request(account.serviceURL, '/api/native/logout', {}, undefined, account.credential);
    this.commits = this.commits.catch(() => {}).then(async () => {if (this.#account?.credential !== account.credential) return; await this.store.clear(); this.#account = undefined; this.error = undefined; this.changed();});
    await this.commits; return this.status();
  }
}
