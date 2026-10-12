import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp as newFixtureDirectory, writeFile as writeFixtureBytes, rm as removeFixtureDirectory } from 'node:fs/promises';
import { tmpdir as fixtureTempRoot } from 'node:os';
import { join as fixturePath } from 'node:path';
import { FakeR2, environment } from './fixtures.mjs';
import { WorkerProvider, JsonJobStore } from '../../cloud/dist/index.js';

test('R2 fixture rejects a small non-final multipart part and permits a small sole/final part', async () => {
    const storage = new FakeR2();
    const invalid = await storage.createMultipartUpload('invalid');
    const first = await invalid.uploadPart(1, new Uint8Array(32));
    const final = await invalid.uploadPart(2, new Uint8Array(8));
    await assert.rejects(() => invalid.complete([first, final]), /below R2 minimum/);
    await invalid.abort();
    const small = await storage.createMultipartUpload('small');
    const sole = await small.uploadPart(1, new Uint8Array(32));
    assert.equal((await small.complete([sole])).size, 32);
});

test('WorkerProvider sends at most four concurrent 10MiB parts with a small final part through R2-valid completion', async t => {
    const f = await environment(); t.after(f.close);
    const directory = await newFixtureDirectory(fixturePath(fixtureTempRoot(), 'rushes-r2-parts-')); t.after(() => removeFixtureDirectory(directory, { recursive: true, force: true }));
    const partBytes = 10 * 1024 * 1024;
    const path = fixturePath(directory, 'multipart.mp4');
    await writeFixtureBytes(path, Buffer.alloc(partBytes * 4 + 333, 0x4e));
    let active = 0, maximum = 0, entered = 0, release;
    const firstWave = new Promise(resolve => { release = resolve; });
    const escape = setTimeout(() => release(), 2000); t.after(() => clearTimeout(escape));
    const sizes = new Map();
    const resume = f.env.MEDIA.resumeMultipartUpload.bind(f.env.MEDIA);
    f.env.MEDIA.resumeMultipartUpload = (key, id) => {
        const multipart = resume(key, id), put = multipart.uploadPart.bind(multipart);
        multipart.uploadPart = async (number, bytes) => {
            active++; maximum = Math.max(maximum, active); sizes.set(number, bytes.byteLength);
            try {
                if (number <= 4) { entered++; if (entered === 4) { clearTimeout(escape); release(); } await firstWave; }
                return await put(number, bytes);
            } finally { active--; }
        };
        return multipart;
    };
    const store = new JsonJobStore(fixturePath(directory, 'jobs'));
    const provider = new WorkerProvider({ workerURL: f.env.PUBLIC_BASE_URL, token: f.env.OWNER_TOKEN }, { store, fetch: (url, options = {}) => f.worker.fetch(new Request(url, options), f.env) });
    const share = await provider.reserve({ id: 'abcdefghijklmnopqrstuv', title: 'Multipart fixture' });
    const asset = await provider.upload(share, { path, kind: 'video' });
    assert.equal(maximum, 4);
    assert.deepEqual([...sizes].sort((a, b) => a[0] - b[0]), [[1, partBytes], [2, partBytes], [3, partBytes], [4, partBytes], [5, 333]]);
    assert.equal((await f.env.MEDIA.head(`s/${share.id}/${asset.file}`)).size, partBytes * 4 + 333);
    assert.equal((await store.read(share.id)).uploads[asset.file].completed, true);
});
