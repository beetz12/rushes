import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as files from 'node:fs/promises';

// Execute the actual fixture admission branch with controlled asynchronous sources.
// Importing the complete fixture in Node would require browser-only product modules.
const fixtureURL = new URL('./matrix-fixture.mjs', import.meta.url);
const source = await files.readFile(fixtureURL, 'utf8');
const begin = source.indexOf("  } else if (['native-feedback', 'native-reference'].includes(sourceMode)) {");
const end = source.indexOf("  } else throw new Error('Unknown test source mode');", begin);
assert.ok(begin >= 0 && end > begin);
const branch = source.slice(begin, end).replaceAll('import.meta.url', 'fixtureURL');
const run = new (Object.getPrototypeOf(async function() {}).constructor)(
  'navigator', 'AudioContext', 'AudioWorkletNode', 'nativeReferenceWitness', 'fixtureURL', 'observingReference', 'sourceAudioFrames',
  `let source, toneContext, tone, audio, suppliedReference;
   const sourceMode = 'native-reference', diagnostic = false, sourceAudioSink = 'none';
   const metrics = { observerErrors: [], clockCapability: { qualified: true } };
   const nativeRecorder = globalThis.MediaRecorder, nativeWorker = globalThis.Worker;
   if (false) { ${branch} }
   return { source, suppliedReference, metrics };`);

function controlled(firstPacket, { requireSilent = false, requireQuantum = false, ignoreSilent = false, observingReference = true, videoStopError, sourceAudioFrames = 128 } = {}) {
  void firstPacket.catch(() => undefined);
  const calls = [], track = { stop() { calls.push('audio-stop'); } };
  const audio = { stream: { getAudioTracks() { return [track]; }, getTracks() { return [track]; } } };
  const navigator = { mediaDevices: { async getUserMedia() { calls.push('video-create'); return { getTracks() { return [{ stop() { calls.push('video-stop'); if (videoStopError) throw new Error(videoStopError); } }]; } }; } } };
  class Context {
    constructor(options) {
      if (requireSilent && options?.sinkId?.type !== 'none') throw new Error('Generated environment has no physical audio output');
      if (requireQuantum && options?.latencyHint !== sourceAudioFrames / 48000) throw new Error('Generated environment needs the declared callback hint');
      this.sinkId = ignoreSilent ? '' : options?.sinkId ?? '';
      this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000;
    }
    audioWorklet = { async addModule() {} };
    createMediaStreamDestination() { return audio; }
    async resume() { this.state = 'running'; this.currentTime = 0.01; calls.push('audio-resume'); }
    async close() { this.state = 'closed'; calls.push('context-close'); }
  }
  class Worklet { connect() {} }
  const observe = async () => {
    calls.push('observer-create');
    return { async ready() { calls.push('pcm-await'); const value = await firstPacket;
      calls.push('pcm-observed'); return value; }, async stop() { calls.push('observer-stop'); } };
  };
  return { calls, start: () => run(navigator, Context, Worklet, observe, fixtureURL, observingReference, sourceAudioFrames) };
}

test('actual supplied-reference setup waits for observed PCM before creating a native video source', async () => {
  const first = Promise.withResolvers(), fixture = controlled(first.promise);
  const settingUp = fixture.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.includes('video-create'), false);
  assert.equal(fixture.calls.includes('pcm-await'), true);
  first.resolve({ timestampUs: 100000, observedPageMs: 101 });
  await settingUp;
  assert.ok(fixture.calls.indexOf('pcm-observed') < fixture.calls.indexOf('video-create'));
});

test('missing initial PCM refuses video creation and retires the owned audio observation', async () => {
  const first = Promise.withResolvers(), fixture = controlled(first.promise);
  const settingUp = fixture.start();
  const refused = assert.rejects(settingUp, /prescribed missing PCM/);
  void refused.catch(() => undefined);
  await new Promise(resolve => setImmediate(resolve));
  first.reject(new Error('prescribed missing PCM'));
  await refused;
  assert.equal(fixture.calls.includes('video-create'), false);
  assert.ok(fixture.calls.includes('observer-stop'));
  assert.ok(fixture.calls.includes('audio-stop'));
  assert.ok(fixture.calls.includes('context-close'));
});


test('actual generated setup works without a physical output device', async () => {
  const fixture = controlled(Promise.resolve({ timestampUs: 100000, observedPageMs: 101 }), { requireSilent: true, requireQuantum: true });
  const result = await fixture.start();
  assert.ok(fixture.calls.includes('pcm-observed'));
  assert.ok(fixture.calls.includes('video-create'));
  assert.deepEqual(result.metrics.observerErrors, []);
});

test('an explicit480-frame source profile changes only the requested latency hint', async () => {
  const fixture = controlled(Promise.resolve({ timestampUs: 100000, observedPageMs: 101 }), {
    requireSilent: true, requireQuantum: true, sourceAudioFrames: 480,
  });
  const result = await fixture.start();
  assert.equal(result.metrics.generatedAudioOutput.requestedCallbackFrames, 480);
  assert.ok(fixture.calls.indexOf('pcm-observed') < fixture.calls.indexOf('video-create'));
  assert.deepEqual(result.metrics.observerErrors, []);
});

test('an ignored silent selector refuses setup and still retires its context', async () => {
  const fixture = controlled(Promise.resolve({ timestampUs: 100000, observedPageMs: 101 }), { ignoreSilent: true });
  await assert.rejects(fixture.start(), /silent.*unavailable/i);
  assert.equal(fixture.calls.includes('video-create'), false);
  assert.ok(fixture.calls.includes('context-close'));
});


test('auxiliary setup failure releases the native video it already acquired', async () => {
  const fixture = controlled(Promise.resolve({}), { ignoreSilent: true, observingReference: false });
  await assert.rejects(fixture.start(), /silent.*unavailable/i);
  assert.ok(fixture.calls.includes('video-create'));
  assert.ok(fixture.calls.includes('video-stop'));
  assert.ok(fixture.calls.includes('context-close'));
});

test('a video retirement error preserves the setup failure and still closes its context', async () => {
  const fixture = controlled(Promise.resolve({}), { ignoreSilent: true, observingReference: false, videoStopError: 'generated video retirement failure' });
  await assert.rejects(fixture.start(), error => {
    assert.match(error.message, /silent.*unavailable/i);
    assert.ok(error.errors.some(value => String(value).includes('generated video retirement failure')));
    return true;
  });
  assert.ok(fixture.calls.includes('context-close'));
});
