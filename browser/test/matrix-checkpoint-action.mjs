// Generated-media CI only. Pinned upload-action workers own credentials; the matrix child never receives them.
import * as checkpointFiles from 'node:fs/promises';
import * as checkpointPaths from 'node:path';
import * as checkpointCrypto from 'node:crypto';
import * as checkpointProcesses from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const uploadProgram = { repository: 'actions/upload-artifact', commit: 'ea165f8d65b6e75b540449e92b4886f43607fa02', bytes: 5051718, sha256: '0165b8a75330f3228f2c7a234b4ff8a107b9139c2b519147f4c8e9fe99b262d8' };
const stages = new Set(['normal-before-recovery', 'first-error', 'final-before-close']);
const validArtifact = value => Number.isSafeInteger(value?.id) && value.id > 0
  && /^[a-f0-9]{64}$/.test(value.digest);
const stageAfter = (before, after) => before === undefined ? ['normal-before-recovery','first-error'].includes(after)
  : before === 'normal-before-recovery' ? ['first-error','final-before-close'].includes(after)
  : before === 'first-error' && after === 'final-before-close';
async function until(operation, expires) {
  let timer;
  try {
    if (performance.now() >= expires) throw new Error('Checkpoint deadline expired');
    const result = await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Checkpoint deadline expired')), Math.max(1, expires - performance.now())); })]);
    if (performance.now() >= expires) throw new Error('Checkpoint completed after its deadline');
    return result;
  } finally { clearTimeout(timer); }
}
export async function requestCheckpoint(channel, sequence, stage) {
  if (typeof channel.send !== 'function' || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 3 || !stages.has(stage))
    throw new Error('Invalid durable checkpoint channel');
  const expires = performance.now() + 60_000, deadlineWallMs = Date.now() + 60_000;
  let observe, disconnected;
  try {
    return await until(new Promise((resolve, reject) => {
      observe = reply => {
        if (reply?.kind !== 'rushes-checkpoint-result' || reply.sequence !== sequence) return;
        if (reply.stage !== stage || reply.ok !== true || !validArtifact(reply.artifact)) reject(new Error('Durable checkpoint was not confirmed'));
        else resolve({ stage, sequence, artifact: reply.artifact });
      };
      disconnected = () => reject(new Error('Checkpoint supervisor disconnected'));
      channel.on('message', observe); channel.once('disconnect', disconnected);
      channel.send({ kind: 'rushes-checkpoint-request', sequence, stage, deadlineWallMs }, error => {
        if (error) reject(new Error('Checkpoint request could not be delivered'));
      });
    }), expires);
  } finally { if (observe) channel.off('message', observe); if (disconnected) channel.off('disconnect', disconnected); }
}
export function withoutCredentials(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY/i.test(key) && !/^INPUT_/i.test(key)));
}
async function freezeCheckpoint(proof, sequence, stage, signal, requireOwner) {
  const rootInfo = await checkpointFiles.lstat(proof); signal.throwIfAborted();
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Expected an owned proof directory');
  const root = checkpointPaths.join(proof, `checkpoint-${sequence}`);
  await checkpointFiles.mkdir(root, { mode: 0o700 }); signal.throwIfAborted();
  const identities = [], files = [];
  for (const [name, maximum, required] of [['metrics.json', 32 * 1024 ** 2, true], ['chrome-stderr.log', 4 * 1024 ** 2, false], ['owned-browser-pid.json', 8192, requireOwner]]) {
    signal.throwIfAborted(); const path = checkpointPaths.join(proof, name); let info;
    try { info = await checkpointFiles.lstat(path); }
    catch (error) { if (error.code !== 'ENOENT' || required) throw error; identities.push({ name, unavailable: true }); continue; }
    signal.throwIfAborted();
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('Checkpoint file is not an ordinary bounded generated file');
    const bytes = await checkpointFiles.readFile(path, { signal });
    if (bytes.length > maximum) throw new Error('Checkpoint file exceeded its bound');
    const target = checkpointPaths.join(root, name); await checkpointFiles.writeFile(target, bytes, { flag: 'wx', mode: 0o600, signal }); files.push(target);
    identities.push({ name, bytes: bytes.length, sha256: checkpointCrypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const metadata = checkpointPaths.join(root, 'checkpoint.json');
  await checkpointFiles.writeFile(metadata, JSON.stringify({ scope: 'Generated short-recording evidence before destructive recovery or cleanup; not retirement or acceptance',
    sequence, stage, intent: stage === 'normal-before-recovery' ? 'Before alternate-tab close, reload and intentional abrupt-kill recovery' : stage === 'first-error' ? 'Before page/trace error read-back and cleanup' : 'Before trace retirement, browser.close and fallback owned-process kill', at: new Date().toISOString(), identities }, null, 2), { flag: 'wx', mode: 0o600, signal });
  files.push(metadata); return { root, files };
}
export function parseArtifactOutput(text) {
  if (typeof text !== 'string' || text.length > 16384) throw new Error('Invalid upload output');
  const rows = text.replaceAll('\r\n','\n').split('\n'), values = new Map();
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index]) continue;
    const match = /^(artifact-id|artifact-digest|artifact-url)<<([A-Za-z0-9_-]+)$/.exec(rows[index]);
    if (!match || values.has(match[1])) throw new Error('Ambiguous upload output');
    const value = rows[++index];
    if (rows[++index] !== match[2]) throw new Error('Incomplete upload output');
    values.set(match[1], value);
  }
  const artifact = { id: Number(values.get('artifact-id')), digest: values.get('artifact-digest'), size: null };
  if (!/^[1-9][0-9]*$/.test(values.get('artifact-id')) || !validArtifact(artifact)) throw new Error('Upload provided no finalized artifact identity');
  return artifact;
}
export function matrixChildEnvironment(environment) {
  const inheritedModules = environment.RUSHES_MATRIX_PS_MODULE_PATH;
  if (typeof inheritedModules !== 'string') throw new Error('The observed PowerShell parent environment is required');
  const result = withoutCredentials(environment);
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'psmodulepath') delete result[key];
  return { ...result, PSModulePath: inheritedModules, RUSHES_M1_DURABLE_CHECKPOINT: '1' };
}
export async function uploadInWorker(request, { signal, expires }, launch) {
  signal.throwIfAborted();
  if (performance.now() >= expires) throw new Error('Upload deadline expired before launch');
  let outputFile;
  if (!launch) {
    const info = await checkpointFiles.lstat(request.script);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== uploadProgram.bytes
      || checkpointCrypto.createHash('sha256').update(await checkpointFiles.readFile(request.script)).digest('hex') !== uploadProgram.sha256)
      throw new Error('Pinned upload action identity differs');
    const outputRoot = checkpointPaths.join(checkpointPaths.dirname(request.root), `upload-output-${checkpointCrypto.randomUUID()}`);
    await checkpointFiles.mkdir(outputRoot, { mode: 0o700 });
    outputFile = checkpointPaths.join(outputRoot,'github-output'); const summary = checkpointPaths.join(outputRoot,'summary');
    await checkpointFiles.writeFile(outputFile,'',{flag:'wx',mode:0o600}); await checkpointFiles.writeFile(summary,'',{flag:'wx',mode:0o600});
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^INPUT_/i.test(key)
      && !['GITHUB_OUTPUT','GITHUB_STEP_SUMMARY'].includes(key.toUpperCase())));
    Object.assign(environment, { INPUT_NAME: request.name, INPUT_PATH: request.files.join('\n'), 'INPUT_IF-NO-FILES-FOUND':'error',
      'INPUT_RETENTION-DAYS':'1','INPUT_COMPRESSION-LEVEL':'1',INPUT_OVERWRITE:'false','INPUT_INCLUDE-HIDDEN-FILES':'false',
      GITHUB_OUTPUT:outputFile,GITHUB_STEP_SUMMARY:summary });
    signal.throwIfAborted(); if (performance.now() >= expires) throw new Error('Upload deadline expired during setup');
    launch = () => checkpointProcesses.fork(request.script, [], { execPath: request.node, env: environment, stdio: ['ignore','ignore','ignore','ipc'] });
  }
  const worker = launch(); let processError = false, rejectError, abort;
  const onError = () => { processError = true; rejectError?.(new Error('Upload worker process error')); };
  worker.on('error', onError);
  const ended = new Promise(resolve => worker.once('close', (code, signalValue) => resolve({ code, signal: signalValue })));
  try {
    const interrupted = new Promise((_, reject) => {
      rejectError = reject; abort = () => reject(new Error('Upload deadline expired'));
      signal.addEventListener('abort', abort, { once: true });
    });
    const outcome = await until(Promise.race([ended, interrupted]), expires);
    if (processError || outcome.code !== 0 || outcome.signal) throw new Error('Upload worker did not confirm a clean exit');
    if (!outputFile) throw new Error('Upload worker provided no output file');
    const artifact = parseArtifactOutput(await until(checkpointFiles.readFile(outputFile,'utf8'), expires));
    return { ...artifact, uploadProof: { actualExit: outcome.code, signal: outcome.signal, pid: worker.pid, node: request.node, program: uploadProgram } };
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    try { await until(ended, performance.now() + 2000); } finally { worker.off('error',onError); }
  }
}
export function superviseCheckpoints(child, { proof, upload, prefix, uploadBudgetMs = 45_000 }) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(prefix) || !Number.isSafeInteger(uploadBudgetMs) || uploadBudgetMs < 1 || uploadBudgetMs > 45_000)
    throw new Error('Invalid checkpoint supervisor limits');
  let tail = Promise.resolve(), previous = 0, previousStage, failed = false;
  const receipts = [], errors = [];
  const send = reply => { try { if (child.connected === false) throw new Error('Checkpoint child disconnected'); child.send(reply); } catch { failed = true; errors.push({ name: 'AcknowledgementDeliveryFailed' }); } };
  const observe = request => {
    if (request?.kind !== 'rushes-checkpoint-request') return;
    tail = tail.then(async () => {
      const sequence = request.sequence, controller = new AbortController(); let uploadOperation, alarm;
      try {
        const wallRemaining = request.deadlineWallMs - Date.now();
        if (failed || sequence !== previous + 1 || sequence > 3 || !stageAfter(previousStage, request.stage)
          || !Number.isSafeInteger(request.deadlineWallMs) || wallRemaining < 1 || wallRemaining > 60_000) throw new Error('Invalid checkpoint sequence or deadline');
        previous = sequence; previousStage = request.stage;
        const expires = performance.now() + Math.min(uploadBudgetMs, wallRemaining);
        alarm = setTimeout(() => controller.abort(), Math.max(1, expires - performance.now()));
        const snapshot = await until(freezeCheckpoint(proof, sequence, request.stage, controller.signal,
          request.stage === 'normal-before-recovery' || receipts.some(row => row.stage === 'normal-before-recovery')), expires);
        controller.signal.throwIfAborted();
        uploadOperation = upload(`${prefix}-${sequence}`, snapshot.files, snapshot.root, { retentionDays: 1, compressionLevel: 1 }, { signal: controller.signal, expires });
        const artifact = await until(uploadOperation, expires);
        if (!validArtifact(artifact) || receipts.some(row => row.artifact.id === artifact.id)) throw new Error('Upload provided no new finalized artifact');
        const receipt = { stage: request.stage, sequence, artifact: { name: `${prefix}-${sequence}`, id: artifact.id, size: artifact.size ?? null, digest: artifact.digest }, uploadProof: artifact.uploadProof };
        await until(checkpointFiles.writeFile(checkpointPaths.join(proof, `checkpoint-receipt-${sequence}.json`), JSON.stringify(receipt),
          { flag: 'wx', mode: 0o600, signal: controller.signal }), expires);
        if (Date.now() >= request.deadlineWallMs) throw new Error('Request expired before acknowledgement');
        receipts.push(receipt); send({ kind: 'rushes-checkpoint-result', ok: true, sequence, stage: request.stage, artifact: receipt.artifact });
      } catch (error) {
        controller.abort(); failed = true; errors.push({ sequence, name: error.name });
        if (uploadOperation) try { await until(uploadOperation.catch(() => undefined), performance.now() + 2500); }
        catch { errors.push({ sequence, name: 'UploadShutdownUnconfirmed' }); }
        // Upload workers have isolated/discarded output: signed storage URLs never reach the public log.
        send({ kind: 'rushes-checkpoint-result', ok: false, sequence, stage: request.stage });
      } finally { clearTimeout(alarm); }
    });
  };
  child.on('message', observe);
  return { async finish() { await tail; child.off('message', observe); return { receipts, errors }; } };
}
export async function main() {
  const environment = process.env;
  if (environment.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') throw new Error('This diagnostic action requires a public Windows runner');
  const event = JSON.parse(await checkpointFiles.readFile(environment.GITHUB_EVENT_PATH, 'utf8'));
  if (event.repository?.private !== false || event.repository?.full_name !== 'beetz12/rushes') throw new Error('Private Actions are forbidden');
  const workspace = environment.GITHUB_WORKSPACE, proof = checkpointPaths.resolve(environment.RUSHES_M1_PROOF);
  const temporary = await checkpointFiles.realpath(environment.RUNNER_TEMP), relative = checkpointPaths.relative(temporary, proof);
  if (!relative || relative.startsWith('..') || checkpointPaths.isAbsolute(relative)) throw new Error('Expected a fresh runner-temporary proof path');
  const node = environment.RUSHES_MATRIX_NODE, runFile = promisify(checkpointProcesses.execFile);
  if (!node || !checkpointPaths.isAbsolute(node) || (await runFile(node, ['--version'], { timeout: 5000 })).stdout.trim() !== 'v22.22.0') throw new Error('An explicit pinned matrix Node executable is required');
  await checkpointFiles.mkdir(proof, { mode: 0o700 });
  const ownerFile = checkpointPaths.join(proof, 'supervisor-owner.json');
  await checkpointFiles.writeFile(ownerFile, JSON.stringify({ supervisorPid: process.pid, supervisorNode: process.version, matrixNode: node, state: 'before-child-start' }), { flag: 'wx', mode: 0o600 });
  const inheritedModules = environment.RUSHES_MATRIX_PS_MODULE_PATH, matrixEnvironment = matrixChildEnvironment(environment);
  const script = environment.RUSHES_UPLOAD_ACTION_SCRIPT;
  if (!script || !checkpointPaths.isAbsolute(script)) throw new Error('The pinned upload program is required');
  const child = checkpointProcesses.fork(fileURLToPath(new URL('./matrix-checkpoint-child.mjs', import.meta.url)), [], { cwd: workspace, execPath: node,
    env: matrixEnvironment, stdio: ['ignore','pipe','pipe','ipc'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  let matrixProcessError = false; child.on('error', () => { matrixProcessError = true; });
  const ended = new Promise(resolve => child.once('close', (actualExit, signal) => resolve({ actualExit, signal, processError: matrixProcessError })));
  const supervisor = superviseCheckpoints(child, { proof, prefix: `matrix-boundary-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-${checkpointCrypto.randomUUID().slice(0, 8)}`,
    upload: (name, files, root, options, control) => uploadInWorker({ name, files, root, options, script, node }, control) });
  try {
    await checkpointFiles.writeFile(ownerFile, JSON.stringify({ supervisorPid: process.pid, matrixPid: child.pid, supervisorNode: process.version, matrixNode: node, modulePathHash: checkpointCrypto.createHash('sha256').update(inheritedModules).digest('hex'), state: 'started' }));
    child.send({ kind: 'begin-owned-matrix' });
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await until(ended, performance.now() + 2000); throw new Error('Matrix ownership could not be persisted before launch');
  }
  const outcome = await ended, checkpoints = await supervisor.finish(); let retirementActualExit;
  try { await runFile(node, [checkpointPaths.join(workspace, 'verification/browser-retirement.mjs'), checkpointPaths.join(proof, 'owned-browser-pid.json'),
    checkpointPaths.join(proof, 'retirement.json')], { cwd: workspace, env: matrixEnvironment, timeout: 15000 }); retirementActualExit = 0; }
  catch { retirementActualExit = 1; }
  const complete = outcome.actualExit === 0 && !outcome.signal && !outcome.processError && !checkpoints.errors.length && retirementActualExit === 0
    && ['normal-before-recovery','final-before-close'].every(stage => checkpoints.receipts.some(receipt => receipt.stage === stage));
  await checkpointFiles.writeFile(checkpointPaths.join(proof, 'supervisor-result.json'), JSON.stringify({ ...outcome, ...checkpoints, retirementActualExit,
    scope: 'Original matrix verdict and independent retirement remain required', accepted: complete }, null, 2), { flag: 'wx', mode: 0o600 });
  return complete ? 0 : 1;
}
