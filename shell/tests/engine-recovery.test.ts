import { describe, it, expect, vi, afterEach } from 'vitest';
import * as sockets from 'node:net';
import * as files from 'node:fs/promises';
import * as paths from 'node:path';
import * as host from 'node:os';
import { once } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EngineClient, EngineSupervisor } from '../src/main/engine';
afterEach(() => vi.useRealTimers());

async function service(path: string, state: string) {
  let current = state,
    stopMode: 'done' | 'pending' | 'fail' = 'done';
  const connections = new Set<sockets.Socket>();
  const commands: string[] = [];
  let nextStatusEvent: string | undefined;
  const server = sockets.createServer((socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n');
        const request = JSON.parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
        commands.push(request.cmd);
        if (request.cmd === 'record.stop' && stopMode === 'fail') {
          socket.write(
            JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                code: 'fixture-stop-failed',
                message: 'Finalization could not be confirmed',
              },
            }) + '\n',
          );
          continue;
        }
        if (request.cmd === 'record.stop') current = stopMode === 'pending' ? 'finishing' : 'idle';
        let response =
          JSON.stringify({ id: request.id, ok: true, result: { state: current } }) + '\n';
        if (request.cmd === 'status' && nextStatusEvent) {
          current = nextStatusEvent;
          nextStatusEvent = undefined;
          response +=
            JSON.stringify({ event: 'recording-started', recordingId: 'next-take' }) + '\n';
        }
        socket.write(response);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    commands,
    connections,
    state: (value: string) => {
      current = value;
    },
    raceNextStatus: (value: string) => {
      nextStatusEvent = value;
    },
    stop: (mode: typeof stopMode) => {
      stopMode = mode;
    },
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
describe('shutdown connection recovery', () => {
  it('rereads a reply superseded by a new-take event in the same packet', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-status-packet-'));
    const peer = await service(paths.join(root, 'control.sock'), 'idle');
    const launch = vi.fn();
    const supervisor = new EngineSupervisor(
      '/missing/engine',
      paths.join(root, 'control.sock'),
      root,
      paths.join(root, 'index'),
      launch as any,
    );
    try {
      await supervisor.start();
      supervisor.active = true;
      peer.raceNextStatus('recording');
      const recovered = vi.fn();
      supervisor.client.on('event', recovered);
      const lost = once(supervisor.client, 'disconnected');
      for (const socket of peer.connections) socket.destroy();
      await lost;
      await vi.waitFor(
        () =>
          expect(recovered).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'engine-reconnected', state: 'recording' }),
          ),
        { timeout: 2500 },
      );
      expect(
        recovered.mock.calls
          .filter(([e]) => e.event === 'engine-reconnected')
          .map(([e]) => e.state),
      ).toEqual(['recording']);
      expect(peer.commands).toEqual(['status', 'status']);
      expect(supervisor.active).toBe(true);
      expect(launch).not.toHaveBeenCalled();
      peer.state('idle');
      await supervisor.quit();
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('retries a connected peer whose first verification is malformed', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-invalid-retry-'));
    const peer = await service(paths.join(root, 'control.sock'), 'unknown');
    const supervisor = new EngineSupervisor(
      '/missing/engine',
      paths.join(root, 'control.sock'),
      root,
      paths.join(root, 'index'),
    );
    try {
      await supervisor.start();
      supervisor.active = true;
      const errors = vi.fn();
      supervisor.client.on('engine-error', errors);
      const lost = once(supervisor.client, 'disconnected');
      for (const socket of peer.connections) socket.destroy();
      await lost;
      await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 2000 });
      peer.state('idle');
      await vi.waitFor(() => expect(supervisor.active).toBe(false), { timeout: 2000 });
      expect(peer.commands).toEqual(['status', 'status']);
      expect(supervisor.client.connected).toBe(true);
      await supervisor.quit();
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('reconciles a missed Stop from fresh idle and can recover a later independent outage', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-missed-stop-'));
    const peer = await service(paths.join(root, 'control.sock'), 'idle');
    const launch = vi.fn();
    const supervisor = new EngineSupervisor(
      '/missing/engine',
      paths.join(root, 'control.sock'),
      root,
      paths.join(root, 'index'),
      launch as any,
    );
    try {
      await supervisor.start();
      for (let outage = 0; outage < 4; outage++) {
        supervisor.active = true;
        const lost = once(supervisor.client, 'disconnected');
        for (const socket of peer.connections) socket.destroy();
        await lost;
        await vi.waitFor(() => expect(supervisor.active).toBe(false), { timeout: 2000 });
        expect(supervisor.client.connected).toBe(true);
      }
      expect(peer.commands).toEqual(['status', 'status', 'status', 'status']);
      expect(launch).not.toHaveBeenCalled();
      await supervisor.quit();
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  }, 10_000);
  it('bounds failed active reconnections and never launches or stops a cached take', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-recovery-bound-'));
    const peer = await service(paths.join(root, 'control.sock'), 'recording');
    const launch = vi.fn();
    const supervisor = new EngineSupervisor(
      '/missing/engine',
      paths.join(root, 'control.sock'),
      root,
      paths.join(root, 'index'),
      launch as any,
    );
    try {
      await supervisor.start();
      supervisor.active = true;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const lost = once(supervisor.client, 'disconnected');
      await peer.close();
      await lost;
      const reconnect = vi
        .spyOn(supervisor.client, 'connect')
        .mockRejectedValue(new Error('Fixture path unavailable'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reconnect).toHaveBeenCalledTimes(3);
      expect(launch).not.toHaveBeenCalled();
      expect(peer.commands).toEqual([]);
      expect(supervisor.active).toBe(true);
    } finally {
      supervisor.client.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('recovers the same live engine after a capture-time connection loss without launching another process', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-active-connection-'));
    const peer = await service(paths.join(root, 'control.sock'), 'recording');
    const launch = vi.fn();
    const supervisor = new EngineSupervisor(
      '/missing/engine',
      paths.join(root, 'control.sock'),
      root,
      paths.join(root, 'index'),
      launch as any,
    );
    try {
      await supervisor.start();
      supervisor.active = true;
      const recovered = vi.fn();
      supervisor.client.on('event', recovered);
      const lost = once(supervisor.client, 'disconnected');
      for (const socket of peer.connections) socket.destroy();
      await lost;
      await vi.waitFor(
        () =>
          expect(recovered).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'engine-reconnected', state: 'recording' }),
          ),
        { timeout: 2500 },
      );
      expect(supervisor.client.connected).toBe(true);
      expect(supervisor.active).toBe(true);
      expect(launch).not.toHaveBeenCalled();
      expect(peer.commands).toEqual(['status']);
      peer.state('idle');
      await supervisor.quit();
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('reconnects after an engine disconnect and requires fresh idle status despite stale active cache', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-quit-recovery-'));
    const path = paths.join(root, 'control.sock');
    let serving = await service(path, 'idle');
    const supervisor = new EngineSupervisor(
      '/missing/fixture/engine',
      path,
      root,
      paths.join(root, 'index'),
    );
    try {
      await supervisor.start();
      supervisor.active = true;
      const disconnected = once(supervisor.client, 'disconnected');
      await serving.close();
      await disconnected;
      serving = await service(path, 'idle');
      await expect(supervisor.quit()).resolves.toBeUndefined();
      expect(serving.commands).toEqual(['status']);
      expect(supervisor.active).toBe(false);
    } finally {
      supervisor.client.close();
      await serving.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
});
describe('fresh status and lifecycle negative controls', () => {
  it('holds failed Stop and pending post-Stop status, then succeeds only after fresh idle', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-quit-holds-'));
    const path = paths.join(root, 'control.sock');
    const peer = await service(path, 'preparing');
    const supervisor = new EngineSupervisor(
      '/missing/fixture/engine',
      path,
      root,
      paths.join(root, 'index'),
    );
    const kill = vi.fn();
    try {
      await supervisor.start();
      supervisor.child = { kill } as unknown as ChildProcess;
      peer.stop('fail');
      await expect(supervisor.quit()).rejects.toMatchObject({ code: 'fixture-stop-failed' });
      expect(kill).not.toHaveBeenCalled();
      expect(supervisor.client.connected).toBe(true);
      peer.stop('pending');
      await expect(supervisor.quit()).rejects.toMatchObject({
        code: 'recording-finalization-pending',
      });
      expect(kill).not.toHaveBeenCalled();
      expect(supervisor.client.connected).toBe(true);
      peer.stop('done');
      await supervisor.quit();
      expect(peer.commands).toEqual([
        'status',
        'record.stop',
        'status',
        'record.stop',
        'status',
        'status',
        'record.stop',
        'status',
      ]);
      expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('does not accept malformed status as cached idle or bypass Stop for a failed session', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-status-holds-'));
    const path = paths.join(root, 'control.sock');
    const peer = await service(path, 'unknown');
    const supervisor = new EngineSupervisor(
      '/missing/fixture/engine',
      path,
      root,
      paths.join(root, 'index'),
    );
    const kill = vi.fn();
    try {
      await supervisor.start();
      supervisor.child = { kill } as unknown as ChildProcess;
      await expect(supervisor.quit()).rejects.toMatchObject({ code: 'engine-status-invalid' });
      expect(kill).not.toHaveBeenCalled();
      peer.state('failed');
      peer.stop('fail');
      await expect(supervisor.quit()).rejects.toMatchObject({ code: 'fixture-stop-failed' });
      expect(kill).not.toHaveBeenCalled();
      expect(supervisor.client.connected).toBe(true);
      peer.state('idle');
      await supervisor.quit();
      expect(kill).toHaveBeenCalledOnce();
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('coalesces concurrent connections and ignores an old socket close after replacement', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-socket-generation-'));
    const path = paths.join(root, 'control.sock');
    const peer = await service(path, 'idle');
    const client = new EngineClient();
    try {
      await Promise.all([client.connect(path), client.connect(path)]);
      await vi.waitFor(() => expect(peer.connections.size).toBe(1));
      // Capture the prior transport solely to schedule its stale completion explicitly.
      const old = (client as unknown as { socket: sockets.Socket }).socket;
      client.close();
      await client.connect(path);
      old.emit('close');
      await expect(client.request('status')).resolves.toEqual({ state: 'idle' });
      expect(client.connected).toBe(true);
    } finally {
      client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('shares a pending startup with Quit, suppresses restart after Quit, and does not clear a replacement child on stale exit', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-owned-start-'));
    const path = paths.join(root, 'control.sock'),
      executable = paths.join(root, 'engine-fixture');
    await files.writeFile(executable, 'injected-process-contract');
    let peer: Awaited<ReturnType<typeof service>> | undefined;
    const children: ChildProcess[] = [];
    const launch = vi.fn(() => {
      const child = new ChildProcess();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
      child.kill = vi.fn(() => {
        Object.assign(child, { exitCode: 0 });
        child.emit('exit', 0, null);
        return true;
      });
      children.push(child);
      void service(path, 'idle').then((value) => {
        peer = value;
        child.stdout!.emit('data', Buffer.from('{"event":"ready"}\n'));
      });
      return child;
    });
    const supervisor = new EngineSupervisor(
      executable,
      path,
      root,
      paths.join(root, 'index'),
      launch as unknown as typeof import('node:child_process').spawn,
    );
    try {
      const one = supervisor.start(),
        two = supervisor.start();
      await Promise.all([one, two, supervisor.quit(), supervisor.quit()]);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(peer!.commands).toEqual(['status']);
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
      await expect(supervisor.start()).rejects.toMatchObject({ code: 'engine-closing' });
      const replacement = new ChildProcess();
      supervisor.child = replacement;
      children[0].emit('exit', 0, null);
      expect(supervisor.child).toBe(replacement);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      supervisor.client.close();
      if (peer) await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
  it('cancels a queued idle restart when Quit reconnects to a replacement service', async () => {
    const root = await files.mkdtemp(paths.join(host.tmpdir(), 'rushes-restart-cancel-'));
    const path = paths.join(root, 'control.sock');
    let peer = await service(path, 'idle');
    const supervisor = new EngineSupervisor(
      '/missing/fixture/engine',
      path,
      root,
      paths.join(root, 'index'),
    );
    try {
      await supervisor.start();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const lost = once(supervisor.client, 'disconnected');
      await peer.close();
      await lost;
      peer = await service(path, 'idle');
      const start = vi.spyOn(supervisor, 'start');
      await supervisor.quit();
      await vi.advanceTimersByTimeAsync(1500);
      expect(start).not.toHaveBeenCalled();
      expect(peer.commands).toEqual(['status']);
    } finally {
      supervisor.client.close();
      await peer.close();
      await files.rm(root, { recursive: true, force: true });
    }
  });
});
