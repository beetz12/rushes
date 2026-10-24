import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

function compiled(path, context = {}) {
  const output = buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true,
    platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} }; vm.runInNewContext(output, { module, ...context }); return module.exports;
}
let recognized = { width: true, height: true, frameRate: true, deviceId: true };
const navigator = { mediaDevices: { getSupportedConstraints() { return recognized; } } };
const { cameraSourceAlreadyBounded } = compiled('../src/capture/camera-source-limits.ts', { navigator });
const { BROWSER_LIMITS } = compiled('../src/contracts.ts');
const source = readFileSync(new URL('../src/capture/index.ts', import.meta.url), 'utf8');
const begin = source.indexOf('    for (const track of [screen, camera]) if (track) {');
const end = source.indexOf('\n  } catch (error)', begin);
assert.ok(begin >= 0 && end > begin);
const apply = new (Object.getPrototypeOf(async function() {}).constructor)(
  'screen', 'camera', 'cameraSourceAlreadyBounded', 'BROWSER_LIMITS', source.slice(begin, end));
function track(change = () => {}) {
  const settings = { deviceId: 'generated-camera', width: 1280, height: 720, frameRate: 30 };
  const constraints = { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } };
  const calls = [], value = { kind: 'video', readyState: 'live', calls,
    getSettings: () => settings, getConstraints: () => constraints,
    async applyConstraints(value) { calls.push(value); } };
  change(constraints, settings, value); return value;
}
const prepare = value => apply(value, undefined, cameraSourceAlreadyBounded, BROWSER_LIMITS);

test('already bounded camera source avoids a second native constraint application even in the screen slot', async () => {
  const value = track(); await prepare(value);
  assert.equal(value.calls.length, 0, 'A declared bounded camera source must keep its existing constraints');
});
test('camera exact bounds and matching immutable device selection retain their original constraints', async () => {
  const value = track((c, s) => {
    c.width = { exact: 640 }; c.height = { exact: 360 }; c.frameRate = { exact: 29.97 };
    c.deviceId = { exact: s.deviceId }; c.advanced = [];
    Object.assign(s, { width: 640, height: 360, frameRate: 29.97 });
  });
  assert.equal(cameraSourceAlreadyBounded(value), true); await prepare(value); assert.equal(value.calls.length, 0);
  assert.deepEqual(value.getConstraints().width, { exact: 640 });
});
test('every unsafe or unknown camera proof preserves the actual original max-limit call', async () => {
  const cases = [
    ['settings-only', c => { delete c.width; }],
    ['bare', c => { c.width = 1280; }],
    ['ideal-only', c => { c.width = { ideal: 1280 }; }],
    ['min-only', c => { c.width = { min: 640 }; }],
    ['advanced-only', c => { delete c.width; c.advanced = [{ width: { max: 1280 } }]; }],
    ['advanced-even-with-basic', c => { c.advanced = [{ aspectRatio: { exact: 2 } }]; }],
    ['weak-max', c => { c.width.max = 1920; }],
    ['weak-exact', c => { c.width = { exact: 1920 }; }],
    ['invalid-string', c => { c.width.max = '1280'; }],
    ['nonfinite', c => { c.frameRate.max = Infinity; }],
    ['zero-bound', c => { c.width.max = 0; }],
    ['fractional-dimension', c => { c.width.max = 1279.5; }],
    ['contradictory-min', c => { c.width.min = 1920; }],
    ['contradictory-exact', c => { c.width.exact = 640; }],
    ['inherited-bound', c => { c.width = Object.create({ max: 1280 }); }],
    ['unknown-bound-key', c => { c.width.other = 1; }],
    ['missing-setting', (_c, s) => { delete s.frameRate; }],
    ['setting-over-limit', (_c, s) => { s.height = 1080; }],
    ['empty-id', (_c, s) => { s.deviceId = ''; }],
    ['display-surface', (_c, s) => { s.displaySurface = 'monitor'; }],
    ['unknown-display-marker', (_c, s) => { s.displaySurface = undefined; }],
    ['logical-surface', (_c, s) => { s.logicalSurface = true; }],
    ['display-constraint', c => { c.displaySurface = 'browser'; }],
    ['extra-required-aspect', c => { c.aspectRatio = { exact: 16 / 9 }; }],
    ['extra-facing-mode', c => { c.facingMode = { exact: 'user' }; }],
    ['other-device', c => { c.deviceId = { exact: 'other' }; }],
    ['unknown-device-selection', c => { c.deviceId = { ideal: 'generated-camera' }; }],
    ['ended', (_c, _s, v) => { v.readyState = 'ended'; }],
    ['audio', (_c, _s, v) => { v.kind = 'audio'; }],
    ['constraints-refused', (_c, _s, v) => { v.getConstraints = () => { throw new Error('read refused'); }; }],
    ['settings-refused', (_c, _s, v) => { v.getSettings = () => { throw new Error('read refused'); }; }],
  ];
  for (const [name, change] of cases) {
    const value = track(change); assert.equal(cameraSourceAlreadyBounded(value), false, name); await prepare(value);
    assert.equal(value.calls.length, 1, name);
    assert.deepEqual(value.calls[0], { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }, name);
  }
});
test('missing or refused supported-constraint evidence also reuses the original apply path', async () => {
  const saved = recognized, getter = navigator.mediaDevices.getSupportedConstraints;
  try {
    for (const support of [undefined, {}, { width: true, height: true, frameRate: false }]) {
      recognized = support; const value = track(); await prepare(value); assert.equal(value.calls.length, 1);
    }
    navigator.mediaDevices.getSupportedConstraints = () => { throw new Error('support refused'); };
    const value = track(); await prepare(value); assert.equal(value.calls.length, 1);
  } finally { recognized = saved; navigator.mediaDevices.getSupportedConstraints = getter; }
});
test('a real fallback apply failure is not swallowed by the read-back guard', async () => {
  const value = track(c => { delete c.frameRate; }), refused = new Error('native apply failed');
  value.applyConstraints = async () => { throw refused; };
  await assert.rejects(prepare(value), error => error === refused);
});
