import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qualifyNativeCalibration} from './native-reference-analysis.mjs';
import {qualifyOrdinalStimulus} from './matrix-calibration.mjs';
import {referenceSync} from './decoded-media.mjs';
import {audioCoordinates} from './media-coordinates.mjs';

function fixture({seconds=8, gapUs=0, delayedOrdinal, delayMs=0, tailMs}={}) {
  const rate=48000, packet=480, origin=1000000, count=seconds*rate;
  const edges=Array.from({length:seconds*2},(_,ordinal)=>Math.ceil(ordinal*rate/2/128)*128);
  const presentation=sample=>100000+Math.floor(sample/packet)*(10000+gapUs)+(sample%packet)/rate*1e6;
  const bytes=Buffer.alloc(count*4), frames=[];
  let ordinal=0;
  for(let sample=0;sample<count;sample++) {
    while(ordinal+1<edges.length && sample>=edges[ordinal+1]+(ordinal+1===delayedOrdinal?delayMs*rate/1000:0))ordinal++;
    const time=sample/rate, low=500+ordinal%64*40, high=4000+Math.floor(ordinal/64)*80;
    bytes.writeFloatLE(.15*(Math.sin(2*Math.PI*low*time)+Math.sin(2*Math.PI*high*time)),sample*4);
  }
  for(let sample=0;sample<count;sample+=packet)frames.push({timestampUs:presentation(sample),frames:packet,rate,channels:1});
  const first=100000, last=tailMs===undefined?presentation(count-1)-33000:presentation(edges.at(-1))+tailMs*1000;
  const input=edges.map((sample,ordinal)=>({ordinal,timestamp:Math.round(origin*1000+presentation(sample)),globalWallMs:sample/rate*1000}));
  const emissions=input.map((edge,index)=>({measurement:'emission',ordinal:edge.ordinal,sourceTimestampUs:edge.timestamp,audioFrame:edges[index],sampleRate:rate,blockLength:128}));
  const snapshot={id:'prescribed-presentation',wallMs:presentation(count-1)/1000+10,metrics:{
    clockCapability:{timeOrigin:1,converter:{qualified:true,unitSlope:1,originIntervalMs:[origin-.1,origin+.1],conservativeSameRealmConversionUncertaintyMs:.401}},
    calibrationInputEdges:input,calibrationAudioEdges:emissions,
    sourceObserverRetirement:{optical:{firstTimestamp:Math.round(origin*1000+first),lastTimestamp:Math.round(origin*1000+last),maxTimestampGapUs:33334,count:seconds*30}},
    frames:{'native-input':{count:seconds*30,firstTimestamp:Math.round(origin*1000+first),lastTimestamp:Math.round(origin*1000+last),maxTimestampGapUs:33334}},
    suppliedReference:{schema:'rushes.supplied-reference-observation/1',sameWindow:true,timeOrigin:1,takeId:'prescribed-presentation',pcmFormat:'f32le',observedPlane:0,storedChannels:1,closed:true,bytes:bytes.length,actualFileBytes:bytes.length,peakPendingBytes:65536,frames}
  }};
  return {snapshot,bytes};
}

test('actual native assembly accepts prescribed PCM presentation joins without fitting the nominal clock',()=>{
  const {snapshot,bytes}=fixture({gapUs:300});
  assert.equal(qualifyOrdinalStimulus(snapshot.metrics.calibrationInputEdges,snapshot.metrics.calibrationAudioEdges).qualified,false);
  const result=qualifyNativeCalibration(snapshot,bytes);
  assert.equal(result.source.qualified,true);
  assert.equal(result.stimulus.nominalSampleClock.qualified,false);
  assert.deepEqual(result.source.decoded.transitionPoints.map(point=>point.ordinal),snapshot.metrics.calibrationInputEdges.slice(1).map(edge=>edge.ordinal));
});

