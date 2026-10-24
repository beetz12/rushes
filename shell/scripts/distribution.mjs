import * as releaseDisk from 'node:fs/promises';
import * as releaseStreams from 'node:fs';
import * as releaseDigests from 'node:crypto';
import * as releasePaths from 'node:path';
import { packageSigning } from './package-signing.mjs';
import { ARTIFACT_BYTES, publicReleaseURL, releaseArtifact, releaseVersion, validateRelease } from './release-policy.mjs';

export function distributionPlan(environment, version, platform = process.platform) {
  const signing = packageSigning(environment, platform);
  releaseVersion(version);
  const production = signing.forceCodeSigning === true;
  if (!production && (environment.RUSHES_SIGN_TYPE !== 'development' || !environment.RUSHES_SIGN_IDENTITY?.trim()))
    throw new Error('Select an explicit development signing identity and RUSHES_SIGN_TYPE=development.');
  if (!production && environment.RUSHES_SIGN_IDENTITY !== '-' && !environment.RUSHES_SIGN_IDENTITY.startsWith('Apple Development: '))
    throw new Error('Development packaging requires an explicit Apple Development identity or ad-hoc choice.');
  const feedURL = production ? publicReleaseURL(environment.RUSHES_UPDATE_URL) : undefined;
  return {
    version, production, targets: ['dmg', 'zip'],
    policy: { schema: 'rushes.mac-updates/1', enabled: production, ...(feedURL ? { feedURL } : {}) },
    config: { ...signing, artifactName: 'Rushes-${version}-${arch}.${ext}',
      electronUpdaterCompatibility: '>=2.16',
      publish: feedURL ? [{ provider: 'generic', url: feedURL, channel: 'latest' }] : [] },
  };
}
export async function writePackagedUpdatePolicy(context, plan) {
  if (context.packager.info.cancellationToken.cancelled) throw new Error('Update policy packaging was cancelled.');
  if (context.packager.appInfo.version !== plan.version) throw new Error('Packaged update version differs from the selected release.');
  const folder = releasePaths.join(context.appOutDir, 'Rushes.app', 'Contents', 'Resources');
  await releaseDisk.writeFile(releasePaths.join(folder, 'RushesUpdates.json'), JSON.stringify(plan.policy) + '\n', { flag: 'wx' });
  if (context.packager.info.cancellationToken.cancelled) throw new Error('Update policy packaging was cancelled.');
}
export async function collectDistribution(artifacts, plan) {
  if (!Array.isArray(artifacts)) throw new Error('Packager did not return release artifacts.');
  const files = [], directories = new Set();
  for (const extension of ['zip', 'dmg']) {
    const name = releaseArtifact(plan.version, extension);
    const matching = artifacts.filter(file => typeof file === 'string' && releasePaths.basename(file) === name);
    if (matching.length !== 1) throw new Error(`Packager did not produce exactly one ${extension} artifact.`);
    const file = releasePaths.resolve(matching[0]), details = await releaseDisk.lstat(file);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > ARTIFACT_BYTES)
      throw new Error('Release artifact is missing, linked or outside the size bound.');
    const digest = releaseDigests.createHash('sha512'); let observed = 0;
    for await (const bytes of releaseStreams.createReadStream(file)) {
      observed += bytes.length;
      if (observed > ARTIFACT_BYTES) throw new Error('Release artifact grew beyond the size bound.');
      digest.update(bytes);
    }
    const after = await releaseDisk.lstat(file);
    if (observed !== details.size || after.size !== details.size || after.ino !== details.ino
      || after.mtimeMs !== details.mtimeMs || !after.isFile() || after.isSymbolicLink())
      throw new Error('Release artifact changed while hashing.');
    files.push({ url: name, size: details.size, sha512: digest.digest('base64') });
    directories.add(releasePaths.dirname(file));
  }
  if (directories.size !== 1) throw new Error('Release artifacts must share one output directory.');
  const manifest = validateRelease({ schema: 'rushes.mac-release/1', appId: 'com.nexai.rushes',
    platform: 'darwin', arch: 'arm64', version: plan.version, releaseDate: new Date().toISOString(), files });
  const directory = [...directories][0], name = plan.production ? 'latest-mac.json' : 'development-build.json';
  const destination = releasePaths.join(directory, name);
  const stage = releasePaths.join(directory, '.release-' + releaseDigests.randomUUID() + '.json');
  try {
    await releaseDisk.writeFile(stage, JSON.stringify(plan.production ? manifest
      : { schema: 'rushes.development-build/1', updatesEnabled: false, version: plan.version, files }, null, 2) + '\n', { flag: 'wx' });
    await releaseDisk.rename(stage, destination);
  } finally { await releaseDisk.rm(stage, { force: true }); }
  return { manifestPath: destination, artifacts: files, distributionType: plan.production ? 'distribution' : 'development',
    signatureVerification: 'Separate actual signed-app and notarization verification required', published: false };
}
