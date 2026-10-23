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
  const file = await (await directory.getFileHandle(name)).getFile();
  if (file.size > 16 * 1024 ** 2) throw new Error('Stored metadata exceeds the local read safety limit. Its bytes are retained.');
  return file.text();
}
function nonnegative(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) return false;
  return value >= 0;
}
const validChunk = (chunk: ChunkDescriptor, kind: TrackKind) => chunk && chunk.track === kind &&
    Number.isInteger(chunk.sequence) && chunk.sequence >= 0 && chunk.sequence < sequenceLimit &&
    Number.isInteger(chunk.bytes) && chunk.bytes >= 0 && chunk.bytes <= chunkLimit &&
    typeof chunk.sha256 === 'string' && /^[a-f0-9]{64}$/.test(chunk.sha256) &&
    typeof chunk.mimeType === 'string' && nonnegative(chunk.checkpointMs);
function inspectManifest(value: unknown, id: string): DraftManifest {
  const manifest = value as DraftManifest;
  if (!manifest || manifest.schema !== 'rushes.browser-recording/1' || manifest.id !== id ||
    typeof manifest.title !== 'string' || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !['screen', 'camera', 'screen-camera'].includes(manifest.mode) ||
    !['ready', 'recording', 'paused', 'stopping', 'complete', 'interrupted', 'failed'].includes(manifest.state) ||
    !nonnegative(manifest.durationMs) || !nonnegative(manifest.epochMs) || !nonnegative(manifest.lastCheckpointMs) ||
    !manifest.bubble || ![manifest.bubble.x, manifest.bubble.y, manifest.bubble.size].every(nonnegative) ||
    typeof manifest.persistent !== 'boolean' || typeof manifest.backupFolder !== 'boolean' ||
    !Array.isArray(manifest.pauses) || !Array.isArray(manifest.events) ||
    !Array.isArray(manifest.tracks) || manifest.tracks.length > kinds.length ||
    new Set(manifest.tracks.map(track => track?.kind)).size !== manifest.tracks.length ||
    !manifest.tracks.every(track => track && kinds.includes(track.kind) && typeof track.mimeType === 'string' &&
      nonnegative(track.startOffsetMs) && (track.startOffsetTimeBasis === undefined
        || ['media-recorder-start-event', 'unknown'].includes(track.startOffsetTimeBasis)) && nonnegative(track.bytes) && Array.isArray(track.chunks) &&
      track.chunks.length <= sequenceLimit && track.chunks.every(chunk => validChunk(chunk, track.kind))))
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
  const aliases = new Map<string, string>();
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
  const directory = (id: string, create = false) => root.getDirectoryHandle(aliases.get(identifier(id)) ?? id, { create });
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
  async function diagnostic(folder: FileSystemDirectoryHandle | undefined, id: string, error: unknown): Promise<DraftManifest> {
    const tracks: DraftManifest['tracks'] = [];
    const notes = ['Recording recovery could not finish. Original metadata and all files are retained.',
      'Duration, original date, source mode, offsets and protection settings are unknown; mode is inferred from recognized filenames.'];
    notes.push(error instanceof Error ? error.message : String(error));
    let modified = 0, unindexed = 0;
    const iterable = folder as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
    try {
      if (!folder) throw new Error('This retained folder could not be opened.');
      for await (const entry of iterable.values()) {
        if (entry.kind !== 'file') { unindexed++; continue; }
        const file = await (await folder.getFileHandle(entry.name)).getFile();
        modified = Math.max(modified, file.lastModified);
        const match = /^(screen|camera|microphone|tab-audio|composed)-(\d{5})\.bin$/.exec(entry.name);
        if (!match || Number(match[2]) >= sequenceLimit || file.size > chunkLimit) { unindexed++; continue; }
        const kind = match[1] as TrackKind, sequence = Number(match[2]);
        let track = tracks.find(value => value.kind === kind);
        if (!track) { track = { kind, mimeType: ['microphone', 'tab-audio'].includes(kind) ? 'audio/webm' : 'video/webm', startOffsetMs: 0, startOffsetTimeBasis: 'unknown', chunks: [], bytes: 0 }; tracks.push(track); }
        try {
          const descriptor: ChunkDescriptor = { track: kind, sequence, bytes: file.size, sha256: await chunkDigest(file), mimeType: track.mimeType, checkpointMs: 0 };
          track.chunks.push(descriptor); track.bytes += file.size;
        } catch (failure) { notes.push(`A retained chunk could not be indexed: ${failure instanceof Error ? failure.message : String(failure)}`); }
      }
    } catch (failure) { notes.push(`Some retained files could not be inspected: ${failure instanceof Error ? failure.message : String(failure)}`); }
    for (const track of tracks) {
      track.chunks.sort((left, right) => left.sequence - right.sequence);
      if (track.chunks.some((chunk, position) => chunk.sequence !== position)) notes.push(`The ${track.kind} original has a gap; available bytes remain downloadable.`);
    }
    if (unindexed) notes.push(`${unindexed} additional metadata or unrecognized entries remain untouched.`);
    notes.push(modified ? 'The date shown is the latest retained file modification, not the recording date.' : 'No readable file date is available; the date field is unknown.');
    const screen = tracks.some(track => track.kind === 'screen'), camera = tracks.some(track => track.kind === 'camera');
    // This diagnostic is an in-memory recovery view. Never replace an unreadable
    // manifest with inferred metadata, or delete unknown files while enumerating.
    return { schema: 'rushes.browser-recording/1', id, title: 'Recording needs recovery', createdAt: new Date(modified).toISOString(),
      mode: screen && camera ? 'screen-camera' : camera ? 'camera' : 'screen', state: 'interrupted', durationMs: 0, epochMs: 0,
      tracks, pauses: [], events: [{ timeMs: 0, kind: 'metadata-unreadable' }], bubble: { x: 1040, y: 500, size: 180 },
      lastCheckpointMs: 0, persistent: false, backupFolder: false, recoveryNote: notes.join(' '), };
  }
  async function reconcile(id: string, interrupted: boolean, verified?: Map<string, File>) {
    const folder = await directory(id);
    let manifest: DraftManifest;
    try { manifest = await stored(id); }
    catch (error) { return diagnostic(folder, id, error); }
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
          if (!chunk || !validChunk(chunk, track.kind) || chunk.sequence !== sequence || chunk.bytes !== data.size || chunk.sha256 !== digest) {
            chunk = { track: track.kind, sequence, bytes: data.size, sha256: digest, mimeType: track.mimeType, checkpointMs: manifest.lastCheckpointMs };
            notes.push(`Recovered uncheckpointed bytes for ${track.kind}.`);
          }
          descriptors.set(sequence, chunk); changed = true;
        } else if (chunk.bytes !== data.size || chunk.sha256 !== digest) {
          notes.push(`Checksum mismatch in ${name}; original bytes retained.`);
        }
        if (chunk && chunk.bytes === data.size && chunk.sha256 === digest) verified?.set(name, data);
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
    if (notes.length) { manifest.state = 'interrupted'; changed = true; }
    if (manifest.state === 'interrupted') {
      const durable = Math.max(manifest.lastCheckpointMs, ...manifest.tracks.flatMap(track => track.chunks.map(chunk => chunk.checkpointMs)));
      if (durable > manifest.lastCheckpointMs) { manifest.lastCheckpointMs = durable; changed = true; }
      if (durable > manifest.durationMs) { manifest.durationMs = durable; changed = true; }
      notes.push('Recovered duration is an estimate from durable chunk checkpoints, not a decoded length; unclosed encoder tail may be missing.');
    }
    const additions = [...new Set(notes)].filter(note => !manifest.recoveryNote?.includes(note));
    if (additions.length) {
      manifest.recoveryNote = [manifest.recoveryNote ?? '', ...additions].filter(Boolean).join(' ');
      changed = true;
    }
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
      const terminal = !['ready', 'recording', 'paused', 'stopping'].includes(manifest.state);
      try {
        inspectManifest(manifest, manifest.id);
        const disk = await stored(manifest.id);
        const merged = structuredClone(manifest);
        // Capture's in-memory metadata cannot erase append's newer durable journal.
        for (const track of merged.tracks) {
          const saved = disk.tracks.find(value => value.kind === track.kind);
          if (saved) { track.chunks = saved.chunks; track.bytes = saved.bytes; }
        }
        merged.lastCheckpointMs = Math.max(disk.lastCheckpointMs, merged.lastCheckpointMs);
        await checkpoint(await directory(merged.id), merged);
        await backupCheckpoint(merged);
      } finally { if (terminal) releaseLease(manifest.id); }
    }),
    load: id => serialized(id, () => reconcile(id, true)),
    list: async () => {
      const manifests: DraftManifest[] = [];
      const iterable = root as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
      for await (const entry of iterable.values()) if (entry.kind === 'directory') {
        let id = entry.name;
        try { identifier(id); }
        catch {
          const bytes = new TextEncoder().encode(entry.name);
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
          id = `recovery-${hash}`; aliases.set(id, entry.name);
        }
        manifests.push(await serialized(id, async () => {
          let folder: FileSystemDirectoryHandle | undefined;
          try { folder = await root.getDirectoryHandle(entry.name); return await reconcile(id, true); }
          catch (error) { return diagnostic(folder, id, error); }
        }));
      }
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
    readSnapshot: id => {
      const queued = performance.now();
      return serialized(id, async () => {
        const acquired = performance.now(), verified = new Map<string, File>();
        const manifest = await reconcile(id, false, verified), checked = performance.now();
        const tracks = new Map<TrackKind, Blob>();
        let chunks = 0, bytes = 0;
        for (const track of manifest.tracks) {
          const parts = track.chunks.map((chunk, index) => {
            const file = verified.get(`${chunkName(track.kind, chunk.sequence)}.bin`);
            if (chunk.sequence !== index || !file || file.size !== chunk.bytes)
              throw new Error('Stored chunk checksum or sequence failed. Bytes have been retained.');
            chunks++; bytes += file.size; return file;
          });
          tracks.set(track.kind, new Blob(parts, { type: track.mimeType }));
        }
        // These File objects were checked in this locked read. No digest or
        // file cache survives into another append, export or finalization pass.
        return { manifest, tracks, read: { queueWaitMs: acquired - queued, integrityMs: checked - acquired,
          assemblyMs: performance.now() - checked, chunks, bytes } };
      });
    },
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
      try { await root.removeEntry(aliases.get(identifier(id)) ?? id, { recursive: true }); } finally { releaseLease(id); }
      if (backup && !aliases.has(id)) await backup.removeEntry(id, { recursive: true }).catch(error => {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      });
    }),
  };
}
