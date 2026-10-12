export function isConnectionErrorCode(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    [
      'engine-disconnected',
      'socket-error',
      'engine-recovery-failed',
      'engine-start-failed',
    ].includes(code)
  );
}
