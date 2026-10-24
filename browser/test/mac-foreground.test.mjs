import test from 'node:test';
import assert from 'node:assert/strict';
import * as fixtureFiles from 'node:fs/promises';
import * as fixtureSystem from 'node:os';
import * as fixturePaths from 'node:path';
import * as fixtureDigests from 'node:crypto';
import { macForegroundConfiguration, ownedForegroundBeforeMedia } from './mac-foreground.mjs';
const digest = value => fixtureDigests.createHash('sha256').update(value).digest('hex');
const valid = { RUSHES_M1_MAC_FOREGROUND: 'baseline', RUSHES_M1_MAC_FOREGROUND_HELPER: '/owned/manifest.json',
  RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_NATIVE_SOURCE_ONLY: '1', RUSHES_M1_SOURCE_AUDIO_SINK: 'default',
  RUSHES_M1_SOURCE_AUDIO_FRAMES: '128', RUSHES_M1_BROWSER_MODE: 'headful', RUSHES_M1_VIDEO_BUFFER: 'cpu' };
test('ordinary configuration stays inert; explicit modes require the exact unloaded Mac source profile', () => {
  assert.equal(macForegroundConfiguration({}, 'win32'), null);
  for (const mode of ['baseline', 'foreground']) assert.equal(macForegroundConfiguration({ ...valid, RUSHES_M1_MAC_FOREGROUND: mode }, 'darwin').mode, mode);
  assert.throws(() => macForegroundConfiguration(valid, 'win32'));
  for (const change of [{ RUSHES_M1_MAC_FOREGROUND: '' }, { RUSHES_M1_MAC_FOREGROUND_HELPER: 'relative' },
    { RUSHES_M1_MAC_FOREGROUND_UNKNOWN: '1' }, { RUSHES_M1_NATIVE_SOURCE_ONLY: undefined },
    { RUSHES_M1_SOURCE_MODE: 'container' }, { RUSHES_M1_SOURCE_AUDIO_SINK: 'none' },
    { RUSHES_M1_SOURCE_AUDIO_FRAMES: '480' }, { RUSHES_M1_BROWSER_MODE: 'headless' }, { RUSHES_M1_VIDEO_BUFFER: 'default' },
    ...['LONG', 'REFERENCE', 'DIAGNOSTIC', 'NATIVE_TRACE_PROOF', 'SOURCE_AUDIO_TRACE_PROOF', 'SOURCE_VIDEO_TRACE_PROOF',
      'SOURCE_TASK_TRACE_PROOF', 'DURABLE_CHECKPOINT', 'NATIVE_ENCODER_CONTROL'].map(name => ({ [`RUSHES_M1_${name}`]: '1' }))])
    assert.throws(() => macForegroundConfiguration({ ...valid, ...change }, 'darwin'));
});

