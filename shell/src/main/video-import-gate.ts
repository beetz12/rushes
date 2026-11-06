// The main process decides which local files may be imported. The renderer
// never names a path for library.import: paths come only from the native
// picker or from files the user dropped, each usable once and briefly.
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isImportableVideo } from '../shared/video-import';

/// Commands the generic `rushes:request` passthrough refuses, with the reason.
export function genericRequestRefusal(cmd: string): string | undefined {
  if (['export', 'thumbnail', 'captions.export', 'chapters.export', 'diagnostics'].includes(cmd))
    return 'Use the native save dialog for file output';
  if (cmd === 'library.import') return 'Use Import video or drop files on the Library to import';
  return undefined;
}

/// An existing regular file with an .mp4, .mov or .m4v name.
export function isImportCandidate(path: unknown, stat = statSync): path is string {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path)) return false;
  if (!isImportableVideo(path)) return false;
  try {
    return stat(path).isFile();
  } catch {
    return false;
  }
}

/// Single-use grants: a path the user picked or dropped may be imported once
/// within `ttlMs`; anything else is refused.
export class ImportAllowlist {
  private grants = new Map<string, number>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  grant(paths: string[]): string[] {
    this.prune();
    const expires = this.now() + this.ttlMs;
    for (const path of paths) this.grants.set(path, expires);
    return paths;
  }
  consume(path: unknown): path is string {
    this.prune();
    if (typeof path !== 'string' || !this.grants.has(path)) return false;
    this.grants.delete(path);
    return true;
  }
  private prune() {
    const now = this.now();
    for (const [path, expires] of this.grants) if (expires <= now) this.grants.delete(path);
  }
}
