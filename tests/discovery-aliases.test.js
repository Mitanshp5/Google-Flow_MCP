import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  page: {
    url: () => 'https://flow.google.com/project/ad-test',
    title: async () => 'Flow',
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => [],
  },
  sidebar: vi.fn(async () => true),
}));
vi.mock('../src/browser/connect.js', () => ({ getPage: () => mocks.page }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn() } }));
vi.mock('../src/utils/screenshots.js', () => ({ takeScreenshot: async () => 'shot.png', sanitizeFileName: x => x }));
vi.mock('../src/browser/safe-actions.js', () => ({ detectPageElements: async () => ({ buttons: [], inputs: [], links: [], headings: [] }) }));
vi.mock('../src/navigation/project-navigator.js', () => ({
  ensureProjectLibrary: async () => {},
  ensureProjectInContext: async () => ({ url: mocks.page.url() }),
  navigateToSidebar: mocks.sidebar,
  extractProjectId: () => 'ad-test',
  buildProjectUrl: () => mocks.page.url(),
}));
vi.mock('fs', () => ({ default: {
  readFileSync: () => '{}', existsSync: () => true, writeFileSync: vi.fn(),
} }));

import { handleDiscoverUi } from '../src/tools/discover-ui.js';

describe('discovery uses canonical selector keys for sidebar routing', () => {
  it.each(['all-media', 'allMedia', 'allmedia', 'video-generation', 'videoGeneration'])('%s resolves to All Media', async page => {
    mocks.sidebar.mockClear();
    const result = await handleDiscoverUi({ page });
    expect(result.status).toBe('discovered');
    expect(mocks.sidebar).toHaveBeenCalledWith(mocks.page, 'All Media');
  });

  it.each(['image-generation', 'imageGeneration', 'images'])('%s resolves to Images', async page => {
    mocks.sidebar.mockClear();
    expect((await handleDiscoverUi({ page })).status).toBe('discovered');
    expect(mocks.sidebar).toHaveBeenCalledWith(mocks.page, 'Images');
  });

  it('still blocks unknown pages rather than inventing routes', async () => {
    expect((await handleDiscoverUi({ page: 'not-a-real-page' })).reason).toBe('unknown_discovery_page');
  });
});
