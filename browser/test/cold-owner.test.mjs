import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldOwnerReceipt, launchArgumentProjection } from './cold-owner.mjs';

const profile = '/tmp/playwright_chromiumdev_profile-AbC123';
const child = (change = {}) => ({ pid: 4242, exitCode: null, signalCode: null,
  spawnargs: ['/opt/chrome', '--headless', `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'], ...change });
const browser = (processInfo = [{ type: 'browser', id: 4242 }, { type: 'renderer', id: 4243 }]) => {
  const calls = [];
  return { calls, version: () => '155.0.0.0',
    async newBrowserCDPSession() {
      return { async send(method) { calls.push(method); return { processInfo }; }, async detach() { calls.push('detach'); } };
    } };
};

test('owner receipt uses the spawned child PID and its actual isolated profile', async () => {
  const cdp = browser(), receipt = await coldOwnerReceipt(child(), cdp);
  assert.equal(receipt.pid, 4242); assert.equal(receipt.profile, profile); assert.equal(receipt.cdpBrowserPid, 4242);
  assert.equal(receipt.schema, 'rushes.cold-owner/2'); assert.equal(receipt.ownership, 'harness-launched-child-process');
  assert.deepEqual(receipt.launchArguments.flags, ['--headless', '--user-data-dir', '--remote-debugging-pipe', '<positional>']);
  assert.match(receipt.launchArguments.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(receipt.launchArguments).includes(profile));
  assert.deepEqual(cdp.calls, ['SystemInfo.getProcessInfo', 'detach']);
});

test('owner receipt refuses a CDP browser process other than the spawned child', async () => {
  for (const processInfo of [[{ type: 'browser', id: 9999 }], [], [{ type: 'browser', id: 4242 }, { type: 'browser', id: 9999 }]]) {
    const cdp = browser(processInfo);
    await assert.rejects(coldOwnerReceipt(child(), cdp), /not the harness-launched child/);
    assert.equal(cdp.calls.at(-1), 'detach');
  }
});

test('owner receipt refuses missing, exited or profile-ambiguous children before any CDP query', async () => {
  for (const change of [{ pid: undefined }, { pid: 0 }, { exitCode: 0 }, { signalCode: 'SIGKILL' },
    { spawnargs: ['/opt/chrome', '--headless'] },
    { spawnargs: ['/opt/chrome', `--user-data-dir=${profile}`, `--user-data-dir=${profile}2`] },
    { spawnargs: ['/opt/chrome', '--user-data-dir=/home/person/Chrome Default'] }]) {
    const cdp = browser();
    await assert.rejects(coldOwnerReceipt(child(change), cdp));
    assert.deepEqual(cdp.calls, []);
  }
});

test('launch projection retains flag names only', () => {
  assert.deepEqual(launchArgumentProjection(['/x', '--use-file-for-fake-video-capture=/private/media.mjpeg', '--mute-audio']).flags,
    ['--use-file-for-fake-video-capture', '--mute-audio']);
  assert.throws(() => launchArgumentProjection(['/only-executable']));
  assert.throws(() => launchArgumentProjection(undefined));
});
