import { expect, it } from 'vitest';
import { libraryRecordingStatus, recordingHealth } from './recording-health';

it('distinguishes saved, checking and independently verified footage', () => {
  expect(recordingHealth({ status: 'complete' })).toBe('Saved · not yet verified');
  expect(recordingHealth({ status: 'recovered' }, { status: 'queued' })).toBe(
    'Saved · checking media',
  );
  expect(recordingHealth({ status: 'complete' }, { status: 'running' })).toBe(
    'Saved · checking media',
  );
  expect(recordingHealth({ status: 'complete', verified: { ok: true } })).toBe('Verified');
  expect(libraryRecordingStatus('complete')).toBe('Saved');
});
it('retains failure and unchecked outcomes even with conflicting success fields', () => {
  expect(recordingHealth({ status: 'failed', verified: { ok: true } })).toContain('issues');
  expect(
    recordingHealth({
      status: 'complete',
      warnings: [{ code: 'ended-early', message: 'stream-error: camera' }],
    }),
  ).toContain('issues');
  expect(recordingHealth({ status: 'complete', verified: { ok: false } })).toContain('issues');
  expect(
    recordingHealth(
      { status: 'complete' },
      { status: 'failed', error: { code: 'verification-failed' } },
    ),
  ).toContain('issues');
  expect(
    recordingHealth(
      { status: 'complete' },
      { status: 'failed', error: { code: 'finalization-pending' } },
    ),
  ).toContain('waiting');
  expect(recordingHealth({ status: 'finishing' })).toBe('finishing');
  expect(libraryRecordingStatus('failed')).toContain('originals kept');
});
