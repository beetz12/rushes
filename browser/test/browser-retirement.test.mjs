import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedProfile, psRows, requireRetired } from '../../verification/browser-retirement.mjs';

const owner = { pid: 42, profile: '/owned/profile-one' };
const self = { pid: 7, name: 'node', command: 'node verification/browser-retirement.mjs' };
test('retirement requires an independently observed process inventory positive control', () => {
  assert.throws(() => requireRetired([], owner, 7), /positive control/);
  assert.deepEqual(requireRetired([self], owner, 7), { processAbsent: true, profileAbsent: true, positiveControl: 7 });
});
test('a live owned PID or a helper holding its profile cannot pass retirement', () => {
  assert.throws(() => requireRetired([self, { pid: 42, command: 'chrome' }], owner, 7), /still present/);
  assert.throws(() => requireRetired([self, { pid: 43, command: 'helper --database=/owned/profile-one/Crashpad' }], owner, 7), /still in use/);
  assert.throws(() => requireRetired([self, { pid: 43, name: 'chrome.exe', command: null }], owner, 7), /could not be inspected/);
  for (const command of ['', '   ', '[chrome.exe]', '(Google Chrome)', '[Google Chrome] (Google Chrome)'])
    assert.throws(() => requireRetired([self, { pid: 43, name: 'chrome.exe', command }], owner, 7), /could not be inspected/);
});
test('owned profile extraction preserves spaces and Windows argument quoting', () => {
  for (const [command, profile] of [
    ['chrome --user-data-dir=/var/folders/one/playwright_chromiumdev_profile-a1 --flag', '/var/folders/one/playwright_chromiumdev_profile-a1'],
    ['chrome --user-data-dir=/tmp/with space/playwright_chromiumdev_profile-a1 --flag', '/tmp/with space/playwright_chromiumdev_profile-a1'],
    ['chrome --user-data-dir="C:\\Users\\Runner Admin\\Temp\\playwright_chromiumdev_profile-a1" --flag', 'C:\\Users\\Runner Admin\\Temp\\playwright_chromiumdev_profile-a1'],
    ['chrome "--user-data-dir=C:\\Users\\Runner Admin\\Temp\\playwright_chromiumdev_profile-a1" --flag', 'C:\\Users\\Runner Admin\\Temp\\playwright_chromiumdev_profile-a1'],
  ]) assert.equal(ownedProfile(command), profile);
  for (const command of [null, '', '[chrome]', 'chrome --user-data-dir=/other/profile',
    'chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-one --user-data-dir=/tmp/playwright_chromiumdev_profile-two'])
    assert.throws(() => ownedProfile(command));
});
test('Windows profile matching is case-insensitive and unrelated system rows are permitted', () => {
  assert.throws(() => requireRetired([self, { pid: 43, command: 'Chrome --user-data-dir=C:\\OWNED\\PROFILE' }],
    { pid: 42, profile: 'c:\\owned\\profile' }, 7), /still in use/);
  assert.equal(requireRetired([self, { pid: 0, name: 'System', command: null }], owner, 7).profileAbsent, true);
});
test('Mac process parsing preserves the complete args field including fallback names with spaces', () => {
  const rows = psRows(' 7 node verification/browser-retirement.mjs\n 43 [Google Chrome] (Google Chrome)\n');
  assert.equal(rows[1].command, '[Google Chrome] (Google Chrome)');
  assert.throws(() => requireRetired(rows, owner, 7), /could not be inspected/);
  assert.throws(() => requireRetired(psRows('7 node check\n43 /Applications/Google Chrome --user-data-dir=/owned/profile-one'), owner, 7), /still in use/);
});

test('refusal retains the failing inventory state and predicate without exempting an opaque process', async () => {
  const { statefulPsRows } = await import('../../verification/browser-retirement.mjs');
  for (const state of ['Z', 'S']) {
    const rows = statefulPsRows(`7 ${state} independent-check\n43 ${state} (Google Chrome)`);
    assert.throws(() => requireRetired(rows, owner, 7), error => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.equal(error.retirementEvidence.blockedRow.pid, 43);
      assert.equal(error.retirementEvidence.blockedRow.state, state);
      assert.equal(error.retirementEvidence.blockedRow.opaqueCommandShape, 'bracketed');
      assert.equal(error.retirementEvidence.positiveControlSeen, true);
      return true;
    });
  }
  assert.throws(() => statefulPsRows('malformed'), /Malformed/);
});
test('retirement diagnostics never serialize credential-like process names or bracketed arguments', () => {
  assert.throws(() => requireRetired([self, { pid: 43, state: 'S',
    name: 'Chrome --token=private', command: '[Chrome --token=private]' }], owner, 7), error => {
    assert.equal(error.retirementEvidence.blockedRow.chromeDetected, true);
    const serialized = JSON.stringify(error) + String(error.stack);
    assert.equal(serialized.includes('--token'), false); assert.equal(serialized.includes('private'), false);
    assert.match(error.retirementEvidence.blockedRow.commandSHA256, /^[a-f0-9]{64}$/);
    return true;
  });
});
