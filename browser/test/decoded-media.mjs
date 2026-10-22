// Independent decoder for generated optical/tone media. Presentation origins stay intact.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { audioCoordinates, decodedEdgeDelta, temporalEdges } from './media-coordinates.mjs';
const run = promisify(execFile);
export async function decodedSync(videoFile, audioFile, { evidenceDirectory = dirname(audioFile) } = {}) {
  const ffmpeg = process.env.RUSHES_FFMPEG || 'ffmpeg';
  const barcodes = (await run(ffmpeg, ['-v', 'error', '-i', videoFile, '-vf', 'crop=256:32:80:8,scale=16:1:flags=neighbor',
    '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 ** 2 })).stdout;
  const timestamps = JSON.parse((await run(process.env.RUSHES_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', videoFile], { maxBuffer: 8 * 1024 ** 2 })).stdout).frames;
  assert.equal(barcodes.length, timestamps.length * 16, 'Every decoded frame must have one optical ordinal');
  const visual = timestamps.map((frame, index) => {
    let ordinal = 0; for (let bit = 0; bit < 16; bit++) if (barcodes[index * 16 + bit] > 128) ordinal |= 1 << bit;
    return { seconds: Number(frame.best_effort_timestamp_time), ordinal };
  });
  const visualEdges = visual.slice(1).flatMap((frame, index) => frame.ordinal !== visual[index].ordinal
    ? [{ seconds: frame.seconds, ordinal: frame.ordinal, previousOrdinal: visual[index].ordinal }] : []);
  assert.ok(visualEdges.every(edge => edge.ordinal > edge.previousOrdinal), 'Decoded optical ordinals must remain ordered');
  const raw = join(evidenceDirectory, `${videoFile.split(/[\\/]/).at(-1)}-calibration.pcm`);
  const decoded = await run(ffmpeg, ['-y', '-hide_banner', '-v', 'info', '-copyts', '-i', audioFile, '-vn',
    '-af', 'aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=mono,asettb=1/48000,ashowinfo',
    '-c:a', 'pcm_f32le', '-f', 'f32le', raw], { maxBuffer: 16 * 1024 ** 2 });
  await writeFile(raw + '.frames.log', decoded.stderr);
  const bytes = await readFile(raw), rate = 48000, count = 1920;
  const audioFrames = [...decoded.stderr.matchAll(/\[Parsed_ashowinfo_\d+ @ [^\]]+\] n:(\d+) pts:(-?\d+) pts_time:[^ ]+ fmt:flt channels:1 chlayout:mono rate:(\d+) nb_samples:(\d+)/g)]
    .map(match => ({ number: Number(match[1]), pts: Number(match[2]), rate: Number(match[3]), samples: Number(match[4]) }));
  const coordinates = audioCoordinates(audioFrames, bytes.length / 4, rate);
  return referenceSync({ visual, visualEdges, bytes, coordinates, rate, count,
    timeBasis: videoFile === audioFile ? 'same-container presentation timestamps' : 'separate exports at their own presentation origins; no inferred common source epoch' });
}


// Actual optical/PCM observations, independent of the source generator and recorder events.
export function referenceSync({ visual, visualEdges, bytes, coordinates, rate = 48000, count = 1920, timeBasis,
  conversionUncertaintyMs = 0, initialAudioPresentationSeconds, allTransitions = false, cacheAnalysis = true }) {
  assert.ok(Number.isFinite(conversionUncertaintyMs) && conversionUncertaintyMs >= 0);
  let maxWindowDiscontinuityMs = 0, initialAnchorDistanceMs = 0;
  const hann = cacheAnalysis ? Float64Array.from({ length: count }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (count - 1))) : null;
  const coefficients = new Map(), banks = new Map(), windowUncertainty = new Map();
  const power = (sample, frequency) => {
    const start = Math.round(sample - count / 2);
    let coefficient = coefficients.get(frequency);
    if (coefficient === undefined) {
      coefficient = 2 * Math.cos(2 * Math.PI * frequency / rate);
      if (cacheAnalysis) coefficients.set(frequency, coefficient);
    }
    if (start < 0 || start + count > bytes.length / 4) throw new Error('Audio ordinal window is outside decoded PCM');
    let discontinuity = windowUncertainty.get(start);
    if (discontinuity === undefined) {
      discontinuity = coordinates.windowUncertaintyMs(start, start + count - 1);
      if (cacheAnalysis) windowUncertainty.set(start, discontinuity);
    }
    maxWindowDiscontinuityMs = Math.max(maxWindowDiscontinuityMs, discontinuity);
    let previous = 0, older = 0;
    for (let index = 0; index < count; index++) {
      const weight = hann ? hann[index] : 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (count - 1));
      const windowed = bytes.readFloatLE((start + index) * 4) * weight;
      const value = windowed + coefficient * previous - older; older = previous; previous = value;
    }
    return previous ** 2 + older ** 2 - coefficient * previous * older;
  };
  const audioBanks = sample => {
    const key = Math.round(sample - count / 2);
    if (cacheAnalysis && banks.has(key)) return banks.get(key);
    const strongest = base => {
      let best = 0, energy = -1;
      for (let candidate = 0; candidate < 64; candidate++) {
        const measured = power(sample, base + candidate * (base === 500 ? 40 : 80));
        if (measured > energy) { energy = measured; best = candidate; }
      }
      if (energy < 1) throw new Error('Decoded audio anchor is silent or missing');
      return best;
    };
    const result = [strongest(500), strongest(4000)];
    if (cacheAnalysis) banks.set(key, result);
    return result;
  };
  const audioOrdinal = sample => { const [low, high] = audioBanks(sample); return low + 64 * high; };
  let anchorSample = rate * 0.08;
  if (initialAudioPresentationSeconds !== undefined) {
    assert.ok(Number.isFinite(initialAudioPresentationSeconds)
      && initialAudioPresentationSeconds - count / rate / 2 >= visual[0].seconds
      && initialAudioPresentationSeconds + count / rate / 2 < visualEdges[0].seconds,
    'The initial source anchor window must stay inside the actually observed initial video state');
    const actual = coordinates.nearestPresentation(initialAudioPresentationSeconds);
    anchorSample = actual.sample;
    initialAnchorDistanceMs = actual.distanceMs;
    const start = Math.round(anchorSample - count / 2);
    assert.ok(coordinates.atSample(start) >= visual[0].seconds
      && coordinates.atSample(start + count - 1) < visualEdges[0].seconds,
    'The actual PCM anchor window must stay inside the observed initial video state');
  }
  const firstVideoOrdinal = visual[0].ordinal, firstAudioOrdinal = audioOrdinal(anchorSample);
  assert.equal(firstAudioOrdinal, firstVideoOrdinal, 'First audio/video ordinals must anchor to the same actual source phase');
  const selected = temporalEdges(visualEdges, visual[0].seconds, visual.at(-1).seconds);
  const measure = (edge, bounded) => {
    if (!edge) throw new Error('No decoded optical ordinal transition');
    const expected = edge.seconds;
    let preceding = coordinates.nearestPresentation(expected - 0.2), following = coordinates.nearestPresentation(expected + 0.2);
    if (bounded) {
      // Choose real, wholly observed PCM windows at short source endpoints.
      // No optical state or PCM is extrapolated beyond the measured interval.
      let first = Math.ceil(coordinates.nearestPresentation(visual[0].seconds).sample);
      let last = Math.floor(coordinates.nearestPresentation(visual.at(-1).seconds).sample);
      while (coordinates.atSample(first) < visual[0].seconds) first++;
      while (coordinates.atSample(last) > visual.at(-1).seconds) last--;
      const minimum = first + count / 2, maximum = last - count / 2 + 1;
      assert.ok(maximum >= minimum, 'Actual PCM window extent is unmeasured');
      if (preceding.sample < minimum) preceding = { sample: minimum, distanceMs: 0 };
      if (following.sample > maximum) following = { sample: maximum, distanceMs: 0 };
      for (const point of [preceding, following]) {
        const start = Math.round(point.sample - count / 2);
        assert.ok(coordinates.atSample(start) >= visual[0].seconds && coordinates.atSample(start + count - 1) <= visual.at(-1).seconds,
          'Actual PCM window is outside the measured optical extent');
      }
      assert.ok(coordinates.atSample(preceding.sample) < expected && coordinates.atSample(following.sample) > expected,
        'Actual PCM brackets are unmeasured at the optical transition');
    }
    assert.equal(audioOrdinal(preceding.sample), edge.previousOrdinal, 'Audio lower bracket must carry the preceding exact ordinal');
    assert.equal(audioOrdinal(following.sample), edge.ordinal, 'Audio upper bracket must carry the same exact optical ordinal');
    const before = [edge.previousOrdinal % 64, Math.floor(edge.previousOrdinal / 64)];
    const after = [edge.ordinal % 64, Math.floor(edge.ordinal / 64)];
    const endpoints = [];
    for (let bank = 0; bank < 2; bank++) {
      if (before[bank] === after[bank]) continue;
      let lower = preceding.sample, upper = following.sample;
      for (let step = 0; step < 8; step++) {
        const middle = (lower + upper) / 2, measured = audioBanks(middle);
        for (let component = 0; component < 2; component++)
          if (measured[component] !== before[component] && measured[component] !== after[component])
            throw new Error(`Audio contained an unrelated tone in bank ${component} while bracketing ${edge.previousOrdinal}/${edge.ordinal}`);
        if (measured[bank] === after[bank]) upper = middle; else lower = middle;
      }
      endpoints.push(coordinates.atSample(lower), coordinates.atSample(upper));
    }
    const first = Math.min(...endpoints), last = Math.max(...endpoints);
    return { ...decodedEdgeDelta(edge, { ordinal: edge.ordinal, seconds: (first + last) / 2 }),
      audioTransitionBoundsSeconds: { first, last },
      uncertaintyMs: count / rate * 500 + (last - first) * 500
        + maxWindowDiscontinuityMs + initialAnchorDistanceMs + Math.max(preceding.distanceMs, following.distanceMs) + conversionUncertaintyMs };
  };
  const result = { timeBasis,
    audioFirstSeconds: coordinates.firstSeconds, audioEndSeconds: coordinates.endSeconds, audioJoins: coordinates.joins,
    anchor: { firstVideoOrdinal, firstAudioOrdinal }, audioDurationSeconds: bytes.length / 4 / rate,
    visualEdges: visualEdges.length, points: selected.map(edge => measure(edge, false)) };
  if (allTransitions) result.transitionPoints = visualEdges.map(edge => measure(edge, true));
  return result;
}
