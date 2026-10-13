import { describe, expect, it } from 'vitest';
import { appErrors, appErrorText, connectionMessages, initialAppErrors } from './app-errors';

describe('independent action errors and verified connection recovery', () => {
  it('latches a connection cause across action starts, dismissal and a successful action', async () => {
    let state = appErrors(initialAppErrors, {
      type: 'report',
      notice: { message: 'Invalid engine event', code: 'invalid-json' },
    });
    for (const clear of [
      { type: 'clear-action' } as const,
      { type: 'report', notice: { message: '' } } as const,
    ]) {
      state = appErrors(state, clear);
      expect(state.connection?.first.code).toBe('invalid-json');
      expect(appErrorText(state)).toContain('Invalid engine event');
    }
    await Promise.resolve({ previewToken: 'successful-action' });
    expect(state.connection?.first.message).toBe('Invalid engine event');
    expect(appErrors(state, { type: 'verified-recovery' }).connection).toBeNull();
  });
  it('retains the original connection cause and exposes a pending request rejection independently of ordinary failures', () => {
    let state = appErrors(initialAppErrors, {
      type: 'report',
      notice: { message: 'Invalid engine event', code: 'invalid-json' },
    });
    state = appErrors(state, {
      type: 'report',
      notice: { message: 'Camera permission denied', code: 'permission-denied' },
    });
    state = appErrors(state, {
      type: 'report',
      notice: { message: 'Pending request disconnected', code: 'engine-disconnected' },
    });
    expect(state.connection?.first).toEqual({
      message: 'Invalid engine event',
      code: 'invalid-json',
    });
    expect(state.connection?.latest).toEqual({
      message: 'Pending request disconnected',
      code: 'engine-disconnected',
    });
    expect(state.action).toEqual({
      message: 'Camera permission denied',
      code: 'permission-denied',
    });
    expect(connectionMessages(state)).toEqual([
      'Invalid engine event',
      'Pending request disconnected',
    ]);
    expect(appErrorText(state)).toContain('Camera permission denied');
  });
  it('verified recovery clears only connection errors while ordinary failure and its code survive', () => {
    let state = appErrors(initialAppErrors, {
      type: 'report',
      notice: { message: 'Transport interrupted', code: 'socket-error' },
    });
    state = appErrors(state, {
      type: 'report',
      notice: { message: 'Not enough disk space', code: 'low-disk' },
    });
    state = appErrors(state, { type: 'verified-recovery' });
    expect(state.connection).toBeNull();
    expect(state.action).toEqual({ message: 'Not enough disk space', code: 'low-disk' });
    expect(appErrorText(state)).toBe('Not enough disk space');
    expect(appErrors(state, { type: 'clear-action' })).toEqual(initialAppErrors);
  });
  it('a fresh action may clear an ordinary error while a new failure during that action remains actionable', async () => {
    let state = appErrors(initialAppErrors, {
      type: 'report',
      notice: { message: 'Old ordinary failure' },
    });
    state = appErrors(state, { type: 'clear-action' });
    const result = Promise.resolve('done');
    state = appErrors(state, {
      type: 'report',
      notice: { message: 'New writer failure', code: 'writer-failed' },
    });
    await result;
    expect(state.action?.message).toBe('New writer failure');
    expect(appErrors(state, { type: 'verified-recovery' }).action?.code).toBe('writer-failed');
  });
});
