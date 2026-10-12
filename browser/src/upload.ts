import type { DraftManifest, DraftStore, RecordingDetail, UploadGrant } from './contracts';
import { RushesAPI, RequestError, trustedURL } from './api';

export type UploadProgress = { phase: 'backup' | 'hashing' | 'video' | 'processing'; completed: number; total: number };
const segmentBytes = 8 * 1024 ** 2;
const checksumConstants = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
// Standard SHA-256 block transform, written here from the algorithm; bounded Blob reads.
export async function blobDigest(blob: Blob, signal?: AbortSignal): Promise<string> {
  const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const schedule = new Uint32Array(64);
  const transform = (input: Uint8Array, offset: number) => {
    const block = new DataView(input.buffer, input.byteOffset + offset, 64);
    for (let pos = 0; pos < 16; pos++) schedule[pos] = block.getUint32(pos * 4);
    for (let pos = 16; pos < 64; pos++) {
      const earlier = schedule[pos - 15], recent = schedule[pos - 2];
      schedule[pos] = (schedule[pos - 16] + (rotate(earlier,7) ^ rotate(earlier,18) ^ (earlier >>> 3)) + schedule[pos - 7] + (rotate(recent,17) ^ rotate(recent,19) ^ (recent >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let pos = 0; pos < 64; pos++) {
      const t1 = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + checksumConstants[pos] + schedule[pos]) >>> 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, pos) => { hash[pos] = (hash[pos] + value) >>> 0; });
  };
  const windowSize = 1024 ** 2;
  let cursor = 0;
  while (cursor + 64 <= blob.size) {
    signal?.throwIfAborted();
    const length = Math.floor(Math.min(windowSize, blob.size - cursor) / 64) * 64;
    const bytes = new Uint8Array(await blob.slice(cursor, cursor + length).arrayBuffer());
    for (let offset = 0; offset < length; offset += 64) transform(bytes, offset);
    cursor += length;
  }
  const tail = new Uint8Array(blob.size - cursor < 56 ? 64 : 128);
  tail.set(new Uint8Array(await blob.slice(cursor).arrayBuffer()));
  tail[blob.size - cursor] = 0x80;
  const ending = new DataView(tail.buffer);
  ending.setUint32(tail.length - 8, Math.floor(blob.size / 0x20000000));
  ending.setUint32(tail.length - 4, (blob.size * 8) >>> 0);
  for (let offset = 0; offset < tail.length; offset += 64) transform(tail, offset);
  signal?.throwIfAborted();
  return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
}
function remoteOffset(response: Response, size: number): number {
  const value = response.headers.get('Upload-Offset');
  if (!value || !/^\d+$/.test(value)) throw new RequestError('UPLOAD_OFFSET', 'The upload provider did not confirm its saved position.');
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset > size) throw new RequestError('UPLOAD_OFFSET', 'The upload provider returned an invalid saved position.');
  const length = response.headers.get('Upload-Length');
  if (length !== null && Number(length) !== size) throw new RequestError('UPLOAD_LENGTH', 'The remote upload belongs to a different file.');
  return offset;
}
async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
type BackupOptions = {
  api: RushesAPI; store: DraftStore; id: string; signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void; transport?: typeof fetch;
};
export async function backupDraft(options: BackupOptions): Promise<void> {
  const { api, store, id, signal, onProgress } = options;
  const transport = options.transport ?? fetch;
  const manifest = await store.load(id);
  const cloudId = manifest.cloudRecordingId;
  if (!cloudId) throw new RequestError('NO_CLOUD_RESERVATION', 'This take has no private cloud reservation. Local bytes stay saved.');
  const acknowledged = (await api.chunks(cloudId, signal)).chunks;
  const descriptors = manifest.tracks.flatMap(track => track.chunks);
  const total = descriptors.reduce((sum, item) => sum + item.bytes, 0);
  let backed = 0;
  for (const chunk of descriptors) {
    signal.throwIfAborted();
    const accepted = acknowledged.find(item => item.track === chunk.track && item.sequence === chunk.sequence);
    if (accepted && (accepted.sha256 !== chunk.sha256 || accepted.bytes !== chunk.bytes)) throw new RequestError('CHUNK_CONFLICT', 'This cloud sequence contains different bytes. Your local original is preserved.');
    if (!accepted) {
      const bytes = await store.readChunk(id, chunk);
      if (bytes.size !== chunk.bytes || await blobDigest(bytes, signal) !== chunk.sha256) throw new RequestError('LOCAL_CHECKSUM', 'A local chunk failed verification. Keep your backup folder and originals.');
      let attempt = 0;
      while (true) {
        signal.throwIfAborted();
        const { checkpointMs: _checkpoint, ...input } = chunk;
        const grant = await api.grant(cloudId, input, signal);
        if (grant.acknowledged) break;
        const uploadURL = new URL(trustedURL(grant.url));
        if (uploadURL.origin !== location.origin) throw new RequestError('UPLOAD_ORIGIN', 'The raw upload grant has an unexpected origin.');
        try {
          const response = await transport(uploadURL.href, { method: 'PUT', credentials: 'same-origin', signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]), headers: { Authorization: `Upload ${grant.token}`, 'Content-Type': chunk.mimeType }, body: bytes });
          const result = await response.json().catch(() => null);
          if (!response.ok || result?.acknowledged !== true) throw new RequestError(result?.error?.code ?? 'CHUNK_UPLOAD', result?.error?.message ?? 'Raw backup was not acknowledged.', response.status);
          break;
        } catch (error) {
          if (signal.aborted || (error instanceof RequestError && error.status > 0 && error.status < 500 && error.status !== 401 && error.status !== 403)) throw error;
          if (++attempt >= 3) throw error;
          await delay(500 * attempt, signal);
        }
      }
    }
    backed += chunk.bytes;
    onProgress({ phase: 'backup', completed: backed, total });
  }
}

