import { EventEmitter } from 'node:events';
import { createConnection, Socket } from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class EngineClient extends EventEmitter {
  private socket?: Socket;
  private buffer = '';
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  async connect(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        this.socket = socket;
        resolve();
      });
      socket.on('data', (data) => this.ingest(data.toString()));
      socket.on('error', (error) =>
        this.emit('engine-error', { code: 'socket-error', message: error.message }),
      );
      socket.on('close', () => {
        this.socket = undefined;
        this.rejectAll('Engine disconnected. Your media stays in the recording library.');
        this.emit('disconnected');
      });
    });
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
    if (!this.socket)
      return Promise.reject(new Error('The native engine is disconnected. Relaunch Rushes.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }
  private rejectAll(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  close() {
    this.socket?.destroy();
  }
}
export class EngineSupervisor {
  readonly client = new EngineClient();
  child?: ChildProcess;
  private closing = false;
  active = false;
  private restartCount = 0;
  constructor(
    readonly enginePath: string,
    readonly socketPath: string,
    readonly recordingsRoot: string,
    readonly indexPath: string,
  ) {
    this.client.on('event', (e) => {
      if (e.event === 'recording-started') this.active = true;
      if (
        e.event === 'state-changed' &&
        ['preparing', 'armed', 'recording', 'paused', 'finishing'].includes(e.state)
      )
        this.active = true;
      if (e.event === 'recording-stopped') this.active = false;
    });
  }
  async start() {
    try {
      await this.client.connect(this.socketPath);
      return;
    } catch {}
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
    this.child = spawn(this.enginePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[Rushes] Native engine ${this.enginePath}`);
    this.child.stderr?.on('data', (chunk) =>
      console.error('[engine]', chunk.toString().slice(0, 2000)),
    );
    this.child.on('exit', () => {
      this.child = undefined;
      if (this.closing || this.active) return;
      if (this.restartCount++ < 3)
        setTimeout(
          () =>
            this.start().catch((e) =>
              this.client.emit('engine-error', { code: 'engine-start-failed', message: String(e) }),
            ),
          1000,
        );
    });
    await new Promise<void>((resolve, reject) => {
      let ready = '';
      let booted = false;
      const timer = setTimeout(
        () => reject(new Error('Native engine did not become ready in 10 seconds')),
        10_000,
      );
      this.child!.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.child!.stdout?.on('data', (data) => {
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
    this.closing = true;
    try {
      const live = await this.client.request('status');
      this.active = ['preparing', 'armed', 'recording', 'paused', 'finishing'].includes(live.state);
      if (this.active) await this.client.request('record.stop');
      this.client.close();
      this.child?.kill('SIGTERM');
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
}
