import { createDeliveryObserver, deliveryPrefix } from './audio-delivery-observation.mjs';
import { lateAudioMetadata } from './startup-metadata.mjs';
// One generated diagnostic's explicit dependencies; never installs production hooks.
export function generatedAudioWorkerObserver({ NativeWorker, metrics, baseURL, getTakeId, getFailureAt, startup, audioTiming = false, now = () => performance.now(), emitDelivery = row => console.info(deliveryPrefix + JSON.stringify(row)) }) {
  let observed, delivery, flushed = false; const lateKinds = new Set();
  metrics.audioLateDropped = 0; metrics.audioLateInvalid = 0; metrics.audioFailureDetailsInvalid = 0; metrics.audioDeliveryLateRows = 0;
  const Worker = class extends NativeWorker {
    constructor(...args) {
      const requested = new URL(args[0], baseURL);
      const audio = requested.origin === new URL(baseURL).origin && requested.username === '' && requested.password === ''
        && requested.pathname === '/src/capture/audio.worker.ts';
      const instrumented = new URL('./observed-audio.worker.mjs', import.meta.url);
      if (audioTiming && audio) instrumented.searchParams.set('takeId', getTakeId());
      super(...(audioTiming && audio ? [instrumented, args[1]] : args));
      if (!audio) return;
      if (observed) { metrics.observerErrors.push({ name: 'audio-worker-identity', message: 'Multiple generated audio workers' }); return; }
      observed = this; metrics.audioWorkerIdentity = { id: 0, pathname: '/src/capture/audio.worker.ts' };
      if (audioTiming) { delivery = createDeliveryObserver(getTakeId()); metrics.audioDelivery = delivery.state; }
      if (audioTiming) metrics.audioDeliveryIdentity = { requestedPathname: '/src/capture/audio.worker.ts', wrapperPathname: instrumented.pathname, takeId: getTakeId(), metadataObserved: false };
      this.addEventListener('message', event => {
        const row = delivery?.receive(event.data), failedAt = getFailureAt();
        if (row) metrics.audioDeliveryIdentity.metadataObserved = true;
        if (row && failedAt !== undefined && metrics.audioDeliveryLateRows++ < 8) emitDelivery(row);
        if (failedAt === undefined || !['consumed', 'error', 'stopped'].includes(event.data?.kind)) return;
        if (lateKinds.has(event.data.kind)) { metrics.audioLateDropped++; return; }
        const candidate = { event: event.data.kind, afterMs: Math.ceil(now() - failedAt),
          ...(event.data.kind === 'consumed' ? { source: event.data.source, frames: event.data.frames } : {}),
          ...(event.data.kind === 'error' ? { message: typeof event.data.message === 'string' ? event.data.message.slice(0, 512) : event.data.message } : {}) };
        const detail = lateAudioMetadata(candidate);
        if (!detail) { metrics.audioLateInvalid++; return; }
        lateKinds.add(detail.event); startup({ kind: 'audio-late', workerId: 0, ...detail });
      });
    }
  };
  if (audioTiming) Worker.prototype.postMessage = function (message, ...transfer) {
    const token = this === observed ? delivery?.prepare(message) : undefined;
    const result = NativeWorker.prototype.postMessage.call(this, message, ...transfer);
    if (token) delivery.sent(token); return result;
  };
  return { Worker, flushDelivery() {
    if (!flushed && delivery && getFailureAt() !== undefined) { flushed = true; for (const row of delivery.state.rows.slice(-16)) emitDelivery(row); }
  } };
}
