import { isIP } from 'node:net';

export const RELEASE_BYTES = 64 * 1024;
export const ARTIFACT_BYTES = 1024 ** 3;
const product = 'com.nexai.rushes';
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, expected) {
  if (!object(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('Invalid release metadata fields.');
}
export function releaseVersion(value) {
  if (typeof value !== 'string') fail('A stable release version is required.');
  const pieces = value.split('.');
  if (pieces.length !== 3 || pieces.some(piece => !/^(?:0|[1-9][0-9]*)$/.test(piece)
    || !Number.isSafeInteger(Number(piece)))) fail('A stable release version is required.');
  return value;
}
export function publicReleaseURL(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('A public HTTPS release feed is required.');
  let url;
  try { url = new URL(value); } catch { fail('A public HTTPS release feed is required.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || host.endsWith('.')
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')
    || ['localhost', 'local', 'localdomain', 'internal', 'test', 'invalid'].some(suffix => host === suffix || host.endsWith('.' + suffix)))
    fail('A public HTTPS release feed is required.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}
export function releaseArtifact(version, extension) {
  releaseVersion(version);
  if (!['dmg', 'zip'].includes(extension)) fail('Unsupported Mac release artifact.');
  return `Rushes-${version}-arm64.${extension}`;
}
export function validateRelease(value) {
  fields(value, ['schema', 'appId', 'platform', 'arch', 'version', 'releaseDate', 'files']);
  if (value.schema !== 'rushes.mac-release/1' || value.appId !== product || value.platform !== 'darwin' || value.arch !== 'arm64')
    fail('Release identity does not match this application.');
  const version = releaseVersion(value.version);
  if (typeof value.releaseDate !== 'string' || !Number.isFinite(Date.parse(value.releaseDate))
    || new Date(value.releaseDate).toISOString() !== value.releaseDate) fail('Invalid release date.');
  if (!Array.isArray(value.files) || value.files.length !== 2) fail('A DMG and ZIP are required.');
  const expected = new Set(['dmg', 'zip']);
  const files = value.files.map(file => {
    fields(file, ['url', 'size', 'sha512']);
    const extension = typeof file.url === 'string' ? file.url.split('.').at(-1) : '';
    if (!expected.delete(extension) || file.url !== releaseArtifact(version, extension)) fail('Invalid release artifact name.');
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > ARTIFACT_BYTES) fail('Invalid release artifact length.');
    if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
      || Buffer.from(file.sha512, 'base64').length !== 64 || Buffer.from(file.sha512, 'base64').toString('base64') !== file.sha512)
      fail('Invalid release artifact digest.');
    return Object.freeze({ url: file.url, size: file.size, sha512: file.sha512 });
  });
  return Object.freeze({ schema: value.schema, appId: product, platform: 'darwin', arch: 'arm64',
    version, releaseDate: value.releaseDate, files: Object.freeze(files) });
}
export function validateUpdatePolicy(value) {
  fields(value, value?.enabled === true ? ['schema', 'enabled', 'feedURL'] : ['schema', 'enabled']);
  if (value.schema !== 'rushes.mac-updates/1' || typeof value.enabled !== 'boolean') fail('Invalid update policy.');
  return value.enabled ? Object.freeze({ schema: value.schema, enabled: true, feedURL: publicReleaseURL(value.feedURL) })
    : Object.freeze({ schema: value.schema, enabled: false });
}
