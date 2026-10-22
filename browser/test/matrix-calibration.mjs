// Private fixture qualification. Arrival time never becomes a fabricated source clock.
export const CALIBRATION_RATE = 48000;
export const CALIBRATION_PHASE_MS = 500;
export const CALIBRATION_TOLERANCE_MS = 100;

export class ArrivalOrdinalTone {
  constructor(initialOrdinal = null) { this.ordinal = initialOrdinal; this.sourceTimestampUs = null; this.emitted = null; }
  receive({ ordinal, sourceTimestampUs }, receivedAudioFrame) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 65535 || !Number.isFinite(sourceTimestampUs)) throw new Error('Invalid source ordinal/timestamp');
    this.ordinal = ordinal; this.sourceTimestampUs = sourceTimestampUs;
    return { measurement: 'arrival', ordinal, sourceTimestampUs, receivedAudioFrame };
  }
  render(output, firstAudioFrame, sampleRate, onEmission) {
    if (output.length === 0) return;
    if (this.ordinal === null) { output.fill(0); return; }
    if (this.ordinal !== this.emitted) {
      this.emitted = this.ordinal;
      onEmission({ measurement: 'emission', ordinal: this.ordinal, sourceTimestampUs: this.sourceTimestampUs,
        audioFrame: firstAudioFrame, sampleRate, blockLength: output.length });
    }
    const low = 500 + this.ordinal % 64 * 40, high = 4000 + Math.floor(this.ordinal / 64) * 80;
    for (let index = 0; index < output.length; index++) {
      const seconds = (firstAudioFrame + index) / sampleRate;
      output[index] = 0.15 * (Math.sin(seconds * 2 * Math.PI * low) + Math.sin(seconds * 2 * Math.PI * high));
    }
  }
}

function inspectOrdinalStimulus(inputs, emissions, requireNominalClock) {
  const errors = [], phases = [], nominalClockErrors = [];
  if (!Array.isArray(inputs) || !Array.isArray(emissions) || inputs.length < 3 || emissions.length < 3)
    return { qualified: false, errors: ['Actual input/emission coverage is missing'], phases };
  if (inputs.length !== emissions.length) errors.push('Source markers were dropped or collapsed before emission');
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index], emission = emissions[index];
    if (!Number.isInteger(input.ordinal) || !Number.isFinite(input.timestamp) || !emission
      || emission.measurement !== 'emission' || emission.ordinal !== input.ordinal || emission.sourceTimestampUs !== input.timestamp
      || emission.sampleRate !== CALIBRATION_RATE || !Number.isSafeInteger(emission.audioFrame) || emission.audioFrame < 0
      || !Number.isSafeInteger(emission.blockLength) || emission.blockLength <= 0)
      errors.push(`Marker ${index} lacks actual, matching sample-block emission metadata`);
    if (index === 0) continue;
    const previousInput = inputs[index - 1], previousEmission = emissions[index - 1];
    if (input.ordinal !== previousInput.ordinal + 1 || input.timestamp <= previousInput.timestamp
      || !emission || !previousEmission || emission.audioFrame <= previousEmission.audioFrame) {
      errors.push(`Marker ${index} is skipped, reordered or emitted in one block`); continue;
    }
    const sourceSpanMs = (input.timestamp - previousInput.timestamp) / 1000;
    const audioSpanMs = (emission.audioFrame - previousEmission.audioFrame) / CALIBRATION_RATE * 1000;
    // The initial observed phase can be partial. Its first transition is still
    // required and remains in the protected decoded-sync bracket measurement.
    // Every subsequent complete phase must retain the declared 15/30fps shape.
    if (index > 1 && (Math.abs(sourceSpanMs - CALIBRATION_PHASE_MS) > CALIBRATION_TOLERANCE_MS
      || Math.abs(audioSpanMs - CALIBRATION_PHASE_MS) > CALIBRATION_TOLERANCE_MS))
      errors.push(`Phase ${previousInput.ordinal} is compressed or stretched`);
    if (Math.abs(audioSpanMs - sourceSpanMs) > CALIBRATION_TOLERANCE_MS) errors.push(`Phase ${previousInput.ordinal} observer/audio interval differs`);
    const relativeErrorMs = (emission.audioFrame - emissions[0].audioFrame) / CALIBRATION_RATE * 1000
      - (input.timestamp - inputs[0].timestamp) / 1000;
    if (Math.abs(relativeErrorMs) > CALIBRATION_TOLERANCE_MS) {
      const error = `Marker ${input.ordinal} relative delivery deformation exceeds100ms`;
      nominalClockErrors.push(error);
      if (requireNominalClock) errors.push(error);
    }
    phases.push({ ordinal: previousInput.ordinal, sourceSpanMs, audioSpanMs, relativeErrorMs });
  }
  return { qualified: errors.length === 0, errors, phases,
    ...(requireNominalClock ? {} : { nominalSampleClock: { qualified: nominalClockErrors.length === 0, errors: nominalClockErrors,
      scope: 'Nominal sample-count versus optical PTS diagnostic; not a supplied-PCM presentation measurement' } }),
    scope: 'Source/observer emission shape only; no common epoch, encoder startup or product-sync acceptance inferred' };
}
export function qualifyOrdinalStimulus(inputs, emissions) {
  return inspectOrdinalStimulus(inputs, emissions, true);
}
// Native reference assembly must independently measure every actual PCM/optical
// transition. This result alone never grants product-sync eligibility.
export function requireOrdinalEmissionShape(inputs, emissions) {
  const result = inspectOrdinalStimulus(inputs, emissions, false);
  if (!result.qualified) throw new Error(`CALIBRATION_STIMULUS_INVALID: ${JSON.stringify(result)}`);
  return result;
}
export function requireQualifiedOrdinalStimulus(inputs, emissions) {
  const result = qualifyOrdinalStimulus(inputs, emissions);
  if (!result.qualified) throw new Error(`CALIBRATION_STIMULUS_INVALID: ${JSON.stringify(result)}`);
  return result;
}
