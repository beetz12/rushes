import assert from 'node:assert/strict';

// Receipts use JSON: filesystem inventories have null prototypes in memory,
// which cannot survive that wire format. Compare every recorded value while
// leaving hashes, names and source/artifact identity fully significant.
export function inspectRecordedIdentity(measured, recorded) {
  assert.deepEqual(JSON.parse(JSON.stringify(measured)), recorded, 'Installed app, product source or verifier differs');
}

export function requiredPhysicalRoles(mode) {
  if (mode === 'signal-only') return ['screen', 'system'];
  if (mode === 'display') return ['screen', 'camera', 'mic', 'system'];
  if (mode === 'camera-only') return ['camera', 'mic'];
  assert(['window', 'area'].includes(mode), 'Unknown physical capture mode');
  return ['screen'];
}

export function inspectPhysicalSelection(manifest, request) {
  assert(request && ['display','window','area','camera-only'].includes(request.mode), 'Requested physical scope is required');
  const actual = manifest.sources;
  assert.equal(actual.mode, request.mode, 'Saved capture mode differs from the requested source');
  for (const key of ['displayId','windowId','area']) assert.deepEqual(actual[key], request[key], 'Saved source selection differs: '+key);
  assert.equal(actual.systemAudio, request.systemAudio, 'System audio selection differs');
  for (const [option,key] of [['camera','cameraId'],['mic','microphoneId']]) {
    if (request[option] === 'default') {assert(typeof request[key] === 'string' && request[key].length > 0, 'Expected catalog device is required: '+key);assert.equal(actual[key],request[key], 'Requested device was not selected: '+key);}
    else {assert.equal(request[option], 'none');assert.equal(actual[key], undefined, 'Unexpected device selected: '+key);}
  }
  assert.deepEqual(manifest.tracks.filter(track=>track.present).map(track=>track.role).sort(), requiredPhysicalRoles(request.mode).sort(), 'Saved original roles differ from the requested sources');
}

export function inspectPhysicalDecode(result, roles, durationMs) {
  assert(Number.isFinite(durationMs) && durationMs >= 3000, 'Take is too short for physical qualification');
  assert.equal(result.length, roles.length, 'Each requested original needs an independent decode');
  for (const [index,item] of result.entries()) {
    assert(item.ok && Number.isFinite(item.duration), 'Physical original failed decoding');
    assert(item.decodedTracks?.length > 0, 'Original contains no decoded stream');
    const type=['screen','camera'].includes(roles[index])?'vide':'soun';
    assert(item.decodedTracks.length===1&&item.decodedTracks[0].type===type,'Original stream type differs from its requested role');
    for (const stream of item.decodedTracks) {
      assert(stream.samples > 0, 'Original contains no decoded samples');
      assert(Number.isFinite(stream.firstPTS) && Math.abs(stream.firstPTS) <= 0.1, 'Original start exceeds 100ms');
      assert(Number.isFinite(stream.sampleEnd) && Math.abs(stream.sampleEnd - durationMs / 1000) <= 0.1, 'Original end exceeds 100ms');
      assert(Number.isFinite(stream.maximumGap) && stream.maximumGap <= 0.25, 'Physical original has a gap over 250ms');
    }
  }
}

// Compare measured content edges in their recorded timelines. No offset fitting,
// re-timing, clock correction or nearest-period match is permitted.
export function inspectOnsets(video, audio, durationSeconds, expected) {
  assert(Array.isArray(expected)&&expected.every(Number.isFinite),'Known emitted schedule is required');
  assert.equal(expected.length, 6, 'All six scheduled cues are required');
  assert(Number.isFinite(durationSeconds) && expected.every(t=>t>=0.25&&t<durationSeconds-0.25), 'Take must contain all six scheduled cues with head/tail room');
  const intervals=expected.slice(1).map((time,i)=>time-expected[i]);
  assert(intervals.every(x=>x>0.3)&&intervals.some(x=>Math.abs(x-intervals[0])>0.02),'Reference schedule must be non-periodic');
  const interior = values => values.filter(t => Number.isFinite(t) && t >= 0.25 && t < durationSeconds - 0.25);
  const v = interior(video), a = interior(audio);
  const scheduled=expected;
  assert.equal(v.length, 6, 'Need all six complete, non-periodic fixture pulses');
  assert.equal(a.length, 6, 'Need all six complete, non-periodic fixture pulses');
  assert.equal(v.length, a.length, 'Screen and system-audio pulse counts differ');
  assert.equal(v.length,scheduled.length,'Both tracks may have lost an emitted pulse');
  assert(v.every((t,i)=>Math.abs(t-scheduled[i])<=0.1)&&a.every((t,i)=>Math.abs(t-scheduled[i])<=0.1),'Captured signal differs from the fixed emitted schedule');
  const differences = v.map((t, i) => Math.abs(t - a[i]));
  assert(differences.every(t => t <= 0.1), 'Screen/system-audio content sync exceeds 100ms');
  return {videoOnsets: v, audioOnsets: a, differences, maximumDifference: Math.max(...differences)};
}

export function risingEdges(points, minimumSpacing = 0.15) {
  const edges = []; let previous = false;
  for (const {time, active} of points) {
    assert(Number.isFinite(time) && typeof active === 'boolean', 'Invalid measured signal point');
    if (active && !previous && (!edges.length || time - edges.at(-1) >= minimumSpacing)) edges.push(time);
    previous = active;
  }
  return edges;
}

// Two independent frequencies identify this fixture among other system audio.
// A single-band RMS detector also counts unrelated notifications and music.
export function codedTonePoints(samples,rate=48000) {
  const size=480,frequencies=[1763,2939],points=[];
  for(let start=0;start+size<=samples.length;start+=size) {
    const amplitudes=frequencies.map(frequency=>{
      let real=0,imaginary=0;
      for(let i=0;i<size;i++){const angle=2*Math.PI*frequency*i/rate;real+=samples[start+i]*Math.cos(angle);imaginary+=samples[start+i]*Math.sin(angle);}
      return 2*Math.hypot(real,imaginary)/size;
    });
    points.push({time:start/rate,active:amplitudes.every(x=>x>0.002)&&amplitudes[0]/amplitudes[1]>0.3&&amplitudes[0]/amplitudes[1]<3.3});
  }
  return points;
}
