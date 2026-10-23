import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sinkFiles from 'node:fs';
import { prepareMatrix } from './matrix-fixture.mjs';
const cli = sinkFiles.readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8');
const begin = cli.indexOf("const long = process.env.RUSHES_M1_LONG === '1';"), end = cli.indexOf('const root = fileURLToPath(', begin);
assert.ok(begin >= 0 && end > begin);
const admission = new Function('process', `${cli.slice(begin, end)};return {sourceAudioSink,sourceAudioFrames};`);
const ordinary = { RUSHES_M1_SOURCE_MODE: 'native-reference' };
const fixture = sinkFiles.readFileSync(new URL('./matrix-fixture.mjs', import.meta.url), 'utf8');
const constructorStart = fixture.indexOf('      toneContext = new AudioContext(');
const constructorEnd = fixture.indexOf('      await toneContext.audioWorklet.addModule(', constructorStart);
assert.ok(constructorStart >= 0 && constructorEnd > constructorStart);
const construct = new Function('AudioContext','sourceAudioFrames','sourceAudioSink','metrics',
  `let toneContext;${fixture.slice(constructorStart,constructorEnd)};return toneContext;`);

test('default source route is explicit and cannot change the128 hint or non-reference modes', () => {
  assert.deepEqual(admission({env:ordinary}), {sourceAudioSink:'none',sourceAudioFrames:128});
  assert.deepEqual(admission({env:{...ordinary,RUSHES_M1_SOURCE_AUDIO_SINK:'default'}}), {sourceAudioSink:'default',sourceAudioFrames:128});
  for (const override of [{RUSHES_M1_SOURCE_AUDIO_SINK:''},{RUSHES_M1_SOURCE_AUDIO_SINK:'speakers'},
    {RUSHES_M1_SOURCE_AUDIO_FRAMES:'480'},{RUSHES_M1_SOURCE_MODE:'container'},{RUSHES_M1_SOURCE_MODE:'native-feedback'}])
    assert.throws(() => admission({env:{...ordinary,RUSHES_M1_SOURCE_AUDIO_SINK:'default',...override}}), /source sink/);
});
test('fixture refuses incompatible source routes before requesting any browser resources', async () => {
  for (const options of [{sourceAudioSink:'unknown'}, {sourceAudioSink:'default',sourceMode:'container'},
    {sourceAudioSink:'default',sourceMode:'native-reference',sourceAudioFrames:480}])
    await assert.rejects(prepareMatrix(options), /source sink/);
});
test('actual AudioContext constructor preserves all options except explicit versus omitted sinkId', () => {
  for (const requested of ['none','default']) {
    let options;const metrics={};
    const AudioContext = class { constructor(value) { options=value;this.sampleRate=48000;this.sinkId=requested==='none'?{type:'none'}:''; } };
    construct(AudioContext,128,requested,metrics);
    assert.deepEqual(options, {sampleRate:48000,latencyHint:128/48000,...(requested==='none'?{sinkId:{type:'none'}}:{})});
    assert.equal(metrics.generatedAudioOutput.type,requested);
    assert.equal(metrics.generatedAudioOutput.requestedCallbackFrames,128);
  }
});
test('requested source route still requires a positive matching observed sink', () => {
  for (const [requested,observed] of [['none',''],['none',{type:'other'}],['default',{type:'none'}],['default','other-device']]) {
    const AudioContext = class { constructor() { this.sinkId=observed;this.sampleRate=48000; } };
    assert.throws(() => construct(AudioContext,128,requested,{}), /audio output is unavailable/);
  }
});
