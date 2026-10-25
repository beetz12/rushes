// Owner receipt for the generated cold capture control. Every field comes from the
// child process this harness launched; no OS process query or executable-name match.
import { ownedProfile } from '../../verification/browser-retirement.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Flag names only: profile, media and executable paths are never retained.
export function launchArgumentProjection(spawnargs) {
  assert.ok(Array.isArray(spawnargs) && spawnargs.length > 1 && spawnargs.every(value => typeof value === 'string'),
    'Owned browser launch arguments are unavailable');
  const flags = spawnargs.slice(1).map(value => value.startsWith('--') ? value.split('=')[0] : '<positional>');
  return { flags, sha256: createHash('sha256').update(JSON.stringify(flags)).digest('hex') };
}

export async function coldOwnerReceipt(child, browser) {
  const pid = child?.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Owned browser PID is unavailable');
  assert.ok(child.exitCode === null && child.signalCode === null, 'Owned browser exited before its owner receipt');
  const launchArguments = launchArgumentProjection(child.spawnargs);
  const profile = ownedProfile(child.spawnargs.slice(1).join(' '));
  // Cross-check only: CDP must name the same browser process the harness spawned.
  const session = await browser.newBrowserCDPSession();
  let cdpBrowserPids;
  try {
    cdpBrowserPids = (await session.send('SystemInfo.getProcessInfo')).processInfo
      .filter(value => value.type === 'browser').map(value => Number(value.id));
  } finally { await session.detach(); }
  assert.deepEqual(cdpBrowserPids, [pid], 'CDP browser process is not the harness-launched child');
  return { schema: 'rushes.cold-owner/2', ownership: 'harness-launched-child-process', pid, profile,
    chrome: browser.version(), cdpBrowserPid: cdpBrowserPids[0], launchArguments };
}
