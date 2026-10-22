import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Mac metadata only. Unit tests inject generated command output, never live devices.
export async function macHostState({ platform = process.platform, execute = run } = {}) {
  const sample = { startedAt: new Date().toISOString(), platform };
  if (platform !== 'darwin') return { ...sample, availability: 'unsupported', reason: 'Mac host evidence only' };
  const commands = [ ['console', 'ioreg', ['-n', 'Root', '-d1']], ['idle', 'ioreg', ['-c', 'IOHIDSystem']],
    ['display', 'ioreg', ['-r', '-n', 'IODisplayWrangler', '-d1']], ['assertions', 'pmset', ['-g', 'assertions']],
    ['framebuffer', 'pmset', ['-g', 'powerstate', 'IOMobileFramebufferShim']] ];
  const results = await Promise.all(commands.map(async ([name, command, args]) => {
    try { return { name, output: (await execute(command, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout }; }
    catch (error) { return { name, error: String(error) }; }
  }));
  const named = Object.fromEntries(results.map(result => [result.name, result]));
  const lock = named.console.output?.match(/"IOConsoleLocked"\s*=\s*(Yes|No)/)?.[1];
  sample.IOConsoleLocked = lock === 'Yes' ? true : lock === 'No' ? false : null;
  sample.hidIdleSeconds = named.idle.output?.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
  sample.hidIdleSeconds = sample.hidIdleSeconds === undefined ? null : Number(sample.hidIdleSeconds) / 1e9;
  const power = named.display.output?.match(/"CurrentPowerState"\s*=\s*(\d+)/)?.[1];
  sample.displayCurrentPowerState = power === undefined ? null : Number(power);
  sample.framebufferPowerStates = named.framebuffer.output?.split('\n').flatMap(line => {
    const match = line.trim().match(/^(IOMobileFramebufferShim)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ driver: match[1], current: Number(match[2]), max: Number(match[3]), description: match[4] }] : [];
  }) ?? null;
  sample.powerAssertions = Object.fromEntries(['UserIsActive', 'PreventUserIdleDisplaySleep', 'InternalPreventDisplaySleep']
    .map(name => [name, named.assertions.output?.match(new RegExp(`^\\s*${name}\\s+(\\d+)`, 'm'))?.[1] ?? null]));
  sample.errors = results.filter(result => result.error).map(({ name, error }) => ({ name, error }));
  sample.availability = lock ? 'available' : 'partial'; sample.endedAt = new Date().toISOString();
  return sample;
}
export function isVerifiedUnlockedMac(sample) {
  return sample?.platform === 'darwin' && sample.availability === 'available' && sample.IOConsoleLocked === false;
}
export function assertUnlockedMac(sample, stage) {
  if (!isVerifiedUnlockedMac(sample)) throw new Error(`Mac unlocked prerequisite lost or unverified at ${stage}: ${JSON.stringify(sample)}`);
}

// This independent control loop continues through pauses, offline actions and
// recovery sleeps. It consumes no media and does not change browser scheduling.
export function monitorMacLock({ read, onSample, onLoss, intervalMs = 2000, wait = sleep, now = Date.now }) {
  let active = true, loss, failure;
  const done = (async () => {
    while (active) {
      const started = now();
      const startedAt = new Date().toISOString();
      let sample;
      try { sample = await read(); }
      catch (error) { sample = { platform: 'darwin', availability: 'error', IOConsoleLocked: null, startedAt,
        endedAt: new Date().toISOString(), message: String(error) }; }
      await onSample(sample);
      if (!isVerifiedUnlockedMac(sample)) { loss = sample; await onLoss(sample); break; }
      if (active) await wait(Math.max(1, intervalMs - (now() - started)));
    }
  })().catch(error => { failure = error; });
  return {
    done,
    assert() { if (failure) throw failure; if (loss) assertUnlockedMac(loss, 'continuous lock monitor'); },
    async stop() { active = false; await done; if (failure) throw failure; }
  };
}
