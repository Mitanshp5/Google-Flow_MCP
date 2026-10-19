import fs from 'fs';
import path from 'path';
import { inflateRawSync } from 'zlib';
import { randomUUID } from 'crypto';
import { detectMediaSignature, verifyDownloadedBytes } from '../assets/catalog.js';

// CDP clients can overwrite Chrome's process-wide download directory. Own
// one bounded transfer directory and bind its bytes to Chrome's exact GUID
// and download URL, rather than guessing a file in the user's Downloads.
export async function captureMediaDownload(page, outDirFn) {
  if (typeof page.context !== 'function' || typeof page.context().newCDPSession !== 'function') return null;
  const dir = path.join(outDirFn('other'), `transfer-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  let started;
  let resolveDone;
  let timer;
  const done = new Promise(resolve => { resolveDone = resolve; });
  cdp.on('Browser.downloadWillBegin', event => { started = event; });
  cdp.on('Browser.downloadProgress', event => {
    if (event.guid === started?.guid && event.receivedBytes > 256 * 1024 * 1024) {
      void cdp.send('Browser.cancelDownload', { guid: event.guid,
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}) }).catch(() => {});
      resolveDone('oversized');
    }
    if (event.guid === started?.guid && ['completed', 'canceled'].includes(event.state)) resolveDone(event.state);
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true,
    ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}) });
  return {
    wrap(download) {
      return {
        url: () => download.url(),
        suggestedFilename: () => download.suggestedFilename(),
        async saveAs(target) {
          timer = setTimeout(() => resolveDone('timeout'), 30000);
          const state = await done;
          clearTimeout(timer);
          if (state !== 'completed' || !started || started.url !== download.url()
            || !/^[a-f0-9-]{36}$/i.test(started.guid)) throw new Error('Download transfer was not verified');
          fs.copyFileSync(path.join(dir, started.guid), target, fs.constants.COPYFILE_EXCL);
        },
      };
    },
    async close() {
      clearTimeout(timer);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default',
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}) }).catch(() => {});
      await cdp.detach().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

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

// Another CDP client can redirect Chrome's downloads to its own temporary
// directory. The original client's saveAs then sees ENOENT after a reconnect.
// Recover only the URL from this exact download event, never a guessed asset.
export async function recoverDownloadBytes(page, download) {
  const source = new URL(download.url());
  const pageUrl = new URL(page.url());
  const allowedHosts = new Set(['flow.google.com', 'flow-content.google']);
  const blob = source.protocol === 'blob:' && source.origin === pageUrl.origin;
  const https = source.protocol === 'https:' && allowedHosts.has(source.hostname) && !source.username && !source.password && (!source.port || source.port === '443');
  if (pageUrl.origin !== 'https://flow.google.com' || (!blob && !https)) {
    throw new Error('Download recovery refused: untrusted download origin');
  }
  const encoded = await page.evaluate(async ({ url, maxBytes }) => {
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error(`Download recovery HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Download recovery exceeds size limit');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error('Download recovery exceeds size limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return await new Promise((resolve, reject) => {
      const fileReader = new FileReader();
      fileReader.onload = () => resolve(fileReader.result.split(',')[1]);
      fileReader.onerror = () => reject(new Error('Could not read recovered download'));
      fileReader.readAsDataURL(new Blob(chunks));
    });
  }, { url: source.href, maxBytes: 256 * 1024 * 1024 });
  return Buffer.from(encoded, 'base64');
}

export async function saveMediaDownload(download, outDirFn, { page } = {}) {
  const temporary = path.join(outDirFn('other'), `${randomUUID()}.download`);
  fs.mkdirSync(path.dirname(temporary), { recursive: true });
  try {
    let bytes;
    let transport = 'playwright-download';
    try {
      await download.saveAs(temporary);
      bytes = fs.readFileSync(temporary);
    } catch (error) {
      if (!page || (error.code !== 'ENOENT' && !/\bENOENT\b/.test(error.message))) throw error;
      bytes = await recoverDownloadBytes(page, download);
      transport = 'browser-fetch-recovery';
    }
    const entries = unpackMedia(bytes, download.suggestedFilename());
    const files = entries.map(entry => {
      const name = path.basename(entry.name.replaceAll('\\', '/')).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 90) || 'media';
      const savePath = path.join(outDirFn(entry.kind), `${Date.now()}_${randomUUID().slice(0, 8)}_${name}.${entry.ext}`);
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, entry.bytes, { flag: 'wx' });
      const check = verifyDownloadedBytes({ bytes: fs.readFileSync(savePath), expectedKind: entry.kind });
      if (!check.ok) throw new Error(`Saved media failed verification: ${check.reason}`);
      return { path: savePath, kind: entry.kind, detectedFrom: 'bytes', verification: { verified: true, ...check, path: savePath } };
    });
    return { ...files[0], files, transport };
  } finally {
    // Only remove our own temporary transport container, never user files.
    fs.rmSync(temporary, { force: true });
  }
}
