import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as testFiles from 'node:fs/promises';
import * as testPaths from 'node:path';
import { tmpdir } from 'node:os';
import { configureWindowsChromeAccess, requirePayloadRules, sandboxPrincipals, sandboxReadExecuteMask } from './windows-chrome-access.mjs';

async function ownedPayload(context) {
  const parent = await testFiles.mkdtemp(testPaths.join(tmpdir(), "rushes-acl's-"));
  context.after(() => testFiles.rm(parent, { recursive: true, force: true }));
  const root = testPaths.join(parent, 'chrome-win64'); await testFiles.mkdir(root);
  for (const name of ['chrome.exe', 'chrome.dll']) await testFiles.writeFile(testPaths.join(root, name), 'generated payload');
  return { parent, root, paths: [root, ...['chrome.exe', 'chrome.dll'].map(name => testPaths.join(root, name))] };
}
const readableRows = paths => paths.map(path => ({ path, rules: sandboxPrincipals.map(sid => ({ sid,
  allow: true, accessMask: sandboxReadExecuteMask, inherits: true, appliesHere: true, propagates: true })) }));

test('actual installer helper grants only payload RX to both sandbox principals and requires read-back', async context => {
  const { root, paths } = await ownedPayload(context), calls = []; let reads = 0;
  const result = await configureWindowsChromeAccess(root, async (command, args) => {
    calls.push({ command, args });
    return { stdout: command === 'powershell.exe' ? JSON.stringify(++reads === 1
      ? paths.map(path => ({ path, rules: [] })) : readableRows(paths)) : '' };
  });
  assert.deepEqual(calls.slice(1, 3), sandboxPrincipals.map(sid => ({ command: 'icacls.exe', args: [root, '/grant', `*${sid}:(OI)(CI)(RX)`] })));
  assert.equal(calls[0].command, 'powershell.exe'); assert.equal(calls[3].command, 'powershell.exe');
  assert.ok(calls[0].args.at(-1).includes("rushes-acl''s-"));
  assert.equal(result.requestedReadExecuteRulesVerified, true);
  assert.deepEqual(result.checkedPaths, paths);
  assert.match(result.effectiveSandboxChild, /real sandboxed browser qualification/);
  const receipt = JSON.parse(await testFiles.readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.state, 'requested-rules-verified');
  assert.deepEqual(receipt.before, paths.map(path => ({ path, rules: [] })));
  assert.deepEqual(receipt.after, readableRows(paths));
});
test('successful grant commands cannot hide missing, denied or noninheriting payload ACLs', async context => {
  for (const change of [
    rows => rows.pop(),
    rows => rows[1].rules.pop(),
    rows => { rows[2].rules[0].accessMask = 0x200a9; },
    rows => { rows[0].rules[0].inherits = false; },
    rows => { rows[0].rules[0].propagates = false; },
    rows => { rows[0].rules[0].appliesHere = false; },
    rows => rows[1].rules.push({ ...rows[1].rules[0], allow: false }),
    rows => rows[1].rules.push({ ...rows[1].rules[0], allow: false, accessMask: 0x100000 }),
    rows => { delete rows[2].rules[0].accessMask; },
  ]) {
    const { root, paths } = await ownedPayload(context);
    const rows = readableRows(paths); change(rows); let reads = 0, grants = 0;
    await assert.rejects(configureWindowsChromeAccess(root, async command => {
      if (command === 'icacls.exe') { grants++; return { stdout: '' }; }
      return { stdout: JSON.stringify(++reads === 1 ? readableRows(paths) : rows) };
    }), /Chrome|ACL/);
    assert.equal(grants, 2);
  }
});
test('a failed grant never reaches read-back or reports a configured sandbox', async context => {
  const { root, paths } = await ownedPayload(context), calls = [];
  await assert.rejects(configureWindowsChromeAccess(root, async command => {
    calls.push(command); if (command === 'powershell.exe') return { stdout: JSON.stringify(readableRows(paths)) };
    throw new Error('icacls denied');
  }), /icacls denied/);
  assert.deepEqual(calls, ['powershell.exe', 'icacls.exe']);
  const receipt = JSON.parse(await testFiles.readFile(testPaths.join(testPaths.dirname(root), 'windows-sandbox-access.json'), 'utf8'));
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.phase, 'grant S-1-15-2-1');
});
test('a bundle junction is refused before any permission tool executes', async context => {
  const { parent, root } = await ownedPayload(context);
  const container = testPaths.join(parent, 'linked'); await testFiles.mkdir(container);
  const linked = testPaths.join(container, 'chrome-win64'); await testFiles.symlink(root, linked, 'junction');
  let calls = 0;
  await assert.rejects(configureWindowsChromeAccess(linked, async () => { calls++; }), /ordinary owned payload/);
  assert.equal(calls, 0);
});
test('duplicate or unrelated ACL rows cannot satisfy a payload read-back', () => {
  const paths = ['owned/chrome-win64', 'owned/chrome-win64/chrome.exe', 'owned/chrome-win64/chrome.dll'];
  const rows = readableRows(paths); rows[2] = rows[1];
  assert.throws(() => requirePayloadRules(rows, paths), /Missing Chrome payload ACL/);
});
test('an existing receipt is preserved before any ACL tool is called', async context => {
  const { parent, root } = await ownedPayload(context), path = testPaths.join(parent, 'windows-sandbox-access.json');
  await testFiles.writeFile(path, 'existing owned data'); let calls = 0;
  await assert.rejects(configureWindowsChromeAccess(root, async () => { calls++; }), { code: 'EEXIST' });
  assert.equal(calls, 0); assert.equal(await testFiles.readFile(path, 'utf8'), 'existing owned data');
});
