// Shared recorder tests only. Private provider seam remains in the full private suite.
import { readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { list: { type: 'boolean', default: false } }, strict: true });
for (const member of ['../browser-worker', '../browser/test/ui-service.test.mjs']) {
  const location = new URL(member, import.meta.url);
  const present = await lstat(location).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (present) throw new Error(`Private hosted-service source is outside the shared recorder tree: ${member}`);
}
const directory = new URL('../browser/test/', import.meta.url);
const privateSeams = new Set(['ui-service.test.mjs']);
const names = (await readdir(directory)).filter(name => name.endsWith('.test.mjs') && !privateSeams.has(name)).sort();
if (!names.length) throw new Error('No shared recorder tests found');
const files = names.map(name => fileURLToPath(new URL(name, directory)));
if (values.list) console.log(JSON.stringify({ scope: 'shared recorder subset; private provider seam remains mandatory separately', files, privateSeams: [...privateSeams] }));
else {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
