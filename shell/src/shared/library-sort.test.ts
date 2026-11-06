import { describe, expect, it } from 'vitest';
import {
  isLibrarySort,
  sortRecordings,
  withoutLibrarySort,
  type SortableRecording,
} from './library-sort';
import { defaultOptions, recordingOptionsSchema } from './contracts';

const rows: SortableRecording[] = [
  { id: 'b', title: 'beta demo', createdAt: '2026-11-02T10:00:00Z', durationMs: 30_000 },
  { id: 'a', title: 'Alpha', createdAt: '2026-11-04T10:00:00Z', durationMs: 5_000 },
  { id: 'c', title: null, createdAt: '2026-11-03T10:00:00Z', durationMs: 90_000 },
  { id: 'd', title: 'item 10', createdAt: 'not a date', durationMs: null },
  { id: 'e', title: 'item 9', createdAt: '2026-11-01T10:00:00Z' },
];
const ids = (list: SortableRecording[]) => list.map((row) => row.id);

describe('library sort', () => {
  it('orders newest first by default and keeps undated rows last', () => {
    expect(ids(sortRecordings(rows, 'newest'))).toEqual(['a', 'c', 'b', 'e', 'd']);
  });
  it('orders oldest first with undated rows first', () => {
    expect(ids(sortRecordings(rows, 'oldest'))).toEqual(['d', 'e', 'b', 'c', 'a']);
  });
  it('orders longest first and puts unknown durations last', () => {
    expect(ids(sortRecordings(rows, 'longest'))).toEqual(['c', 'b', 'a', 'e', 'd']);
  });
  it('orders titles A to Z, case-insensitive and numeric, untitled last', () => {
    expect(ids(sortRecordings(rows, 'title'))).toEqual(['a', 'b', 'e', 'd', 'c']);
  });
  it('breaks ties deterministically and does not mutate its input', () => {
    const tied = [
      { id: 'y', title: 'Same', createdAt: '2026-11-01T00:00:00Z', durationMs: 1 },
      { id: 'x', title: 'same', createdAt: '2026-11-01T00:00:00Z', durationMs: 1 },
    ];
    const copy = [...tied];
    for (const sort of ['newest', 'oldest', 'longest', 'title'] as const)
      expect(ids(sortRecordings(tied, sort))).toEqual(['x', 'y']);
    expect(tied).toEqual(copy);
  });
  it('recognizes only the known sort keys', () => {
    expect(isLibrarySort('longest')).toBe(true);
    expect(isLibrarySort('size')).toBe(false);
    expect(isLibrarySort(undefined)).toBe(false);
  });
  it('keeps the sort out of presets', () => {
    const saved = withoutLibrarySort({ ...defaultOptions, librarySort: 'title' as const });
    expect('librarySort' in saved).toBe(false);
    expect(saved.countdownSeconds).toBe(defaultOptions.countdownSeconds);
  });
  it('drops an unknown saved sort without resetting the other settings', () => {
    const parsed = recordingOptionsSchema.parse({
      ...defaultOptions,
      countdownSeconds: 5,
      mic: 'usb-mic',
      librarySort: 'by-size',
    });
    expect(parsed.librarySort).toBeUndefined();
    expect(parsed.countdownSeconds).toBe(5);
    expect(parsed.mic).toBe('usb-mic');
    expect(
      recordingOptionsSchema.parse({ ...defaultOptions, librarySort: 'oldest' }).librarySort,
    ).toBe('oldest');
  });
});
