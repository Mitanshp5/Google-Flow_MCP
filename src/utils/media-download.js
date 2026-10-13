import fs from 'fs';
import path from 'path';
import { inflateRawSync } from 'zlib';
import { randomUUID } from 'crypto';
import { detectMediaSignature, verifyDownloadedBytes } from '../assets/catalog.js';

// Read ZIP's central directory, not local sizes (downloads can use descriptors).
// Extract only verified media, with flat filenames and bounded decompression.
export function unpackMedia(bytes, suggested = 'download') {
  const b = Buffer.from(bytes);
  const direct = detectMediaSignature(b);
  if (direct.kind === 'image' || direct.kind === 'video') return [{ bytes: b, name: suggested, ...direct }];
  if (b.length < 4 || b.readUInt32LE(0) !== 0x04034b50) throw new Error('Download is neither media nor a supported ZIP');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('ZIP directory missing');
  const count = b.readUInt16LE(end + 10);
  if (count > 100 || b.readUInt16LE(end + 4) !== 0 || b.readUInt16LE(end + 6) !== 0) throw new Error('Unsupported ZIP layout');
  let offset = b.readUInt32LE(end + 16);
  const files = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > b.length || b.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = b.readUInt16LE(offset + 8);
    const method = b.readUInt16LE(offset + 10);
    const size = b.readUInt32LE(offset + 20);
    const expanded = b.readUInt32LE(offset + 24);
    const nameLen = b.readUInt16LE(offset + 28);
    const extraLen = b.readUInt16LE(offset + 30);
    const commentLen = b.readUInt16LE(offset + 32);
    const local = b.readUInt32LE(offset + 42);
    const name = b.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    total += expanded;
    if (flags & 1 || expanded > 256 * 1024 * 1024 || total > 512 * 1024 * 1024) throw new Error('Encrypted or oversized ZIP');
    if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (start + size > b.length) throw new Error('Truncated ZIP payload');
    const packed = b.subarray(start, start + size);
    const content = method === 0 ? packed : method === 8 ? inflateRawSync(packed, { maxOutputLength: Math.max(1, expanded) }) : null;
    if (!content || content.length !== expanded) throw new Error('Unsupported or incomplete ZIP payload');
    const sig = detectMediaSignature(content);
    if (sig.kind === 'image' || sig.kind === 'video') files.push({ bytes: content, name, ...sig });
  }
  if (!files.length) throw new Error('ZIP contains no recognized images or videos');
  return files;
}

export async function saveMediaDownload(download, outDirFn) {
  const temporary = path.join(outDirFn('other'), `${randomUUID()}.download`);
  await download.saveAs(temporary);
  try {
    const entries = unpackMedia(fs.readFileSync(temporary), download.suggestedFilename());
    const files = entries.map(entry => {
      const name = path.basename(entry.name.replaceAll('\\', '/')).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 90) || 'media';
      const savePath = path.join(outDirFn(entry.kind), `${Date.now()}_${randomUUID().slice(0, 8)}_${name}.${entry.ext}`);
      fs.writeFileSync(savePath, entry.bytes, { flag: 'wx' });
      const check = verifyDownloadedBytes({ bytes: fs.readFileSync(savePath), expectedKind: entry.kind });
      if (!check.ok) throw new Error(`Saved media failed verification: ${check.reason}`);
      return { path: savePath, kind: entry.kind, detectedFrom: 'bytes', verification: { verified: true, ...check, path: savePath } };
    });
    return { ...files[0], files };
  } finally {
    // Only remove our own temporary transport container, never user files.
    fs.unlinkSync(temporary);
  }
}
