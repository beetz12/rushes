// Build only this generated-test AppKit helper, before browser/media work.
import * as buildProcesses from 'node:child_process';
import * as buildCalls from 'node:util';
import * as buildFiles from 'node:fs/promises';
import * as buildDigests from 'node:crypto';
import * as buildPaths from 'node:path';
import * as buildURLs from 'node:url';
import assert from 'node:assert/strict';
import { withoutCredentials } from '../browser/test/matrix-checkpoint-action.mjs';
import { runOwnedHelper } from '../shell/scripts/owned-helper-build.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.argv.length, 3, 'Usage: build-mac-app-helper.mjs <new-output-directory>');
// runOwnedHelper intentionally inherits its caller. Sanitize only this build
// process's environment so its compiler/session-helper descendants inherit it.
const clean = withoutCredentials(process.env);
for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
const run = buildCalls.promisify(buildProcesses.execFile), digest = value => buildDigests.createHash('sha256').update(value).digest('hex');
const output = buildPaths.resolve(process.argv[2]); await buildFiles.mkdir(output, { mode: 0o700 });
const source = buildURLs.fileURLToPath(new URL('../browser/test/OwnedMacApplication.swift', import.meta.url));
const executable = buildPaths.join(output, 'owned-mac-application');
const receipt = { schema: 'rushes.mac-application-helper/1', startedAt: new Date().toISOString(),
  sourceSHA256: digest(await buildFiles.readFile(source)), executable, sha256: null };
try {
  const inspect = async args => (await run('/usr/bin/xcrun', args,
    { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384, env: clean })).stdout.trim();
  const sdk = await inspect(['--sdk', 'macosx', '--show-sdk-path']);
  const compiler = await inspect(['--sdk', 'macosx', '--find', 'swiftc']);
  const header = buildPaths.join(sdk, 'System/Library/Frameworks/AppKit.framework/Headers/NSRunningApplication.h');
  receipt.sdk = { path: sdk, settingsSHA256: digest(await buildFiles.readFile(buildPaths.join(sdk, 'SDKSettings.json'))), headerSHA256: digest(await buildFiles.readFile(header)) };
  receipt.compiler = { path: compiler, sha256: digest(await buildFiles.readFile(compiler)),
    version: (await run(compiler, ['--version'], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384, env: clean })).stdout.trim() };
  const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch]; assert.ok(architecture);
  receipt.target = `${architecture}-apple-macos14.0`;
  receipt.command = [compiler, '-parse-as-library', '-O', '-sdk', sdk, '-target', receipt.target,
    '-module-cache-path', buildPaths.join(output, 'module-cache'), source, '-o', executable];
  receipt.build = await runOwnedHelper(receipt.command[0], receipt.command.slice(1),
    { cwd: output, timeoutMs: 45000, stopWaitMs: 1000, killWaitMs: 1000 });
  receipt.sha256 = digest(await buildFiles.readFile(executable));
  receipt.negativeControls = [];
  for (const [name, pid, deadline, expectedExit] of [
    ['invalid-pid', '0', Date.now() + 18000, 2], ['expired-deadline', '2', Date.now() - 1000, 4]]) {
    const args = ['observe', pid, '/unused/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', '-', String(deadline)];
    const operation = run(executable, args, { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 8192, env: clean });
    let failure; try { await operation; } catch (error) { failure = error; }
    const row = { name, args, actualExit: operation.child.exitCode, signal: operation.child.signalCode,
      helperPID: operation.child.pid, output: failure?.stdout ? JSON.parse(failure.stdout) : null };
    receipt.negativeControls.push(row);
    assert.equal(row.actualExit, expectedExit); assert.equal(row.signal, null);
    assert.equal(row.output?.activationAttempted, false); assert.equal(row.output?.identityMatched, false);
    if (name === 'expired-deadline') assert.equal(row.output.deadlineExpired, true);
    row.oraclePassed = true;
  }
  receipt.negativeControlsPassed = true;
} catch (error) {
  receipt.build ??= error.buildResult ?? { actualExitCode: null, retirementConfirmed: false };
  receipt.failure = error.name; throw error;
} finally {
  receipt.endedAt = new Date().toISOString();
  await buildFiles.writeFile(buildPaths.join(output, 'manifest.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
}
