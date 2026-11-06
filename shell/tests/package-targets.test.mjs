import { test, expect } from 'vitest';
import { packageSigning } from '../scripts/package-signing.mjs';
import { packageTargets, installerTargets } from '../scripts/package-targets.mjs';

const developerId = 'Developer ID Application: Generated Packaging Test (ABCDEFGHIJ)';
const development = 'Apple Development: Generated Local Test (ABCDEFGHIJ)';
const production = { RUSHES_SIGN_TYPE: 'distribution', RUSHES_SIGN_IDENTITY: developerId, RUSHES_NOTARIZE: '1', APPLE_KEYCHAIN_PROFILE: 'generated-profile' };

test('installers are a dmg and a zip alongside the unpacked app', () => {
  expect(installerTargets).toEqual(['dir', 'dmg', 'zip']);
  expect(Object.isFrozen(installerTargets)).toBe(true);
});
test('only the complete notarized production selection gets an unlabeled artifact name', () => {
  const selection = packageTargets(packageSigning(production, 'darwin'));
  expect(selection.notarized).toBe(true); expect(selection.label).toBe('notarized');
  expect(selection.mac).toEqual({ identity: 'Generated Packaging Test (ABCDEFGHIJ)', type: 'distribution', notarize: true, hardenedRuntime: true,
    artifactName: '${productName}-${version}-${arch}.${ext}' });
});
test('a development identity keeps its signing and is named not notarized', () => {
  for (const environment of [{ RUSHES_SIGN_IDENTITY: development }, { RUSHES_SIGN_IDENTITY: development, RUSHES_NOTARIZE: '0' }]) {
    const selection = packageTargets(packageSigning(environment, 'darwin'), environment);
    expect(selection.notarized).toBe(false); expect(selection.label).toBe('dev-signed-not-notarized');
    expect(selection.mac).toEqual({ identity: development, type: 'development', notarize: false,
      artifactName: '${productName}-${version}-${arch}-dev-signed-not-notarized.${ext}' });
  }
});
test('CSC_NAME counts as a named development identity and is left to the packager', () => {
  const selection = packageTargets(packageSigning({}, 'darwin'), { CSC_NAME: 'Generated Local Test' });
  expect(selection.label).toBe('dev-signed-not-notarized'); expect(selection.mac.identity).toBeUndefined();
});
test('no identity is an ad hoc unsigned preview, never keychain auto-discovery', () => {
  for (const environment of [{}, { CSC_NAME: '  ' }]) {
    const selection = packageTargets(packageSigning(environment, 'darwin'), environment);
    expect(selection.notarized).toBe(false); expect(selection.label).toBe('unsigned-preview');
    expect(selection.mac).toEqual({ identity: '-', hardenedRuntime: false, artifactName: '${productName}-${version}-${arch}-unsigned-preview.${ext}' });
  }
});
test('a selection that is not forced and notarized is never labeled notarized', () => {
  for (const signing of [{ mac: { identity: developerId, notarize: true } }, { forceCodeSigning: true, mac: { identity: developerId, notarize: false } }])
    expect(packageTargets(signing).notarized).toBe(false);
});
