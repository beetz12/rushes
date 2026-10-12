import { realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function copyVideoFile(
  path: string,
  allow: (path: string) => Promise<unknown>,
  clipboard: {
    write(data: Record<string, string>): Promise<void>;
  },
) {
  const file = await realpath(path);
  await allow(file);
  if (!(await stat(file)).isFile() || !['.mp4', '.mov'].includes(extname(file).toLowerCase()))
    throw Object.assign(new Error('A rendered video file is required.'), {
      code: 'clipboard-file-invalid',
    });
  const url = pathToFileURL(file).toString();
  await clipboard.write({
    'text/uri-list': url,
    'electron application/osclipboard;format="public.file-url"': url,
  });
  return { copied: true };
}
