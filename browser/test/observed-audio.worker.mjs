// Static import installs the real mixer before the implicit Worker message queue opens.
import '../src/capture/audio.worker.ts';
import { deliveryStamp } from './audio-delivery-observation.mjs';
const takeId = new URL(location.href).searchParams.get('takeId');
const nativePost = globalThis.postMessage.bind(globalThis), nativeReceive = globalThis.onmessage;
const ordinals = [0, 0], pending = [[], []];
globalThis.onmessage = function (event) {
  const message = event.data;
  if (message?.kind === 'input' && [0, 1].includes(message.source)) {
    const queue = pending[message.source];
    const ordinal = ++ordinals[message.source];
    if (queue.length < 32) queue.push({ ordinal, entered: deliveryStamp() });
  }
  return nativeReceive.call(this, event);
};
globalThis.postMessage = function (message, ...transfer) {
  if (!['ready', 'consumed', 'stopped'].includes(message?.kind)) return nativePost(message, ...transfer);
  const input = message.kind === 'consumed' ? pending[message.source]?.shift() : undefined;
  return nativePost({ ...message, generatedDelivery: { version: 1, takeId, kind: message.kind,
    ordinal: input?.ordinal ?? null, entered: input?.entered ?? null, posted: deliveryStamp() } }, ...transfer);
};
