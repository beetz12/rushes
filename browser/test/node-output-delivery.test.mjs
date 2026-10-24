import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { superviseCheckpoints } from './matrix-checkpoint-action.mjs';
import { fork } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { outputDeliveryMode, nodeConsoleLedger, observeChildOutput } from './node-output-delivery.mjs';
const startupPrefix = 'GENERATED_CAPTURE_STARTUP ';
const row = index => ({ takeId: 'generated-fixture', index, timeMs: index, kind: 'phase', phase: 'session-start-entered' });
const text = index => startupPrefix + JSON.stringify(row(index)) + '\n';
const clock = () => { let ns = 0n; return { stamp: () => ({ wallMs: 1000 + Number(ns / 1_000_000n), monoNs: ns.toString() }), advance: value => { ns += value; } }; };
const pipes = () => ({ stdout: new PassThrough(), stderr: new PassThrough() });
async function ownedProof(context) {
  const path = fileURLToPath(new URL(`./pure-output-${process.pid}-${Math.random().toString(16).slice(2)}`, import.meta.url));
  await mkdir(path);context.after(() => rm(path, { recursive: true, force: true }));return path;
}
test('Node receipt records local console span without altering the strict browser row', () => {
  const c = clock(), ledger = nodeConsoleLedger({ stamp: c.stamp });const value = row(0), before = structuredClone(value), received = ledger.receive();
  c.advance(10n);const result = ledger.record(value, received, () => { c.advance(300_000_000n);return 7; });
  assert.equal(result, 7);assert.deepEqual(value, before);const actual = ledger.snapshot();
  assert.equal(actual.rows.length, 1);assert.deepEqual(actual.rows[0].received, received);
  assert.equal(actual.rows[0].consoleSpanNs, '300000000');assert.equal(actual.firstSlow.index, 0);
  assert.equal(actual.rows[0].afterConsole.wallMs, 1300);
});
test('console throws retain a failed span and bounded overflow preserves the first slow observation', () => {
  const c = clock(), ledger = nodeConsoleLedger({ stamp: c.stamp, limit: 1 }), failure = new Error('generated sentinel');
  assert.throws(() => ledger.record(row(0), ledger.receive(), () => { throw failure; }), error => error === failure);
  ledger.record(row(1), ledger.receive(), () => c.advance(251_000_000n));
  const actual = ledger.snapshot();assert.equal(actual.rows.length, 1);assert.equal(actual.dropped, 1);
  assert.equal(actual.rows[0].consoleThrew, true);assert.equal(actual.firstSlow.index, 1);
  assert.equal(JSON.stringify(actual).includes('generated sentinel'), false);
  assert.throws(() => ledger.record({ ...row(2), commandLine: 'excluded' }, ledger.receive(), () => {}));
});
test('only explicit known diagnostic modes are accepted and both pipes validate before listeners attach', () => {
  assert.equal(outputDeliveryMode(undefined), undefined);
  assert.equal(outputDeliveryMode('observe-forward'), 'observe-forward');assert.equal(outputDeliveryMode('retain-only'), 'retain-only');
  for (const value of ['', 'default', true, '__proto__']) assert.throws(() => outputDeliveryMode(value));
  const child = { stdout: new PassThrough() };assert.throws(() => observeChildOutput(child, 'retain-only'));
  assert.equal(child.stdout.listenerCount('data'), 0);assert.throws(() => observeChildOutput(pipes(), undefined));
});
test('retained sink keeps exact bounded prefixes, continuously drains overflow and leaves it failed', async context => {
  const child = pipes(), observer = observeChildOutput(child, 'retain-only', { byteLimit: 8 });
  child.stdout.write(Buffer.from('012345'));child.stdout.write(Buffer.from('6789'));child.stdout.write(Buffer.from('abcdef'));
  child.stderr.write(Buffer.from('stderr-ok'));
  const proof = await ownedProof(context);await observer.flush(proof);const actual = observer.snapshot();
  assert.equal(actual.channels.stdout.bytes, 16);assert.equal(actual.channels.stdout.retainedBytes, 8);assert.equal(actual.channels.stdout.discardedBytes, 8);
  assert.equal(actual.channels.stderr.discardedBytes, 1);assert.equal(actual.overflow, true);
  assert.equal((await readFile(join(proof, 'matrix-child-stdout.log'), 'utf8')), '01234567');
  const retained = JSON.parse(await readFile(join(proof, 'supervisor-output-delivery.json'), 'utf8'));assert.equal(retained.overflow, true);
  observer.detach();assert.equal(child.stdout.listenerCount('data'), 0);assert.equal(child.stderr.listenerCount('data'), 0);
});
test('parent receipts survive arbitrary prefix/UTF8 boundaries and ignore raw payloads', () => {
  const child = pipes(), observer = observeChildOutput(child, 'observe-forward');
  const warning = { ...row(1), kind: 'warning', state: 'recording', message: 'generated é' };delete warning.phase;
  const bytes = Buffer.from(text(0) + startupPrefix + JSON.stringify(warning) + '\r\n');
  for (let offset = 0; offset < bytes.length; offset += 3) child.stdout.write(bytes.subarray(offset, offset + 3));
  const actual = observer.snapshot().channels.stdout;assert.deepEqual(actual.receipts.map(value => value.index), [0, 1]);
  assert.equal(actual.incompleteLine, false);assert.equal(JSON.stringify(actual.receipts).includes('message'), false);observer.detach();
});
test('overlong partial lines stay bounded and do not consume the next strict row', () => {
  const child = pipes(), observer = observeChildOutput(child, 'retain-only');
  child.stdout.write(Buffer.from('x'.repeat(4098)));child.stdout.write(Buffer.from('\n' + text(0)));
  const actual = observer.snapshot().channels.stdout;assert.equal(actual.overlongLines, 1);assert.equal(actual.receipts[0].index, 0);
  observer.detach();
});
test('actual supervisor integration preserves default pipes and observes before forwarding only when explicit', () => {
  const source = readFileSync(new URL('./matrix-checkpoint-action.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('  // Diagnostic observers attach'), end = source.indexOf('  let matrixProcessError', begin);
  assert.ok(begin > 0 && end > begin);
  const attach = new Function('child', 'process', 'outputDelivery', 'observeChildOutput', source.slice(begin, end) + ';return childOutput;');
  for (const mode of [undefined, 'observe-forward', 'retain-only']) {
    const order = [], child = { stdout: { pipe(value) { order.push('stdout:' + value); } }, stderr: { pipe(value) { order.push('stderr:' + value); } } };
    let calls = 0;const result = attach(child, { stdout: 'out', stderr: 'err' }, mode, () => { calls++;order.push('observe');return 5; });
    assert.equal(calls, mode === undefined ? 0 : 1);assert.equal(result, mode === undefined ? undefined : 5);
    assert.deepEqual(order, mode === undefined ? ['stdout:out', 'stderr:err'] : mode === 'observe-forward' ? ['observe', 'stdout:out', 'stderr:err'] : ['observe']);
  }
});
test('output admission rejects altered media or ordinary acceptance and leaves normal option undefined', () => {
  const source = readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf("const long = process.env.RUSHES_M1_LONG === '1';"), end = source.indexOf('const diagnosticDurationMs =', begin);
  const admit = new Function('process', 'sourceTaskObservationWindow', source.slice(begin, end) + ';return {outputDelivery,targetMs};');
  const base = { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_DURABLE_CHECKPOINT: '1', RUSHES_M1_BROWSER_MODE: 'headful' };
  const run = env => admit({ env, platform: 'win32', send() {} }, () => 0);
  assert.deepEqual(run(base), { outputDelivery: undefined, targetMs: 8000 });
  for (const mode of ['observe-forward', 'retain-only']) assert.deepEqual(run({ ...base, RUSHES_M1_OUTPUT_DELIVERY: mode }), { outputDelivery: mode, targetMs: 8000 });
  for (const change of [{ RUSHES_M1_OUTPUT_DELIVERY: '' }, { RUSHES_M1_LONG: '1' }, { RUSHES_M1_REFERENCE: '1' },
    { RUSHES_M1_NATIVE_SOURCE_ONLY: '1' }, { RUSHES_M1_DURABLE_CHECKPOINT: undefined }, { RUSHES_M1_NATIVE_TRACE_PROOF: '1' },
    { RUSHES_M1_VIDEO_ENCODER: 'software-diagnostic' }, { RUSHES_M1_VIDEO_BUFFER: 'cpu' }, { RUSHES_M1_SOURCE_AUDIO_SINK: 'default' },
    { RUSHES_M1_SOURCE_AUDIO_FRAMES: '480' }, { RUSHES_M1_SOURCE_MODE: 'native-feedback' }, { RUSHES_M1_BROWSER_MODE: 'headless' }])
    assert.throws(() => run({ ...base, RUSHES_M1_OUTPUT_DELIVERY: 'retain-only', ...change }));
  assert.ok(source.includes("'test/node-output-delivery.mjs'"));
  assert.ok(source.includes("evidence.schema = 'rushes.output-delivery-control/1'"));
});
test('a small owned Node output control is positively reaped and its bytes retained without forwarding', async context => {
  const proof = await ownedProof(context), script = join(proof, 'generated-output.mjs');
  await writeFile(script, `process.stdout.write(${JSON.stringify(text(0))});process.stderr.write('generated-stderr\\n');\n`);
  const child = fork(script, [], { execPath: process.execPath, env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const observer = observeChildOutput(child, 'retain-only');let alarm;
  context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');observer.detach(); });
  const ended = new Promise((resolve, reject) => { child.once('close', (code, signal) => resolve({ code, signal }));child.once('error', reject); });
  const outcome = await Promise.race([ended, new Promise((_, reject) => { alarm = setTimeout(() => reject(new Error('Pure output child deadline')), 5000); })]).finally(() => clearTimeout(alarm));
  assert.deepEqual(outcome, { code: 0, signal: null });await observer.flush(proof);const actual = observer.snapshot();
  assert.equal(actual.overflow, false);assert.equal(actual.channels.stdout.receipts[0].index, 0);
  assert.equal(await readFile(join(proof, 'matrix-child-stdout.log'), 'utf8'), text(0));
  assert.ok(actual.channels.stdout.bytes + actual.channels.stderr.bytes < 2048);observer.detach();
});

test('flush freezes retained bytes and receipt metadata together while the pipe continues draining', async context => {
  const child = pipes(), observer = observeChildOutput(child, 'retain-only');
  child.stdout.write(Buffer.from(text(0)));const firstBytes = observer.snapshot().channels.stdout.bytes;
  const proof = await ownedProof(context), flushing = observer.flush(proof);
  await Promise.resolve();child.stdout.write(Buffer.from(text(1)));await flushing;
  const captured = JSON.parse(await readFile(join(proof, 'supervisor-output-delivery.json'), 'utf8'));
  assert.equal(captured.channels.stdout.bytes, firstBytes);
  assert.equal(await readFile(join(proof, 'matrix-child-stdout.log'), 'utf8'), text(0));
  assert.ok(observer.snapshot().channels.stdout.bytes > firstBytes);observer.detach();
});

test('optional output snapshots finish before durable freeze under the existing checkpoint budget', async context => {
  const proof = await ownedProof(context), previousMode = process.env.RUSHES_M1_OUTPUT_DELIVERY;
  process.env.RUSHES_M1_OUTPUT_DELIVERY = 'retain-only';context.after(() => { if (previousMode === undefined) delete process.env.RUSHES_M1_OUTPUT_DELIVERY;else process.env.RUSHES_M1_OUTPUT_DELIVERY = previousMode; });
  await writeFile(join(proof, 'metrics.json'), '{"scope":"generated"}');
  await writeFile(join(proof, 'owned-browser-pid.json'), '{"pid":123}');
  const child = Object.assign(new EventEmitter(), pipes(), { connected: true, replies: [], send(value) { this.replies.push(value); } });
  const output = observeChildOutput(child, 'retain-only');child.stdout.write(Buffer.from(text(0)));let captured;
  const broker = superviseCheckpoints(child, { proof, prefix: 'output-pure-control', beforeFreeze: control => output.flush(proof, control),
    upload: async (_name, files) => { captured = files.map(value => value.split('/').at(-1));return { id: 123, digest: 'a'.repeat(64) }; } });
  child.emit('message', { kind: 'rushes-checkpoint-request', sequence: 1, stage: 'normal-before-recovery', deadlineWallMs: Date.now() + 60_000 });
  const result = await broker.finish();assert.deepEqual(result.errors, []);assert.equal(child.replies[0].ok, true);
  assert.ok(captured.includes('matrix-child-stdout.log'));assert.ok(captured.includes('supervisor-output-delivery.json'));output.detach();
});
