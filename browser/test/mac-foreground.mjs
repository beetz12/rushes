// Generated Mac source-only diagnostic. Importing this file never inspects or
// activates an app. Existing matrix source/PCM predicates remain authoritative.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { withoutCredentials } from './matrix-checkpoint-action.mjs';
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

export function macForegroundConfiguration(environment, platform = process.platform) {
  const mode = environment.RUSHES_M1_MAC_FOREGROUND, helperManifest = environment.RUSHES_M1_MAC_FOREGROUND_HELPER;
  const allowed = ['RUSHES_M1_MAC_FOREGROUND', 'RUSHES_M1_MAC_FOREGROUND_HELPER'];
  assert.ok(Object.keys(environment).filter(key => key.startsWith('RUSHES_M1_MAC_FOREGROUND')).every(key => allowed.includes(key)), 'Unknown Mac foreground option');
  if (mode === undefined && helperManifest === undefined) return null;
  assert.ok(['baseline', 'foreground'].includes(mode), 'Mac foreground mode must be baseline or foreground');
  assert.ok(typeof helperManifest === 'string' && isAbsolute(helperManifest), 'Mac foreground requires an absolute helper manifest');
  assert.equal(platform, 'darwin', 'Mac foreground control requires Mac');
  const required = { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_NATIVE_SOURCE_ONLY: '1',
    RUSHES_M1_SOURCE_AUDIO_SINK: 'default', RUSHES_M1_BROWSER_MODE: 'headful', RUSHES_M1_VIDEO_BUFFER: 'cpu' };
  for (const [key, value] of Object.entries(required)) assert.equal(environment[key], value, `Mac foreground requires ${key}=${value}`);
  assert.equal(environment.RUSHES_M1_SOURCE_AUDIO_FRAMES ?? '128', '128', 'Mac foreground requires128');
  for (const key of ['LONG', 'REFERENCE', 'DIAGNOSTIC', 'ALLOCATION_DIAGNOSTIC', 'SOURCE_CONTROL',
    'NATIVE_TRACE_PROOF', 'SOURCE_AUDIO_TRACE_PROOF', 'SOURCE_VIDEO_TRACE_PROOF', 'SOURCE_TASK_TRACE_PROOF',
    'SOURCE_TASK_TRACE_WINDOW_MS', 'DURABLE_CHECKPOINT', 'NATIVE_ENCODER_CONTROL'])
    assert.equal(environment[`RUSHES_M1_${key}`], undefined, 'Mac foreground requires untraced source-only8s');
  return { mode, helperManifest };
}

export async function readMacHelper(file, checked = operation => operation(), files = { readFile }) {
  const manifest = JSON.parse(await checked(() => files.readFile(file, 'utf8')));
  assert.equal(manifest.schema, 'rushes.mac-application-helper/1');
  assert.equal(manifest.build.actualExitCode, 0); assert.equal(manifest.build.signal, null);
  assert.equal(manifest.build.retirementConfirmed, true);
  assert.equal(manifest.negativeControlsPassed, true);
  assert.equal(manifest.sourceSHA256, hash(await checked(() => files.readFile(new URL('./OwnedMacApplication.swift', import.meta.url)))));
  assert.ok(isAbsolute(manifest.executable) && /^[a-f0-9]{64}$/.test(manifest.sha256));
  assert.equal(hash(await checked(() => files.readFile(manifest.executable))), manifest.sha256);
  return manifest;
}

export function parseBirth(stdout, pid, parentPID) {
  const lines = stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, 'Expected one owned process row');
  const match = lines[0].match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
  assert.ok(match, 'Unavailable owned PID/PPID/lstart');
  assert.ok(Number.isFinite(Date.parse(match[3] + ' GMT')), 'Unavailable process start date');
  assert.equal(Number(match[1]), pid); assert.equal(Number(match[2]), parentPID);
  return { pid, parentPID, startText: match[3].replace(/\s+/g, ' '),
    basis: 'ps lstart %c with LC_ALL=C,TZ=UTC; one-second display resolution', raw: stdout };
}
function live(child, owner) {
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 1, 'Expected a positive owned child PID');
  assert.equal(owner.parentPID, process.pid, 'Owner must be this direct spawning Node process');
  assert.equal(child.pid, owner.pid); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
}
function matchingBirth(a, b) {
  assert.equal(a.pid, b.pid); assert.equal(a.parentPID, b.parentPID); assert.equal(a.startText, b.startText);
}
function application(stdout, owner, executable, mode, expiresAt) {
  const value = JSON.parse(stdout);
  assert.equal(value.schema, 'rushes.owned-mac-application-control/1');
  assert.equal(value.deadlineUnixMs, expiresAt);
  assert.equal(value.mode, mode); assert.equal(value.availability, 'available');
  assert.equal(value.identityMatched, true); assert.equal(value.ownedPID, owner.pid);
  assert.equal(value.ownedExecutable, executable);
  for (const field of ['isActive', 'isHidden']) assert.equal(typeof value[field], 'boolean');
  assert.ok(Number.isInteger(value.activationPolicyRaw));
  assert.ok(value.launchDate === null || typeof value.launchDate === 'string');
  return value;
}

