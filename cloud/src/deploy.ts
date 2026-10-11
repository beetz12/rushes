import { randomBytes } from 'node:crypto';
import { ShareError, type Fetch } from './types.js';
export interface DeploymentInput {
    accountId: string;
    apiToken: string;
    workerName: string;
    bucketName: string;
    databaseName: string;
    workersSubdomain: string;
    script: string;
    schemaSQL: string;
    ownerToken?: string;
    sessionSecret?: string;
}
export interface DeploymentResult {
    workerURL: string;
    accountId: string;
    bucketName: string;
    databaseId: string;
    workerName: string;
    ownerToken: string;
    sessionSecret: string;
    checks: string[];
}
/** This mutates a selected Cloudflare account. The caller owns authorization and secure persistence. */
export async function deployWorker(input: DeploymentInput, fetcher: Fetch = fetch): Promise<DeploymentResult> {
    if (!/^[a-f0-9]{32}$/.test(input.accountId) || !input.apiToken || ![input.workerName, input.bucketName, input.databaseName, input.workersSubdomain].every(n => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(n)))
        throw new ShareError('INVALID_DEPLOY_INPUT', 'Select a Cloudflare account and valid resource names before deployment.');
    if ((input.ownerToken !== undefined && input.ownerToken.length < 32) || (input.sessionSecret !== undefined && input.sessionSecret.length < 32))
        throw new ShareError('INVALID_SECRET', 'Worker secrets must contain at least 32 characters.');
    const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}`;
    const call = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
        const form = body instanceof FormData;
        let r: Response;
        try {
            r = await fetcher(base + path, { method, headers: { Authorization: `Bearer ${input.apiToken}`, ...(!form && body ? { 'Content-Type': 'application/json' } : {}) }, body: form ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000), redirect: 'error' });
        }
        catch {
            throw new ShareError('CLOUDFLARE_NETWORK', 'Cloudflare request failed.');
        }
        let b: {
            success?: boolean;
            result: T;
            errors?: Array<{
                code: number;
            }>;
        };
        try {
            b = await r.json() as typeof b;
        }
        catch {
            throw new ShareError('CLOUDFLARE_RESPONSE', 'Cloudflare returned an invalid response.');
        }
        if (!r.ok || !b.success) {
            if (b.errors?.some(e => e.code === 10007) && r.status === 404)
                throw new ShareError('SUBDOMAIN_MISSING', 'The selected account has no workers.dev subdomain.', 404);
            if (b.errors?.some(e => e.code === 10042))
                throw new ShareError('R2_NOT_ENABLED', `R2 is disabled in selected account ${input.accountId}. Enable R2 in the Cloudflare Dashboard, then retry setup.`, r.status);
            throw new ShareError('CLOUDFLARE_API', `Cloudflare ${method} request failed (HTTP ${r.status}; code ${b.errors?.[0]?.code ?? 'unknown'}).`, r.status);
        }
        return b.result;
    };
    // Probe R2 activation before any writes. Disabled accounts do not receive repeated write attempts.
    await call('/r2/buckets', 'GET');
    // A selected new subdomain is created only for an account with no existing one.
    let existingSubdomain: string | undefined;
    try {
        existingSubdomain = (await call<{
            subdomain: string;
        }>('/workers/subdomain', 'GET')).subdomain;
    }
    catch (e) {
        if (!(e instanceof ShareError && e.code === 'SUBDOMAIN_MISSING'))
            throw e;
    }
    if (existingSubdomain && existingSubdomain !== input.workersSubdomain)
        throw new ShareError('SUBDOMAIN_MISMATCH', 'Use the existing account workers.dev subdomain; this deployment will not rename it.');
    if (!existingSubdomain)
        await call('/workers/subdomain', 'PUT', { subdomain: input.workersSubdomain });
    const buckets = await call<{
        buckets: Array<{
            name: string;
        }>;
    }>('/r2/buckets', 'GET');
    if (!buckets.buckets.some(b => b.name === input.bucketName))
        await call('/r2/buckets', 'POST', { name: input.bucketName });
    const databases = await call<Array<{
        uuid: string;
        name: string;
    }>>('/d1/database', 'GET');
    let databaseId = databases.find(d => d.name === input.databaseName)?.uuid;
    if (!databaseId)
        databaseId = (await call<{
            uuid: string;
        }>('/d1/database', 'POST', { name: input.databaseName })).uuid;
    await call(`/d1/database/${databaseId}/query`, 'POST', { sql: input.schemaSQL, params: [] });
    const ownerToken = input.ownerToken ?? randomBytes(32).toString('base64url');
    const sessionSecret = input.sessionSecret ?? randomBytes(32).toString('base64url');
    if (ownerToken.length < 32 || sessionSecret.length < 32)
        throw new ShareError('INVALID_SECRET', 'Worker secrets must contain at least 32 characters.');
    const workerURL = `https://${input.workerName}.${input.workersSubdomain}.workers.dev`;
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-10-11', bindings: [{ type: 'r2_bucket', name: 'MEDIA', bucket_name: input.bucketName }, { type: 'd1', name: 'DB', id: databaseId }, { type: 'secret_text', name: 'OWNER_TOKEN', text: ownerToken }, { type: 'secret_text', name: 'SESSION_SECRET', text: sessionSecret }, { type: 'plain_text', name: 'PUBLIC_BASE_URL', text: workerURL }] })], { type: 'application/json' }));
    form.set('worker.js', new Blob([input.script], { type: 'application/javascript+module' }), 'worker.js');
    await call(`/workers/scripts/${input.workerName}`, 'PUT', form);
    await call(`/workers/scripts/${input.workerName}/subdomain`, 'POST', { enabled: true, previews_enabled: false });
    await call(`/workers/scripts/${input.workerName}/schedules`, 'PUT', [{ cron: '0 3 * * *' }]);
    const health = await fetcher(workerURL + '/health', { signal: AbortSignal.timeout(15000) });
    const h = await health.json() as {
        ok?: boolean;
    };
    if (!health.ok || h.ok !== true)
        throw new ShareError('DEPLOY_HEALTH', 'Worker deployment health could not be confirmed.');
    const probe = await fetcher(workerURL + '/api/setup/check', { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
    if (!probe.ok || (await probe.json() as {
        ok?: boolean;
    }).ok !== true)
        throw new ShareError('DEPLOY_PROBE', 'Worker is reachable but storage/database checks failed.');
    return { workerURL, accountId: input.accountId, bucketName: input.bucketName, databaseId: databaseId!, workerName: input.workerName, ownerToken, sessionSecret, checks: ['R2 enabled', 'bucket exists', 'D1 schema applied', 'Worker uploaded', 'workers.dev enabled', 'expiry cron set', 'HTTP health', 'storage/database probe'] };
}
