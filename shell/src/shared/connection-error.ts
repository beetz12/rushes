export function isConnectionErrorCode(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    [
      'engine-disconnected',
      'socket-error',
      'invalid-json',
      'engine-recovery-failed',
      'engine-start-failed',
    ].includes(code)
  );
}
