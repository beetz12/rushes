// Poster frames for Library cards: lazy, cached on disk, never decoded on
// the main thread (rendering is delegated, e.g. to the system thumbnailer).
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

export interface ThumbnailDeps {
  /// Directory that holds the recording packages.
  recordingsRoot: string;
  /// App-owned cache directory for generated posters.
  cacheDir: string;
  /// Renders a JPEG of the video's poster frame, or undefined if it cannot.
  render(videoPath: string, size: { width: number; height: number }): Promise<Buffer | undefined>;
  /// Turns a file into a URL the renderer may load (the media protocol).
  publish(path: string): Promise<string>;
  /// Concurrent renders allowed (default 2).
  concurrency?: number;
  /// Injected for tests; defaults to fs.rename.
  rename?: (from: string, to: string) => Promise<void>;
}

export const thumbnailSize = { width: 480, height: 270 };
// The engine's reserved poster name first, then the tracks a package can hold.
const posterNames = ['poster.jpg'];
const videoNames = ['screen.mov', 'camera.mov'];

export class LibraryThumbnails {
  private inflight = new Map<string, Promise<string | null>>();
  private failed = new Set<string>();
  private queue: Array<() => void> = [];
  private active = 0;
  private deps: ThumbnailDeps & { rename: (from: string, to: string) => Promise<void> };
  constructor(deps: ThumbnailDeps) {
    this.deps = { ...deps, rename: deps.rename ?? rename };
  }

  /// The URL of a poster for the package folder, or null when there is none.
  async poster(folder: string): Promise<string | null> {
    const package_ = await this.packageFolder(folder);
    if (!package_) return null;
    for (const name of posterNames) {
      const path = await insidePackage(package_, name);
      if (path && (await isFile(path))) return this.deps.publish(path).catch(() => null);
    }
    for (const name of videoNames) {
      // The real file must live in the package: a symlink to anything
      // elsewhere on disk is ignored rather than thumbnailed and served.
      const video = await insidePackage(package_, name);
      if (!video) continue;
      const info = await stat(video).catch(() => undefined);
      if (!info?.isFile() || info.size === 0) continue;
      // <which video>-<which version of it>: a new version replaces the old poster.
      const prefix = videoPrefix(video);
      const key = `${prefix}-${hash(`${info.size}\0${info.mtimeMs}`)}`;
      const cached = join(this.deps.cacheDir, `${key}.jpg`);
      if (await isFile(cached)) return this.deps.publish(cached).catch(() => null);
      if (this.failed.has(key)) return null;
      let job = this.inflight.get(key);
      if (!job) {
        job = this.limited(() => this.generate(video, cached, key, prefix)).finally(() =>
          this.inflight.delete(key),
        );
        this.inflight.set(key, job);
      }
      return job;
    }
    return null;
  }

  /// Deletes cached posters whose video no longer exists in the library
  /// (trashed or moved recordings). Run once at startup; cheap and bounded.
  async prune(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.deps.cacheDir);
    } catch {
      return 0;
    }
    const live = new Set<string>();
    try {
      const root = await realpath(this.deps.recordingsRoot);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const name of videoNames) {
          const video = await insidePackage(join(root, entry.name), name);
          if (video) live.add(videoPrefix(video));
        }
      }
    } catch {
      return 0; // An unreadable library must not empty the cache.
    }
    let removed = 0;
    for (const name of names) {
      const prefix = /^([0-9a-f]{16})-[0-9a-f]{16}\.jpg(\..*\.tmp)?$/.exec(name)?.[1];
      if (!prefix || live.has(prefix)) continue;
      await rm(join(this.deps.cacheDir, name), { force: true }).catch(() => {});
      removed++;
    }
    return removed;
  }

  private async generate(
    video: string,
    output: string,
    key: string,
    prefix: string,
  ): Promise<string | null> {
    let data: Buffer | undefined;
    try {
      data = await this.deps.render(video, thumbnailSize);
    } catch {
      data = undefined;
    }
    if (!data?.length) {
      // Same file identity, same answer: do not ask the renderer again.
      this.failed.add(key);
      return null;
    }
    const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(temporary, data, { mode: 0o600 });
      await this.deps.rename(temporary, output);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      return null;
    }
    await this.dropOlderVersions(prefix, output);
    return this.deps.publish(output).catch(() => null);
  }

  private async dropOlderVersions(prefix: string, keep: string) {
    const names = await readdir(this.deps.cacheDir).catch(() => [] as string[]);
    for (const name of names)
      if (
        name.startsWith(`${prefix}-`) &&
        name.endsWith('.jpg') &&
        join(this.deps.cacheDir, name) !== keep
      )
        await rm(join(this.deps.cacheDir, name), { force: true }).catch(() => {});
  }

  /// A direct child folder of the recordings root, resolved, or undefined.
  private async packageFolder(folder: string): Promise<string | undefined> {
    if (typeof folder !== 'string' || !folder || folder.length > 4000) return;
    try {
      const [root, real] = await Promise.all([
        realpath(this.deps.recordingsRoot),
        realpath(folder),
      ]);
      const rel = relative(root, real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/')) return;
      return (await stat(real)).isDirectory() ? real : undefined;
    } catch {
      return;
    }
  }

  private limited<T>(work: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, this.deps.concurrency ?? 2);
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        work()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.queue.shift()?.();
          });
      };
      if (this.active < limit) start();
      else this.queue.push(start);
    });
  }
}

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
function videoPrefix(realVideo: string) {
  return hash(realVideo);
}
/// The real path of a package file if it resolves inside the package folder.
async function insidePackage(packageFolder: string, name: string): Promise<string | undefined> {
  try {
    const [folder, real] = await Promise.all([
      realpath(packageFolder),
      realpath(join(packageFolder, name)),
    ]);
    const rel = relative(folder, real);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? real : undefined;
  } catch {
    return;
  }
}
async function isFile(path: string) {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}
