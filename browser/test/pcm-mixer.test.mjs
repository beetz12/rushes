import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
const compiled = await transform(await readFile(new URL('../src/capture/pcm-mixer.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { TimestampMixer, PCMInput } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
const plane = (length, value) => new Float32Array(length).fill(value);
test('fatal buffer diagnostics retain actual bounds and expose no PCM samples',()=>{
  const mix=new TimestampMixer();
  for(let packet=0;packet<25;packet++)mix.push(0,48000,packet*10000,plane(480,.2),plane(480,.2));
  assert.throws(()=>mix.push(0,48000,250000,plane(480,.2),plane(480,.2)),/buffer/);
  assert.deepEqual(mix.bufferState,{cursorFrames:0,inputs:[{sampleRate:48000,originUs:0,firstSample:0,endSample:12000,capacityFrames:12128},undefined]});
  assert.equal(JSON.stringify(mix.bufferState).includes('samples'),false);
});
test('same-rate stereo mix retains input timestamps and distinct channels with half gain', () => {
  const mix = new TimestampMixer();
  for (let packet = 0; packet < 10; packet++) {
    const timestamp = 37000 + packet * 10000;
    mix.push(0, 48000, timestamp, plane(480, .2), plane(480, .4));
    mix.push(1, 48000, timestamp, plane(480, .6), plane(480, -.2));
    const output = mix.pull(); assert.equal(output.timestamp, timestamp);
    assert.ok(output.data.subarray(0, 480).every(sample => Math.abs(sample - .4) < 1e-6));
    assert.ok(output.data.subarray(480).every(sample => Math.abs(sample - .1) < 1e-6));
  }
  assert.equal(mix.diagnostics.missingSecondaryFrames, 0);
});
test('declared clock jitter remains bounded; real gaps and overlaps remain counted', () => {
  const input = new PCMInput(48000, 0);
  for (let packet = 0; packet < 10; packet++) {
    input.push(packet * 10000 + (packet % 2 ? 2700 : 0), plane(480, .1), plane(480, .2));
    input.retire(input.endUs);
  }
  assert.equal(input.end, 4800); assert.equal(input.timing.maxResidualUs, 2700);
  input.push(110000, plane(480, .1), plane(480, .2));
  assert.equal(input.timing.insertedFrames, 480);
  input.retire(input.endUs); input.push(110000, plane(480, .1), plane(480, .2));
  assert.equal(input.timing.trimmedFrames, 480);
  assert.throws(() => input.push(400000, plane(480, 1), plane(480, 1)), /250ms/);
});
test('slower secondary is bounded and missing samples are explicit', () => {
  const mix = new TimestampMixer();
  for (let packet = 0; packet < 5; packet++) mix.push(0, 48000, packet * 10000, plane(480, .2), plane(480, .2));
  const output = mix.pull(); assert.equal(output.timestamp, 0); assert.equal(mix.diagnostics.missingSecondaryFrames, 480);
  assert.ok(output.data.every(sample => Math.abs(sample - .1) < 1e-6));
});
test('producer overrun and format changes fail closed', () => {
  const mix = new TimestampMixer();
  for (let packet = 0; packet < 25; packet++) mix.push(0, 48000, packet * 10000, plane(480, .2), plane(480, .2));
  assert.throws(() => mix.push(0, 48000, 250000, plane(480, .2), plane(480, .2)), /buffer/);
  assert.throws(() => mix.push(0, 44100, 250000, plane(441, .2), plane(441, .2)), /rate changed/);
});
function conversion(rate, packetFrames, frequency) {
  const count = Math.round(rate * .2), input = new PCMInput(rate, 37000), output = [];
  let next = 0;
  for (let offset = 0; offset < count; offset += packetFrames) {
    const frames = Math.min(packetFrames, count - offset);
    const data = Float32Array.from({ length: frames }, (_, i) => Math.sin((offset + i) * 2 * Math.PI * frequency / rate));
    input.push(Math.round(37000 + offset * 1e6 / rate), data, data);
    while (input.readyThrough(37000 + (next + 1) * 1e6 / 48000)) {
      output.push(input.sample(0, 37000 + next * 1e6 / 48000)); next++;
    }
    input.retire(37000 + next * 1e6 / 48000);
  }
  return output;
}
test('streaming sinc rate conversion preserves phase and is independent of packet boundaries', () => {
  for (const rate of [44100, 96000]) {
    const a = conversion(rate, 441, 1000), b = conversion(rate, 777, 1000);
    assert.deepEqual(a, b);
    const stable = a.slice(200, -200);
    const error = stable.reduce((total, sample, index) => total + (sample - Math.sin((index + 200) * 2 * Math.PI * 1000 / 48000)) ** 2, 0) / stable.length;
    assert.ok(error < 1e-6, `rate${rate} error${error}`);
  }
});
test('96kHz to48kHz rejects an above-Nyquist signal without folded audible energy', () => {
  const samples = conversion(96000, 960, 30000).slice(200, -200);
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  assert.ok(rms < .001, `alias RMS${rms}`);
});
test('input displacement is preserved and unequal packet lengths neither invent phase nor lose samples', () => {
  const mix = new TimestampMixer();
  for (let packet = 0; packet < 12; packet++) {
    mix.push(0, 48000, 100000 + packet * 10000, plane(480, 0), plane(480, 0));
    if (packet % 2 === 0) mix.push(1, 48000, 137000 + packet * 10000, plane(960, .6), plane(960, .6));
    const output = mix.pull();
    if (!output) continue;
    for (let sample = 0; sample < 480; sample++) {
      const timestamp = output.timestamp + sample * 1e6 / 48000;
      assert.ok(Math.abs(output.data[sample] - (timestamp < 137000 ? 0 : .3)) < 1e-6);
    }
  }
  assert.equal(mix.inputs[1].timing.insertedFrames, 0); assert.equal(mix.inputs[1].timing.trimmedFrames, 0);
});
test('speaker downmix keeps rear/center content and excludes5.1 LFE', async () => {
  const { stereoPlanes } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
  assert.deepEqual(stereoPlanes([plane(1, 1), plane(1, 2), plane(1, 3), plane(1, 4)]).map(value => value[0]), [2, 3]);
  const output = stereoPlanes([plane(1, 1), plane(1, 2), plane(1, 3), plane(1, 100), plane(1, 4), plane(1, 5)]);
  assert.ok(Math.abs(output[0][0] - (1 + Math.SQRT1_2 * 7)) < 1e-6);
  assert.ok(Math.abs(output[1][0] - (2 + Math.SQRT1_2 * 8)) < 1e-6);
});
