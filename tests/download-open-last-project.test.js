import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadProjects } from '../src/navigation/project-navigator.js';
import { handleDownloadWithPage, selectDownloadCandidate } from '../src/tools/download-latest.js';

vi.mock('../src/navigation/project-navigator.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadProjects: vi.fn() };
});

/** Minimal page stub: records navigations, reports a configurable URL. */
function makePage(initialUrl = 'https://flow.google.com/') {
  const state = { url: initialUrl, visits: [] };
  const page = {
    url: () => state.url,
    goto: async (url) => {
      state.visits.push(url);
      state.url = url;
    },
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
        click: async () => {},
      }),
    }),
    waitForTimeout: async () => {},
    waitForEvent: async () => null,
    evaluate: async () => [],
  };
  return { page, state };
}

const HOME = 'https://flow.google.com/';
const PROJ_A = 'https://flow.google.com/project/aaaaaaaa-1111-2222-3333-444444444444';
const PROJ_B = 'https://flow.google.com/project/bbbbbbbb-1111-2222-3333-444444444444';

describe('flow_download_latest — open_last_project (opt-in)', () => {
  beforeEach(() => {
    loadProjects.mockReset();
    loadProjects.mockReturnValue({ projects: [] });
  });

  it('does not navigate when the flag is omitted and the tab is on home', async () => {
    const { page, state } = makePage(HOME);
    await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits).toEqual([]);
  });

  it('does not navigate when the flag is false', async () => {
    const { page, state } = makePage(HOME);
    await handleDownloadWithPage(page, { open_last_project: false }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits).toEqual([]);
  });

  it('opens the most recently used project when the flag is true on home', async () => {
    loadProjects.mockReturnValue({ projects: [
      { name: 'old', url: PROJ_A, last_used: '2026-11-01T10:00:00Z' },
      { name: 'new', url: PROJ_B, last_used: '2026-11-23T10:00:00Z' },
    ] });
    const { page, state } = makePage(HOME);
    await handleDownloadWithPage(page, { open_last_project: true }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits[0]).toBe(PROJ_B);
  });

  it('ignores unusable/unsafe registry entries and never creates a project', async () => {
    loadProjects.mockReturnValue({ projects: [
      { name: 'traversal', url: 'https://flow.google.com/project/abc/../../about' },
      { name: 'query', url: 'https://flow.google.com/project/abc?x=1' },
      { name: 'other-host', url: 'https://evil.example/project/abc' },
    ] });
    const { page, state } = makePage(HOME);
    await handleDownloadWithPage(page, { open_last_project: true }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits).toEqual([]);
  });

  it('does not navigate when already inside a project', async () => {
    loadProjects.mockReturnValue({ projects: [{ name: 'a', url: PROJ_A, last_used: '2026-11-23T10:00:00Z' }] });
    const { page, state } = makePage(PROJ_B);
    await handleDownloadWithPage(page, { open_last_project: true }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits).toEqual([]);
  });

  it('explicit project_url wins over the registry and is still validated', async () => {
    loadProjects.mockReturnValue({ projects: [{ name: 'b', url: PROJ_B, last_used: '2026-11-23T10:00:00Z' }] });
    const { page, state } = makePage(HOME);
    await handleDownloadWithPage(page, { open_last_project: true, project_url: PROJ_A }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits[0]).toBe(PROJ_A);
  });

  it('rejects a malformed project_url with INVALID_PARAMS', async () => {
    const { page } = makePage(HOME);
    await expect(handleDownloadWithPage(page, { project_url: 'https://flow.google.com/project/abc/../about' }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('blocks before downloading when navigation lands on a different project', async () => {
    loadProjects.mockReturnValue({ projects: [{ name: 'b', url: PROJ_B, last_used: '2026-11-23T10:00:00Z' }] });
    const { page, state } = makePage(HOME);
    // Simulate a redirect to another project.
    page.goto = async (url) => { state.visits.push(url); state.url = PROJ_A; };
    const res = await handleDownloadWithPage(page, { open_last_project: true }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(res.reason).toBe('project_unavailable');
    expect(res.status).toBe('not_found');
  });

  it('returns suggested_project_url on home when the flag is off', async () => {
    loadProjects.mockReturnValue({ projects: [{ name: 'b', url: PROJ_B, last_used: '2026-11-23T10:00:00Z' }] });
    const { page } = makePage(HOME);
    const res = await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(res.reason).toBe('project_required');
    expect(res.suggested_project_url).toBe(PROJ_B);
  });

  it('protects an implicit open project: switching project mid-flight aborts', async () => {
    const { page, state } = makePage(PROJ_A);
    let calls = 0;
    page.evaluate = async () => {
      calls += 1;
      if (calls === 2) state.url = PROJ_B; // another project takes over the tab
      return [];
    };
    const res = await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(res.reason).toBe('project_unavailable');
    expect(state.visits).toEqual([]);
  });

  it('does not treat non-canonical project routes as an open project', async () => {
    loadProjects.mockReturnValue({ projects: [{ name: 'b', url: PROJ_B, last_used: '2026-11-23T10:00:00Z' }] });
    const { page, state } = makePage(`${PROJ_A}/extra`);
    await handleDownloadWithPage(page, { open_last_project: true }, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(state.visits[0]).toBe(PROJ_B);
  });

  it('refuses non-canonical start with no resolvable project, even if the tab later looks like one', async () => {
    const { page, state } = makePage(`${PROJ_A}/extra`);
    let calls = 0;
    page.evaluate = async () => { calls += 1; if (calls === 1) state.url = PROJ_B; return []; };
    const clickSpy = vi.spyOn(page, 'locator');
    const res = await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(res.reason).toBe('project_required');
    expect(state.visits).toEqual([]);
    expect(calls).toBe(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('exclude_titles keeps a reference image from being returned as the result', () => {
    const tiles = [
      { assetId: 'ref-1', title: 'reference-photo.jpg', kind: 'image' },
      { assetId: 'out-1', title: 'Male fashion model wearing shirt', kind: 'image' },
    ];
    const d = selectDownloadCandidate(tiles, { excludeTitles: ['reference-photo.jpg'], pick: 'first-tile' });
    expect(d.status).toBe('selected');
    expect(d.asset.assetId).toBe('out-1');
    // After excluding the reference only one eligible asset remains, so the
    // strict path selects it by elimination — no feed-order guess needed.
    expect(d.explicitPick).toBe(false);
  });

  it('never returns an excluded reference even when it is the only tile', () => {
    const tiles = [{ assetId: 'ref-1', title: 'reference-photo.jpg', kind: 'image' }];
    const d = selectDownloadCandidate(tiles, { excludeTitles: ['reference-photo.jpg'], pick: 'first-tile' });
    expect(d.status).toBe('not_found');
    expect(d.asset).toBeUndefined();
  });

  it('recognises an open project even with UI query parameters (?hl=en)', async () => {
    const { page, state } = makePage(`${PROJ_A}?hl=en`);
    const res = await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    // The project is recognised: the failure is "no assets", not "no project".
    expect(res.reason).not.toBe('project_required');
    expect(state.visits).toEqual([]);
  });

  it('refuses the blind visible-Download path when exclusions were requested', async () => {
    const { page, state } = makePage(PROJ_A);
    page.locator = () => ({ first: () => ({ isVisible: async () => true, click: async () => { state.clicks = (state.clicks || 0) + 1; } }) });
    page.evaluate = async () => [];
    const res = await handleDownloadWithPage(page, { exclude_titles: ['reference-photo.jpg'] },
      { takeScreenshotFn: async () => null, getOutputDirFn: () => '/tmp' });
    expect(res.reason).toBe('exclusions_require_enumerable_assets');
    expect(state.clicks || 0).toBe(0);
  });
});
