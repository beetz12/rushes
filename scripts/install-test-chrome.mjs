// Official Chrome for Testing binaries, isolated from the user's Chrome profile.
import { mkdir, writeFile, appendFile, access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const { values } = parseArgs({ options: { generation: { type: 'string', default: 'current' }, destination: { type: 'string' }, 'plan-only': { type: 'boolean', default: false } }, strict: true });
if (!['current', 'previous'].includes(values.generation)) throw new Error('Generation must be current or previous.');
const platform = process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64' : 'linux64';
const endpoint = 'https://googlechromelabs.github.io/chrome-for-testing/';
async function metadata(name) {
  const response = await fetch(endpoint + name, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Official Chrome metadata HTTP${response.status}.`);
  return response.json();
}
const pins = JSON.parse(await readFile(new URL('../browser/test/chrome-versions.json', import.meta.url), 'utf8'));
const version = pins[values.generation];
if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('A named immutable Chrome version is required.');
const release = (await metadata('known-good-versions-with-downloads.json')).versions.find(item => item.version === version);
const download = release?.downloads?.chrome?.find(item => item.platform === platform);
if (!download) throw new Error(`Official Chrome binary unavailable for ${values.generation}/${platform}.`);
const url = new URL(download.url);
if (url.origin !== 'https://storage.googleapis.com' || !url.pathname.startsWith('/chrome-for-testing-public/') || !/^\d+\.\d+\.\d+\.\d+$/.test(release.version)) throw new Error('Chrome release metadata has an unexpected destination.');
const plan = { generation: values.generation, version: release.version, platform, download: url.href };
if (values['plan-only']) { console.log(JSON.stringify(plan)); process.exit(0); }
if (!values.destination) throw new Error('An isolated destination is required.');
const destination = resolve(values.destination); await mkdir(destination, { recursive: true });
const archive = join(destination, 'chrome.zip');
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
if (!response.ok) throw new Error(`Official Chrome download HTTP${response.status}.`);
const archiveBytes = Buffer.from(await response.arrayBuffer());
const archiveSHA256 = createHash('sha256').update(archiveBytes).digest('hex');
await writeFile(archive, archiveBytes);
const run = promisify(execFile);
if (process.platform === 'win32') {
  // Quoting here is PowerShell syntax; no shell string interpolation of metadata.
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(destination)} -Force`]);
} else await run('/usr/bin/unzip', ['-q', '-o', archive, '-d', destination]);
const executable = join(destination, `chrome-${platform}`, process.platform === 'win32' ? 'chrome.exe' : process.platform === 'darwin' ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' : 'chrome');
await access(executable);
const engine = process.platform === 'darwin'
  ? join(destination, `chrome-${platform}`, 'Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions', release.version, 'Google Chrome for Testing Framework')
  : process.platform === 'win32' ? join(destination, `chrome-${platform}`, 'chrome.dll') : executable;
async function digestFile(path) {
  const digest = createHash('sha256');
  for await (const block of createReadStream(path)) digest.update(block);
  return digest.digest('hex');
}
const payloads = [];
for (const path of [...new Set([executable, engine])]) payloads.push({ path, sha256: await digestFile(path) });
await writeFile(join(destination, 'release.json'), JSON.stringify({ ...plan, archiveSHA256, executable, payloads }, null, 2));
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `RUSHES_CAPTURE_BROWSER_EXECUTABLE=${executable}\nRUSHES_CHROME=${executable}\n`);
console.log(JSON.stringify({ ...plan, executable }));
