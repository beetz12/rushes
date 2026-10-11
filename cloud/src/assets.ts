import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { ShareError, type UploadInput, type UploadedAsset } from './types.js';
export const PART_BYTES = 10 * 1024 * 1024;
export const MIME = { video:'video/mp4',poster:'image/jpeg',captions:'text/vtt',transcript:'application/json' } as const;
export async function describeAsset(input: UploadInput): Promise<UploadedAsset & { contentType: string }> {
  const info=await stat(input.path); if (!info.isFile() || info.size <= 0 || info.size > 50 * 1024 ** 3) throw new ShareError('INVALID_FILE', 'Asset must be a nonempty file of at most 50 GiB.');
  const suffix = extname(input.path).toLowerCase();
  const extensions={video:['.mp4'],poster:['.jpg','.jpeg','.png'],captions:['.vtt'],transcript:['.json']};
  if (!extensions[input.kind].includes(suffix)) throw new ShareError('INVALID_TYPE', `Invalid ${input.kind} file extension.`);
  const h=createHash('sha256'); for await (const chunk of createReadStream(input.path)) { if (input.signal?.aborted) throw new ShareError('CANCELLED','Upload cancelled.'); h.update(chunk); }
  const sha256=h.digest('hex'); const ext = input.kind === 'poster' && suffix === '.png' ? 'png' : {video:'mp4',poster:'jpg',captions:'vtt',transcript:'json'}[input.kind];
  return {kind:input.kind,file:`${input.kind}-${sha256.slice(0,8)}.${ext}`,bytes:info.size,sha256,contentType: ext==='png'?'image/png':MIME[input.kind]};
}
export async function readChunk(path: string, offset: number, bytes: number): Promise<Buffer> {
  const f=await open(path,'r'); try { const b=Buffer.alloc(bytes); let read=0; while(read<bytes) { const {bytesRead}=await f.read(b,read,bytes-read,offset+read); if(!bytesRead) throw new ShareError('FILE_CHANGED','Asset changed during upload.'); read+=bytesRead; } return b; } finally {await f.close();}
}
export function xmlEscape(s: string): string { return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!)); }
export function xmlValue(xml: string,tag:string):string|undefined { return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/&(?:amp|lt|gt|quot|apos);/g,c=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[c]!)); }
