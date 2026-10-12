import { expect, it } from 'vitest';
import { isConnectionErrorCode } from '../src/shared/connection-error';
it('clears verified connection recovery errors by code while preserving recording and permission failures', () => {
  for (const code of [
    'engine-disconnected',
    'socket-error',
    'engine-recovery-failed',
    'engine-start-failed',
  ])
    expect(isConnectionErrorCode(code)).toBe(true);
  for (const code of [
    'low-disk',
    'permission-denied',
    'fixture-stop-failed',
    'recording-finalization-pending',
    'engine-request-timeout',
    undefined,
    'The native engine is disconnected',
  ])
    expect(isConnectionErrorCode(code)).toBe(false);
});
