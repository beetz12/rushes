// Fetch the same pinned MIT action already used by the workflows, without changing browser dependencies.
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as crypto from 'node:crypto';
const repository = 'actions/upload-artifact', commit = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'beetz12/rushes') throw new Error('Public shared CI only');
const root = await files.mkdtemp(paths.join(process.env.RUNNER_TEMP, 'rushes-upload-'));
const pins = [
  ['dist/upload/index.js', 'upload.cjs', 5051718, '0165b8a75330f3228f2c7a234b4ff8a107b9139c2b519147f4c8e9fe99b262d8'],
  ['LICENSE', 'LICENSE', 1097, '3e855ffa704114a51628ef8f0bf3aeb41728adf9d9070e263bf58aa5640b0eb5'],
];
const identities = [];
for (const [source, name, size, sha256] of pins) {
  const url = `https://raw.githubusercontent.com/${repository}/${commit}/${source}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Pinned CI tool download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== size || crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Pinned CI tool bytes differ');
  await files.writeFile(paths.join(root, name), bytes, { flag: 'wx', mode: 0o600 });
  identities.push({ source: url, name, bytes: size, sha256 });
}
await files.writeFile(paths.join(root, 'tool.json'), JSON.stringify({ repository, commit, identities, node: process.version,
  scope: 'Byte-pristine compiled action and license; actual upload compatibility remains a provider check' }, null, 2), { flag: 'wx' });
await files.appendFile(process.env.GITHUB_ENV, `RUSHES_UPLOAD_ACTION_SCRIPT=${paths.join(root, 'upload.cjs')}\nRUSHES_UPLOAD_TOOL_RECEIPT=${paths.join(root, 'tool.json')}\n`);
