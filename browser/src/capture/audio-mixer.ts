import { MIX_FRAMES, TimestampMixer } from './pcm-mixer';

type Message = { kind: 'input'; source: number; rate: number; timestamp: number; left: Float32Array; right: Float32Array }
  | { kind: 'setup' | 'stop' } | { kind: 'written'; sequence: number };
type Endpoint = { onmessage: ((event: MessageEvent<Message>) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };

// The same PCM core can serve real Window ports or the generated Worker reference.
export function installAudioMixer(endpoint: Endpoint, unhandled: (error: unknown) => void = error => { throw error; }): () => void {
  let mix: TimestampMixer | undefined = new TimestampMixer();
  let stopping = false, wake: (() => void) | undefined;
  let written: (() => void) | undefined, outputSequence = 0;
  const diagnostics = () => ({ ...mix!.diagnostics, inputs: mix!.inputs.map(input => input?.timing), modelUncertaintyUs: 5000 });
  function dispose() {
    if (stopping) return;
    stopping = true; wake?.(); written?.(); wake = undefined; written = undefined;
    endpoint.onmessage = null; endpoint.onmessageerror = null; mix = undefined;
  }
  function stop() {
    if (stopping) return;
    const snapshot = diagnostics(); dispose();
    endpoint.postMessage({ kind: 'timing', diagnostics: snapshot }); endpoint.postMessage({ kind: 'stopped' });
  }
  function failure(error: unknown, incoming?: unknown) {
    if (!stopping) endpoint.postMessage({ kind: 'error', message: String(error), diagnostics: {
      ...diagnostics(), failure: { buffers: mix!.bufferState, incoming, outputSequence, receiptPending: !!written },
    } });
    stop();
  }
  function reportFailure(error: unknown, incoming?: unknown) {
    try { failure(error, incoming); }
    catch (refused) { dispose(); unhandled(refused); }
  }
  async function run() {
    while (!stopping) {
      const packet = mix!.pull();
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
      if (outputSequence % (48000 / MIX_FRAMES) === 0) endpoint.postMessage({ kind: 'timing', diagnostics: diagnostics() });
    }
  }
  endpoint.onmessage = event => {
    const message = event.data;
    try {
      if (message.kind === 'stop') { stop(); return; }
      if (stopping) return;
      if (message.kind === 'setup') void run().catch(reportFailure);
      else if (message.kind === 'written') {
        if (message.sequence !== outputSequence || !written) throw new Error('Unexpected composed audio delivery receipt');
        written();
      } else if (message.kind === 'input') {
        mix!.push(message.source, message.rate, message.timestamp, message.left, message.right);
        endpoint.postMessage({ kind: 'consumed', source: message.source, frames: message.left.length }); wake?.();
      }
    } catch (error) { reportFailure(error, message?.kind === 'input' ? { kind: message.kind, source: message.source, rate: message.rate,
      timestampUs: message.timestamp, frames: message.left?.length } : { kind: message?.kind }); }
  };
  endpoint.onmessageerror = () => reportFailure(new Error('Audio mixer input could not be deserialized'));
  return dispose;
}

export function createWindowAudioMixer() {
  const channel = new MessageChannel(); let terminated = false, onerror: ((event: MessageEvent) => void) | null = null;
  const dispose = installAudioMixer(channel.port2, error => {
    if (!terminated) onerror?.(new MessageEvent('messageerror', { data: String(error) }));
  });
  return {
    set onmessage(receive: ((event: MessageEvent) => void) | null) { channel.port1.onmessage = receive && (event => { if (!terminated) receive(event); }); },
    set onerror(receive: ((event: MessageEvent) => void) | null) { onerror = receive; channel.port1.onmessageerror = receive && (event => { if (!terminated) receive(event); }); },
    postMessage(value: unknown, transfer?: Transferable[]) { channel.port1.postMessage(value, transfer ?? []); },
    terminate() {
      if (terminated) return; terminated = true; dispose(); onerror = null;
      channel.port1.onmessage = null; channel.port1.onmessageerror = null;
      channel.port1.close(); channel.port2.close();
    },
  };
}
