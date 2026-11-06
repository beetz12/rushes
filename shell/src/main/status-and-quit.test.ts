/// <reference lib="es2024.promise" />
import { describe, expect, it } from 'vitest';
import {
  AppQuitGate,
  NativeStatusRequests,
  recordingStoppedActions,
  retainedFinishedTake,
  recoverIdleRecorder,
} from './recording-controls';
import { PrimaryNavigation } from './primary-window';

describe('desktop status and quit transitions', () => {
  it('does not reopen a parked recovered take after navigating away and back', async () => {
    const navigation = new PrimaryNavigation();
    const current = navigation.checkpoint();
    const read = Promise.withResolvers<unknown>();
    const actions: string[] = [];
    const pending = recoverIdleRecorder('A', {
      current,
      show: () => read.promise,
      open: (id) => {
        actions.push('open:' + id);
      },
      rearm: async () => {
        actions.push('rearm');
      },
    });
    navigation.select('settings');
    navigation.select('recorder');
    read.resolve({ manifest: { id: 'A', status: 'complete', tracks: [{ present: true }] } });
    await pending;
    expect(actions).toEqual([]);
    // Deferred review dispatch uses the same checkpoint guard.
    navigation.select('review');
    const dispatchCurrent = navigation.checkpoint();
    navigation.select('library');
    navigation.select('review');
    expect(dispatchCurrent()).toBe(false);
  });
  it('rearms idle input feedback after control recovery, including a deleted cancelled take', async () => {
    for (const id of [undefined, 'deleted']) {
      const actions: string[] = [];
      await recoverIdleRecorder(id, {
        current: () => true,
        show: async () => {
          throw Object.assign(new Error('deleted'), { code: 'not-found' });
        },
        open: (value) => {
          actions.push(value);
        },
        rearm: async () => {
          actions.push('rearm');
        },
      });
      expect(actions).toEqual(['rearm']);
    }
    let rearmed = false;
    await recoverIdleRecorder(undefined, {
      current: () => false,
      show: async () => null,
      open: () => {},
      rearm: async () => {
        rearmed = true;
      },
    });
    expect(rearmed).toBe(false);
  });
  it('recovers a missed Stop review only for the same retained terminal take with media', () => {
    for (const status of ['complete', 'recovered', 'failed']) {
      expect(
        retainedFinishedTake('A', { manifest: { id: 'A', status, tracks: [{ present: true }] } }),
      ).toBe('A');
    }
    for (const manifest of [
      { id: 'B', status: 'complete', tracks: [{ present: true }] },
      { id: 'A', status: 'recording', tracks: [{ present: true }] },
      { id: 'A', status: 'complete', tracks: [] },
      { id: 'A', status: 'failed', tracks: [{ present: false }] },
      undefined,
    ])
      expect(retainedFinishedTake('A', { manifest })).toBeUndefined();
  });
  it('returns discarded takes to setup and skips automatic sharing', () => {
    expect(
      recordingStoppedActions({ event: 'recording-stopped', result: { discardRequested: true } }),
    ).toEqual({ view: 'recorder', autoShare: false });
    for (const result of [
      { status: 'failed' },
      { discardRequested: false },
      { discardRequested: 'true' },
      undefined,
    ])
      expect(recordingStoppedActions({ event: 'recording-stopped', result })).toEqual({
        view: 'review',
        autoShare: true,
      });
  });
  it('rejects an old idle response after a new take changes state', async () => {
    const requests = new NativeStatusRequests(),
      pending = Promise.withResolvers<{ state: string }>();
    const old = requests.read(() => pending.promise);
    requests.changed();
    pending.resolve({ state: 'idle' });
    await expect(old).rejects.toMatchObject({ code: 'status-superseded' });
    await expect(requests.read(async () => ({ state: 'recording' }))).resolves.toEqual({
      state: 'recording',
    });
  });
  it('repeated Quit cannot bypass pending native or draft cleanup', () => {
    const quit = new AppQuitGate();
    expect(quit.request()).toBe('begin');
    expect(quit.request()).toBe('wait');
    expect(quit.request()).toBe('wait');
    quit.failed();
    expect(quit.request()).toBe('begin');
    quit.confirm();
    expect(quit.request()).toBe('exit');
  });
});
