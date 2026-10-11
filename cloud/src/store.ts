import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ShareError, assertShareId, publicManifest, type ShareReservation } from './types.js';
export interface UploadJob { key: string; sha256: string; size: number; uploadId?: string; parts: Record<string,string>; completed?: boolean; provider?: string; }
export interface ShareJob { reservation: ShareReservation; uploads: Record<string,UploadJob> }
export interface JobStore { read(id: string): Promise<ShareJob | undefined>; write(id: string, state: ShareJob): Promise<void>; remove(id: string): Promise<void> }
export class JsonJobStore implements JobStore {
  private pending = new Map<string,Promise<void>>();
  constructor(readonly directory: string) {}
  async read(id: string): Promise<ShareJob | undefined> {
    assertShareId(id);
    try { const data: unknown = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')); const state = data as ShareJob; if (state?.reservation?.id !== id || typeof state.uploads !== 'object') throw new Error('invalid'); return state; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new ShareError('JOB_CORRUPT', 'The local share job could not be read.'); }
  }
  async write(id: string, state: ShareJob): Promise<void> {
    assertShareId(id);
    // State is intentionally typed and projected; arbitrary fields and credentials cannot persist.
    const clean: ShareJob = { reservation: { id, url: state.reservation.url, manifest: publicManifest(state.reservation.manifest) }, uploads: Object.fromEntries(Object.entries(state.uploads).map(([k,v]) => [k, { key:v.key,sha256:v.sha256,size:v.size,uploadId:v.uploadId,parts:v.parts,completed:v.completed,provider:v.provider }])) };
    const next = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const dest = join(this.directory, `${id}.json`); const temp = `${dest}.${randomBytes(8).toString('hex')}.tmp`;
      try { await writeFile(temp, JSON.stringify(clean), { mode:0o600 }); await rename(temp,dest); } finally { await rm(temp, {force:true}); }
    });
    this.pending.set(id,next); await next;
    if (this.pending.get(id) === next) this.pending.delete(id);
  }
  async remove(id: string): Promise<void> { assertShareId(id); await (this.pending.get(id) ?? Promise.resolve()); await rm(join(this.directory, `${id}.json`), {force:true}); }
}
export class MemoryJobStore implements JobStore {
  private data = new Map<string,ShareJob>();
  async read(id: string): Promise<ShareJob | undefined> { const s=this.data.get(id); return s && structuredClone(s); }
  async write(id: string,state: ShareJob): Promise<void> { this.data.set(id,structuredClone(state)); }
  async remove(id: string): Promise<void> { this.data.delete(id); }
}
