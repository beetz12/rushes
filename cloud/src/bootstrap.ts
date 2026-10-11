import { spawn } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ShareError, requireHTTPS } from './types.js';
const SERVICE = 'com.rushes.cloud.bootstrap';
export interface BootstrapSecrets {
    ownerToken: string;
    sessionSecret: string;
}
export interface BootstrapMetadata {
    accountId: string;
    workerName: string;
    bucketName: string;
    databaseName: string;
    workerURL: string;
}
export interface BootstrapKeychain {
    add(account: string, key: string): Promise<void>;
    read(account: string): Promise<string>;
    remove(account: string): Promise<void>;
}
interface Envelope {
    schema: 'rushes.encrypted-bootstrap/1';
    service: string;
    account: string;
    nonce: string;
    ciphertext: string;
    tag: string;
    metadata: BootstrapMetadata;
}
function security(args: string[], stdin = ''): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        process.stdout.on('data', c => output += c);
        process.stderr.resume();
        process.on('error', () => reject(new ShareError('KEYCHAIN_UNAVAILABLE', 'Keychain service unavailable.')));
        process.on('close', code => code === 0 ? resolve(output) : reject(new ShareError('KEYCHAIN_FAILED', 'Keychain operation failed.')));
        process.stdin.on('error', () => reject(new ShareError('KEYCHAIN_FAILED', 'Keychain operation failed.')));
        process.stdin.end(stdin);
    });
}
const systemKeychain: BootstrapKeychain = {
    async add(account, key) { await security(['-i'], `add-generic-password -U -a ${account} -s ${SERVICE} -w ${key}\n`); },
    async read(account) { return (await security(['find-generic-password', '-a', account, '-s', SERVICE, '-w'])).trim(); },
    async remove(account) { await security(['delete-generic-password', '-a', account, '-s', SERVICE]); }
};
function validateMetadata(input: BootstrapMetadata): BootstrapMetadata {
    if (!/^[a-f0-9]{32}$/.test(input.accountId) || ![input.workerName, input.bucketName, input.databaseName].every(s => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(s)))
        throw new ShareError('INVALID_BOOTSTRAP', 'Bootstrap resource metadata is invalid.');
    requireHTTPS(input.workerURL);
    return { accountId: input.accountId, workerName: input.workerName, bucketName: input.bucketName, databaseName: input.databaseName, workerURL: input.workerURL };
}
function validateEnvelope(input: Envelope): Envelope {
    if (input.schema !== 'rushes.encrypted-bootstrap/1' || input.service !== SERVICE || !/^[a-f0-9]{32}$/.test(input.account))
        throw new ShareError('INVALID_BOOTSTRAP', 'Invalid encrypted bootstrap.');
    validateMetadata(input.metadata);
    return input;
}
export async function createBootstrap(path: string, secrets: BootstrapSecrets, rawMetadata: BootstrapMetadata, keychain: BootstrapKeychain = systemKeychain): Promise<string> {
    if (secrets.ownerToken.length < 32 || secrets.sessionSecret.length < 32)
        throw new ShareError('INVALID_BOOTSTRAP', 'Strong Worker credentials are required.');
    const metadata = validateMetadata(rawMetadata), key = randomBytes(32), account = randomBytes(16).toString('hex'), nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
    const plaintext = Buffer.from(JSON.stringify({ ownerToken: secrets.ownerToken, sessionSecret: secrets.sessionSecret }));
    let ciphertext: Buffer;
    try {
        ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }
    finally {
        plaintext.fill(0);
    }
    await keychain.add(account, key.toString('hex'));
    const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
        const readBack = Buffer.from(await keychain.read(account), 'hex');
        try {
            if (readBack.length !== key.length || !timingSafeEqual(readBack, key))
                throw new ShareError('KEYCHAIN_READBACK', 'Keychain key read-back did not match.');
        }
        finally {
            readBack.fill(0);
        }
        const envelope: Envelope = { schema: 'rushes.encrypted-bootstrap/1', service: SERVICE, account, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'), metadata };
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
        await rename(temporary, path);
    }
    catch (e) {
        await keychain.remove(account).catch(() => { });
        throw e;
    }
    finally {
        key.fill(0);
        await rm(temporary, { force: true });
    }
    return path;
}
/** Call only from a secure main-process importer; never print the returned secrets. */
export async function readBootstrap(path: string, keychain: BootstrapKeychain = systemKeychain): Promise<{
    secrets: BootstrapSecrets;
    metadata: BootstrapMetadata;
}> {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0)
        throw new ShareError('BOOTSTRAP_PERMISSIONS', 'Bootstrap must be owner-only.');
    const envelope = validateEnvelope(JSON.parse(await readFile(path, 'utf8')) as Envelope);
    const key = Buffer.from(await keychain.read(envelope.account), 'hex');
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify(envelope.metadata)));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
        try {
            return { secrets: JSON.parse(plaintext.toString('utf8')) as BootstrapSecrets, metadata: envelope.metadata };
        }
        finally {
            plaintext.fill(0);
        }
    }
    catch {
        throw new ShareError('BOOTSTRAP_AUTH_FAILED', 'Encrypted bootstrap could not be authenticated.');
    }
    finally {
        key.fill(0);
    }
}
/** Caller must prove safeStorage import and non-secret state read-back before cleanup. */
export async function removeBootstrap(path: string, keychain: BootstrapKeychain = systemKeychain): Promise<void> {
    const envelope = validateEnvelope(JSON.parse(await readFile(path, 'utf8')) as Envelope);
    await keychain.remove(envelope.account);
    await rm(path);
}
