// Validate operator intent before the external packager can build or sign anything.
export function packageSigning(environment, platform = process.platform) {
  const type = environment.RUSHES_SIGN_TYPE ?? 'development';
  const notarize = environment.RUSHES_NOTARIZE;
  if (!['development', 'distribution'].includes(type)) throw new Error('Select development or distribution signing.');
  if (notarize !== undefined && !['0', '1'].includes(notarize)) throw new Error('RUSHES_NOTARIZE must be 0 or 1.');
  const identity = environment.RUSHES_SIGN_IDENTITY;
  const production = type === 'distribution' || notarize === '1';
  if (!production) return identity ? { mac: { identity, type: 'development', notarize: false } } : {};
  if (platform !== 'darwin') throw new Error('Production Mac packaging requires macOS.');
  const team = identity?.match(/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/)?.[1];
  if (!team) throw new Error('Production packaging requires an explicit Developer ID Application identity.');
  if (type !== 'distribution' || notarize !== '1') throw new Error('Production packaging requires distribution signing and RUSHES_NOTARIZE=1.');
  if (environment.CI && environment.CI !== 'false' && environment.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('Production CI packaging requires a manually dispatched CI event.');
  if (environment.GITHUB_BASE_REF) throw new Error('Production signing is unavailable in a pull request.');
  if (environment.APPLE_TEAM_ID && environment.APPLE_TEAM_ID !== team)
    throw new Error('The notarization team differs from the selected Developer ID team.');
  // Preserve the pinned builder's authentication precedence; a partial first method cannot fall through.
  const methods = [
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    ['APPLE_KEYCHAIN_PROFILE'],
  ];
  const selected = methods.find(names => names.some(name => environment[name]));
  const required = selected?.includes('APPLE_ID') ? [...selected, 'APPLE_TEAM_ID'] : selected;
  if (!required || required.some(name => !environment[name]?.trim()))
    throw new Error('Complete notarization credentials are required before production packaging.');
  return { forceCodeSigning: true, mac: { identity, type: 'distribution', notarize: true, hardenedRuntime: true } };
}
