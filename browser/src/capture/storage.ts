import { BROWSER_LIMITS, type ChunkDescriptor, type DraftManifest, type DraftStore, type TrackKind } from '../contracts';

const kinds: TrackKind[] = ['screen', 'camera', 'microphone', 'tab-audio', 'composed'];
const directoryName = 'rushes-browser-v1';
const chunkLimit = 64 * 1024 ** 2;
const sequenceLimit = 4096;
const identifier = (id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid local draft identifier.');
  return id;
};
const chunkName = (kind: TrackKind, sequence: number) => {
  if (!kinds.includes(kind) || !Number.isInteger(sequence) || sequence < 0 || sequence >= sequenceLimit)
    throw new Error('Invalid chunk position.');
  return `${kind}-${String(sequence).padStart(5, '0')}`;
};
export async function chunkDigest(blob: Blob): Promise<string> {
  if (blob.size > chunkLimit) throw new Error('A recording chunk exceeded the 64 MiB local safety limit.');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
async function write(directory: FileSystemDirectoryHandle, name: string, contents: Blob | string) {
  const file = await directory.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  try { await writer.write(contents); await writer.close(); }
  catch (error) { await writer.abort().catch(() => undefined); throw error; }
}
async function textFile(directory: FileSystemDirectoryHandle, name: string) {
  return (await (await directory.getFileHandle(name)).getFile()).text();
}
function inspectManifest(value: unknown, id: string): DraftManifest {
  const manifest = value as DraftManifest;
  if (!manifest || manifest.schema !== 'rushes.browser-recording/1' || manifest.id !== id ||
    !Array.isArray(manifest.tracks) || manifest.tracks.length > kinds.length ||
    !manifest.tracks.every(track => kinds.includes(track.kind) && Array.isArray(track.chunks) && track.chunks.length <= sequenceLimit))
    throw new Error(`Draft ${id} has an invalid manifest. Its files have been retained.`);
  return manifest;
}
// File closes commit bytes; descriptor sidecars let recovery reconcile the narrow
// chunk-close / manifest-close crash window without throwing away unjournaled data.
export async function createDraftStore(backup?: FileSystemDirectoryHandle): Promise<DraftStore> {
  if (!navigator.storage?.getDirectory) throw new Error('Chrome local recording storage is unavailable.');
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName, { create: true });
  const tails = new Map<string, Promise<unknown>>();
  const active = new Set<string>();
  const leases = new Map<string, () => void>();
  async function acquireLease(id: string) {
    if (!navigator.locks) { active.add(id); return; }
    let ready: () => void = () => undefined;
    let failed: (error: unknown) => void = () => undefined;
    const acquired = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    void navigator.locks.request(`rushes-active-${id}`, { ifAvailable: true }, async lock => {
      if (!lock) { failed(new Error('This draft is already active in another tab.')); return; }
      active.add(id);
      const finished = new Promise<void>(resolve => leases.set(id, resolve));
      ready(); await finished;
    }).catch(failed);
    await acquired;
  }
  function releaseLease(id: string) {
    active.delete(id); leases.get(id)?.(); leases.delete(id);
  }
  async function isLive(id: string) {
    if (active.has(id)) return true;
    if (!navigator.locks) return false;
    return (await navigator.locks.query()).held?.some(lock => lock.name === `rushes-active-${id}`) ?? false;
  }
  async function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    identifier(id);
    const previous = tails.get(id) ?? Promise.resolve();
    const action = previous.catch(() => undefined).then(() => navigator.locks
      ? navigator.locks.request(`rushes-draft-${id}`, operation) : operation());
    tails.set(id, action);
    try { return await action; }
    finally { if (tails.get(id) === action) tails.delete(id); }
  }
  const directory = (id: string, create = false) => root.getDirectoryHandle(identifier(id), { create });
  async function stored(id: string) {
    const folder = await directory(id);
    return inspectManifest(JSON.parse(await textFile(folder, 'manifest.json')), id);
  }
  async function checkpoint(folder: FileSystemDirectoryHandle, manifest: DraftManifest) {
    await write(folder, 'manifest.json', JSON.stringify(manifest));
  }
  async function backupCheckpoint(manifest: DraftManifest, chunk?: { name: string; data: Blob; descriptor: ChunkDescriptor }) {
    if (!backup) return;
    const folder = await backup.getDirectoryHandle(identifier(manifest.id), { create: true });
    if (chunk) {
      await write(folder, `${chunk.name}.bin`, chunk.data);
      const saved = await (await folder.getFileHandle(`${chunk.name}.bin`)).getFile();
      if (await chunkDigest(saved) !== chunk.descriptor.sha256) throw new Error('Backup chunk verification failed.');
      await write(folder, `${chunk.name}.json`, JSON.stringify(chunk.descriptor));
    }
    await checkpoint(folder, manifest);
  }
  async function reconcile(id: string, interrupted: boolean) {
    const folder = await directory(id);
    const manifest = await stored(id);
    let changed = false;
    const notes: string[] = [];
    const files: string[] = [];
    // TS's DOM declarations lag the standardized async directory iterator.
    const iterable = folder as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
    for await (const name of iterable.keys()) if (/^(screen|camera|microphone|tab-audio|composed)-\d{5}\.bin$/.test(name)) files.push(name);
    for (const track of manifest.tracks) {
      const descriptors = new Map(track.chunks.map(chunk => [chunk.sequence, chunk]));
      for (const name of files.filter(file => file.startsWith(`${track.kind}-`)).sort()) {
        const sequence = Number(name.slice(track.kind.length + 1, -4));
        const data = await (await folder.getFileHandle(name)).getFile();
        const digest = await chunkDigest(data);
        let chunk = descriptors.get(sequence);
        if (!chunk) {
          try { chunk = JSON.parse(await textFile(folder, `${name.slice(0, -4)}.json`)) as ChunkDescriptor; }
          catch (error) {
            if (!(error instanceof DOMException && error.name === 'NotFoundError')) notes.push(`Unreadable journal entry for ${name}.`);
          }
          if (!chunk || chunk.track !== track.kind || chunk.sequence !== sequence || chunk.bytes !== data.size || chunk.sha256 !== digest) {
            chunk = { track: track.kind, sequence, bytes: data.size, sha256: digest, mimeType: track.mimeType, checkpointMs: manifest.lastCheckpointMs };
            notes.push(`Recovered uncheckpointed bytes for ${track.kind}.`);
          }
          descriptors.set(sequence, chunk); changed = true;
        } else if (chunk.bytes !== data.size || chunk.sha256 !== digest) {
          notes.push(`Checksum mismatch in ${name}; original bytes retained.`);
        }
      }
      for (const chunk of descriptors.values()) if (!files.includes(`${chunkName(track.kind, chunk.sequence)}.bin`))
        notes.push(`Missing ${track.kind} chunk file; available bytes retained.`);
      track.chunks = [...descriptors.values()].sort((left, right) => left.sequence - right.sequence);
      track.bytes = track.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
      if (track.chunks.some((chunk, index) => chunk.sequence !== index)) notes.push(`Missing ${track.kind} chunk; available bytes retained.`);
    }
    if (interrupted && !await isLive(id) && ['ready', 'recording', 'paused', 'stopping'].includes(manifest.state)) {
      manifest.state = 'interrupted'; changed = true;
      notes.push('Recording was interrupted. Recovery contains closed chunks through the last checkpoint; encoder tail data may be missing.');
    }
    if (notes.length) { manifest.recoveryNote = [...new Set(notes)].join(' '); manifest.state = 'interrupted'; changed = true; }
    if (changed) await checkpoint(folder, manifest);
    return manifest;
  }
  return {
    create: manifest => serialized(manifest.id, async () => {
      inspectManifest(manifest, manifest.id);
      try { await directory(manifest.id); throw Object.assign(new Error('A draft with this identifier already exists.'), { code: 'DRAFT_EXISTS' }); }
      catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
      const folder = await directory(manifest.id, true);
      await checkpoint(folder, manifest); await acquireLease(manifest.id);
      try { await backupCheckpoint(manifest); }
      catch (error) { releaseLease(manifest.id); throw error; }
    }),
    save: manifest => serialized(manifest.id, async () => {
      inspectManifest(manifest, manifest.id);
      const disk = await stored(manifest.id);
      const merged = structuredClone(manifest);
      // Capture's in-memory metadata cannot erase append's newer durable journal.
      for (const track of merged.tracks) {
        const saved = disk.tracks.find(value => value.kind === track.kind);
        if (saved) { track.chunks = saved.chunks; track.bytes = saved.bytes; }
      }
      merged.lastCheckpointMs = Math.max(disk.lastCheckpointMs, merged.lastCheckpointMs);
      try { await checkpoint(await directory(merged.id), merged); }
      finally { if (!['ready', 'recording', 'paused', 'stopping'].includes(merged.state)) releaseLease(merged.id); }
      await backupCheckpoint(merged);
    }),
    load: id => serialized(id, () => reconcile(id, true)),
    list: async () => {
      const manifests: DraftManifest[] = [];
      const iterable = root as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
      for await (const entry of iterable.values()) if (entry.kind === 'directory') manifests.push(await serialized(entry.name, () => reconcile(entry.name, true)));
      return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    append: (id, track, sequence, blob, checkpointMs) => serialized(id, async () => {
      const name = chunkName(track, sequence);
      if (!Number.isFinite(checkpointMs) || checkpointMs < 0 || !blob.size) throw new Error('Invalid recording chunk.');
      const manifest = await stored(id);
      const item = manifest.tracks.find(value => value.kind === track);
      if (!item) throw new Error('Chunk track is not in this draft.');
      const sha256 = await chunkDigest(blob);
      const prior = item.chunks.find(chunk => chunk.sequence === sequence);
      if (prior) {
        if (prior.sha256 !== sha256 || prior.bytes !== blob.size) throw new Error('Chunk sequence already contains different bytes.');
        await backupCheckpoint(manifest, { name, data: blob, descriptor: prior });
        return prior;
      }
      if (sequence !== item.chunks.length) throw new Error('Chunk sequence must be contiguous.');
      if (manifest.tracks.reduce((total, value) => total + value.bytes, 0) + blob.size > BROWSER_LIMITS.activeRawBytes)
        throw new Error('The 2 GB local take safety limit was reached.');
      const folder = await directory(id);
      const descriptor: ChunkDescriptor = { track, sequence, bytes: blob.size, sha256, mimeType: blob.type || item.mimeType, checkpointMs };
      await write(folder, `${name}.bin`, blob);
      const saved = await (await folder.getFileHandle(`${name}.bin`)).getFile();
      if (saved.size !== blob.size || await chunkDigest(saved) !== sha256) throw new Error('Local chunk verification failed.');
      await write(folder, `${name}.json`, JSON.stringify(descriptor));
      item.chunks.push(descriptor); item.bytes += descriptor.bytes;
      manifest.lastCheckpointMs = Math.max(manifest.lastCheckpointMs, checkpointMs);
      await checkpoint(folder, manifest);
      await backupCheckpoint(manifest, { name, data: blob, descriptor });
      return descriptor;
    }),
    readChunk: (id, chunk) => serialized(id, async () => {
      const file = await (await (await directory(id)).getFileHandle(`${chunkName(chunk.track, chunk.sequence)}.bin`)).getFile();
      if (file.size !== chunk.bytes || await chunkDigest(file) !== chunk.sha256) throw new Error('Stored chunk checksum failed. Bytes have been retained.');
      return file.slice(0, file.size, chunk.mimeType);
    }),
    trackBlob: (id, kind) => serialized(id, async () => {
      const manifest = await reconcile(id, false);
      const track = manifest.tracks.find(value => value.kind === kind);
      if (!track) throw new Error('This original was not recorded.');
      const folder = await directory(id);
      const parts: Blob[] = [];
      for (const chunk of track.chunks) {
        const file = await (await folder.getFileHandle(`${chunkName(kind, chunk.sequence)}.bin`)).getFile();
        if (file.size !== chunk.bytes || await chunkDigest(file) !== chunk.sha256) throw new Error('Stored chunk checksum failed. Bytes have been retained.');
        parts.push(file);
      }
      return new Blob(parts, { type: track.mimeType });
    }),
    remove: id => serialized(id, async () => {
      if (!active.has(id) && await isLive(id)) throw new Error('This draft is recording in another tab. Stop it there before deleting.');
      try { await root.removeEntry(identifier(id), { recursive: true }); } finally { releaseLease(id); }
      if (backup) await backup.removeEntry(id, { recursive: true }).catch(error => {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      });
    }),
  };
}
