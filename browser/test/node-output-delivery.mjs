// Generated Windows8s diagnostic only. No browser payload or product-handler changes.
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startupMetadata, startupPrefix } from './startup-metadata.mjs';
const MAX_OUTPUT = 1024 ** 2;
const clock = () => ({ wallMs: Date.now(), monoNs: process.hrtime.bigint().toString() });
export function outputDeliveryMode(value) {
  if (value !== undefined && !['observe-forward', 'retain-only'].includes(value)) throw new Error('Unknown generated output delivery diagnostic');
  return value;
}
export function nodeConsoleLedger({ stamp = clock, limit = 128 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid node observation bound');
  const rows = []; let dropped = 0, firstSlow;
  return {
    receive: () => stamp(),
    record(row, received, operation) {
      if (!startupMetadata(startupPrefix + JSON.stringify(row))) throw new Error('Invalid startup row for Node receipt');
      const entry = { takeId: row.takeId, index: row.index, kind: row.kind, received, beforeConsole: stamp() };
      if (rows.length < limit) rows.push(entry); else dropped++;
      try { return operation(); }
      catch (error) { entry.consoleThrew = true; throw error; }
      finally {
        entry.afterConsole = stamp();
        const duration = BigInt(entry.afterConsole.monoNs) - BigInt(entry.beforeConsole.monoNs);
        entry.consoleSpanNs = duration.toString();
        if (duration > 250_000_000n && !firstSlow) firstSlow = structuredClone(entry);
      }
    },
    snapshot: () => structuredClone({ schema: 'rushes.node-console-receipt/1', rows, dropped, firstSlow,
      scope: 'Process-local call spans; no Actions ingestion or cross-clock latency inferred' }),
  };
}
export function observeChildOutput(child, mode, { stamp = clock, byteLimit = MAX_OUTPUT } = {}) {
  if (!outputDeliveryMode(mode)) throw new Error('An explicit output diagnostic mode is required');
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > MAX_OUTPUT) throw new Error('Invalid retained output bound');
  for (const name of ['stdout', 'stderr']) if (!child[name]?.on || !child[name]?.off) throw new Error('Owned child output pipe is unavailable');
  const channels = {}, handlers = [];
  for (const channel of ['stdout', 'stderr']) {
    const stream = child[channel];
    const state = { bytes: 0, retainedBytes: 0, discardedBytes: 0, buffer: Buffer.alloc(byteLimit), receipts: [], receiptDropped: 0,
      overlongLines: 0, pending: '', skipping: false, decoder: new StringDecoder('utf8'), hash: createHash('sha256') };
    channels[channel] = state;
    function line(value, received) {
      const row = startupMetadata(value); if (!row) return;
      if (state.receipts.length < 128) state.receipts.push({ takeId: row.takeId, index: row.index, kind: row.kind, received });
      else state.receiptDropped++;
    }
    const receive = chunk => {
      const received = stamp();
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected an owned binary output pipe');
      state.bytes += chunk.length; state.hash.update(chunk);
      const count = Math.min(chunk.length, byteLimit - state.retainedBytes);
      if (count) { chunk.copy(state.buffer, state.retainedBytes, 0, count); state.retainedBytes += count; }
      state.discardedBytes += chunk.length - count;
      // A read can split UTF8, the prefix or a JSON row. Never retain an unbounded partial line.
      for (const part of state.decoder.write(chunk).split(/(?<=\n)/)) {
        const complete = part.endsWith('\n');
        if (!state.skipping && state.pending.length + part.length <= 4097) state.pending += part;
        else if (!state.skipping) { state.overlongLines++; state.pending = ''; state.skipping = true; }
        if (complete) {
          if (!state.skipping) line(state.pending.replace(/\r?\n$/, ''), received);
          state.pending = ''; state.skipping = false;
        }
      }
    };
    stream.on('data', receive); handlers.push([stream, receive]);
  }
  let detached = false;
  const snapshot = () => ({ schema: 'rushes.supervisor-output-receipt/1', mode, byteLimit,
    channels: Object.fromEntries(Object.entries(channels).map(([name, s]) => [name, { bytes: s.bytes, retainedBytes: s.retainedBytes,
      discardedBytes: s.discardedBytes, sha256: s.hash.copy().digest('hex'), receipts: structuredClone(s.receipts), receiptDropped: s.receiptDropped,
      overlongLines: s.overlongLines, incompleteLine: Boolean(s.pending.length || s.skipping) }])),
    overflow: Object.values(channels).some(s => s.discardedBytes > 0), detached,
    scope: 'Owned generated child output; local receive stamps, not Actions ingestion or media acceptance' });
  return {
    snapshot,
    async flush(proof, { signal } = {}) {
      // Freeze both channel prefixes and their metadata in one task before any I/O yields.
      const captured = snapshot(), buffers = Object.fromEntries(['stdout', 'stderr'].map(name => [name, Buffer.from(channels[name].buffer.subarray(0, channels[name].retainedBytes))]));
      for (const name of ['stdout', 'stderr']) {
        captured.channels[name].retainedSHA256 = createHash('sha256').update(buffers[name]).digest('hex');
        await writeFile(join(proof, `matrix-child-${name}.log`), buffers[name], { mode: 0o600, signal });
      }
      await writeFile(join(proof, 'supervisor-output-delivery.json'), JSON.stringify(captured), { mode: 0o600, signal });
    },
    detach() { if (!detached) { detached = true; for (const [stream, handler] of handlers) stream.off('data', handler); } },
  };
}
