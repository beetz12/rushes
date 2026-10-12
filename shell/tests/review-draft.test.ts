import { describe, it, expect, vi, afterEach } from 'vitest';
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as host from 'node:os';
import {
  DraftAutosave,
  sidebarDraft,
  validateZoomCue,
  videoExportRequest,
  persistReviewDraft,
  refreshedMetadata,
} from '../src/shared/review-draft';
import { atomicJSON } from '../src/main/atomic';
import { copyVideoFile } from '../src/main/file-clipboard';
import { MediaRegistry } from '../src/main/media';
import { AutoShare } from '../src/main/share-lifecycle';
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await files.rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-draft-'));
  roots.push(root);
  return root;
}

describe('durable review draft queue', () => {
  it('persists manual summary through its native route and preserves it during automatic refresh', async () => {
    const request = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => {});
    await persistReviewDraft(request, 'take', {
      title: 'manual title',
      layout: 'bubble',
      summary: 'manual summary',
    });
    expect(request.mock.calls).toEqual([
      ['edit.set', { id: 'take', title: 'manual title', layout: 'bubble' }],
      ['meta.set', { id: 'take', summary: 'manual summary', title: 'manual title' }],
    ]);
    expect(
      refreshedMetadata({ summary: 'generated', chapters: ['new chapter'] }, 'manual summary'),
    ).toEqual({ summary: 'manual summary', chapters: ['new chapter'] });
    expect(refreshedMetadata({ summary: 'generated' }, undefined)).toEqual({
      summary: 'generated',
    });
  });
  it('debounces changes, serializes a slow writer, and flushes the latest patch to actual disk', async () => {
    vi.useFakeTimers();
    const root = await temporary(),
      path = paths.join(root, 'edit-draft.json');
    let release!: () => void,
      active = 0,
      maxActive = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = vi.fn(async (value: { title: string; micGain: number }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (value.title === 'first') await gate;
      await atomicJSON(path, value);
      active--;
    });
    const state = vi.fn(),
      draft = new DraftAutosave(persist, state);
    draft.update({ title: 'first', micGain: 1 });
    await vi.advanceTimersByTimeAsync(249);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);
    draft.update({ title: 'second', micGain: 0.5 });
    draft.update({ title: 'last manual title', micGain: 0.25 });
    const pending = draft.flush();
    release();
    await pending;
    expect(persist.mock.calls.map(([value]) => value.title)).toEqual([
      'first',
      'last manual title',
    ]);
    expect(maxActive).toBe(1);
    expect(JSON.parse(await files.readFile(path, 'utf8'))).toEqual({
      title: 'last manual title',
      micGain: 0.25,
    });
    expect(state).toHaveBeenLastCalledWith('saved');
  });
  it('keeps failed changes for retry and prevents an output action before persistence succeeds', async () => {
    const persist = vi.fn(async (_value: { title: string }) => {});
    persist.mockRejectedValueOnce(new Error('Fixture disk full'));
    const state = vi.fn(),
      draft = new DraftAutosave(persist, state),
      output = vi.fn(async () => 'output');
    draft.update({ title: 'manual' });
    await expect(draft.run(output)).rejects.toThrow('disk full');
    expect(state).toHaveBeenLastCalledWith('failed');
    expect(output).not.toHaveBeenCalled();
    expect(await draft.run(output)).toBe('output');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({ title: 'manual' });
  });
  it('orders full-document mutations after pending sidebar edits while retaining manual metadata', async () => {
    const stored: any = {
      title: 'old',
      micGain: 1,
      meta: { summary: 'manual summary', chapters: ['manual chapter'] },
      clips: ['first'],
    };
    const draft = new DraftAutosave<Record<string, unknown>>(
      async (patch) => {
        Object.assign(stored, patch);
      },
      () => {},
    );
    draft.update({ title: 'typed by user', micGain: 0.3 });
    await draft.run(async () => {
      expect(stored.title).toBe('typed by user');
      stored.clips.push('second');
    });
    draft.update({ title: 'final typed title', micGain: 0.2 });
    await draft.flush();
    expect(stored).toEqual({
      title: 'final typed title',
      micGain: 0.2,
      meta: { summary: 'manual summary', chapters: ['manual chapter'] },
      clips: ['first', 'second'],
    });
    const fields = sidebarDraft(
      {
        layout: {
          preset: 'screenOnly',
          bubble: {
            center: [0.2, 0.3],
            size: 0.4,
            visible: false,
            shape: 'squircle',
            mirror: false,
          },
        },
        audio: { micGain: 0.2, systemGain: 0.8 },
        captions: { burnIn: true },
        meta: { title: 'draft manual title', summary: 'kept' },
      },
      'manifest title',
    );
    expect(fields).toEqual({
      layout: 'screenOnly',
      bubbleSize: 0.4,
      bubbleX: 0.2,
      bubbleY: 0.3,
      bubbleVisible: false,
      shape: 'squircle',
      mirror: false,
      micGain: 0.2,
      systemGain: 0.8,
      title: 'draft manual title',
      burnIn: true,
    });
    expect(fields).not.toHaveProperty('meta');
    expect(fields).not.toHaveProperty('clips');
  });
});
describe('zoom and source-size export contracts', () => {
  it('accepts a cue inside its kept clip and rejects removed clips, invalid ranges, scale and focus', () => {
    const clips = [{ id: 'c1', sourceStartMs: 100, sourceEndMs: 900 }];
    const cue = {
      id: 'zoom',
      clipId: 'c1',
      sourceStartMs: 200,
      sourceEndMs: 800,
      scale: 1.8,
      focus: [0.4, 0.6] as [number, number],
      origin: 'auto' as const,
    };
    expect(validateZoomCue(cue, clips)).toEqual({ ...cue, origin: 'manual' });
    for (const patch of [
      { clipId: 'removed' },
      { sourceStartMs: 0 },
      { sourceEndMs: 1000 },
      { sourceEndMs: 200 },
      { scale: 0.5 },
      { scale: 4.1 },
      { focus: [1.1, 0.5] },
      { focus: [NaN, 0.5] },
    ])
      expect(() => validateZoomCue({ ...cue, ...patch } as any, clips)).toThrow(
        'inside one kept clip',
      );
  });
  it('forwards source-size only for the explicitly selected YouTube source export', () => {
    expect(videoExportRequest('take', 'youtube-source', '/chosen/output.mp4')).toEqual({
      id: 'take',
      preset: 'youtube',
      sourceSize: true,
      path: '/chosen/output.mp4',
    });
    expect(videoExportRequest('take', 'youtube', '/chosen/output.mp4')).toEqual({
      id: 'take',
      preset: 'youtube',
      path: '/chosen/output.mp4',
    });
    expect(videoExportRequest('take', 'audio-wav', '/chosen/output.wav').preset).toBe('audio');
  });
});
describe('awaited clipboard adapters', () => {
  it('writes only a validated rendered file URI in native file formats and awaits actual completion', async () => {
    const root = await temporary(),
      path = paths.join(root, 'edited clip #1.mp4');
    await files.writeFile(path, Buffer.alloc(1024 * 1024, 7));
    const media = new MediaRegistry();
    await media.allowRoot(root);
    let release!: () => void;
    const write = vi.fn(
      (_data: Record<string, string>) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let done = false;
    const result = copyVideoFile(path, (value) => media.allowFile(value), { write }).then(
      (value) => {
        done = true;
        return value;
      },
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(done).toBe(false);
    const data = write.mock.calls[0][0];
    expect(Object.keys(data)).toEqual([
      'text/uri-list',
      'electron application/osclipboard;format="public.file-url"',
    ]);
    expect(data['text/uri-list']).toContain('edited%20clip%20%231.mp4');
    expect(data['text/uri-list']).toMatch(/^file:\/\//);
    expect(JSON.stringify(data).length).toBeLessThan(2000);
    expect(data).not.toHaveProperty('text/plain');
    release();
    expect(await result).toEqual({ copied: true });
  });
  it('refuses disallowed paths and propagates clipboard failure instead of a copied claim', async () => {
    const root = await temporary(),
      path = paths.join(root, 'video.mp4');
    await files.writeFile(path, 'fixture');
    const write = vi.fn(async (_formats: Record<string, string>) => {});
    await expect(
      copyVideoFile(
        path,
        async () => {
          throw new Error('Outside library');
        },
        { write },
      ),
    ).rejects.toThrow('Outside library');
    expect(write).not.toHaveBeenCalled();
    write.mockRejectedValueOnce(new Error('Fixture clipboard unavailable'));
    await expect(copyVideoFile(path, async () => {}, { write })).rejects.toThrow(
      'clipboard unavailable',
    );
  });
  it('waits for auto-share clipboard completion and reports its rejection without copied notification', async () => {
    const events = vi.fn();
    let release!: () => void;
    const copy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const auto = new AutoShare(
      async () => ({ url: 'https://example.invalid/s/share', state: 'processing' }),
      copy,
      events,
    );
    const pending = auto.recordingStopped('take', true);
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(events).not.toHaveBeenCalled();
    release();
    await pending;
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: 'share-link-copied' }));
    copy.mockRejectedValueOnce(new Error('Fixture clipboard refused'));
    await auto.recordingStopped('another', true);
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'auto-share-failed' }));
    expect(events.mock.calls.filter(([event]) => event.event === 'share-link-copied')).toHaveLength(
      1,
    );
  });
});