test('an unselected middle waveform error cannot hide behind three good anchors',()=>{
  const {snapshot,bytes}=fixture({delayedOrdinal:4,delayMs:150});
  assert.throws(()=>qualifyNativeCalibration(snapshot,bytes),/alignment|bracket|unmeasured|exceeds100ms/);
});

test('every observed tail transition is checked within its actual short optical extent',()=>{
  const good=fixture({tailMs:133});
  const result=qualifyNativeCalibration(good.snapshot,good.bytes);
  assert.equal(result.source.qualified,true);
  const bad=fixture({tailMs:133,delayedOrdinal:15,delayMs:150});
  assert.throws(()=>qualifyNativeCalibration(bad.snapshot,bad.bytes),/alignment|bracket|unmeasured|exceeds100ms/);
  const short=fixture({tailMs:10});
  assert.throws(()=>qualifyNativeCalibration(short.snapshot,short.bytes),/window|extent|bracket|unmeasured/);
});

test('native assembly still requires actual contiguous matching emission records',()=>{
  const {snapshot,bytes}=fixture();
  for(const mutate of [value=>value.metrics.calibrationAudioEdges.splice(4,1),value=>{value.metrics.calibrationAudioEdges[4].blockLength=0;},value=>{value.metrics.calibrationAudioEdges[4].sampleRate=44100;}]){
    const copy=structuredClone(snapshot);mutate(copy);assert.throws(()=>qualifyNativeCalibration(copy,bytes));
  }
});

test('uncertainty is charged at an otherwise unselected real waveform displacement',()=>{
  const {snapshot,bytes}=fixture({delayedOrdinal:4,delayMs:90});
  assert.throws(()=>qualifyNativeCalibration(snapshot,bytes),/alignment|exceeds100ms/);
});

function rawReference(snapshot,bytes) {
  const metric=snapshot.metrics, origin=metric.clockCapability.converter.originIntervalMs.reduce((a,b)=>a+b)/2;
  const optical=metric.sourceObserverRetirement.optical;
  const first=(optical.firstTimestamp/1000-origin)/1000,last=(optical.lastTimestamp/1000-origin)/1000;
  const rows=metric.calibrationInputEdges.map(edge=>({ordinal:edge.ordinal,seconds:(edge.timestamp/1000-origin)/1000}));
  const scoped=rows.filter(edge=>edge.seconds>first&&edge.seconds<=last),initial=rows.filter(edge=>edge.seconds<=first).at(-1);
  const visual=[{...initial,seconds:first},...scoped,{...scoped.at(-1),seconds:last}];
  const visualEdges=scoped.map((edge,index)=>({...edge,previousOrdinal:index?scoped[index-1].ordinal:initial.ordinal}));
  const frames=metric.suppliedReference.frames.map((frame,number)=>({number,pts:Math.round(frame.timestampUs*48000/1e6),rate:48000,samples:frame.frames}));
  return {visual,visualEdges,bytes,coordinates:audioCoordinates(frames,bytes.length/4),initialAudioPresentationSeconds:first+.08,
    conversionUncertaintyMs:.401+1000/48000,timeBasis:'prescribed actual PCM presentation',allTransitions:true};
}

test('cached and uncached windows preserve exact bounds and uncertainty including joins, endpoints and bank rollover',()=>{
  for(const options of [{},{tailMs:133},{gapUs:300},{seconds:40}]){
    const {snapshot,bytes}=fixture(options),args=rawReference(snapshot,bytes);
    assert.deepEqual(referenceSync({...args,cacheAnalysis:true}),referenceSync({...args,cacheAnalysis:false}));
  }
});

test('spectrum caches cannot survive changed PCM bytes at the same window positions',()=>{
  const good=fixture(),changed=fixture({delayedOrdinal:4,delayMs:150});
  assert.equal(qualifyNativeCalibration(good.snapshot,good.bytes).source.qualified,true);
  changed.bytes.copy(good.bytes);
  assert.throws(()=>qualifyNativeCalibration(good.snapshot,good.bytes),/alignment|bracket|exceeds100ms/);
});
