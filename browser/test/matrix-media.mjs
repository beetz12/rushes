import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Only the isolated test runner consumes these generated native capture files.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Two-second native fake-device loop, 720p/30. The changing high-detail image
// avoids a static low-bitrate fixture; top-left luma and audio amplitude alternate
// together every 500 ms for independent decoded sync measurements.
export async function matrixMedia(directory) {
  const video = join(directory, 'calibration.y4m'), audio = join(directory, 'calibration.wav');
  const width = 1280, height = 720, plane = width * height;
  const file = await open(video, 'w');
  await file.write(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`);
  let random = 123456789;
  const texture = Buffer.alloc(plane);
  for (let index = 0; index < texture.length; index++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    texture[index] = 32 + ((random >>> 0) % 192);
  }
  for (let frame = 0; frame < 60; frame++) {
    const bytes = Buffer.alloc(plane * 3 / 2, 128), white = Math.floor(frame / 15) % 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      bytes[y * width + x] = process.env.RUSHES_M1_ENTROPY === '1'
        ? texture[(y * width + x + frame * 37) % plane]
        : 32 + (((Math.floor((x + frame * 3) / 12) * 17) ^ (Math.floor(y / 12) * 23)) % 192);
    for (let y = 0; y < 64; y++) bytes.fill(white ? 235 : 16, y * width, y * width + 64);
    await file.write('FRAME\n'); await file.write(bytes);
  }
  await file.close();
  const rate = 48000, samples = rate * 2, wav = Buffer.alloc(44 + samples * 2);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) wav.write(text, offset);
  for (const [offset, value] of [[4, wav.length - 8], [16, 16], [24, rate], [28, rate * 2], [40, samples * 2]]) wav.writeUInt32LE(value, offset);
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) wav.writeUInt16LE(value, offset);
  for (let index = 0; index < samples; index++) {
    const gain = Math.floor(index / (rate / 2)) % 2 ? 0.35 : 0.035;
    wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 1000 / rate) * gain * 32767), 44 + index * 2);
  }
  await writeFile(audio, wav);
  const anchored = join(directory, 'timecoded.mjpeg');
  const filters = ['drawbox=x=80:y=8:w=256:h=32:color=black:t=fill'];
  for (let bit = 0; bit < 16; bit++) filters.push(`drawbox=x=${80 + bit * 16}:y=8:w=16:h=32:color=white:t=fill:enable='bitand(floor(n/15),${2 ** bit})'`);
  await promisify(execFile)(process.env.RUSHES_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-stream_loop', '-1', '-i', video,
    '-t', process.env.RUSHES_M1_LONG === '1' ? '630' : '20', '-vf', filters.join(','), '-c:v', 'mjpeg', '-q:v', '8',
    '-pix_fmt', 'yuvj420p', '-threads', '2', '-f', 'mjpeg', anchored]);
  return { video: anchored, audio };
}
