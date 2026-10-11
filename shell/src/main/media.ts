import { realpath, stat } from 'node:fs/promises';
import { dirname, relative, isAbsolute, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class MediaRegistry {
  private paths = new Map<string, string>();
  private roots = new Set<string>();
  async allowRoot(path: string) {
    this.roots.add(await realpath(path));
  }
  async allowFile(path: string) {
    const real = await realpath(path);
    if (
      !['.mov', '.mp4', '.m4a', '.wav', '.webm', '.jpg', '.jpeg', '.png', '.vtt', '.srt'].includes(
        extname(real).toLowerCase(),
      )
    )
      throw new Error('Unsupported media type');
    const info = await stat(real);
    if (!info.isFile()) throw new Error('Not a regular media file');
    const allowed = [...this.roots].some((root) => {
      const rel = relative(root, real);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!allowed) throw new Error('Media is outside the recording library');
    const token = randomUUID();
    this.paths.set(token, real);
    return `rushes-media://local/${token}`;
  }
  get(url: string): string | undefined {
    try {
      const u = new URL(url);
      if (u.protocol !== 'rushes-media:' || u.hostname !== 'local') return;
      return this.paths.get(u.pathname.slice(1));
    } catch {
      return;
    }
  }
}
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | undefined {
  if (!header) return;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m) throw new Error('Invalid range');
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new Error('Unsatisfiable range');
  end = Math.min(end, size - 1);
  return { start, end };
}
export function mimeType(path: string) {
  return (
    (
      {
        '.mov': 'video/quicktime',
        '.mp4': 'video/mp4',
        '.m4a': 'audio/mp4',
        '.wav': 'audio/wav',
        '.webm': 'video/webm',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.vtt': 'text/vtt',
        '.srt': 'text/plain',
      } as Record<string, string>
    )[extname(path)] ?? 'application/octet-stream'
  );
}
