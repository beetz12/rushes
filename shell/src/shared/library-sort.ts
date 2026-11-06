// Library ordering. Pure, so the renderer and tests share one definition.
export const librarySortKeys = ['newest', 'oldest', 'longest', 'title'] as const;
export type LibrarySort = (typeof librarySortKeys)[number];
export const defaultLibrarySort: LibrarySort = 'newest';
export const librarySortLabels: Record<LibrarySort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  longest: 'Longest first',
  title: 'Title A–Z',
};

/// Presets hold recording setups only; the Library sort never travels with
/// them, so saving or applying a preset leaves the current sort alone.
export function withoutLibrarySort<T extends { librarySort?: unknown }>(
  options: T,
): Omit<T, 'librarySort'> {
  const { librarySort: _ignored, ...rest } = options;
  return rest;
}

export interface SortableRecording {
  id: string;
  title?: string | null;
  createdAt?: string | null;
  durationMs?: number | null;
}

export function isLibrarySort(value: unknown): value is LibrarySort {
  return typeof value === 'string' && (librarySortKeys as readonly string[]).includes(value);
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function createdTime(row: SortableRecording): number {
  const time = row.createdAt ? Date.parse(row.createdAt) : NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function duration(row: SortableRecording): number {
  const ms = row.durationMs;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : -1;
}

function titleOf(row: SortableRecording): string {
  return (row.title ?? '').trim();
}

/// Returns a new array; ties fall back to newest first, then id, so the
/// order is stable across reloads whatever order the engine returns.
export function sortRecordings<T extends SortableRecording>(
  rows: readonly T[],
  sort: LibrarySort,
): T[] {
  const newest = (a: T, b: T) => createdTime(b) - createdTime(a) || collator.compare(a.id, b.id);
  const compare: (a: T, b: T) => number =
    sort === 'oldest'
      ? (a, b) => createdTime(a) - createdTime(b) || collator.compare(a.id, b.id)
      : sort === 'longest'
        ? (a, b) => duration(b) - duration(a) || newest(a, b)
        : sort === 'title'
          ? (a, b) => {
              const left = titleOf(a),
                right = titleOf(b);
              // Untitled recordings sit after titled ones.
              if (!left !== !right) return left ? -1 : 1;
              return collator.compare(left, right) || newest(a, b);
            }
          : newest;
  return [...rows].sort((a, b) => {
    const result = compare(a, b);
    return Number.isNaN(result) ? 0 : result;
  });
}