// owner is the actual existing launch descriptor; never discover a process by
// app name. Caller must retain this entire receipt even when admitted is false.
export async function ownedForegroundBeforeMedia({ mode, child, owner, pinnedExecutable,
  pinnedExecutableSHA256, pinnedProfile, helperManifest, persist, geometry, expiresAt,
  platform = process.platform, environment = process.env, run = execute, now = Date.now,
  files = { readFile, realpath } }) {
  const receipt = { schema: 'rushes.pre-media-foreground-control/1', mode,
    startedAt: new Date().toISOString(), expiresAt, admitted: false, powered: false, commands: [] };
  assert.equal(typeof persist, 'function');
  const remaining = () => {
    live(child, owner);
    const value = expiresAt - now();
    assert.ok(Number.isFinite(expiresAt) && value >= 1 && value <= 20000, 'Mac foreground absolute deadline expired or invalid');
    return Math.floor(value);
  };
  const checked = async operation => { remaining(); const value = await operation(); remaining(); return value; };
  const childEnvironment = withoutCredentials(environment);
  const call = async (command, args, environment) => {
    const timeout = Math.min(2000, remaining());
    const row = { command, args, startedAt: new Date().toISOString() }; receipt.commands.push(row);
    let commandChild;
    try {
      const operation = run(command, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 8192,
        env: environment ?? childEnvironment });
      commandChild = operation.child; row.pid = commandChild?.pid ?? null;
      const result = await operation;
      row.stdout = result.stdout;
      row.stderrBytes = Buffer.byteLength(result.stderr ?? ''); row.stderrSHA256 = hash(result.stderr ?? '');
      assert.ok(commandChild && Number.isSafeInteger(commandChild.pid), 'Command child identity is unavailable');
      row.actualExit = commandChild.exitCode; row.signal = commandChild.signalCode;
      assert.equal(row.actualExit, 0); assert.equal(row.signal, null);
      remaining(); return result.stdout;
    } catch (error) {
      row.actualExit = commandChild?.exitCode ?? null; row.signal = commandChild?.signalCode ?? null;
      row.commandErrorCode = error.code ?? null; row.killed = error.killed ?? false;
      row.stdout = error.stdout ?? row.stdout ?? '';
      if (error.stderr !== undefined) {
        row.stderrBytes = Buffer.byteLength(error.stderr); row.stderrSHA256 = hash(error.stderr);
      } else { row.stderrBytes ??= 0; row.stderrSHA256 ??= hash(''); }
      throw error;
    } finally { row.endedAt = new Date().toISOString(); live(child, owner); }
  };
  try {
    await checked(() => persist(receipt));
    assert.equal(platform, 'darwin'); assert.ok(['baseline', 'foreground'].includes(mode));
    live(child, owner);
    const build = await checked(() => readMacHelper(helperManifest, checked, files)); receipt.build = build;
    const executable = await checked(() => files.realpath(pinnedExecutable)), helperPath = await checked(() => files.realpath(build.executable));
    const helperSHA256 = build.sha256;
    assert.equal(await checked(() => files.realpath(owner.executable)), executable);
    assert.equal(await checked(() => files.realpath(owner.profile)), await checked(() => files.realpath(pinnedProfile)));
    assert.equal(hash(await checked(() => files.readFile(executable))), pinnedExecutableSHA256);
    assert.equal(hash(await checked(() => files.readFile(helperPath))), helperSHA256);
    const birth = async () => parseBirth(await call('/bin/ps', ['-p', String(owner.pid), '-o', 'pid=,ppid=,lstart='],
      { ...childEnvironment, LC_ALL: 'C', TZ: 'UTC' }), owner.pid, owner.parentPID);
    const firstBirth = await checked(birth);
    const before = application(await call(helperPath, ['observe', String(owner.pid), executable, '-', String(expiresAt)]), owner, executable, 'observe', expiresAt);
    matchingBirth(firstBirth, await checked(birth)); receipt.before = before; receipt.birth = firstBirth;
    assert.equal(before.isActive, false, 'Already-active baseline cannot power an inactive-to-active contrast');
    assert.equal(before.activationPolicyRaw, 0, 'Only an actual regular-policy CFT may enter this control');
    assert.equal(typeof geometry, 'function'); receipt.geometryBefore = await checked(geometry);
    if (mode === 'baseline') {
      receipt.geometryAfter = await checked(geometry); assert.deepEqual(receipt.geometryAfter, receipt.geometryBefore);
      receipt.admitted = true; receipt.baselineInactive = true; return receipt;
    }
    const request = application(await call(helperPath,
      ['activate', String(owner.pid), executable, before.launchDate ?? '-', String(expiresAt)]), owner, executable, 'activate', expiresAt);
    receipt.request = request; matchingBirth(firstBirth, await checked(birth));
    assert.equal(request.isActive, false); assert.equal(request.activationPolicyRaw, 0);
    assert.equal(request.activationAttempted, true);
    const after = application(await call(helperPath, ['observe', String(owner.pid), executable, '-', String(expiresAt)]), owner, executable, 'observe', expiresAt);
    receipt.after = after; matchingBirth(firstBirth, await checked(birth)); live(child, owner);
    assert.equal(request.requestAccepted, true);
    assert.equal(after.isActive, true, 'Activation did not produce measured active=true; no retry');
    assert.equal(after.activationPolicyRaw, 0);
    if (before.launchDate !== null && after.launchDate !== null) assert.equal(after.launchDate, before.launchDate);
    receipt.geometryAfter = await checked(geometry); assert.deepEqual(receipt.geometryAfter, receipt.geometryBefore);
    assert.equal(hash(await checked(() => files.readFile(executable))), pinnedExecutableSHA256);
    receipt.admitted = true; receipt.powered = true; return receipt;
  } catch (error) {
    // The original helper output/actual exit is retained above; no false/empty
    // state is invented, and the caller must not initialize any media.
    receipt.reason = String(error.message ?? error); return receipt;
  } finally {
    receipt.endedAt = new Date().toISOString();
    try { await checked(() => persist(receipt)); }
    catch (error) {
      receipt.admitted = false; receipt.powered = false; receipt.reason = String(error.message ?? error);
      // Reporting may finish late, but this terminal branch has no commands or activation.
      await persist(receipt);
    }
  }
}
