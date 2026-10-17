import { it, expect } from 'vitest';
import { unpackMedia } from '../src/utils/media-download.js';
import { deflateRawSync } from 'zlib';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function zip(content, method = 0) {
  const name = Buffer.from('../image');
  const packed = method === 8 ? deflateRawSync(content) : content;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}
it('detects extensionless media by bytes', () => {
  expect(unpackMedia(png, 'uuid')[0]).toMatchObject({ kind: 'image', ext: 'png' });
  const mp4 = Buffer.from('0000ftypisom');
  expect(unpackMedia(mp4, 'uuid')[0]).toMatchObject({ kind: 'video', ext: 'mp4' });
});
it('corrects misleading extensions using bytes, including JPEG labelled PNG', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  expect(unpackMedia(jpeg, 'reference.png')[0]).toMatchObject({kind: 'image', ext: 'jpg', mime: 'image/jpeg'});
  expect(unpackMedia(png, 'download.bin')[0]).toMatchObject({kind: 'image', ext: 'png'});
});
it('unpacks stored and deflated ZIP media using central sizes', () => {
  for (const method of [0, 8]) expect(unpackMedia(zip(png, method))[0].bytes).toEqual(png);
});
it('rejects unknown, HTML, empty and truncated ZIP payloads', () => {
  for (const b of [Buffer.alloc(0), Buffer.from('<html>error'), zip(png).subarray(0, 20)]) expect(() => unpackMedia(b)).toThrow();
});
