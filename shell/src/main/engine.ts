import { EventEmitter } from 'node:events';
import { createConnection, Socket } from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const disconnected = () =>
  Object.assign(
    new Error(
      'The native engine is disconnected. Connection recovery is required before shutdown.',
    ),
    { code: 'engine-disconnected' },
  );
const sessionStates = [
  'idle',
  'preparing',
  'armed',
  'recording',
  'paused',
  'finishing',
  'complete',
  'failed',
];
export class EngineClient extends EventEmitter {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private connectingSocket?: Socket;
  private buffer = '';
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  async connect(path: string): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const operation = new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      this.connectingSocket = socket;
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        this.socket = socket;
        this.buffer = '';
        resolve();
      });
      socket.on('data', (data) => {
        if (this.socket === socket) this.ingest(data.toString());
      });
      socket.on('error', (error) => {
        if (this.socket === socket)
          this.emit('engine-error', { code: 'socket-error', message: error.message });
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.buffer = '';
        this.rejectAll('Engine disconnected. Your media stays in the recording library.');
        this.emit('disconnected');
      });
    }).finally(() => {
      this.connecting = undefined;
      this.connectingSocket = undefined;
    });
    this.connecting = operation;
    return operation;
  }
  get connected() {
    return !!this.socket && !this.socket.destroyed && this.socket.writable;
  }
  ingest(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.socket?.destroy();
      this.buffer = '';
      this.rejectAll('Oversized engine message');
      return;
    }
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let object: any;
      try {
        object = JSON.parse(line);
      } catch {
        this.emit('engine-error', { code: 'invalid-json', message: 'Invalid engine event' });
        continue;
      }
      if (typeof object.event === 'string') {
        this.emit('event', object);
        continue;
      }
      const waiting = this.pending.get(object.id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(object.id);
      if (object.ok === true) waiting.resolve(object.result);
      else
        waiting.reject(
          Object.assign(new Error(object.error?.message ?? 'Engine request failed'), {
            code: object.error?.code ?? 'engine-error',
          }),
        );
    }
  }
  request(cmd: string, args: Record<string, unknown> = {}, timeout = 120_000): Promise<any> {
    if (!this.connected) return Promise.reject(disconnected());
    const socket = this.socket!;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${cmd} timed out`), { code: 'engine-request-timeout' }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, cmd, args }) + '\n', (error) => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(disconnected());
      });
    });
  }
  private rejectAll(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { code: 'engine-disconnected' }));
    }
    this.pending.clear();
  }
  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = '';
    this.rejectAll('Engine connection closed.');
    socket?.destroy();
    this.connectingSocket?.destroy(disconnected());
  }
}
export class EngineSupervisor {
  readonly client = new EngineClient();
  child?: ChildProcess;
  private closing = false;
  active = false;
  private restartCount = 0;
  private restartTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private quitting?: Promise<void>;
  constructor(
    readonly enginePath: string,
    readonly socketPath: string,
    readonly recordingsRoot: string,
    readonly indexPath: string,
    private launch: typeof spawn = spawn,
  ) {
    this.client.on('event', (e) => {
      if (e.event === 'recording-started') this.active = true;
      if (
        e.event === 'state-changed' &&
        ['preparing', 'armed', 'recording', 'paused', 'finishing'].includes(e.state)
      )
        this.active = true;
      if (e.event === 'recording-stopped') this.active = false;
      if (e.event === 'state-changed' && e.state === 'idle') this.active = false;
    });
    this.client.on('disconnected', () => this.scheduleRestart());
  }
  async start() {
    if (this.closing)
      throw Object.assign(new Error('The engine is closing.'), { code: 'engine-closing' });
    return this.ensureStarted();
  }
  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    const operation = this.boot().finally(() => {
      this.starting = undefined;
    });
    this.starting = operation;
    return operation;
  }
  private scheduleRestart() {
    if (
      this.closing ||
      this.active ||
      this.restartTimer ||
      this.client.connected ||
      this.restartCount >= 3
    )
      return;
    this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closing || this.active || this.client.connected) return;
      void this.start().catch((error) =>
        this.client.emit('engine-error', { code: 'engine-start-failed', message: String(error) }),
      );
    }, 1000);
  }
  private async boot() {
    try {
      await this.client.connect(this.socketPath);
      return;
    } catch {}
    // A disconnected but live child may be recovering or opening its socket.
    // Reconnect to that child; never launch a second process beside it.
    const tracked = this.child;
    if (tracked?.exitCode === null && tracked.signalCode === null) {
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        this.child === tracked &&
        tracked.exitCode === null &&
        tracked.signalCode === null
      ) {
        try {
          await this.client.connect(this.socketPath);
          return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.child === tracked && tracked.exitCode === null && tracked.signalCode === null)
        throw Object.assign(
          new Error(
            'The native engine is still running but its connection could not be recovered. Keep Rushes open and retry.',
          ),
          { code: 'engine-recovery-failed' },
        );
    }
    await access(this.enginePath);
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const args = [
      '--socket-path',
      this.socketPath,
      '--recordings-root',
      this.recordingsRoot,
      '--index-path',
      this.indexPath,
      '--shell-bundle-id',
      'com.nexai.rushes',
    ];
    if (process.env.RUSHES_SMOKE === '1' && process.env.RUSHES_TEST_ENGINE_STUB === '1')
      args.push('--capture-stub');
    const child = this.launch(this.enginePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    console.log(`[Rushes] Native engine ${this.enginePath}`);
    child.stderr?.on('data', (chunk) => console.error('[engine]', chunk.toString().slice(0, 2000)));
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.scheduleRestart();
    });
    await new Promise<void>((resolve, reject) => {
      let ready = '';
      let booted = false;
      const timer = setTimeout(
        () => reject(new Error('Native engine did not become ready in 10 seconds')),
        10_000,
      );
      child.once('error', (e) => {
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        reject(e);
      });
      child.once('exit', () => {
        if (!booted) {
          clearTimeout(timer);
          reject(
            Object.assign(new Error('Native engine exited before becoming ready.'), {
              code: 'engine-start-failed',
            }),
          );
        }
      });
      child.stdout?.on('data', (data) => {
        if (booted) return;
        ready += data.toString();
        if (ready.length > 65536) {
          clearTimeout(timer);
          reject(new Error('Oversized engine startup message'));
          return;
        }
        const lines = ready.split('\n');
        ready = lines.pop() ?? '';
        for (const line of lines) {
          try {
            if (JSON.parse(line).event === 'ready') {
              booted = true;
              ready = '';
              clearTimeout(timer);
              resolve();
              return;
            }
          } catch {}
        }
      });
    });
    await this.client.connect(this.socketPath);
  }
  async quit() {
    if (this.quitting) return this.quitting;
    const operation = this.finishQuit().finally(() => {
      this.quitting = undefined;
    });
    this.quitting = operation;
    return operation;
  }
  private async freshStatus() {
    let live;
    try {
      live = await this.client.request('status', {}, 10_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'engine-disconnected') throw error;
      try {
        await this.ensureStarted();
      } catch (cause) {
        throw Object.assign(
          new Error(
            'The native engine connection could not be recovered. Keep Rushes open and retry Quit.',
          ),
          { code: 'engine-recovery-failed', cause },
        );
      }
      live = await this.client.request('status', {}, 10_000);
    }
    if (!sessionStates.includes(live?.state))
      throw Object.assign(
        new Error('Native status is unavailable or invalid; shutdown cannot be confirmed.'),
        { code: 'engine-status-invalid' },
      );
    return live;
  }
  private async finishQuit() {
    this.closing = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    try {
      const live = await this.freshStatus();
      this.active = live.state !== 'idle';
      if (this.active) {
        // A failed Stop deliberately holds the connection/child for a later retry.
        await this.client.request('record.stop');
        const stopped = await this.freshStatus();
        this.active = stopped.state !== 'idle';
        if (this.active)
          throw Object.assign(
            new Error('The native engine is still finalizing. Keep Rushes open and retry Quit.'),
            { code: 'recording-finalization-pending' },
          );
      }
      this.client.close();
      this.child?.kill('SIGTERM');
    } catch (error) {
      this.closing = false;
      this.scheduleRestart();
      throw error;
    }
  }
}
