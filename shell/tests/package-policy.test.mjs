import { test, expect } from 'vitest';
import disk from 'node:fs/promises';
import operatingSystem from 'node:os';
import path from 'node:path';
import childProcesses from 'node:child_process';
import utilities from 'node:util';
import addresses from 'node:url';
import { packageSigning } from '../scripts/package-signing.mjs';

const execute = utilities.promisify(childProcesses.execFile);
const entryPoint = addresses.fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
const identity = 'Developer ID Application: Generated Packaging Test (ABCDEFGHIJ)';
async function packageAttempt(selection) {
  const directory = await disk.mkdtemp(path.join(operatingSystem.tmpdir(), 'rushes-package-policy-'));
  const receipt = path.join(directory, 'builder.json'), hook = path.join(directory, 'builder-hook.mjs');
  const workingDirectory = path.join(directory, 'shell');
  await disk.mkdir(workingDirectory);
  const resources = path.join(directory, '.build/release'); await disk.mkdir(resources, { recursive: true });
  for (const name of ['rushcore-engine', 'rushes']) await disk.writeFile(path.join(resources, name), 'Generated access-only resource; never executed.');
  // Run the actual entry point; only the external packager is replaced. No signing occurs.
  await disk.writeFile(hook, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'electron-builder' ? { url: 'rushes:packaging-test', shortCircuit: true } : next(specifier, context);
    }, load(url, context, next) {
      return url === 'rushes:packaging-test' ? { format: 'module', shortCircuit: true,
        source: "import { writeFileSync } from 'node:fs'; export const Arch = { x64: 1, arm64: 3 }; export async function build(value) { writeFileSync(process.env.RUSHES_PACKAGE_TEST_RECEIPT, JSON.stringify({ ...value, hasNativeHelperHook: typeof value.config.afterPack === 'function' })); }" } : next(url, context);
    } });`);
  const environment = { ...process.env };
  for (const name of Object.keys(environment))
    if (name.startsWith('APPLE_') || name.startsWith('CSC_') || name.startsWith('RUSHES_SIGN_') || name === 'RUSHES_NOTARIZE') delete environment[name];
  delete environment.GITHUB_BASE_REF; delete environment.CI; delete environment.GITHUB_EVENT_NAME;
  Object.assign(environment, selection, { RUSHES_PACKAGE_TEST_RECEIPT: receipt });
  try {
    let code = 0, output = '';
    try { const result = await execute(process.execPath, ['--import', hook, entryPoint], { cwd: workingDirectory, env: environment, timeout: 10000 }); output = result.stdout + result.stderr; }
    catch (error) { code = error.code; output = String(error.stdout) + String(error.stderr); }
    const built = await disk.readFile(receipt, 'utf8').then(JSON.parse, () => null);
    return { code, output, built };
  } finally { await disk.rm(directory, { recursive: true, force: true }); }
}

test('production intent refuses an absent Developer ID before invoking the packager', async () => {
  const result = await packageAttempt({ RUSHES_SIGN_TYPE: 'distribution', RUSHES_NOTARIZE: '1' });
  expect(result.code).not.toBe(0); expect(result.built).toBeNull();
  expect(result.output).toMatch(/Developer ID Application/);
});
test('production intent refuses missing notarization credentials before invoking the packager', async () => {
  const result = await packageAttempt({ RUSHES_SIGN_TYPE: 'distribution', RUSHES_SIGN_IDENTITY: identity, RUSHES_NOTARIZE: '1' });
  expect(result.code).not.toBe(0); expect(result.built).toBeNull();
  expect(result.output).toMatch(/notarization credentials/i);
});
test('explicit local development packaging remains development-only', async () => {
  const result = await packageAttempt({ RUSHES_SIGN_IDENTITY: 'Apple Development: Generated Local Test (ABCDEFGHIJ)' });
  expect(result.code).toBe(0);
  expect(result.built.config.mac).toEqual({ identity: 'Apple Development: Generated Local Test (ABCDEFGHIJ)', type: 'development', notarize: false });
  expect(result.built.mac).toEqual(['dir']); expect(result.built.publish).toBe('never');
});
test('complete production intent forwards mandatory signing and notarization to the packager', async () => {
  const result = await packageAttempt({ RUSHES_SIGN_TYPE: 'distribution', RUSHES_SIGN_IDENTITY: identity,
    RUSHES_NOTARIZE: '1', APPLE_KEYCHAIN_PROFILE: 'generated-profile-no-authentication', CI: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' });
  expect(result.code).toBe(0);
  expect(result.built.config).toEqual({ forceCodeSigning: true, mac: { identity, type: 'distribution', notarize: true, hardenedRuntime: true } });
  expect(result.built.publish).toBe('never');
});
test('signing policy refuses downgrade, unsupported hosts, partial auth and an unrelated team', () => {
  const production = { RUSHES_SIGN_TYPE: 'distribution', RUSHES_SIGN_IDENTITY: identity,
    RUSHES_NOTARIZE: '1', APPLE_KEYCHAIN_PROFILE: 'generated-profile' };
  for (const value of [undefined, '', '-', 'null', 'Apple Development: Generated Local Test (ABCDEFGHIJ)'])
    expect(() => packageSigning({ ...production, RUSHES_SIGN_IDENTITY: value }, 'darwin')).toThrow(/Developer ID Application/);
  for (const value of [undefined, '0'])
    expect(() => packageSigning({ ...production, RUSHES_NOTARIZE: value }, 'darwin')).toThrow(/RUSHES_NOTARIZE=1/);
  for (const platform of ['linux', 'win32']) expect(() => packageSigning(production, platform)).toThrow(/requires macOS/);
  expect(() => packageSigning({ ...production, APPLE_ID: 'generated@example.invalid' }, 'darwin')).toThrow(/notarization credentials/i);
  expect(() => packageSigning({ ...production, APPLE_API_KEY_ID: 'generated' }, 'darwin')).toThrow(/notarization credentials/i);
  expect(() => packageSigning({ ...production, APPLE_TEAM_ID: 'OTHERTEAM1' }, 'darwin')).toThrow(/differs/);
  expect(() => packageSigning({ ...production, CI: 'true', GITHUB_EVENT_NAME: 'pull_request' }, 'darwin')).toThrow(/manually dispatched/);
  expect(() => packageSigning({ ...production, GITHUB_BASE_REF: 'main' }, 'darwin')).toThrow(/pull request/);
  expect(() => packageSigning({ RUSHES_SIGN_TYPE: 'distributon' }, 'darwin')).toThrow(/Select/);
  expect(() => packageSigning({ RUSHES_NOTARIZE: 'true' }, 'darwin')).toThrow(/0 or 1/);
});
test('all supported complete notarization methods are accepted without exposing their values', () => {
  const production = { RUSHES_SIGN_TYPE: 'distribution', RUSHES_SIGN_IDENTITY: identity, RUSHES_NOTARIZE: '1' };
  const methods = [
    { APPLE_ID: 'generated@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'generated-auth-placeholder', APPLE_TEAM_ID: 'ABCDEFGHIJ' },
    { APPLE_API_KEY: '/generated/unopened.p8', APPLE_API_KEY_ID: 'GENERATED1', APPLE_API_ISSUER: 'generated-issuer' },
    { APPLE_KEYCHAIN_PROFILE: 'generated-profile' },
  ];
  for (const auth of methods) {
    const config = packageSigning({ ...production, ...auth }, 'darwin');
    expect(config.mac.notarize).toBe(true); expect(config.forceCodeSigning).toBe(true);
    for (const value of Object.values(auth)) if (value !== 'ABCDEFGHIJ') expect(JSON.stringify(config)).not.toContain(value);
  }
});


test('the actual package entrypoint registers the awaited helper hook', async () => {
  const result = await packageAttempt({});
  expect(result.code).toBe(0);
  expect(result.built.hasNativeHelperHook).toBe(true);
});
