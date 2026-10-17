// Test stimulus with one declared content timeline. No browser callback clock.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const run = promisify(execFile);

export async function synchronizedMedia(directory, seconds = 20, initialOrdinal = 0) {
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 630) throw new Error('Invalid fixture length');
  if (!Number.isInteger(initialOrdinal) || initialOrdinal < 0 || initialOrdinal + seconds * 2 >= 4096)
    throw new Error('Invalid initial fixture ordinal');
  const optical = initialOrdinal ? `(floor(n/15)+${initialOrdinal})` : 'floor(n/15)';
  const phase = initialOrdinal ? `(floor(t*2)+${initialOrdinal})` : 'floor(t*2)';
  const filters = ['drawbox=x=80:y=8:w=256:h=32:color=black:t=fill'];
  for (let bit = 0; bit < 16; bit++) filters.push(`drawbox=x=${80 + bit * 16}:y=8:w=16:h=32:color=white:t=fill:enable='bitand(${optical},${2 ** bit})'`);
  const tone = `aevalsrc='0.15*(sin(2*PI*(500+mod(${phase},64)*40)*t)+sin(2*PI*(4000+floor(${phase}/64)*80)*t))':s=48000`;
  const file = join(directory, 'synchronized.webm');
  await run(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', tone,
    '-t', String(seconds), '-vf', filters.join(','), '-c:v', 'libvpx', '-deadline', 'realtime',
    '-cpu-used', '8', '-b:v', '4M', '-threads', '2', '-c:a', 'libopus', '-ar', '48000', file]);
  return file;
}
