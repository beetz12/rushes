import { MIX_FRAMES, TimestampMixer } from './pcm-mixer';
type Message = { kind: 'input'; source: number; rate: number; timestamp: number; left: Float32Array; right: Float32Array }
  | { kind: 'setup' | 'stop' } | { kind: 'written'; sequence: number };
const endpoint = globalThis as unknown as { onmessage: ((event: MessageEvent<Message>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
const mix = new TimestampMixer();
let stopping = false, wake: (() => void) | undefined;
let written: (() => void) | undefined, outputSequence = 0;
const timing = () => endpoint.postMessage({ kind: 'timing', diagnostics: {
  ...mix.diagnostics, inputs: mix.inputs.map(input => input?.timing), modelUncertaintyUs: 5000,
} });
function stop() { if (stopping) return; stopping = true; wake?.(); written?.(); timing(); endpoint.postMessage({ kind: 'stopped' }); }
function failure(error: unknown, incoming?: unknown) {
  if (!stopping) endpoint.postMessage({ kind: 'error', message: String(error), diagnostics: {
    ...mix.diagnostics, inputs: mix.inputs.map(input => input?.timing), modelUncertaintyUs: 5000,
    failure: { buffers: mix.bufferState, incoming, outputSequence, receiptPending: !!written },
  } });
  stop();
}
async function run() {
  while (!stopping) {
    const packet = mix.pull();
    if (!packet) { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; continue; }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const acknowledged = new Promise<void>((resolve, reject) => {
        written = resolve;
        deadline = setTimeout(() => reject(new Error('Composed audio delivery timed out')), 1000);
      });
      endpoint.postMessage({ kind: 'packet', sequence: outputSequence, ...packet }, [packet.data.buffer]);
      await acknowledged;
    } finally { clearTimeout(deadline); written = undefined; }
    if (stopping) break;
    outputSequence++;
    if (outputSequence === 1) endpoint.postMessage({ kind: 'ready' });
    if (outputSequence % (48000 / MIX_FRAMES) === 0) timing();
  }
}
endpoint.onmessage = event => {
  const message = event.data;
  if (message.kind === 'stop') { stop(); return; }
  if (stopping) return;
  try {
    if (message.kind === 'setup') void run().catch(failure);
    else if (message.kind === 'written') {
      if (message.sequence !== outputSequence || !written) throw new Error('Unexpected composed audio delivery receipt');
      written();
    } else if (message.kind === 'input') {
      mix.push(message.source, message.rate, message.timestamp, message.left, message.right);
      endpoint.postMessage({ kind: 'consumed', source: message.source, frames: message.left.length }); wake?.();
    }
  } catch (error) { failure(error, message.kind === 'input' ? { kind: message.kind, source: message.source, rate: message.rate,
    timestampUs: message.timestamp, frames: message.left.length } : { kind: message.kind }); }
};
