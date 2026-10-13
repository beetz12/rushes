import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import * as fixtureFiles from 'node:fs/promises';
import * as fixtureHost from 'node:os';
import * as fixturePaths from 'node:path';
import { once } from 'node:events';
import { EngineClient, EngineSupervisor } from './engine';
import { isConnectionErrorCode } from '../shared/connection-error';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function peer(connected: (socket: Socket, connection: number) => void) {
  const root = await fixtureFiles.mkdtemp(
    fixturePaths.join(fixtureHost.tmpdir(), 'rushes-terminal-transport-'),
  );
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    connected(socket, ++connections);
  });
  const path = fixturePaths.join(root, 'control.sock');
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(path, done);
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await fixtureFiles.rm(root, { recursive: true, force: true });
  });
  return { root, path, sockets, server, connections: () => connections };
}
function requests(socket: Socket, received: (message: any) => void) {
  socket.setEncoding('utf8');
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk;
    for (;;) {
      const boundary = input.indexOf('\n');
      if (boundary < 0) return;
      const message = JSON.parse(input.slice(0, boundary));
      input = input.slice(boundary + 1);
      received(message);
    }
  });
}
describe('terminal malformed engine input', () => {
  it('rejects pending requests, closes only the socket, and ignores apparently valid trailing status/events', async () => {
    const fixture = await peer((socket) =>
      requests(socket, (message) => {
        socket.write(
          'sensitive-generated-prefix\n' +
            JSON.stringify({ event: 'state-changed', state: 'idle' }) +
            '\n' +
            JSON.stringify({ id: message.id, ok: true, result: { state: 'idle' } }) +
            '\n',
        );
      }),
    );
    const client = new EngineClient(),
      events = vi.fn(),
      errors = vi.fn();
    client.on('event', events);
    client.on('engine-error', errors);
    await client.connect(fixture.path);
    const disconnected = once(client, 'disconnected');
    const rejected = expect(client.request('status')).rejects.toMatchObject({
      code: 'engine-disconnected',
    });
    await rejected;
    await disconnected;
    expect(client.connected).toBe(false);
    expect(events).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledExactlyOnceWith({
      code: 'invalid-json',
      message: 'Invalid engine event',
      lineBytes: 26,
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('sensitive-generated-prefix');
    client.ingest('{"event":"recording-stopped","recordingId":"retained-take"}\n');
    expect(events).not.toHaveBeenCalled();
    client.close();
  });
  it.each(['null', '[]', '4', '"not-an-object"'])(
    'terminates a %s top-level envelope without throwing or accepting a later event',
    (message) => {
      const client = new EngineClient(),
        errors = vi.fn(),
        events = vi.fn();
      client.on('engine-error', errors);
      client.on('event', events);
      expect(() => client.ingest(message + '\n{"event":"recording-stopped"}\n')).not.toThrow();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(events).not.toHaveBeenCalled();
    },
  );
  it('resets the connection-local failure latch on reconnect and preserves valid primitive payloads', async () => {
    const fixture = await peer((socket, connection) =>
      requests(socket, (message) => {
        socket.write(
          connection === 1
            ? 'malformed\n'
            : JSON.stringify({ id: message.id, ok: true, result: null }) + '\n',
        );
      }),
    );
    const client = new EngineClient();
    await client.connect(fixture.path);
    const lost = once(client, 'disconnected');
    await expect(client.request('ping')).rejects.toMatchObject({ code: 'engine-disconnected' });
    await lost;
    await client.connect(fixture.path);
    await expect(client.request('ping')).resolves.toBeNull();
    expect(client.connected).toBe(true);
    client.close();
  });
  it('keeps an active take and error intact until held fresh-status recovery is verified, without launching, killing or sending Stop', async () => {
    const commands: string[] = [];
    let first: Socket | undefined;
    let freshStatus: ((state: string) => void) | undefined;
    const fixture = await peer((socket, connection) => {
      if (connection === 1) first = socket;
      else socket.write('{"event":"warning","code":"generated-peer-ready"}\n');
      requests(socket, (message) => {
        commands.push(message.cmd);
        if (message.cmd === 'status' && connection > 1) {
          freshStatus = (state) =>
            socket.write(
              JSON.stringify({
                id: message.id,
                ok: true,
                result: { state, recording: { recordingID: 'retained-take' } },
              }) + '\n',
            );
        }
      });
    });
    const launch = vi.fn(),
      kill = vi.fn();
    const supervisor = new EngineSupervisor(
      '/never/launch/engine',
      fixture.path,
      fixture.root,
      fixturePaths.join(fixture.root, 'index'),
      launch as any,
    );
    supervisor.child = { exitCode: null, signalCode: null, kill } as any;
    let shownError: unknown;
    const recovered = vi.fn();
    const ordinaryEvent = vi.fn();
    supervisor.client.on('engine-error', (error) => {
      shownError = error.code;
    });
    supervisor.client.on('event', (event) => {
      if (event.event === 'warning') ordinaryEvent(event);
      if (event.event === 'engine-reconnected') {
        recovered(event);
        if (isConnectionErrorCode(shownError)) shownError = undefined;
      }
    });
    await supervisor.start();
    await vi.waitFor(() => expect(first).toBeDefined());
    first!.write('{"event":"recording-started","recordingId":"retained-take"}\n');
    await vi.waitFor(() => expect(supervisor.active).toBe(true));
    first!.write(
      'partial-generated-preview\n{"event":"recording-stopped","recordingId":"retained-take"}\n',
    );
    await vi.waitFor(() => expect(freshStatus).toBeDefined(), { timeout: 2500 });
    expect(shownError).toBe('invalid-json');
    expect(ordinaryEvent).toHaveBeenCalledWith({ event: 'warning', code: 'generated-peer-ready' });
    expect(recovered).not.toHaveBeenCalled();
    expect(supervisor.active).toBe(true);
    expect(supervisor.client.connected).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(commands).toEqual(['status']);
    freshStatus!('recording');
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
    expect(recovered).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'engine-reconnected', state: 'recording' }),
    );
    expect(shownError).toBeUndefined();
    expect(supervisor.active).toBe(true);
    expect(commands).toEqual(['status']);
    expect(launch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    supervisor.client.close();
  }, 5000);
});
