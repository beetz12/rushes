import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicJSON } from './atomic';

// What the viewer-feedback poller last told the user about, per share. Kept on disk so plays
// and comments that arrive while Rushes is closed are reported once after the next launch.
export type SeenShare = {
  views: number;
  // Ids of the comments already reported. When the list is capped, every comment created at or
  // before `commentFloor` also counts as reported.
  comments: string[];
  commentFloor?: string;
};
export type SeenShares = Record<string, SeenShare>;
export interface SeenStore {
  load(): Promise<SeenShares>;
  save(shares: SeenShares): Promise<void>;
}

const SCHEMA = 'rushes.share-watch/1';

function validEntry(value: unknown): value is SeenShare {
  const v = value as SeenShare;
  return (
    !!v &&
    typeof v === 'object' &&
    Number.isSafeInteger(v.views) &&
    v.views >= 0 &&
    Array.isArray(v.comments) &&
    v.comments.every((id) => typeof id === 'string') &&
    (v.commentFloor === undefined || typeof v.commentFloor === 'string')
  );
}

// Mirrors the data directory index.ts uses, so the poller can persist without new wiring.
export function defaultSeenPath() {
  return join(
    process.env.RUSHES_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Rushes'),
    'share-watch.json',
  );
}

export class FileSeenStore implements SeenStore {
  constructor(private path: string = defaultSeenPath()) {}
  // A missing, unreadable or malformed file starts fresh: every share gets a silent baseline.
  async load(): Promise<SeenShares> {
    let parsed: any;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      return {};
    }
    if (parsed?.schema !== SCHEMA || !parsed.shares || typeof parsed.shares !== 'object') return {};
    const shares: SeenShares = {};
    for (const [key, entry] of Object.entries(parsed.shares))
      if (validEntry(entry)) shares[key] = entry;
    return shares;
  }
  async save(shares: SeenShares) {
    await atomicJSON(this.path, { schema: SCHEMA, shares });
  }
}
