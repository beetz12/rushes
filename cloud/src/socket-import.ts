import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ShareError } from './types.js';
import type { BootstrapMetadata, BootstrapSecrets } from './bootstrap.js';
export async function cloudSocketAvailable(path: string): Promise<boolean> { try {
    const s = await lstat(path);
    if (!s.isSocket() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.())
        throw new ShareError('SOCKET_PERMISSIONS', 'Secure cloud import socket must belong to this user with mode 0600.');
    return true;
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return false;
    throw e;
} }
interface Configuration {
    provider: string;
    endpoint?: string;
    accountId?: string;
    configured: boolean;
    encrypted: boolean;
}
async function socketRequest(path: string, cmd: string, args: Record<string, unknown>): Promise<Configuration> { return new Promise((resolve, reject) => { const id = randomBytes(16).toString('hex'); const socket = createConnection(path); let input = ''; const timeout = setTimeout(() => { socket.destroy(); reject(new ShareError('IMPORT_TIMEOUT', 'Secure application import timed out.')); }, 10000); const finish = (error?: Error, result?: Configuration) => { clearTimeout(timeout); socket.destroy(); error ? reject(error) : resolve(result!); }; socket.on('error', () => finish(new ShareError('IMPORT_UNAVAILABLE', 'Secure application import socket is unavailable.'))); socket.on('connect', () => socket.write(JSON.stringify({ id, cmd, args }) + '\n')); socket.on('data', chunk => { input += chunk.toString(); if (input.length > 65536)
    return finish(new ShareError('IMPORT_RESPONSE', 'Secure import response exceeded its limit.')); let newline: number; while ((newline = input.indexOf('\n')) >= 0) {
    const raw = input.slice(0, newline);
    input = input.slice(newline + 1);
    try {
        const response = JSON.parse(raw) as {
            id?: string;
            ok?: boolean;
            result?: Configuration;
        };
        if (response.id !== id)
            continue;
        if (response.ok !== true || !response.result)
            return finish(new ShareError('IMPORT_FAILED', 'Secure application import failed.'));
        finish(undefined, response.result);
        return;
    }
    catch {
        return finish(new ShareError('IMPORT_RESPONSE', 'Secure application import returned invalid JSON.'));
    }
} }); }); }
/** Credentials travel only over this same-user 0600 socket; no logs or plaintext files. */
export async function configureThroughSocket(path: string, metadata: BootstrapMetadata, secrets: BootstrapSecrets): Promise<Configuration> { if (!await cloudSocketAvailable(path))
    throw new ShareError('APP_REQUIRED', 'Open Rushes before deploying to import credentials securely.'); await socketRequest(path, 'share.configure', { provider: 'worker', workerURL: metadata.workerURL, token: secrets.ownerToken, accountId: metadata.accountId }); const readBack = await socketRequest(path, 'share.configuration', {}); if (readBack.provider !== 'worker' || readBack.endpoint !== metadata.workerURL || readBack.accountId !== metadata.accountId || readBack.configured !== true || readBack.encrypted !== true)
    throw new ShareError('IMPORT_READBACK', 'The encrypted application configuration did not match deployment settings.'); return readBack; }