// Every executor below is injected. No process, AppKit, browser or media API is
// invoked. Fixture files contain generated text only; no helper is executable.
async function model(options = {}) {
  const root = await fixtureFiles.realpath(await fixtureFiles.mkdtemp(fixturePaths.join(fixtureSystem.tmpdir(), 'rushes-pure-app-control-')));
  try {
    const executable = fixturePaths.join(root, 'cft-text'), helper = fixturePaths.join(root, 'helper-text'), profile = fixturePaths.join(root, 'profile');
    await fixtureFiles.mkdir(profile); await fixtureFiles.writeFile(executable, 'generated browser placeholder'); await fixtureFiles.writeFile(helper, 'generated helper placeholder');
    const manifest = fixturePaths.join(root, 'manifest.json');
    await fixtureFiles.writeFile(manifest, JSON.stringify({ schema: 'rushes.mac-application-helper/1', executable: helper,
      sha256: options.wrongBinary ? '0'.repeat(64) : digest(await fixtureFiles.readFile(helper)), sourceSHA256: options.wrongSource ? '0'.repeat(64) : digest(await fixtureFiles.readFile(new URL('./OwnedMacApplication.swift', import.meta.url))),
      negativeControlsPassed: true, build: { actualExitCode: 0, signal: null, retirementConfirmed: true } }));
    const child = { pid: 42001, exitCode: null, signalCode: null }, commands = [], receipts = [];
    let observations = 0, births = 0, geometries = 0, persists = 0, clock = 100000;
    const expiresAt = clock + 18000;
    const state = (mode, active) => ({ schema: 'rushes.owned-mac-application-control/1', mode,
      deadlineUnixMs: expiresAt, availability: 'available', identityMatched: true, ownedPID: child.pid, ownedExecutable: options.wrongExecutable ? 'generated-mismatch' : executable,
      isActive: active, isHidden: false, activationPolicyRaw: options.policy ?? 0,
      launchDate: options.dateChanges ? (observations > 1 ? '2026-10-24T12:00:01.000Z' : '2026-10-24T12:00:00.000Z') : null,
      activationAttempted: mode === 'activate', requestAccepted: options.accepted ?? true });
    const run = (command, args, config) => {
      commands.push({ command, args, config });
      let stdout, failure;
      if (command === '/bin/ps') {
        births++; const parent = options.wrongParent ? process.pid + 1 : process.pid;
        stdout = `${child.pid} ${parent} Sat Oct 24 12:00:${options.birthChanges && births > 1 ? '01' : '00'} 2026\n`;
        if (options.malformedBirth) stdout = 'generated unavailable row';
      } else {
        assert.equal(command, helper);
        const mode = args[0];
        stdout = JSON.stringify(state(mode, mode === 'observe' ? (observations++ ? options.afterActive ?? true : options.beforeActive ?? false) : false));
        if (options.unavailable) { stdout = '{"availability":"unavailable","isActive":null}'; failure = 2; }
        if (options.timeout) failure = 'ETIMEDOUT';
        if (options.childEnds) child.exitCode = 0;
        if (options.childDeadlineExpired && mode === 'activate') {
          stdout = JSON.stringify({ ...state(mode, false), availability: 'unpowered', deadlineExpired: true, activationAttempted: false }); failure = 4;
        }
      }
      if (options.expireAfterCommand) clock = expiresAt;
      const operation = failure ? Promise.reject(Object.assign(new Error('generated refusal'), { code: failure, stdout,
        signal: options.timeout ? 'SIGKILL' : null, killed: !!options.timeout })) : Promise.resolve({ stdout, stderr: '' });
      operation.child = { pid: 43000 + commands.length, exitCode: typeof failure === 'number' ? failure : failure ? null : 0,
        signalCode: options.timeout ? 'SIGKILL' : null };
      if (options.unretiredCommand) operation.child.exitCode = null;
      return operation;
    };
    const result = await ownedForegroundBeforeMedia({ mode: options.mode ?? 'foreground', child,
      owner: { pid: child.pid, parentPID: process.pid, executable, profile }, pinnedExecutable: executable,
      pinnedExecutableSHA256: digest(await fixtureFiles.readFile(executable)), pinnedProfile: profile, helperManifest: manifest,
      platform: 'darwin', run, expiresAt, now: () => clock, files: { ...fixtureFiles,
        async readFile(file, ...args) {
          const value = await fixtureFiles.readFile(file, ...args);
          if (options.expireAfterManifest && file === manifest) clock = expiresAt;
          return value;
        } }, environment: { PATH: '/usr/bin:/bin', GH_TOKEN: 'generated-sentinel',
        AWS_ACCESS_KEY_ID: 'generated-sentinel', PRIVATE_KEY: 'generated-sentinel', INPUT_ACTION: 'generated-sentinel' },
      persist: async receipt => {
        receipts.push(structuredClone(receipt)); persists++;
        if (options.expireAfterPersist || (options.expireFinalPersist && persists === 2)) clock = expiresAt;
        else if (options.nearDeadline) clock = expiresAt - 7;
      },
      geometry: async () => {
        if (options.expireBeforeActivation) clock = expiresAt;
        return { width: options.geometryChanges && geometries++ ? 900 : 800, height: 600 };
      } });
    return { result, commands, receipts, activationCalls: commands.filter(c => c.args[0] === 'activate').length };
  } finally { await fixtureFiles.rm(root, { recursive: true }); }
}
test('one measured inactive-to-active request admits; null LaunchServices date uses real birth/parent guards', async () => {
  const r = await model(); assert.equal(r.result.admitted, true); assert.equal(r.result.powered, true); assert.equal(r.activationCalls, 1);
  assert.equal(r.result.before.isActive, false); assert.equal(r.result.after.isActive, true); assert.equal(r.result.before.launchDate, null);
  assert.equal(r.receipts[0].admitted, false); assert.equal(r.receipts.at(-1).admitted, true);
  assert.ok(r.result.commands.every(c => c.actualExit === 0 && c.signal === null && c.pid > 1));
  for (const c of r.commands) for (const name of ['GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'PRIVATE_KEY', 'INPUT_ACTION']) assert.equal(c.config.env[name], undefined);
});
test('inactive baseline performs no activation and makes no intervention claim', async () => {
  const r = await model({ mode: 'baseline' }); assert.equal(r.result.admitted, true); assert.equal(r.result.baselineInactive, true);
  assert.equal(r.result.powered, false); assert.equal(r.activationCalls, 0);
});
for (const options of [{ beforeActive: true }, { policy: 1 }, { policy: 2 }, { wrongParent: true },
  { birthChanges: true }, { malformedBirth: true }, { unavailable: true }, { timeout: true }, { childEnds: true },
  { wrongSource: true }, { wrongBinary: true }, { wrongExecutable: true }, { unretiredCommand: true }])
  test('unpowered/unknown identity refuses before activation: ' + JSON.stringify(options), async () => {
    const r = await model(options); assert.equal(r.result.admitted, false); assert.equal(r.activationCalls, 0);
    assert.equal(r.receipts[0].admitted, false); assert.equal(r.receipts.at(-1).admitted, false);
  });
for (const options of [{ accepted: false }, { afterActive: false }, { geometryChanges: true }, { dateChanges: true }])
  test('one request never retries or bypasses its failed postcondition: ' + JSON.stringify(options), async () => {
    const r = await model(options); assert.equal(r.result.admitted, false); assert.equal(r.result.powered, false); assert.equal(r.activationCalls, 1);
  });
test('matrix hook precedes all source initialization and workflow gates foreground on baseline proof plus retirement', async () => {
  const matrix = await fixtureFiles.readFile(new URL('./matrix.mjs', import.meta.url), 'utf8');
  const launch = matrix.indexOf('async function launch(media)'), hook = matrix.indexOf('if (macForeground)', launch), end = matrix.indexOf('async function killAbruptly', launch);
  assert.ok(matrix.indexOf('await page.goto(', launch) < hook && hook < end);
  assert.ok(matrix.includes("Date.now() >= expiresAt || !receipt.admitted"));
  const source = await fixtureFiles.readFile(new URL('./OwnedMacApplication.swift', import.meta.url), 'utf8');
  assert.equal((source.match(/app\.activate\(options: \[\]\)/g) ?? []).length, 1);
  assert.ok(!source.includes('app.hide(') && !source.includes('app.unhide('));
  const workflow = await fixtureFiles.readFile(new URL('../../.github/workflows/browser-mac-foreground.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("steps.baseline.outputs.retired == 'true'") && workflow.includes("steps.baseline.outputs.inactive == 'true'"));
  assert.ok(workflow.includes("steps.baseline_proof.outputs.artifact-id != ''") && workflow.includes("steps.baseline_proof.outputs.artifact-digest != ''"));
  assert.ok(!workflow.includes('RUSHES_M1_LONG:') && !workflow.includes('RUSHES_M1_REFERENCE:'));
});

for (const options of [{ expireAfterManifest: true }, { expireBeforeActivation: true }, { expireAfterCommand: true }, { expireAfterPersist: true }])
  test('absolute deadline blocks late continuation before any activation: ' + JSON.stringify(options), async () => {
    const r = await model(options); assert.equal(r.result.admitted, false); assert.equal(r.activationCalls, 0);
    assert.match(r.result.reason, /deadline/);
    assert.ok(r.commands.every(c => c.config.timeout > 0 && c.config.timeout <= 18000));
  });
test('expired child guard preserves stdout deadline refusal without an API activation', async () => {
  const r = await model({ childDeadlineExpired: true }); assert.equal(r.result.admitted, false);
  const row = r.result.commands.find(c => c.args[0] === 'activate');
  assert.equal(row.actualExit, 4); assert.equal(JSON.parse(row.stdout).deadlineExpired, true);
  assert.equal(JSON.parse(row.stdout).activationAttempted, false);
  assert.equal(row.args[4], String(r.result.expiresAt));
});
test('every command timeout is capped by the one remaining deadline', async () => {
  const r = await model({ nearDeadline: true }); assert.equal(r.result.admitted, true);
  assert.ok(r.commands.length > 0 && r.commands.every(c => c.config.timeout <= 7));
});
test('late terminal receipt cannot leave an admitted result after the deadline', async () => {
  const r = await model({ expireFinalPersist: true }); assert.equal(r.result.admitted, false);
  assert.equal(r.result.powered, false); assert.match(r.result.reason, /deadline/);
});
