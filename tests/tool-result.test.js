import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeToolResult } from '../src/utils/tool-result.js';
import { resolveSafePath } from '../src/utils/sanitize.js';
import { handleToolCall } from '../src/index.js';

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const readResult = result => JSON.parse(result.content[0].text);

describe('copy-safe tool paths', () => {
  it('normalizes nested paths, screenshot paths, and path arrays, not prose or URLs', () => {
    const value = {
      path: String.raw`C:\Code\outputs\1792237728128.jpg`,
      files: [{ verification: { path: String.raw`C:\Code\outputs\1792237728128.jpg` } }],
      screenshot: String.raw`D:\shots\test.png`,
      requested: [String.raw`\\server\share\ref.png`],
      message: String.raw`Use C:\Code\outputs for files`,
      url: 'https://flow.google.com/project/abc',
      digest: 'unchanged',
    };
    const original = textResult(value);
    const actual = readResult(normalizeToolResult(original));
    expect(actual.path).toBe('C:/Code/outputs/1792237728128.jpg');
    expect(actual.files[0].verification.path).toBe(actual.path);
    expect(actual.screenshot).toBe('D:/shots/test.png');
    expect(actual.requested).toEqual(['//server/share/ref.png']);
    expect(actual.message).toBe(value.message);
    expect(actual.url).toBe(value.url);
    expect(actual.digest).toBe(value.digest);
    expect(readResult(original)).toEqual(value);
  });

  it('preserves errors and non-JSON or non-text content', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'plain text' }, { type: 'image', data: 'abc', mimeType: 'image/png' }] };
    expect(normalizeToolResult(result)).toEqual(result);
    expect(normalizeToolResult(null)).toBe(null);
  });

  it('round-trips an actual downloaded-style filename to an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-path-'));
    const file = path.join(dir, '1792237728128_607cae7a_ref.jpg');
    try {
      fs.writeFileSync(file, 'reference');
      const returned = readResult(normalizeToolResult(textResult({ path: file }))).path;
      // Simulate copying the returned path into a JS string for the next call.
      const reused = Function(`"use strict"; return "${returned}";`)();
      expect(fs.readFileSync(resolveSafePath(reused), 'utf8')).toBe('reference');
    } finally {
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
    }
  });

  it('applies normalization at the shared dispatcher boundary', async () => {
    const result = await handleToolCall('flow_queue_status', {});
    expect(result).toEqual(normalizeToolResult(result));
    expect(readResult(result)).toHaveProperty('hasActiveJob');
  });

  it.each(['\f', '\t', '\n', '\r', '\b', '\x7f'])('rejects corrupted paths (%j) before file lookup', control => {
    expect(() => resolveSafePath(`C:Codeoutputs${control}1792237728128.jpg`)).toThrow(/control characters.*forward-slash/);
  });
});
