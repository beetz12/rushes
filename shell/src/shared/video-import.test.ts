import { describe, expect, it } from 'vitest';
import { importSummary, importVideos, isImportableVideo, progressText } from './video-import';

describe('video import', () => {
  it('accepts only mp4, mov and m4v, in any case', () => {
    expect(isImportableVideo('/Users/me/Downloads/Weekly sync.MP4')).toBe(true);
    expect(isImportableVideo('/a/b.mov')).toBe(true);
    expect(isImportableVideo('/a/b.m4v')).toBe(true);
    expect(isImportableVideo('/a/b.webm')).toBe(false);
    expect(isImportableVideo('/a/notes.txt')).toBe(false);
    expect(isImportableVideo('/a.mp4/README')).toBe(false);
  });

  it('imports one at a time, reports progress, keeps going after a failure', async () => {
    const calls: string[] = [];
    const progress: string[] = [];
    const outcome = await importVideos(
      ['/d/one.mp4', '/d/notes.txt', '/d/bad.mov', '/d/one.mp4', '/d/two.m4v'],
      async (path) => {
        calls.push(`library.import ${path}`);
        if (path.endsWith('bad.mov')) throw new Error('bad.mov has no video track.');
        return { id: `id-${calls.length}`, title: path.split('/').pop()!.split('.')[0] };
      },
      (p) => progress.push(progressText(p)),
    );
    expect(calls).toEqual([
      'library.import /d/one.mp4',
      'library.import /d/bad.mov',
      'library.import /d/two.m4v',
    ]);
    expect(progress[0]).toBe('Importing 1 of 3: one.mp4…');
    expect(outcome.imported.map((i) => i.title)).toEqual(['one', 'two']);
    expect(outcome.failed).toEqual([{ name: 'bad.mov', message: 'bad.mov has no video track.' }]);
    expect(outcome.skipped).toEqual(['notes.txt']);
    const summary = importSummary(outcome);
    expect(summary).toContain('Imported 2 videos.');
    expect(summary).toContain('bad.mov: bad.mov has no video track.');
    expect(summary).toContain('Skipped notes.txt');
  });

  it('describes a single import and an empty selection', () => {
    expect(
      importSummary({ imported: [{ id: 'x', title: 'Demo' }], failed: [], skipped: [] }),
    ).toBe('Imported “Demo”. Transcript and captions are on the way.');
    expect(importSummary({ imported: [], failed: [], skipped: [] })).toBe(
      'No videos were imported.',
    );
    expect(progressText({ index: 1, total: 1, name: 'a.mp4' })).toBe('Importing a.mp4…');
  });
});
