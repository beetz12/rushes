// Generated supervised diagnostic only; these stamps never become media timestamps.
export const deliveryPrefix = 'GENERATED_AUDIO_DELIVERY ';
export const deliveryStamp = () => [performance.timeOrigin, performance.now()];
const stamp = value => Array.isArray(value) && value.length === 2 && value.every(number => Number.isFinite(number) && number >= 0);
const globalMs = value => value[0] + value[1];
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
export function readDeliveryRow(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'frames,kind,matched,ordinal,received,sentAfter,sentBefore,source,takeId,version,workerEntered,workerPosted') return;
  if (value.version !== 1 || typeof value.takeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.takeId)
    || !['ready', 'consumed', 'stopped'].includes(value.kind) || typeof value.matched !== 'boolean'
    || !stamp(value.workerPosted) || !stamp(value.received)) return;
  if (value.kind === 'consumed') {
    if (![0, 1].includes(value.source) || !count(value.ordinal) || value.ordinal < 1 || !count(value.frames) || value.frames < 1
      || !stamp(value.workerEntered) || value.workerEntered[0] !== value.workerPosted[0] || globalMs(value.workerEntered) > globalMs(value.workerPosted)) return;
    if (value.matched && (!stamp(value.sentBefore) || !stamp(value.sentAfter) || value.sentBefore[0] !== value.sentAfter[0]
      || value.sentBefore[0] !== value.received[0] || globalMs(value.sentBefore) > globalMs(value.sentAfter) || globalMs(value.sentAfter) > globalMs(value.received))) return;
    if (!value.matched && (value.sentBefore !== null || value.sentAfter !== null)) return;
  } else if ([value.source, value.ordinal, value.frames, value.workerEntered, value.sentBefore, value.sentAfter].some(part => part !== null) || value.matched) return;
  return value;
}
export function deliveryClockBracket(row) {
  if (!readDeliveryRow(row) || !row.matched) return;
  const minimumOffsetMs = globalMs(row.sentBefore) - globalMs(row.workerEntered);
  const maximumOffsetMs = globalMs(row.received) - globalMs(row.workerPosted);
  if (minimumOffsetMs > maximumOffsetMs) return;
  return { minimumOffsetMs, maximumOffsetMs };
}
export function createDeliveryObserver(takeId, readClock = deliveryStamp) {
  const sends = [new Map(), new Map()], posted = [0, 0], received = [0, 0];
  const state = { rows: [], invalid: 0, unpaired: 0, sequenceErrors: 0, dropped: 0 };
  const read = () => { try { const value = readClock(); if (stamp(value)) return value; } catch { /* Diagnostic failure is counted, not substituted for a mixer failure. */ } state.invalid++; return null; };
  return { state,
    prepare(message) {
      if (message?.kind !== 'input' || ![0, 1].includes(message.source) || !count(message.left?.length) || message.left.length < 1) return;
      return { source: message.source, ordinal: posted[message.source] + 1, frames: message.left.length, before: read() };
    },
    sent(token) {
      if (!token) return;
      const source = token.source; posted[source] = token.ordinal;
      sends[source].set(token.ordinal, { ...token, after: read() });
      if (sends[source].size > 64) sends[source].delete(sends[source].keys().next().value);
    },
    receive(message) {
      const meta = message?.generatedDelivery; if (!meta) return;
      if (Object.keys(meta).sort().join(',') !== 'entered,kind,ordinal,posted,takeId,version' || meta.version !== 1 || meta.takeId !== takeId || meta.kind !== message.kind) { state.invalid++; return; }
      const sent = message.kind === 'consumed' ? sends[message.source]?.get(meta.ordinal) : undefined;
      const matched = !!sent && sent.frames === message.frames && stamp(sent.before) && stamp(sent.after);
      const row = { version: 1, takeId, kind: message.kind, source: message.kind === 'consumed' ? message.source : null,
        ordinal: message.kind === 'consumed' ? meta.ordinal : null, frames: message.kind === 'consumed' ? message.frames : null,
        workerEntered: message.kind === 'consumed' ? meta.entered : null, workerPosted: meta.posted,
        sentBefore: matched ? sent.before : null, sentAfter: matched ? sent.after : null, received: read(), matched };
      if (!readDeliveryRow(row)) { state.invalid++; return; }
      if (message.kind === 'consumed') {
        if (meta.ordinal !== received[message.source] + 1) state.sequenceErrors++;
        received[message.source] = meta.ordinal; if (!matched) state.unpaired++;
      }
      if (state.rows.length === 128) { state.rows.shift(); state.dropped++; }
      state.rows.push(row); return row;
    },
  };
}
