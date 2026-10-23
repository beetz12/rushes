// Original streaming PCM mixer. All coordinates come from supplied input references.
export const MIX_RATE = 48000, MIX_FRAMES = 480;
const HISTORY = 64, HALF_KERNEL = 32, PHASES = 1024;
const JITTER_US = 5000, MAX_GAP_US = 250000, SECONDARY_WAIT_US = 40000;
type Timing = { maxResidualUs: number; residualSumUs: number; packets: number; insertedFrames: number; trimmedFrames: number };
const kernels = new Map<number, Float64Array[]>();
function filter(rate: number): Float64Array[] {
  const existing = kernels.get(rate); if (existing) return existing;
  const cutoff = Math.min(1, MIX_RATE / rate) * 0.94;
  const table = Array.from({ length: PHASES + 1 }, (_, phase) => {
    const weights = new Float64Array(HALF_KERNEL * 2); let total = 0;
    for (let tap = 0; tap < weights.length; tap++) {
      const distance = tap - HALF_KERNEL + 1 - phase / PHASES;
      const angle = Math.PI * cutoff * distance;
      const window = Math.abs(distance) >= HALF_KERNEL ? 0 :
        0.42 + 0.5 * Math.cos(Math.PI * distance / HALF_KERNEL) + 0.08 * Math.cos(2 * Math.PI * distance / HALF_KERNEL);
      weights[tap] = (Math.abs(angle) < 1e-12 ? cutoff : Math.sin(angle) / (Math.PI * distance)) * window;
      total += weights[tap];
    }
    for (let tap = 0; tap < weights.length; tap++) weights[tap] /= total;
    return weights;
  });
  kernels.set(rate, table); return table;
}
export class PCMInput {
  readonly timing: Timing = { maxResidualUs: 0, residualSumUs: 0, packets: 0, insertedFrames: 0, trimmedFrames: 0 };
  readonly originUs: number;
  readonly rate: number;
  private capacity: number;
  private samples: [Float32Array, Float32Array];
  private first = 0;
  end = 0;
  constructor(rate: number, originUs: number) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || !Number.isSafeInteger(originUs)) throw new Error('Invalid audio reference format');
    this.rate = rate; this.originUs = originUs;
    this.capacity = Math.ceil(rate / 4) + HISTORY * 2;
    this.samples = [new Float32Array(this.capacity), new Float32Array(this.capacity)];
  }
  get endUs() { return this.originUs + this.end * 1e6 / this.rate; }
  get bufferState() { return { sampleRate: this.rate, originUs: this.originUs, firstSample: this.first, endSample: this.end, capacityFrames: this.capacity }; }
  push(timestampUs: number, left: Float32Array, right: Float32Array) {
    if (!Number.isSafeInteger(timestampUs) || left.length !== right.length || !left.length || left.length > this.rate / 4)
      throw new Error('Invalid or oversized audio packet');
    const residual = timestampUs - (this.originUs + this.end * 1e6 / this.rate);
    this.timing.maxResidualUs = Math.max(this.timing.maxResidualUs, Math.abs(residual));
    this.timing.residualSumUs += residual; this.timing.packets++;
    if (Math.abs(residual) >= MAX_GAP_US) throw new Error(`Audio reference discontinuity reached250ms (residualUs=${residual}, originUs=${this.originUs}, packetUs=${timestampUs}, frames=${this.end}, rate=${this.rate})`);
    // A declared5ms input-clock uncertainty bound, never a reset of the source anchor.
    // Crossing it is an explicit sample-count discontinuity, including gradual skew.
    const adjustment = Math.abs(residual) > JITTER_US ? Math.round(residual * this.rate / 1e6) : 0;
    const skipped = Math.min(left.length, Math.max(0, -adjustment));
    const gap = Math.max(0, adjustment);
    if (this.end + gap + left.length - skipped - this.first > this.capacity) throw new Error('Audio processing exceeded its250ms buffer');
    for (let index = 0; index < gap; index++) this.append(0, 0);
    this.timing.insertedFrames += gap; this.timing.trimmedFrames += skipped;
    for (let index = skipped; index < left.length; index++) {
      if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) throw new Error('Nonfinite audio samples');
      this.append(left[index], right[index]);
    }
  }
  private append(left: number, right: number) {
    this.samples[0][this.end % this.capacity] = left;
    this.samples[1][this.end % this.capacity] = right; this.end++;
  }
  private at(channel: number, index: number) {
    return index < this.first || index < 0 || index >= this.end ? 0 : this.samples[channel][index % this.capacity];
  }
  readyThrough(endUs: number) {
    const position = (endUs - this.originUs) * this.rate / 1e6;
    const exact = this.rate === MIX_RATE && Math.abs(position - Math.round(position)) < 1e-5;
    return position + (exact ? 0 : HALF_KERNEL) <= this.end;
  }
  sample(channel: number, timeUs: number) {
    const position = (timeUs - this.originUs) * this.rate / 1e6;
    const index = Math.floor(position), fraction = position - index;
    if (this.rate === MIX_RATE && Math.abs(position - Math.round(position)) < 1e-5) return this.at(channel, Math.round(position));
    const weights = filter(this.rate)[Math.round(fraction * PHASES)]; let value = 0;
    for (let tap = 0; tap < weights.length; tap++) value += weights[tap] * this.at(channel, index - HALF_KERNEL + 1 + tap);
    return value;
  }
  retire(timeUs: number) {
    const index = Math.floor((timeUs - this.originUs) * this.rate / 1e6) - HISTORY;
    this.first = Math.max(this.first, Math.min(this.end, index));
  }
}
export class TimestampMixer {
  readonly inputs: (PCMInput | undefined)[] = [undefined, undefined];
  readonly diagnostics = { missingSecondaryFrames: 0, incompleteSecondaryKernelFrames: 0, clippedSamples: 0, outputFrames: 0 };
  private cursor = 0;
  get bufferState() { return { cursorFrames: this.cursor, inputs: this.inputs.map(input => input?.bufferState) }; }
  push(source: number, rate: number, timestampUs: number, left: Float32Array, right: Float32Array) {
    if (source !== 0 && source !== 1) throw new Error('Invalid audio input');
    const input = this.inputs[source] ??= new PCMInput(rate, timestampUs);
    if (input.rate !== rate) throw new Error('Audio sample rate changed during this take');
    // Drop only data already past the output cursor, retaining filter history.
    if (this.inputs[0]) input.retire(this.inputs[0].originUs + this.cursor * 1e6 / MIX_RATE);
    input.push(timestampUs, left, right);
  }
  pull(): { timestamp: number; data: Float32Array } | undefined {
    const primary = this.inputs[0]; if (!primary) return;
    const timestamp = primary.originUs + this.cursor * 1e6 / MIX_RATE;
    const end = timestamp + MIX_FRAMES * 1e6 / MIX_RATE;
    if (!primary.readyThrough(end)) return;
    const secondary = this.inputs[1];
    if (!secondary?.readyThrough(end) && primary.endUs - end < SECONDARY_WAIT_US) return;
    const data = new Float32Array(MIX_FRAMES * 2);
    for (let frame = 0; frame < MIX_FRAMES; frame++) {
      const time = timestamp + frame * 1e6 / MIX_RATE;
      const missing = !secondary || time < secondary.originUs || time >= secondary.endUs;
      if (missing) this.diagnostics.missingSecondaryFrames++;
      else if (!secondary.readyThrough(time)) this.diagnostics.incompleteSecondaryKernelFrames++;
      for (let channel = 0; channel < 2; channel++) {
        const value = (primary.sample(channel, time) + (missing ? 0 : secondary.sample(channel, time))) / 2;
        if (Math.abs(value) > 1) this.diagnostics.clippedSamples++;
        data[channel * MIX_FRAMES + frame] = value;
      }
    }
    this.cursor += MIX_FRAMES; this.diagnostics.outputFrames += MIX_FRAMES;
    for (const input of this.inputs) input?.retire(end);
    return { timestamp: Math.round(timestamp), data };
  }
}
// Standard speaker downmix. Source originals keep their full channel layout.
export function stereoPlanes(channels: Float32Array[]): [Float32Array, Float32Array] {
  if (![1, 2, 4, 6].includes(channels.length) || channels.some(channel => channel.length !== channels[0].length))
    throw new Error('Use mono, stereo, quad or5.1 audio for composition');
  if (channels.length === 1) return [channels[0], channels[0]];
  if (channels.length === 2) return [channels[0], channels[1]];
  const left = new Float32Array(channels[0].length), right = new Float32Array(left.length);
  for (let index = 0; index < left.length; index++) {
    if (channels.length === 4) {
      left[index] = (channels[0][index] + channels[2][index]) / 2;
      right[index] = (channels[1][index] + channels[3][index]) / 2;
    } else {
      left[index] = channels[0][index] + Math.SQRT1_2 * (channels[2][index] + channels[4][index]);
      right[index] = channels[1][index] + Math.SQRT1_2 * (channels[2][index] + channels[5][index]);
    }
  }
  return [left, right];
}
