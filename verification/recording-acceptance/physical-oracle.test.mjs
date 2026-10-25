import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requiredPhysicalRoles, inspectPhysicalDecode, inspectPhysicalSelection, inspectOnsets, risingEdges, codedTonePoints} from './physical-oracle.mjs';

const valid = () => ({ok:true,duration:4,decodedTracks:[{type:'vide',samples:120,firstPTS:0,sampleEnd:4,maximumGap:0.01}]});
test('all physical source modes have explicit separate-original requirements', () => {
  assert.deepEqual(requiredPhysicalRoles('display'), ['screen','camera','mic','system']);
  assert.deepEqual(requiredPhysicalRoles('camera-only'), ['camera','mic']);
  assert.deepEqual(requiredPhysicalRoles('area'), ['screen']);
  assert.throws(() => requiredPhysicalRoles('generated'));
});
test('physical decoder rejects missing, corrupt, empty, shifted and starved originals', () => {
  inspectPhysicalDecode([valid()], ['screen'], 4000);
  for (const mutate of [v=>{v.ok=false;},v=>{v.decodedTracks=[];},v=>{v.decodedTracks[0].samples=0;},v=>{v.decodedTracks[0].firstPTS=0.101;},v=>{v.decodedTracks[0].sampleEnd=3.899;},v=>{v.decodedTracks[0].maximumGap=0.251;}]) {
    const v=valid();mutate(v);assert.throws(()=>inspectPhysicalDecode([v],['screen'],4000));
  }
  assert.throws(()=>inspectPhysicalDecode([],['screen'],4000));
});
test('non-periodic content comparison measures sync without correcting a shifted take', () => {
  const video=[0.4,1.1,2.4,3.3,4.95,5.5];
  assert(inspectOnsets(video,video.map(x=>x+0.035),8,video).maximumDifference<0.04);
  for(const offset of [0.101,0.5,1.2,-0.2])assert.throws(()=>inspectOnsets(video,video.map(x=>x+offset),8,video));
  assert.throws(()=>inspectOnsets(video,video.slice(1),8,video));
  assert.throws(()=>inspectOnsets([1],[1],8,[1]));
  assert.throws(()=>inspectOnsets(video.slice(1),video.slice(1),8,video));
  assert.throws(()=>inspectOnsets([1,2,3],[1,2,3],8,[1,2,3]));
});
test('original role cannot be satisfied by a different decoded media type',()=>{
  assert.throws(()=>inspectPhysicalDecode([valid()],['system'],4000));
  const audio=valid();audio.decodedTracks[0].type='soun';
  assert.throws(()=>inspectPhysicalDecode([audio],['camera'],4000));
  inspectPhysicalDecode([audio],['mic'],4000);
});
test('edge extraction retains measured times and debounces a repeated active sample', () => {
  assert.deepEqual(risingEdges([{time:0,active:false},{time:0.4,active:true},{time:0.41,active:true},{time:0.5,active:false},{time:1.1,active:true}]),[0.4,1.1]);
});
test('coded audio source rejects unrelated single tones without changing onset timing',()=>{
  const make=frequencies=>Float32Array.from({length:48000},(_,i)=>i>=19200&&i<25920?frequencies.reduce((sum,f)=>sum+0.01*Math.sin(2*Math.PI*f*i/48000),0):0);
  const matched=risingEdges(codedTonePoints(make([1763,2939])));
  assert.equal(matched.length,1);assert(Math.abs(matched[0]-0.4)<=0.01);
  for(const frequencies of [[880],[1763],[2939],[1000,2000]])assert.equal(risingEdges(codedTonePoints(make(frequencies))).length,0);
});

test('a shortened take or reference cannot qualify only a prefix of the six cues',()=>{
  const six=[0.4,1.1,2.4,3.3,4.95,5.5];
  assert.throws(()=>inspectOnsets(six.slice(0,3),six.slice(0,3),3,six),/six|schedule/i);
  assert.throws(()=>inspectOnsets(six.slice(0,3),six.slice(0,3),8,six.slice(0,3)),/six/i);
  assert.throws(()=>inspectOnsets(six,six,5.7,six),/six|schedule/i);
});
test('saved source selection and exact original roles must match the requested scope',()=>{
  const request={mode:'area',displayId:'display-1',area:{x:100,y:200,width:500,height:300},camera:'none',mic:'none',systemAudio:false};
  const manifest={sources:{mode:'area',displayId:'display-1',area:{...request.area},systemAudio:false},tracks:[{role:'screen',present:true}]};
  inspectPhysicalSelection(manifest,request);
  for(const mutate of [m=>{m.sources.mode='display';},m=>{m.sources.displayId='display-2';},m=>{m.sources.area.x=0;},m=>{m.sources.cameraId='unexpected';},m=>{m.sources.systemAudio=true;},m=>{m.tracks.push({role:'camera',present:true});}]){
    const changed=structuredClone(manifest);mutate(changed);assert.throws(()=>inspectPhysicalSelection(changed,request));
  }
  const window={mode:'window',windowId:'window-42',camera:'none',mic:'none',systemAudio:false};
  const windowManifest={sources:{mode:'window',windowId:'window-42',systemAudio:false},tracks:[{role:'screen',present:true}]};
  inspectPhysicalSelection(windowManifest,window);
  windowManifest.sources.windowId='window-43';assert.throws(()=>inspectPhysicalSelection(windowManifest,window));
});

test('the default device must be the actual selected catalog device',()=>{
 const request={mode:'camera-only',camera:'default',mic:'default',cameraId:'dev-camera-1',microphoneId:'dev-mic-1',systemAudio:false};
 const manifest={sources:{mode:'camera-only',cameraId:'dev-camera-1',microphoneId:'dev-mic-1',systemAudio:false},tracks:[{role:'camera',present:true},{role:'mic',present:true}]};
 inspectPhysicalSelection(manifest,request);
 manifest.sources.cameraId='dev-camera-2';assert.throws(()=>inspectPhysicalSelection(manifest,request));
});
