import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImportAllowlist, genericRequestRefusal, isImportCandidate } from './video-import-gate';

describe('video import gate', () => {
  it('the generic request passthrough refuses library.import', () => {
    expect(genericRequestRefusal('library.import')).toMatch(/Import video/);
    expect(genericRequestRefusal('export')).toMatch(/save dialog/);
    expect(genericRequestRefusal('list')).toBeUndefined();
  });

  it('refuses paths that were never picked or dropped', () => {
    const allow = new ImportAllowlist();
    allow.grant(['/Users/me/Downloads/picked.mp4']);
    expect(allow.consume('/Users/me/Documents/secret.mp4')).toBe(false);
    expect(allow.consume(42)).toBe(false);
  });

  it('consumes a granted path exactly once and expires stale grants', () => {
    let now = 1_000;
    const allow = new ImportAllowlist(5_000, () => now);
    allow.grant(['/d/a.mp4', '/d/b.mov']);
    expect(allow.consume('/d/a.mp4')).toBe(true);
    expect(allow.consume('/d/a.mp4')).toBe(false);
    now += 5_000;
    expect(allow.consume('/d/b.mov')).toBe(false);
  });

  it('accepts only existing regular files with a video extension as drops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rushes-drop-'));
    const video = join(dir, 'clip.MP4');
    const text = join(dir, 'notes.txt');
    writeFileSync(video, 'x');
    writeFileSync(text, 'x');
    mkdirSync(join(dir, 'folder.mov'));
    expect(isImportCandidate(video)).toBe(true);
    expect(isImportCandidate(text)).toBe(false);
    expect(isImportCandidate(join(dir, 'folder.mov'))).toBe(false);
    expect(isImportCandidate(join(dir, 'missing.mp4'))).toBe(false);
    expect(isImportCandidate('relative/clip.mp4')).toBe(false);
    expect(isImportCandidate({ path: video })).toBe(false);
  });
});
