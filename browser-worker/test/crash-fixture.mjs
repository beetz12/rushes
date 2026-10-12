// Isolated synthetic process used only by the hard-stop regression.
import { writeFile } from 'node:fs/promises';
import { fixture, newRecording, storedChunk, finalInput } from './fixtures.mjs';
const [databasePath, providerPath] = process.argv.slice(2);
const f = await fixture();
const draft = await newRecording(f, 'alpha', 'process-stop-draft');
const chunk = await storedChunk(f, draft);
const input = finalInput(draft, chunk, f.now());
input.manifest.id = 'process-stop-draft';
const original = f.runtime.fetch;
f.runtime.fetch = async (url, options) => {
  const response = await original(url, options);
  if (String(url).includes('direct_user=true')) {
    // D1 and the provider outlive a Worker isolate. Preserve their acknowledged
    // state at this exact boundary, then let the parent terminate the process.
    f.db.db.prepare('VACUUM INTO ?').run(databasePath);
    await writeFile(
      providerPath,
      JSON.stringify({
        videos: [...f.providers.videos],
        raw: [...f.raw.objects].map(([key, value]) => [key, { ...value, bytes: [...value.bytes] }]),
      }),
    );
    process.send({ created: true, id: draft.id });
    await new Promise(() => {});
  }
  return response;
};
await f.request(`/api/recordings/${draft.id}/finalize`, f.auth('alpha', 'POST', input));
