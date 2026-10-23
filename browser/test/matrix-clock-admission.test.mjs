import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fixtureFiles from 'node:fs';

const runner = fixtureFiles.readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
const begin = runner.indexOf('async function startMatrixTake(');
const end = runner.indexOf('\nasync function nativeAllocationProbe()', begin);
assert.ok(begin >= 0 && end > begin);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const actualStart = new AsyncFunction('requireUnlockedHost', 'stage', 'sourceMode', 'evidence', 'nativeClockSeed', 'page',
  'bounded', 'sourceOnly', 'sourceAudioFrames', `${runner.slice(begin, end)}\nreturn startMatrixTake();`);

function coldImportControl(seedRetirementMs = 0, importFailure = false) {
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
  return { events, run: () => actualStart(async () => {}, async () => {}, 'native-reference', {}, clock, page,
    async operation => operation, false, 128) };
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
