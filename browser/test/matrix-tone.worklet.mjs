import { ArrivalOrdinalTone } from './matrix-calibration.mjs';

class MatrixTone extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.tone = new ArrivalOrdinalTone(options.processorOptions?.diagnostic ? 0 : null);
    this.port.onmessage = event => {
      try { this.port.postMessage(this.tone.receive(event.data, currentFrame)); }
      catch (error) { this.port.postMessage({ measurement: 'error', message: String(error) }); }
    };
  }
  process(_inputs, outputs) {
    this.tone.render(outputs[0][0], currentFrame, sampleRate, emission => this.port.postMessage(emission));
    return true;
  }
}
registerProcessor('matrix-tone', MatrixTone);
