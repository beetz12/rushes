import { createServer, createConnection, type Server } from 'node:net';
import { lstat, unlink, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { shareCommands } from '../shared/contracts';
const schema = z
  .object({
    id: z.string().min(1).max(200),
    cmd: z.enum(shareCommands),
    args: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export async function startShellServer(
  path: string,
  handler: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Server> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isSocket() || info.uid !== process.getuid?.())
      throw new Error('Refusing an unsafe shell socket path');
    const live = await new Promise<boolean>((resolve) => {
      const s = createConnection(path);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (live) throw new Error('Another Rushes shell is serving commands');
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > 256 * 1024) {
        socket.destroy();
        return;
      }
      for (;;) {
        const n = buffer.indexOf('\n');
        if (n < 0) break;
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        void (async () => {
          let id = 'invalid';
          try {
            const raw = JSON.parse(line);
            if (typeof raw.id === 'string') id = raw.id;
            const r = schema.parse(raw);
            const result = await handler(r.cmd, r.args);
            socket.write(JSON.stringify({ id, ok: true, result }) + '\n');
          } catch (error) {
            socket.write(
              JSON.stringify({
                id,
                ok: false,
                error: {
                  code: (error as any).code ?? 'shell-service-error',
                  message: (error as Error).message,
                },
              }) + '\n',
            );
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return server;
}
