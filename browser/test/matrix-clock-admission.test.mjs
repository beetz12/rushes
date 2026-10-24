import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fixtureFiles from 'node:fs';

const runner = fixtureFiles.readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
const begin = runner.indexOf('async function startMatrixTake(');
const end = runner.indexOf('\nasync function nativeAllocationProbe()', begin);
assert.ok(begin >= 0 && end > begin);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const actualStart = new AsyncFunction('requireUnlockedHost', 'stage', 'sourceMode', 'evidence', 'nativeClockSeed', 'page',
  'bounded', 'sourceOnly', 'sourceAudioFrames', 'sourceAudioSink', 'checkpointRequested', 'beforeStart', `${runner.slice(begin, end)}\nreturn startMatrixTake({}, beforeStart);`);

function coldImportControl(seedRetirementMs = 0, importFailure = false, cleanupFailure) {
  let pageMs = 0;
  const modules = ['/test/matrix-fixture.mjs', '/src/capture/index.ts', '/src/capture/storage.ts'];
  const pending = new Map(), loaded = new Set();
  const events = [];
  const load = name => {
    assert.ok(modules.includes(name));
    if (!pending.has(name)) pending.set(name, new Promise(resolve => setImmediate(resolve)).then(() => {
      if (importFailure && name === modules[1]) throw new Error('Cold module import refused');
      pageMs += 1601; loaded.add(name);
      return { prepareMatrix() { throw new Error('Module preload must not prepare media'); } };
    }));
    return pending.get(name);
  };
  const page = { async evaluate(operation, options) {
    const text = operation.toString();
    if (text.includes('window.matrixTake.start()')) { events.push('start'); return; }
    if (text.includes('window.matrixTake.finish()')) { events.push('finish'); if (cleanupFailure) throw cleanupFailure; return; }
    if (options) {
      await Promise.all(modules.map(load));
      if (pageMs - options.clockSeed.beforePageMs > 1500) throw new Error('Invalid, stale or cross-document native clock seed');
      events.push('prepare'); return;
    }
    // Execute the actual import callback against asynchronous, cached module loads.
    // Losing either await must expose the cold imports to the finite seed budget.
    await new AsyncFunction('load', `return (${text.replace(/\bimport\(/g, 'load(')})();`)(load);
    if (loaded.size === modules.length) events.push('modules');
  } };
  const clock = async () => {
    events.push('clock'); const seed = { beforePageMs: pageMs };
    pageMs += seedRetirementMs; return seed;
  };
  return { events, run: beforeStart => actualStart(async () => {}, async () => {}, 'native-reference', {}, clock, page,
    async operation => operation, false, 128, 'none', false, beforeStart) };
}

test('actual matrix admission loads cold modules before sampling its1500ms clock seed', async () => {
  const control = coldImportControl(); await control.run();
  assert.deepEqual(control.events, ['modules', 'clock', 'prepare', 'start']);
});
test('module admission does not retry or admit a seed that becomes genuinely stale afterward', async () => {
  const control = coldImportControl(1501);
  await assert.rejects(control.run(), /stale or cross-document/);
  assert.equal(control.events.filter(value => value === 'clock').length, 1);
  assert.ok(!control.events.includes('start'));
});
test('an asynchronous module refusal prevents clock sampling and media preparation', async () => {
  const control = coldImportControl(0, true);
  await assert.rejects(control.run(), /Cold module import refused/);
  assert.deepEqual(control.events, []);
});


test('late trace waits after prepared media and before observation without resampling the seed', async () => {
  const control = coldImportControl(); let release;
  const ready = new Promise(resolve => { release = resolve; });
  const take = control.run(async () => { control.events.push('trace'); await ready; });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(control.events, ['modules', 'clock', 'prepare', 'trace']);
  release(); await take;
  assert.deepEqual(control.events, ['modules', 'clock', 'prepare', 'trace', 'start']);
});
test('late trace refusal retires the live prepared source and preserves its original error', async () => {
  const control = coldImportControl(), refused = new Error('Trace setup refused');
  await assert.rejects(control.run(async () => { control.events.push('trace'); throw refused; }), error => error === refused);
  assert.deepEqual(control.events, ['modules', 'clock', 'prepare', 'trace', 'finish']);
});
test('late trace and prepared-source retirement errors are retained together', async () => {
  const cleanup = new Error('Prepared source retirement refused'), refused = new Error('Trace setup refused');
  const control = coldImportControl(0, false, cleanup);
  await assert.rejects(control.run(async () => { control.events.push('trace'); throw refused; }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [refused, cleanup]); return true;
  });
  assert.deepEqual(control.events, ['modules', 'clock', 'prepare', 'trace', 'finish']);
});
test('late trace is never entered when the unchanged seed admission rejects preparation', async () => {
  const control = coldImportControl(1501);
  await assert.rejects(control.run(async () => { control.events.push('trace'); }), /stale or cross-document/);
  assert.deepEqual(control.events, ['modules', 'clock']);
});
