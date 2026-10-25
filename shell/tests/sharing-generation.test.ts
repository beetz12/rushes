import {afterEach, describe, expect, it, vi} from 'vitest';
import {promises as ownedFiles} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const commits = vi.hoisted(() => ({before: undefined as undefined | ((value: any) => Promise<void>)}));
vi.mock('../src/main/atomic', async importOriginal => {
  const real = await importOriginal<typeof import('../src/main/atomic')>();
  return {...real, atomicJSON: async (path: string, value: unknown) => {await commits.before?.(value); await real.atomicJSON(path, value);}};
});
import {SharingService} from '../src/main/sharing';
afterEach(() => {commits.before = undefined;});
describe('sharing configuration commit ownership', () => {
  for (const stage of ['processing', 'ready']) it(`retires ${stage} metadata writes after settings change without a late success`, async () => {
    const root = await ownedFiles.mkdtemp(join(tmpdir(), 'rushes-commit-'));
    try {
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
      let generation = 0;
      commits.before = async value => {if (value.state === stage) {entered.resolve(); await released.promise;}};
      const reservation = {id: 'controlled-take', url: 'https://example.test/s/controlled-share', manifest: {status: 'processing'}};
      const provider = {supportsAncillaryAssets: false, reserve: vi.fn(async () => reservation), upload: vi.fn(async () => ({kind: 'video', file: 'video.mp4', bytes: 1, sha256: 'fixture'})), publish: vi.fn(async () => ({...reservation, manifest: {status: 'ready'}})), updateMetadata: vi.fn(), delete: vi.fn(), setupCheck: vi.fn()};
      const events: Record<string, unknown>[] = [];
      const engine = {request: async (command: string) => command === 'edit.get' ? {clips: [{sourceStartMs: 0, sourceEndMs: 1000, speed: 1}]} : command === 'show' ? {packagePath: root, manifest: {title: 'Commit fixture', tracks: [], clock: {durationNs: 1e9}}} : {videoPath: 'unread-generated-path', width: 320, height: 180, durationMs: 1000, title: 'Commit fixture', chapters: [], cacheKey: 'fixture', editRevision: 1, editSnapshot: {}}};
      const service = new SharingService(engine, async () => provider, () => 'hosted:service:tenant:user', event => events.push(event), () => generation);
      const operation = service.share('controlled-take', true);
      const rejection = expect(operation).rejects.toThrow();
      await entered.promise; generation++; service.cancelForConfigurationChange(); released.resolve(); await rejection;
      expect(events.some(event => event.event === 'share-progress' && event.state === 'ready')).toBe(false);
      if (stage === 'processing') expect(provider.upload).not.toHaveBeenCalled();
      expect(JSON.parse(await ownedFiles.readFile(join(root, 'share', 'state.json'), 'utf8')).state).toBe('failed');
    } finally {await ownedFiles.rm(root, {recursive: true, force: true});}
  });
  it('reserves the edited timeline rather than rejecting a trimmed long original', async () => {
    const root = await ownedFiles.mkdtemp(join(tmpdir(), 'rushes-edited-share-'));
    try {
      const reservation = {id: 'hosted-recording', url: 'https://example.test/s/share', manifest: {status: 'processing'}};
      const provider = {supportsAncillaryAssets: false, reserve: vi.fn(async () => reservation), upload: vi.fn(async () => ({kind: 'video', file: 'video.mp4', bytes: 1, sha256: 'fixture'})), publish: vi.fn(async () => ({...reservation, manifest: {status: 'ready'}})), updateMetadata: vi.fn(), delete: vi.fn(), setupCheck: vi.fn()};
      const engine = {request: async (command: string) => command === 'show' ? {packagePath: root, manifest: {title: 'Long original', tracks: [{role: 'camera', present: true}], clock: {durationNs: 1800e9}}} : command === 'edit.get' ? {clips: [{sourceStartMs: 0, sourceEndMs: 600000, speed: 2}, {sourceStartMs: 1200000, sourceEndMs: 1500000, speed: 2}]} : {videoPath: 'unread-edited-export', width: 320, height: 180, durationMs: 450000, title: 'Edited video', chapters: [], cacheKey: 'edited', editRevision: 2, editSnapshot: {}}};
      const service = new SharingService(engine, async () => provider, () => 'hosted:service:tenant:user', () => {});
      await service.share('stable-native-take', true);
      expect(provider.reserve).toHaveBeenCalledWith({clientId: 'stable-native-take', title: 'Long original', mode: 'camera', durationMs: 450000});
      expect(provider.upload).toHaveBeenCalledTimes(1);
    } finally {await ownedFiles.rm(root, {recursive: true, force: true});}
  });

});
