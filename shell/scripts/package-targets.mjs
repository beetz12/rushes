// Choose the installer targets and an honest artifact label from an already validated signing selection.
export const installerTargets = Object.freeze(['dir', 'dmg', 'zip']);

export function packageTargets(signing, environment = {}) {
  const notarized = signing.forceCodeSigning === true && signing.mac?.notarize === true;
  const named = Boolean(signing.mac?.identity || environment.CSC_NAME?.trim());
  const label = notarized ? '' : named ? '-dev-signed-not-notarized' : '-unsigned-preview';
  const mac = { artifactName: '${productName}-${version}-${arch}' + label + '.${ext}' };
  // Without a named identity, sign ad hoc rather than let auto-discovery pick an arbitrary keychain identity.
  // An ad hoc seal cannot satisfy library validation under the hardened runtime, so that lane runs without it.
  if (!notarized && !named) Object.assign(mac, { identity: '-', hardenedRuntime: false });
  return { notarized, label: notarized ? 'notarized' : label.slice(1), mac: { ...signing.mac, ...mac } };
}
