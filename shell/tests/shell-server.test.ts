import { describe, it, expect } from 'vitest';
import { createConnection } from 'node:net';
import * as fixtureFiles from 'node:fs/promises';
import * as fixtureHost from 'node:os';
import * as fixturePaths from 'node:path';
import { startShellServer } from '../src/main/shell-server';
describe('local share service', () => {
  it('uses a private socket, rejects other routes, and returns correlated NDJSON', async () => {
    const root = await fixtureFiles.mkdtemp(
        fixturePaths.join(fixtureHost.tmpdir(), 'rushes-shell-'),
      ),
      path = fixturePaths.join(root, 'shell.sock');
    const server = await startShellServer(path, async (cmd) => ({ handled: cmd }));
    expect((await fixtureFiles.lstat(path)).mode & 0o777).toBe(0o600);
    try {
      const replies = await new Promise<any[]>((resolve, reject) => {
        const client = createConnection(path);
        client.setTimeout(1000, () => {
          client.destroy();
          reject(new Error('Local fixture response timed out'));
        });
        client.once('error', reject);
        let buffer = '';
        client.once('connect', () =>
          client.write(
            '{"id":"a","cmd":"share","args":{"id":"take"}}\n{"id":"b","cmd":"eval","args":{}}\n',
          ),
        );
        client.on('data', (data) => {
          buffer += data;
          if (buffer.trim().split('\n').length === 2) {
            client.destroy();
            resolve(
              buffer
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line)),
            );
          }
        });
      });
      expect(replies.find((r) => r.id === 'a')).toMatchObject({
        ok: true,
        result: { handled: 'share' },
      });
      expect(replies.find((r) => r.id === 'b')).toMatchObject({
        ok: false,
        error: { code: 'shell-service-error' },
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await fixtureFiles.rm(root, { recursive: true });
    }
  });
});
