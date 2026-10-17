import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { synchronizedMedia } from './synchronized-media.mjs';
import { decodedSync } from './decoded-media.mjs';
import { requireDecodedAlignment } from './media-coordinates.mjs';
const run = promisify(execFile);

test('independent encoded source qualifies; real37ms audio shift is retained; real300ms video shift cannot pass', { timeout: 30000 }, async () => {
  const fixtureFiles = await import('node:fs/promises');
  const proof = await fixtureFiles.mkdtemp((await import('node:os')).tmpdir() + '/rushes-decoded-oracle-');
  const fixture = await synchronizedMedia(proof, 4);
  const positive = await decodedSync(fixture, fixture);
  requireDecodedAlignment(positive.points);
  const shiftedAudio = proof + '/audio-plus37ms.webm';
  await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-itsoffset', '0.037', '-i', fixture,
    '-i', fixture, '-map', '1:v:0', '-map', '0:a:0', '-c', 'copy', shiftedAudio]);
  const shifted = await decodedSync(shiftedAudio, shiftedAudio);
  requireDecodedAlignment(shifted.points);
  for (let index = 0; index < 3; index++) assert.ok(Math.abs(shifted.points[index].driftMs - positive.points[index].driftMs + 37) < 5);
  const shiftedVideo = proof + '/video-plus300ms.webm';
  await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-itsoffset', '0.300', '-i', fixture,
    '-i', fixture, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', shiftedVideo]);
  let rejected;
  try { requireDecodedAlignment((await decodedSync(shiftedVideo, shiftedVideo)).points); }
  catch (error) { rejected = String(error); }
  assert.ok(rejected, 'A real300ms displacement must fail without fitting/callback correction');
  await fixtureFiles.writeFile(proof + '/report.json', JSON.stringify({ positive, shifted, rejected }, null, 2));
  console.log('Independent source/oracle evidence:', proof);
});

test('encoded tone-bank rollovers retain both transition bounds and reject unrelated or silent components', { timeout: 45000 }, async () => {
  const fixtureFiles = await import('node:fs/promises');
  const proof = await fixtureFiles.mkdtemp((await import('node:os')).tmpdir() + '/rushes-bank-rollover-');
  const reports = [];
  for (const initial of [60, 124]) {
    const directory = proof + '/' + initial; await fixtureFiles.mkdir(directory);
    const fixture = await synchronizedMedia(directory, 4, initial);
    const positive = await decodedSync(fixture, fixture);
    requireDecodedAlignment(positive.points);
    assert.equal(positive.points[1].ordinal, initial + 4);
    assert.ok(positive.points[1].audioTransitionBoundsSeconds.last >= positive.points[1].audioTransitionBoundsSeconds.first);
    reports.push({ initial, positive });
    if (initial !== 124) continue;
    const shiftedAudio = directory + '/plus37ms.webm';
    await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-itsoffset', '0.037', '-i', fixture,
      '-i', fixture, '-map', '1:v:0', '-map', '0:a:0', '-c', 'copy', shiftedAudio]);
    const shifted = await decodedSync(shiftedAudio, shiftedAudio); requireDecodedAlignment(shifted.points);
    for (let index = 0; index < 3; index++) assert.ok(Math.abs(shifted.points[index].driftMs - positive.points[index].driftMs + 37) < 5);
    const shiftedVideo = directory + '/plus300ms.webm';
    await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-itsoffset', '0.300', '-i', fixture,
      '-i', fixture, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', shiftedVideo]);
    await assert.rejects(async () => requireDecodedAlignment((await decodedSync(shiftedVideo, shiftedVideo)).points));
    const split = directory + '/split-banks.webm';
    const splitTone = "aevalsrc='0.15*(sin(2*PI*(500+mod(floor(t*2)+124,64)*40)*t)+sin(2*PI*(4000+floor((floor((t-0.110)*2)+124)/64)*80)*t))':s=48000";
    await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-i', fixture, '-f', 'lavfi', '-i', splitTone,
      '-codec:a', 'libopus', '-codec:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-t', '4', split]);
    const splitDecoded = await decodedSync(split, split);
    assert.ok(splitDecoded.points[1].uncertaintyMs > 65, 'The union must retain both physically separated component edges');
    assert.throws(() => requireDecodedAlignment(splitDecoded.points), /exceeds100ms/);
    for (const mutation of ['third-tone', 'silence']) {
      const file = directory + '/' + mutation + '.webm';
      const phase = '(floor(t*2)+124)', corruption = 'between(t,1.95,2.05)';
      const high = mutation === 'third-tone' ? `if(${corruption},4560,4000+floor(${phase}/64)*80)` : `4000+floor(${phase}/64)*80`;
      const gain = mutation === 'silence' ? `if(${corruption},0,0.15)` : '0.15';
      const tone = `aevalsrc='${gain}*(sin(2*PI*(500+mod(${phase},64)*40)*t)+sin(2*PI*(${high})*t))':s=48000`;
      await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-i', fixture, '-f', 'lavfi', '-i', tone,
        '-codec:a', 'libopus', '-codec:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-t', '4', file]);
      await assert.rejects(() => decodedSync(file, file), mutation === 'silence' ? /silent or missing/ : /unrelated tone/);
    }
    reports.at(-1).shifted = shifted;
    reports.at(-1).split = splitDecoded;
  }
  await fixtureFiles.writeFile(proof + '/report.json', JSON.stringify(reports, null, 2));
  console.log('Independent bank-rollover controls:', proof);
});
