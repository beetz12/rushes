import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configureMatrixBrowser } from './matrix-browser-options.mjs';
import { sourceTaskObservationWindow } from './cold-trace.mjs';

const options = () => new Map([['headless', 'new'], ['use-fake-device-for-media-stream', true], ['user-data-dir', 'owned']]);
const profile = { platform: 'win32', sourceMode: 'native-reference', browserMode: 'headful', videoBuffer: 'default' };
test('software full diagnosis changes exactly one encoder flag and records the actual argv', () => {
  const baseline = options(), software = options();
  assert.deepEqual(configureMatrixBrowser(baseline, profile), { browserMode: 'headful', videoBuffer: 'default' });
  assert.deepEqual(configureMatrixBrowser(software, { ...profile, videoEncoder: 'software-diagnostic' }),
    { browserMode: 'headful', videoBuffer: 'default', videoEncoder: 'software-diagnostic' });
  assert.deepEqual([...software], [...baseline, ['disable-accelerated-video-encode', true]]);
  const argv = [...software].map(([name, value]) => value === true ? `--${name}` : `--${name}=${value}`);
  assert.equal(argv.filter(value => value === '--disable-accelerated-video-encode').length, 1);
  assert.equal(software.has('disable-video-capture-use-gpu-memory-buffer'), false);
});
test('wrong software profiles and an unmarked software flag fail before mutating launch options', () => {
  for (const change of [{ platform: 'darwin' }, { sourceMode: 'container' }, { browserMode: 'headless' }, { videoBuffer: 'cpu' }, { videoEncoder: 'unknown' }]) {
    const value = options(), before = [...value];
    assert.throws(() => configureMatrixBrowser(value, { ...profile, videoEncoder: 'software-diagnostic', ...change }));
    assert.deepEqual([...value], before);
  }
  const value = options(); value.set('disable-accelerated-video-encode', true);
  assert.throws(() => configureMatrixBrowser(value, profile), /Unmarked/);
});

const runner = readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
const first = runner.indexOf("const long = process.env.RUSHES_M1_LONG === '1';"), last = runner.indexOf('const root = fileURLToPath(', first);
assert.ok(first >= 0 && last > first);
const admission = new Function('sourceTaskObservationWindow', 'process', runner.slice(first, last) + ';return {videoEncoder,softwareEncoderDiagnostic};');
const environment = { RUSHES_M1_SOURCE_MODE: 'native-reference', RUSHES_M1_DURABLE_CHECKPOINT: '1',
  RUSHES_M1_BROWSER_MODE: 'headful', RUSHES_M1_VIDEO_ENCODER: 'software-diagnostic' };
const admit = change => admission(sourceTaskObservationWindow, { platform: 'win32', send() {}, env: { ...environment, ...change } });
test('software diagnosis is limited to the original untraced supervised Windows8s full graph', () => {
  assert.deepEqual(admit({}), { videoEncoder: 'software-diagnostic', softwareEncoderDiagnostic: true });
  for (const change of [{ RUSHES_M1_LONG: '1' }, { RUSHES_M1_REFERENCE: '1' }, { RUSHES_M1_NATIVE_SOURCE_ONLY: '1' },
    { RUSHES_M1_DIAGNOSTIC: '1' }, { RUSHES_M1_NATIVE_ENCODER_CONTROL: '1' }, { RUSHES_M1_NATIVE_TRACE_PROOF: '1' },
    { RUSHES_M1_SOURCE_AUDIO_SINK: 'default' }, { RUSHES_M1_SOURCE_AUDIO_FRAMES: '480' },
    { RUSHES_M1_BROWSER_MODE: 'headless' }, { RUSHES_M1_VIDEO_BUFFER: 'cpu' },
    { RUSHES_M1_DURABLE_CHECKPOINT: undefined }, { RUSHES_M1_VIDEO_ENCODER: 'unknown' }]) assert.throws(() => admit(change));
});
test('software evidence cannot substitute for ordinary product or raw-source schema', () => {
  const expression = runner.match(/const evidence = \{ schema: (.*), startedAt:/)[1];
  const schema = new Function('softwareEncoderDiagnostic', 'nativeEncoderControl', 'sourceOnly', 'return ' + expression);
  assert.equal(schema(true, false, false), 'rushes.software-encoder-control/1');
  assert.equal(schema(false, false, false), 'rushes.independent-m1/1');
  assert.equal(schema(false, true, true), 'rushes.native-encoder-control/1');
  assert.equal(schema(false, false, true), 'rushes.source-load-control/1');
});
