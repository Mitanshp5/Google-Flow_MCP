import { describe, it, expect } from 'vitest';
import { normalizeSidebarLabel, extractSidebarCandidates, matchSidebarSection } from '../src/browser/page-adapter.js';

const QA_SIDEBAR_HTML = `
<nav class="sidebar">
  <mat-list-item><span>Characters</span></mat-list-item>
  <mat-list-item><span>Scenes</span></mat-list-item>
  <a href="/project/abc/tools"><span class="icon">apps_spark_2</span><span>Tools</span></a>
  <button>All media</button>
</nav>`;

describe('W02 sidebar adapter (real HTML)', () => {
  it('matches mat-list-item Characters/Scenes, not buttons-only', () => {
    expect(matchSidebarSection(QA_SIDEBAR_HTML, 'Characters')).not.toBe(null);
    expect(matchSidebarSection(QA_SIDEBAR_HTML, 'Scenes')).not.toBe(null);
  });

  it('matches icon-prefixed Tools by stripping known ligatures', () => {
    expect(normalizeSidebarLabel('apps_spark_2 Tools')).toBe('Tools');
    // Glued form from the actual isolated probe (spans collapse, no space).
    expect(normalizeSidebarLabel('apps_spark_2Tools')).toBe('Tools');
    expect(matchSidebarSection(QA_SIDEBAR_HTML, 'Tools')).not.toBe(null);
  });

  it('never strips a legit label that merely starts like a ligature', () => {
    expect(normalizeSidebarLabel('homely')).toBe('homely');
    expect(normalizeSidebarLabel('settings')).toBe('settings');
  });

  it('requires exact dedicated labels; route/tool guesses never valid', () => {
    expect(matchSidebarSection(QA_SIDEBAR_HTML, 'Tool')).toBe(null);
    expect(matchSidebarSection(QA_SIDEBAR_HTML, 'Char')).toBe(null);
    const cands = extractSidebarCandidates(QA_SIDEBAR_HTML);
    expect(cands.length).toBeGreaterThanOrEqual(4);
  });
});
