import { describe, it, expect } from 'vitest';
import { classifyRenameResult, RENAME_BUDGET_MS } from '../src/navigation/project-navigator.js';

describe('W02 bounded verified rename', () => {
  it('has a bounded budget well under the old 30s stall', () => {
    expect(RENAME_BUDGET_MS).toBeLessThanOrEqual(15000);
  });

  it('classifies verified rename as renamed with ID preserved', () => {
    const r = classifyRenameResult({ attempted: true, verified: true, projectId: 'abc', name: 'MCP QA', elapsedMs: 2000 });
    expect(r.state).toBe('renamed');
    expect(r.projectId).toBe('abc');
  });

  it('classifies unverified rename as pending/failed, never a duplicate project', () => {
    const r = classifyRenameResult({ attempted: true, verified: false, projectId: 'abc', name: 'MCP QA', elapsedMs: 3000 });
    expect(['pending', 'failed']).toContain(r.state);
    expect(r.projectId).toBe('abc');
    expect(r.duplicateCreated).toBe(false);
  });

  it('empty name never attempts rename', () => {
    const r = classifyRenameResult({ attempted: false, verified: false, projectId: 'abc', name: '', elapsedMs: 0 });
    expect(r.state).toBe('failed');
  });
});
