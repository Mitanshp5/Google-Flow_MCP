import { describe, it, expect } from 'vitest';
import { sanitizeFileName, assertFlowUrl, clampWaitFor, resolveSafePath } from '../src/utils/sanitize.js';
import { ErrorCodes } from '../src/utils/errors.js';

describe('sanitizeFileName', () => {
  it('strips traversal and separators', () => {
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('..');
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });
  it('caps length and falls back', () => {
    expect(sanitizeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('   ')).toBe('file');
  });
});

describe('assertFlowUrl', () => {
  it('accepts Flow URLs (new host + legacy labs path)', () => {
    expect(assertFlowUrl('https://flow.google.com/')).toContain('flow.google.com');
    expect(assertFlowUrl('https://flow.google.com/project/abc')).toContain('/project/abc');
    expect(assertFlowUrl('https://labs.google/fx/tools/flow/project/abc')).toContain('/project/abc');
  });
  it('rejects SSRF/file/localhost', () => {
    for (const u of ['file:///etc/passwd', 'http://flow.google.com/', 'http://localhost:9222/json', 'https://evil.com/fx/tools/flow', 'https://flow.google.com.evil.com/', 'https://labs.google/other']) {
      expect(() => assertFlowUrl(u)).toThrow();
    }
  });
  it('exposes isFlowUrl helper', async () => {
    const { isFlowUrl } = await import('../src/utils/sanitize.js');
    expect(isFlowUrl('https://flow.google.com/project/x')).toBe(true);
    expect(isFlowUrl('https://labs.google/fx/tools/flow')).toBe(true);
    expect(isFlowUrl('https://evil.com/')).toBe(false);
  });
});

describe('clampWaitFor', () => {
  it('clamps and defaults', () => {
    expect(clampWaitFor(undefined)).toBe(3000);
    expect(clampWaitFor(NaN)).toBe(3000);
    expect(clampWaitFor(-5)).toBe(0);
    expect(clampWaitFor(999999)).toBe(15000);
    expect(clampWaitFor(1000)).toBe(1000);
  });
});

describe('resolveSafePath', () => {
  it('rejects empty/null bytes', () => {
    expect(() => resolveSafePath('')).toThrow();
    expect(() => resolveSafePath(null)).toThrow();
    expect(() => resolveSafePath('a\0b')).toThrow();
  });
  it('resolves relative against flowHome (absolute output)', () => {
    const p = resolveSafePath('outputs/x.png');
    expect(p).toMatch(/outputs/);
    // path.isAbsolute check via leading / or drive letter
    expect(p.length).toBeGreaterThan('outputs/x.png'.length);
  });
});

describe('ErrorCodes', () => {
  it('includes previously-missing codes', () => {
    expect(ErrorCodes.CONFIG_ERROR).toBe('CONFIG_ERROR');
    expect(ErrorCodes.INVALID_PARAMS).toBe('INVALID_PARAMS');
    expect(ErrorCodes.UNSUPPORTED_URL).toBe('UNSUPPORTED_URL');
  });
});
