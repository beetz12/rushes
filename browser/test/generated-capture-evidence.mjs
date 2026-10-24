import * as evidenceFiles from 'node:fs/promises';
import * as evidenceNames from 'node:path';
import * as evidenceOS from 'node:os';
import * as evidenceHash from 'node:crypto';

// Called only by the isolated generated fixtures, before their decode assertions.
export async function retainGeneratedCapture(directory, prefix, value) {
  const location = directory ?? await evidenceFiles.mkdtemp(evidenceNames.join(evidenceOS.tmpdir(), 'rushes-generated-proof-'));
  await evidenceFiles.mkdir(location, { recursive: true });
  const { retained, ...observations } = value, files = {};
  for (const [kind, encoded] of Object.entries(retained)) {
    const bytes = Buffer.from(encoded, 'base64');
    const name = `${prefix}-${kind}.webm`;
    await evidenceFiles.writeFile(evidenceNames.join(location, name), bytes);
    files[kind] = { name, bytes: bytes.length, sha256: evidenceHash.createHash('sha256').update(bytes).digest('hex') };
  }
  await evidenceFiles.writeFile(evidenceNames.join(location, `${prefix}.log`), JSON.stringify({ ...observations, files }, null, 2));
  return location;
}

// Serializable in page.evaluate; observations never substitute for sample timing.
export function observeGeneratedRecorders() {
  const Native = globalThis.MediaRecorder;
  let next = 0;
  globalThis.generatedRecorderObservations = { rows: [], dropped: 0 };
  globalThis.MediaRecorder = class extends Native {
    constructor(stream, ...options) {
      super(stream, ...options);
      const id = next++, tracks = stream.getTracks().map(track => track.kind);
      for (const kind of ['start', 'pause', 'resume', 'stop', 'error']) this.addEventListener(kind, () => {
        const log = globalThis.generatedRecorderObservations;
        if (log.rows.length < 256) log.rows.push({ id, kind, tracks, state: this.state, pageMs: performance.now() });
        else log.dropped++;
      });
    }
  };
  globalThis.restoreGeneratedRecorders = () => { globalThis.MediaRecorder = Native; };
}
