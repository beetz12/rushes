import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineClient, EngineSupervisor } from '../src/main/engine';
import { MediaRegistry, parseRange } from '../src/main/media';
import { requestSchema, recordingOptionsSchema, defaultOptions } from '../src/shared/contracts';
describe('native engine transport', () => {
  it('correlates out-of-order replies and handles split NDJSON events separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rushes-socket-'));
    const path = join(dir, 'control.sock');
    const server = createServer((socket) => {
      let input = '';
      socket.on('data', (data) => {
        input += data;
        const lines = input.trim().split('\n');
        if (lines.length < 2) return;
        const requests = lines.map((s) => JSON.parse(s));
        const event = Buffer.from(
          '{"event":"recording-started","recordingId":"take1","title":"你好 📹"}\n',
        );
        const boundary = event.indexOf(Buffer.from('好')) + 1;
        socket.write(event.subarray(0, boundary));
        setTimeout(() => {
          socket.write(event.subarray(boundary));
          socket.write(
            JSON.stringify({ id: requests[1].id, ok: true, result: { second: true } }) +
              '\n' +
              JSON.stringify({ id: requests[0].id, ok: true, result: { first: true } }) +
              '\n',
          );
        }, 10);
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const client = new EngineClient();
    const events: any[] = [];
    client.on('event', (e) => events.push(e));
    await client.connect(path);
    const [first, second] = await Promise.all([client.request('ping'), client.request('status')]);
    expect(first).toEqual({ first: true });
    expect(second).toEqual({ second: true });
    expect(events).toEqual([
      { event: 'recording-started', recordingId: 'take1', title: '你好 📹' },
    ]);
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true });
  });
  it('surfaces machine error and fails pending requests on disconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rushes-error-'));
    const path = join(dir, 'control.sock');
    const server = createServer((socket) =>
      socket.on('data', (data) => {
        const r = JSON.parse(data.toString());
        socket.end(
          JSON.stringify({
            id: r.id,
            ok: false,
            error: { code: 'low-disk', message: 'Need 2 GB' },
          }) + '\n',
        );
      }),
    );
    await new Promise<void>((r) => server.listen(path, r));
    const client = new EngineClient();
    await client.connect(path);
    await expect(client.request('record.start')).rejects.toMatchObject({
      code: 'low-disk',
      message: 'Need 2 GB',
    });
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true });
  });
});
describe('media authorization', () => {
  it('issues opaque media tokens and rejects symlink escapes outside approved roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rushes-media-'));
    const root = join(dir, 'recordings');
    await mkdir(root);
    await writeFile(join(root, 'screen.mov'), 'media');
    await writeFile(join(dir, 'outside.mov'), 'secret');
    await symlink(join(dir, 'outside.mov'), join(root, 'escape.mov'));
    const registry = new MediaRegistry();
    await registry.allowRoot(root);
    const token = await registry.allowFile(join(root, 'screen.mov'));
    expect(token).toMatch(/^rushes-media:\/\/local\/[\w-]+$/);
    expect(registry.get(token)).toBe(await realpath(join(root, 'screen.mov')));
    expect(registry.get(token.replace('local', 'foreign'))).toBeUndefined();
    await expect(registry.allowFile(join(root, 'escape.mov'))).rejects.toThrow('outside');
    await rm(dir, { recursive: true });
  });
  it('supports bounded/open/suffix ranges and rejects unsatisfiable ranges', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=80-', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRange('bytes=-15', 100)).toEqual({ start: 85, end: 99 });
    expect(() => parseRange('bytes=150-', 100)).toThrow();
    expect(() => parseRange('bytes=1-3,5-6', 100)).toThrow();
  });
});
describe('IPC boundary', () => {
  it('rejects unknown commands, extra fields, and invalid recording choices', () => {
    expect(() => requestSchema.parse({ cmd: 'eval', args: { code: 'anything' } })).toThrow();
    expect(() => requestSchema.parse({ cmd: 'ping', args: {}, evil: true })).toThrow();
    expect(() =>
      recordingOptionsSchema.parse({ ...defaultOptions, countdownSeconds: 9 }),
    ).toThrow();
    expect(recordingOptionsSchema.parse(defaultOptions)).toEqual(defaultOptions);
  });
});

describe('recording finalization on Quit', () => {
  it('keeps the sidecar alive when native Stop cannot confirm finalization', async () => {
    const supervisor = new EngineSupervisor(
      '/fixture/engine',
      '/fixture/socket',
      '/fixture/takes',
      '/fixture/index',
    );
    supervisor.active = true;
    const kill = vi.fn();
    supervisor.child = { kill } as unknown as import('node:child_process').ChildProcess;
    const close = vi.spyOn(supervisor.client, 'close');
    const request = vi
      .spyOn(supervisor.client, 'request')
      .mockResolvedValueOnce({ state: 'recording' })
      .mockRejectedValueOnce(new Error('Fixture finalization pending'));
    await expect(supervisor.quit()).rejects.toThrow('finalization pending');
    expect(kill).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ state: 'recording' }).mockResolvedValueOnce({ stopped: true });
    await supervisor.quit();
    expect(request).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('does not terminate a take still preparing before the recording-started event', async () => {
    const supervisor = new EngineSupervisor(
      '/fixture/engine',
      '/fixture/socket',
      '/fixture/takes',
      '/fixture/index',
    );
    const kill = vi.fn();
    supervisor.child = { kill } as unknown as import('node:child_process').ChildProcess;
    vi.spyOn(supervisor.client, 'request').mockImplementation(async (cmd) => {
      if (cmd === 'status') return { state: 'preparing' };
      throw new Error('Fixture pipeline is still preparing');
    });
    expect(supervisor.active).toBe(false);
    await expect(supervisor.quit()).rejects.toThrow('still preparing');
    expect(kill).not.toHaveBeenCalled();
    supervisor.client.ingest('{"event":"state-changed","state":"armed"}\n');
    expect(supervisor.active).toBe(true);
  });
});
