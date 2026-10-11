import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function atomicBytes(path: string, value: Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (e) {
    await handle?.close();
    await unlink(temporary).catch(() => {});
    throw e;
  }
}

export async function atomicJSON(path: string, value: unknown) {
  await atomicBytes(path, Buffer.from(JSON.stringify(value, null, 2)));
}
