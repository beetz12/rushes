import * as paths from 'node:path';
import { LibraryThumbnails } from './library-thumbnails';
import * as fsp from 'node:fs/promises';
import * as vt from 'vitest';
import { tmpdir as systemTemp } from 'node:os';

const { afterEach, beforeEach, describe, expect, it } = vt;
const { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } = fsp;
const join = paths.join;
const tmpdir = systemTemp;

let base: string, root: string, cache: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rushes-thumbs-'));
  root = join(base, 'Recordings');
  cache = join(base, 'cache');
  await mkdir(root);
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function makePackage(name: string, files: Record<string, string>) {
  const folder = join(root, name);
  await mkdir(folder);
  for (const [file, body] of Object.entries(files)) await writeFile(join(folder, file), body);
  return folder;
}
function harness(
  render: (path: string) => Promise<Buffer | undefined>,
  concurrency?: number,
  rename?: (from: string, to: string) => Promise<void>,
) {
  const calls: string[] = [];
  const thumbs = new LibraryThumbnails({
    recordingsRoot: root,
    cacheDir: cache,
    concurrency,
    rename,
    render: async (path) => {
      calls.push(path);
      return render(path);
    },
    publish: async (path) => `media:${path}`,
  });
  return { thumbs, calls };
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('library thumbnails', () => {
  it('renders the screen track once and serves the cached poster after', async () => {
    const folder = await makePackage('2026-11-06_10-00-00_AAAAAA', { 'screen.mov': 'video' });
    const { thumbs, calls } = harness(async () => jpeg);
    const first = await thumbs.poster(folder);
    expect(first).toMatch(/^media:.*\/cache\/[0-9a-f]{16}-[0-9a-f]{16}\.jpg$/);
    expect(await thumbs.poster(folder)).toBe(first);
    expect(calls).toHaveLength(1);
    // A fresh instance (next launch) reuses the disk cache.
    const again = harness(async () => jpeg);
    expect(await again.thumbs.poster(folder)).toBe(first);
    expect(again.calls).toHaveLength(0);
  });
  it('prefers a poster already in the package and falls back to the camera track', async () => {
    const withPoster = await makePackage('p1_AAAAAA', { 'poster.jpg': 'x', 'screen.mov': 'v' });
    const cameraOnly = await makePackage('p2_BBBBBB', { 'camera.mov': 'v' });
    const { thumbs, calls } = harness(async () => jpeg);
    expect(await thumbs.poster(withPoster)).toMatch(/^media:.*\/p1_AAAAAA\/poster\.jpg$/);
    expect(await thumbs.poster(cameraOnly)).toMatch(/\.jpg$/);
    expect(calls).toEqual([expect.stringMatching(/camera\.mov$/)]);
  });
  it('regenerates when the video changes', async () => {
    const folder = await makePackage('p_AAAAAA', { 'screen.mov': 'video' });
    const { thumbs, calls } = harness(async () => jpeg);
    const first = await thumbs.poster(folder);
    await utimes(join(folder, 'screen.mov'), new Date(), new Date(Date.now() + 5000));
    const second = await thumbs.poster(folder);
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
    // The superseded poster of the same video is removed.
    expect(await readdir(cache)).toEqual([second!.split('/').pop()]);
  });
  it('ignores package files that are symlinks to media outside the package', async () => {
    const outside = join(base, 'secret');
    await mkdir(outside);
    await writeFile(join(outside, 'private.mov'), 'v');
    await writeFile(join(outside, 'private.jpg'), 'x');
    const folder = await makePackage('s_AAAAAA', {});
    await symlink(join(outside, 'private.mov'), join(folder, 'screen.mov'));
    await symlink(join(outside, 'private.jpg'), join(folder, 'poster.jpg'));
    const { thumbs, calls } = harness(async () => jpeg);
    expect(await thumbs.poster(folder)).toBeNull();
    expect(calls).toHaveLength(0);
    // A link that stays inside the package is fine.
    await writeFile(join(folder, 'take.mov'), 'v');
    await rm(join(folder, 'screen.mov'));
    await symlink(join(folder, 'take.mov'), join(folder, 'screen.mov'));
    expect(await thumbs.poster(folder)).toMatch(/\.jpg$/);
  });
  it('removes the temporary file when the final rename fails', async () => {
    const folder = await makePackage('r_AAAAAA', { 'screen.mov': 'v' });
    const { thumbs } = harness(
      async () => jpeg,
      undefined,
      async () => {
        throw new Error('disk full');
      },
    );
    expect(await thumbs.poster(folder)).toBeNull();
    expect(await readdir(cache)).toEqual([]);
  });
  it('prunes cached posters of recordings that left the library', async () => {
    const kept = await makePackage('k_AAAAAA', { 'screen.mov': 'v' });
    const gone = await makePackage('g_BBBBBB', { 'camera.mov': 'v' });
    const { thumbs } = harness(async () => jpeg);
    const keptURL = await thumbs.poster(kept);
    await thumbs.poster(gone);
    await writeFile(join(cache, 'unrelated.txt'), 'leave me');
    await rm(gone, { recursive: true });
    expect(await thumbs.prune()).toBe(1);
    expect((await readdir(cache)).sort()).toEqual(
      [keptURL!.split('/').pop(), 'unrelated.txt'].sort(),
    );
    // An unreadable library root never empties the cache.
    await rm(root, { recursive: true });
    expect(await thumbs.prune()).toBe(0);
    expect(await readdir(cache)).toHaveLength(2);
  });
  it('returns null without retrying when rendering fails or yields nothing', async () => {
    const empty = await makePackage('e_AAAAAA', { 'screen.mov': 'v' });
    const broken = await makePackage('b_BBBBBB', { 'screen.mov': 'v' });
    const { thumbs, calls } = harness(async (path) => {
      if (path.includes('b_BBBBBB')) throw new Error('unreadable');
      return Buffer.alloc(0);
    });
    expect(await thumbs.poster(empty)).toBeNull();
    expect(await thumbs.poster(broken)).toBeNull();
    expect(await thumbs.poster(broken)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await readdir(base)).not.toContain('cache');
  });
  it('refuses folders outside the recordings root, nested paths and missing media', async () => {
    const outside = join(base, 'elsewhere');
    await mkdir(outside);
    await writeFile(join(outside, 'screen.mov'), 'v');
    const nested = await makePackage('n_AAAAAA', {});
    await mkdir(join(nested, 'inner'));
    await writeFile(join(nested, 'inner', 'screen.mov'), 'v');
    await symlink(outside, join(root, 'link_CCCCCC'));
    const audioOnly = await makePackage('a_DDDDDD', { 'mic.mov': 'v', 'screen.mov': '' });
    const { thumbs, calls } = harness(async () => jpeg);
    for (const folder of [
      outside,
      join(nested, 'inner'),
      join(root, 'link_CCCCCC'),
      root,
      audioOnly,
      '',
      join(root, 'missing'),
    ])
      expect(await thumbs.poster(folder)).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it('shares one render between concurrent requests and limits parallel renders', async () => {
    const folders = await Promise.all(
      ['a', 'b', 'c', 'd'].map((n) => makePackage(`${n}_AAAAAA`, { 'screen.mov': n })),
    );
    let running = 0,
      peak = 0;
    const { thumbs, calls } = harness(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return jpeg;
    }, 2);
    const results = await Promise.all([...folders, folders[0]].map((f) => thumbs.poster(f)));
    expect(results.every((url) => url?.endsWith('.jpg'))).toBe(true);
    expect(results[0]).toBe(results[4]);
    expect(calls).toHaveLength(4);
    expect(peak).toBe(2);
  });
});
