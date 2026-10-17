import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macHostState, assertUnlockedMac, monitorMacLock } from './matrix-host-state.mjs';

const unlocked = { platform: 'darwin', availability: 'available', IOConsoleLocked: false };
function generatedCommands(lockOutput, consoleFailure) {
  const calls = [];
  return { calls, execute: async (command, args) => {
    calls.push({ command, args });
    if (args.includes('Root')) {
      if (consoleFailure) throw new Error(consoleFailure);
      return { stdout: lockOutput };
    }
    if (args.includes('IOHIDSystem')) return { stdout: '"HIDIdleTime" = 9000000000' };
    if (args.includes('IODisplayWrangler')) return { stdout: '' };
    if (args.includes('assertions')) return { stdout: '   PreventUserIdleDisplaySleep 1\n' };
    return { stdout: 'IOMobileFramebufferShim 1 1 USEABLE\n' };
  } };
}
test('generated unlocked read permits start, while locked or missing evidence prevents it', async () => {
  for (const [output, mayStart] of [['"IOConsoleLocked" = No', true], ['"IOConsoleLocked" = Yes', false], ['', false]]) {
    const commands = generatedCommands(output);
    const sample = await macHostState({ platform: 'darwin', execute: commands.execute });
    let starts = 0;
    const start = () => { assertUnlockedMac(sample, 'generated pre-start'); starts++; };
    if (mayStart) start(); else assert.throws(start, /prerequisite lost or unverified/);
    assert.equal(starts, mayStart ? 1 : 0);
    assert.equal(commands.calls.length, 5);
    assert.equal(sample.hidIdleSeconds, 9);
    assert.equal(sample.displayCurrentPowerState, null);
  }
});
test('generated command failure preserves unknown lock state and error instead of accepting it', async () => {
  const commands = generatedCommands('', 'generated ioreg failure');
  const sample = await macHostState({ platform: 'darwin', execute: commands.execute });
  assert.equal(sample.IOConsoleLocked, null);
  assert.equal(sample.availability, 'partial');
  assert.match(sample.errors[0].error, /generated ioreg failure/);
  assert.throws(() => assertUnlockedMac(sample, 'generated failed command'));
});
test('continuous monitor requests stop once on locked or missing evidence and fails its gate', async () => {
  for (const bad of [{ ...unlocked, IOConsoleLocked: true }, { platform: 'darwin', availability: 'partial', IOConsoleLocked: null }]) {
    let elapsed = 0, reads = 0, stopRequests = 0;
    const waits = [], samples = [];
    const monitor = monitorMacLock({
      read: async () => { reads++; elapsed += 70; return reads < 3 ? { ...unlocked } : bad; },
      onSample: sample => samples.push(sample), onLoss: () => { stopRequests++; },
      now: () => elapsed, wait: async milliseconds => { waits.push(milliseconds); elapsed += milliseconds; }
    });
    await monitor.done;
    assert.equal(reads, 3); assert.equal(stopRequests, 1); assert.equal(samples.at(-1), bad);
    assert.deepEqual(waits, [1930, 1930]);
    assert.throws(() => monitor.assert(), /continuous lock monitor/);
    await monitor.stop();
  }
});
test('continuous monitor turns a thrown metadata read into a durable loss and stop request', async () => {
  let recorded, stops = 0;
  const monitor = monitorMacLock({ read: async () => { throw new Error('generated read rejection'); },
    onSample: sample => { recorded = sample; }, onLoss: () => { stops++; } });
  await monitor.done;
  assert.equal(stops, 1); assert.equal(recorded.IOConsoleLocked, null);
  assert.match(recorded.message, /generated read rejection/);
  assert.ok(Number.isFinite(Date.parse(recorded.startedAt)) && Number.isFinite(Date.parse(recorded.endedAt)));
  assert.throws(() => monitor.assert()); await monitor.stop();
});
test('healthy continuous monitor shuts down without fabricating a loss or blocking cleanup', async () => {
  let releaseWait, waiting, reads = 0, stops = 0;
  const reachedWait = new Promise(resolve => { waiting = resolve; });
  const monitor = monitorMacLock({ read: async () => { reads++; return { ...unlocked }; },
    onSample: () => {}, onLoss: () => { stops++; }, wait: async () => {
      waiting(); await new Promise(resolve => { releaseWait = resolve; });
    } });
  await reachedWait;
  const stopped = monitor.stop(); releaseWait(); await stopped;
  assert.equal(reads, 1); assert.equal(stops, 0); monitor.assert();
});
test('unsupported platform does not execute Mac commands or invent unlocked evidence', async () => {
  const sample = await macHostState({ platform: 'win32', execute: () => { throw new Error('must not run'); } });
  assert.equal(sample.availability, 'unsupported'); assert.equal(sample.IOConsoleLocked, undefined);
  assert.throws(() => assertUnlockedMac(sample, 'Mac-only prerequisite'));
});