export async function uploadDraft(options: {
  api: RushesAPI; store: DraftStore; id: string; signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void; transport?: typeof fetch;
}): Promise<RecordingDetail> {
  const { api, store, id, signal, onProgress } = options;
  const transport = options.transport ?? fetch;
  let manifest: DraftManifest = await store.load(id);
  if (manifest.state !== 'complete') throw new RequestError('INCOMPLETE_RECORDING', 'Download your recovered originals first. Only completed recordings can be hosted.');
  if (!manifest.cloudRecordingId) {
    const created = await api.create({ clientId: id, title: manifest.title, mode: manifest.mode }, signal);
    manifest = { ...manifest, cloudRecordingId: created.id };
    await store.save(manifest);
  }
  const cloudId = manifest.cloudRecordingId!;
  await backupDraft(options);
  onProgress({ phase: 'hashing', completed: 0, total: 1 });
  const composed = await store.trackBlob(id, 'composed');
  if (!composed.size) throw new RequestError('NO_COMPOSED_VIDEO', 'The composed recording has no saved bytes. Download the originals.');
  const finalize = { manifest, composed: { bytes: composed.size, sha256: await blobDigest(composed, signal), mimeType: composed.type } };
  let grant: UploadGrant = (await api.finalize(cloudId, finalize, signal)).upload;
  const journal = async (offset: number) => {
    manifest = { ...manifest, upload: { ...grant, offset } };
    await store.save(manifest);
  };
  await journal(manifest.upload?.uid === grant.uid ? manifest.upload.offset : 0);
  let failures = 0;
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      grant = (await api.finalize(cloudId, finalize, signal)).upload;
      if (Date.parse(grant.expiresAt) <= Date.now()) throw new RequestError('UPLOAD_EXPIRED', 'This upload expired. Your local originals remain available; retry when Rushes can issue a fresh upload.');
    }
    try {
      const url = trustedURL(grant.url);
      const head = await transport(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]), headers: { 'Tus-Resumable': '1.0.0' } });
      if (!head.ok) throw new RequestError('UPLOAD_HEAD', 'Could not resume the video upload.', head.status);
      offset = remoteOffset(head, composed.size);
      await journal(offset);
      onProgress({ phase: 'video', completed: offset, total: composed.size });
      while (offset < composed.size) {
        signal.throwIfAborted();
        const end = Math.min(offset + segmentBytes, composed.size);
        const patch = await transport(url, { method: 'PATCH', credentials: 'omit', signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]), headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: composed.slice(offset, end) });
        if (patch.status !== 204) throw new RequestError('UPLOAD_PATCH', 'Video upload interrupted. Retry will continue from its saved position.', patch.status);
        if (remoteOffset(patch, composed.size) !== end) throw new RequestError('UPLOAD_OFFSET', 'The provider did not acknowledge the sent bytes.');
        offset = end;
        await journal(offset);
        onProgress({ phase: 'video', completed: offset, total: composed.size });
        failures = 0;
      }
      break;
    } catch (error) {
      if (signal.aborted || (error instanceof RequestError && ['UPLOAD_OFFSET', 'UPLOAD_LENGTH'].includes(error.code))) throw error;
      if (++failures >= 3) throw error;
      if (error instanceof RequestError && [401,403,404,410].includes(error.status)) grant = (await api.finalize(cloudId, finalize, signal)).upload;
      await delay(750 * failures, signal);
    }
  }
  onProgress({ phase: 'processing', completed: 1, total: 1 });
  return api.process(cloudId, signal);
}

// One running request per take, one coalesced pending checkpoint. No media bytes are queued here.
export function createLiveBackup(options: Omit<BackupOptions, 'signal'> & { onError: (message: string) => void }) {
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  let pending = false;
  let paused = false;
  const pump = () => {
    if (running || paused || controller.signal.aborted || !pending) return running ?? Promise.resolve();
    running = (async () => {
      while (pending && !controller.signal.aborted) {
        pending = false;
        try { await backupDraft({...options, signal: controller.signal}); }
        catch (error) { if (!controller.signal.aborted) { paused = true; pending = true; options.onError(error instanceof Error ? error.message : 'Cloud backup interrupted.'); } break; }
      }
    })().finally(() => { running = null; });
    return running;
  };
  return {
    enqueue: () => { pending = true; void pump(); },
    retry: () => { paused = false; pending = true; void pump(); },
    flush: async () => { if (running) await running; paused = false; pending = true; await pump(); if (paused) throw new RequestError('LIVE_BACKUP_PAUSED', 'Cloud backup needs retry. Local saved chunks remain available.'); },
    cancel: async () => { controller.abort(new DOMException('Cloud backup cancelled', 'AbortError')); if (running) await running; },
  };
}
