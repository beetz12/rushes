import test from 'node:test';
import assert from 'node:assert/strict';
import { configureMatrixBrowser } from './matrix-browser-options.mjs';
const base = () => new Map([['headless','new'], ['use-fake-device-for-media-stream',true], ['use-file-for-fake-video-capture','generated.mjpeg'], ['user-data-dir','owned-profile']]);
test('default leaves the original isolated fake-browser configuration intact', () => {
  const options=base(), before=[...options];
  assert.deepEqual(configureMatrixBrowser(options,{platform:'darwin',sourceMode:'native-reference'}),{browserMode:'headless',videoBuffer:'default'});
  assert.deepEqual([...options],before);
});
test('explicit Mac reference profile matches the observed headful CPU launch changes only', () => {
  const options=base();
  configureMatrixBrowser(options,{platform:'darwin',sourceMode:'native-reference',browserMode:'headful',videoBuffer:'cpu'});
  assert.deepEqual([...options],[['use-fake-device-for-media-stream',true],['use-file-for-fake-video-capture','generated.mjpeg'],['user-data-dir','owned-profile'],['disable-video-capture-use-gpu-memory-buffer',true]]);
});
test('headful mode keeps native buffer defaults on Windows',()=>{
  const options=base();configureMatrixBrowser(options,{platform:'win32',sourceMode:'native-reference',browserMode:'headful'});
  assert.equal(options.has('headless'),false);assert.equal(options.has('disable-video-capture-use-gpu-memory-buffer'),false);
});
for(const configuration of [
  {platform:'win32',sourceMode:'native-reference',videoBuffer:'cpu'},
  {platform:'darwin',sourceMode:'container',videoBuffer:'cpu'},
  {platform:'darwin',sourceMode:'native-reference',browserMode:'unknown'},
  {platform:'darwin',sourceMode:'native-reference',videoBuffer:'unknown'},
]) test('invalid configuration fails before changing launch options: '+JSON.stringify(configuration),()=>{
  const options=base(),before=[...options];assert.throws(()=>configureMatrixBrowser(options,configuration));assert.deepEqual([...options],before);
});
