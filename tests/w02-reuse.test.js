import { describe, it, expect } from 'vitest';
import { isSameProjectTarget, shouldReloadProject } from '../src/navigation/project-navigator.js';
import { withUiTransaction, getUiLease } from '../src/browser/ui-transaction.js';

describe('W02 in-place reuse + serialization', () => {
  it('detects same project target without reload', () => {
    expect(isSameProjectTarget(
      'https://flow.google.com/project/abc123',
      'https://flow.google.com/project/abc123'
    )).toBe(true);
    expect(isSameProjectTarget(
      'https://flow.google.com/project/abc123',
      'abc123'
    )).toBe(true);
    expect(isSameProjectTarget(
      'https://flow.google.com/project/abc123',
      'https://flow.google.com/project/other'
    )).toBe(false);
  });

  it('skips reload when listing on the already-targeted project', () => {
    expect(shouldReloadProject('https://flow.google.com/project/abc123', { project_url: 'https://flow.google.com/project/abc123' })).toBe(false);
    expect(shouldReloadProject('https://flow.google.com/project/abc123', { project_url: 'https://flow.google.com/project/other' })).toBe(true);
  });

  it('serializes UI transactions in order', async () => {
    const order = [];
    await Promise.all([
      withUiTransaction(async () => { order.push('a'); }),
      withUiTransaction(async () => { order.push('b'); }),
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(typeof getUiLease().getEpoch()).toBe('number');
  });
});
