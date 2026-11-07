import { describe, expect, it } from 'vitest';
import { suggestedExportName } from './export-name';

describe('suggested export name', () => {
  it('uses the recording title and date', () => {
    expect(suggestedExportName('Weekly demo', '2026-11-07T21:10:00Z', 'mp4')).toBe(
      'Weekly demo 2026-11-07.mp4',
    );
  });
  it('replaces characters Finder rejects', () => {
    expect(suggestedExportName('Q4: plan/notes?', undefined, 'mov')).toBe('Q4 plan notes.mov');
  });
  it('falls back to a readable name for untitled recordings', () => {
    expect(suggestedExportName('Untitled recording', '2026-11-07', 'gif')).toBe(
      'Rushes recording 2026-11-07.gif',
    );
    expect(suggestedExportName('', undefined, 'mp4')).toBe('Rushes recording.mp4');
  });
  it('never starts with a dot or exceeds the length cap', () => {
    expect(suggestedExportName('...hidden', undefined, 'mp4')).toBe('hidden.mp4');
    expect(suggestedExportName('a'.repeat(300), undefined, 'mp4').length).toBe(104);
  });
});
