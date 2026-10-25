import { describe, it, expect, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import * as files from 'node:fs/promises';
import * as operatingSystem from 'node:os';
import * as paths from 'node:path';
import { randomUUID } from 'node:crypto';
import { EngineSupervisor } from '../src/main/engine';
import type { ChildProcess } from 'node:child_process';

async function fixture() {
  const root = await files.mkdtemp(paths.join(operatingSystem.tmpdir(), 'rushes-update-'));
  const path = paths.join(root, 'control.sock');
  const connections = new Set<Socket>();
  const commands: { cmd: string; token?: string; socket: Socket }[] = [];
  let held: string | undefined;
  let pid = process.pid;
  let acquireDelay = 0;
  let releaseInvalid = false;
  let releaseCount = 0;
  let parkRelease = 0;
  let parkedRelease: (() => void) | undefined;
  let lateAcquire: (() => void) | undefined;
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const reply = (result: unknown) => {
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
        };
        if (request.cmd === 'preview.subscribe') { reply({ enabled: true }); continue; }
        commands.push({ cmd: request.cmd, token: request.args.token, socket });
        if (request.cmd === 'status') reply({ pid, state: 'idle' });
        else if (request.cmd === 'update.hold.acquire') {
          const acquire = () => {
            // Model the native socket-liveness admission check. Late request
            // tasks cannot reserve after supervisor invalidates this socket.
            if (socket.destroyed) return;
            held = request.args.token;
            reply({ pid, held: true });
          };
          if (acquireDelay) lateAcquire = acquire;
          else acquire();
        } else if (request.cmd === 'update.hold.release') {
          if (held === request.args.token) held = undefined;
          const acknowledge = () => reply({ pid: releaseInvalid ? pid + 1 : pid, held: false });
          if (++releaseCount === parkRelease) parkedRelease = acknowledge; else acknowledge();
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  const launch = vi.fn();
  const supervisor = new EngineSupervisor('/missing/engine', path, root, paths.join(root, 'index'), launch as any);
  const child = { pid: process.pid, exitCode: null, signalCode: null, kill: vi.fn() } as unknown as ChildProcess;
  supervisor.child = child;
  await supervisor.client.connect(path);
  return {
    supervisor, child, launch, commands,
    held: () => held,
    pid: (value: number) => { pid = value; },
    delayAcquire: () => { acquireDelay = 1; },
    invalidRelease: (value: boolean) => { releaseInvalid = value; },
    lateAcquire: () => lateAcquire?.(),
    parkRelease: (number: number) => {parkRelease = number;},
    finishRelease: () => parkedRelease?.(),
    disconnect: async () => {
      for (const socket of connections) socket.destroy();
      await vi.waitFor(() => expect(supervisor.client.connected).toBe(false));
    },
    close: async () => {
      // Fixture teardown avoids quit's process signal; the child here only
      // represents ownership of this test's live PID for read-only kill(0).
      (supervisor as any).closing = true;
      (supervisor as any).previews.stop();
      clearTimeout((supervisor as any).restartTimer);
      supervisor.client.close();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await files.rm(root, { recursive: true, force: true });
    },
  };
}

describe('native update hold ownership', () => {
  it('refuses adopted/untracked engines without booting or sending an acquire', async () => {
    const f = await fixture();
    try {
      f.supervisor.child = undefined;
      await expect(f.supervisor.acquireUpdateHold(randomUUID())).rejects.toMatchObject({ code: 'update-engine-unowned' });
      expect(f.commands).toEqual([]);
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.supervisor.updateHoldPending).toBe(false);
    } finally { await f.close(); }
  });

  it('holds capture/restart admission until matching same-PID release across reconnect', async () => {
    const f = await fixture();
    try {
      const token = randomUUID();
      const hold = await f.supervisor.acquireUpdateHold(token);
      expect(hold).toEqual({ token, pid: process.pid });
      expect(Object.isFrozen(hold)).toBe(true);
      expect(f.supervisor.updateHoldPending).toBe(true);
      await expect(f.supervisor.start()).rejects.toMatchObject({ code: 'update-held' });
      await expect(f.supervisor.releaseUpdateHold({ ...hold, token: randomUUID() })).rejects.toMatchObject({ code: 'update-token-mismatch' });
      expect(f.held()).toBe(token);
      await f.disconnect();
      await f.supervisor.releaseUpdateHold(hold);
      expect(f.held()).toBeUndefined();
      expect(f.supervisor.updateHoldPending).toBe(false);
      expect(f.commands.map((c) => c.cmd)).toEqual(['update.hold.acquire', 'status', 'update.hold.release']);
      expect(f.launch).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('invalidates a timed-out acquire socket before same-child reconnect/release and late acquisition', async () => {
    const f = await fixture();
    try {
      f.delayAcquire();
      const request = f.supervisor.client.request.bind(f.supervisor.client);
      vi.spyOn(f.supervisor.client, 'request').mockImplementation((cmd, args, timeout) =>
        request(cmd, args, cmd === 'update.hold.acquire' ? 25 : timeout));
      const token = randomUUID();
      await expect(f.supervisor.acquireUpdateHold(token)).rejects.toMatchObject({ code: 'engine-request-timeout' });
      expect(f.commands.map((c) => c.cmd)).toEqual(['update.hold.acquire', 'status', 'update.hold.release']);
      expect(f.commands[0].socket.destroyed).toBe(true);
      expect(f.commands[0].socket).not.toBe(f.commands[1].socket);
      expect(f.commands[2].token).toBe(token);
      f.lateAcquire();
      expect(f.held()).toBeUndefined();
      expect(f.supervisor.updateHoldPending).toBe(false);
      expect(f.launch).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('rejects an acquire reply for another PID and keeps unknown cleanup explicit', async () => {
    const f = await fixture();
    try {
      f.pid(process.pid + 1);
      const token = randomUUID();
      let failure: any;
      try { await f.supervisor.acquireUpdateHold(token); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'update-hold-cleanup-unknown', hold: { token, pid: process.pid } });
      expect(f.supervisor.updateHoldPending).toBe(true);
      expect(f.commands.map((c) => c.cmd)).toEqual(['update.hold.acquire', 'status']);
      expect(f.launch).not.toHaveBeenCalled();
      // A later explicit retry must re-confirm the original PID before release.
      f.pid(process.pid);
      await f.disconnect();
      await f.supervisor.releaseUpdateHold(failure.hold);
      expect(f.supervisor.updateHoldPending).toBe(false);
    } finally { await f.close(); }
  });

  it('never reconnects or releases against a replacement tracked child after timeout', async () => {
    const f = await fixture();
    try {
      f.delayAcquire();
      const request = f.supervisor.client.request.bind(f.supervisor.client);
      vi.spyOn(f.supervisor.client, 'request').mockImplementation((cmd, args, timeout) => {
        if (cmd === 'update.hold.acquire') {
          f.supervisor.child = { ...f.child } as ChildProcess;
          return request(cmd, args, 25);
        }
        return request(cmd, args, timeout);
      });
      await expect(f.supervisor.acquireUpdateHold(randomUUID())).rejects.toMatchObject({ code: 'update-hold-cleanup-unknown' });
      expect(f.commands.map((c) => c.cmd)).toEqual(['update.hold.acquire']);
      expect(f.supervisor.updateHoldPending).toBe(true);
      expect(f.launch).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('keeps failed release blocked and retries its known token on the same engine', async () => {
    const f = await fixture();
    try {
      const hold = await f.supervisor.acquireUpdateHold(randomUUID());
      f.invalidRelease(true);
      await expect(f.supervisor.releaseUpdateHold(hold)).rejects.toMatchObject({ code: 'update-hold-cleanup-unknown' });
      expect(f.supervisor.updateHoldPending).toBe(true);
      f.invalidRelease(false);
      await f.supervisor.releaseUpdateHold(hold);
      expect(f.supervisor.updateHoldPending).toBe(false);
    } finally { await f.close(); }
  });
  it('a delayed old release acknowledgement cannot clear a newer native hold', async () => {
    const f = await fixture();
    try {
      const first = await f.supervisor.acquireUpdateHold(randomUUID()); f.parkRelease(2);
      const releaseOne = f.supervisor.releaseUpdateHold(first), releaseTwo = f.supervisor.releaseUpdateHold(first);
      await releaseOne;
      const next = await f.supervisor.acquireUpdateHold(randomUUID());
      expect(f.held()).toBe(next.token); f.finishRelease(); await releaseTwo;
      expect(f.supervisor.updateHoldPending).toBe(true); expect(f.held()).toBe(next.token);
      await f.supervisor.releaseUpdateHold(next); expect(f.supervisor.updateHoldPending).toBe(false);
    } finally {f.finishRelease(); await f.close();}
  });

});
