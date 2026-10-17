import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { w00LaunchBrowser } from './helpers/w00-dom.js';
import { withPage } from '../src/browser/session-scope.js';
import { handleFlowStatus } from '../src/tools/flow-status.js';
import { handleDiscoverUi } from '../src/tools/discover-ui.js';
import { handleOpenCharacters } from '../src/tools/open-characters.js';
import { handleImportCharacter } from '../src/tools/import-character.js';
import { handleCreateCharacter } from '../src/tools/create-character.js';
import { handleCreateScene } from '../src/tools/create-scene.js';
import { handleOpenToolsGallery } from '../src/tools/open-tools-gallery.js';
import { handleUseGridArchitect } from '../src/tools/grid-architect.js';
import { handleUseFlowTool } from '../src/tools/use-flow-tool.js';
import { handleGenerateVideo } from '../src/tools/generate-video.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { getFlowHome } from '../src/utils/config.js';
import fs from 'fs';
import path from 'path';

let browser = null;
const PROJECT_URL = 'https://flow.google.com/project/w06-fixture-probe';
const ERROR_404_URL = 'https://flow.google.com/404';

beforeAll(async () => {
  browser = await w00LaunchBrowser();
});

afterAll(async () => {
  jobQueue.reset();
  if (browser) await browser.close();
});

beforeEach(() => {
  jobQueue.reset();
});

const VALID_PROJECT_SHELL = `
  <html>
    <body>
      <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
      <textarea placeholder="Ask Flow to generate a video..."></textarea>
      <button aria-label="Agent mode" aria-pressed="false">Agent</button>
      <button>Video · 720p · 8s ▢ x1</button>
      <button>Nano Banana Pro ▢ x1</button>
    </body>
  </html>
`;

async function makePage(htmlOrRoutes, url = PROJECT_URL) {
  const page = await browser.newPage();
  await page.route('https://flow.google.com/**', (route) => {
    const reqUrl = route.request().url();
    if (typeof htmlOrRoutes === 'object' && htmlOrRoutes !== null) {
      for (const [pattern, body] of Object.entries(htmlOrRoutes)) {
        if (pattern !== 'default' && reqUrl.includes(pattern)) {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
        }
      }
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: htmlOrRoutes.default || '' });
    }
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: htmlOrRoutes });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('W06 Truthful Diagnostics — flow_status', () => {
  it('detects 404 error page and marks flowAccessible: false with appState: error_404', async () => {
    const page = await makePage(`
      <!DOCTYPE html>
      <html>
        <head><title>404 Not Found</title></head>
        <body><h1>Error: 404</h1><p>The requested URL was not found on this server.</p></body>
      </html>
    `, ERROR_404_URL);
    try {
      const res = await withPage(page, async () => handleFlowStatus({ full: false }));
      expect(res.browser).toBe(true);
      expect(res.appState).toBe('error_404');
      expect(res.flowAccessible).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('full: true captures screenshot and returns screenshot path', async () => {
    const page = await makePage('<html><body><h1>Flow Test</h1></body></html>');
    try {
      const res = await withPage(page, async () => handleFlowStatus({ full: true }));
      expect(res.browser).toBe(true);
      expect(typeof res.screenshot).toBe('string');
      expect(res.screenshot.length).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it('positively extracts observed account and verifies against expected account', async () => {
    const page = await makePage(`
      <html>
        <body>
          <button aria-label="Google Account: qa-tester@gmail.com">Avatar</button>
        </body>
      </html>
    `);
    try {
      const res = await withPage(page, async () => handleFlowStatus({ full: false }));
      expect(res.account).toBe('qa-tester@gmail.com');
      expect(res.accountVerified).toBeDefined();
    } finally {
      await page.close();
    }
  });
});

describe('W06 Truthful Diagnostics — flow_discover_ui', () => {
  it('creates FLOW_HOME config directory recursively if missing and avoids ENOENT', async () => {
    const configDir = path.join(getFlowHome(), 'config');
    const page = await makePage('<html><body><button>Test</button></body></html>');
    try {
      const res = await withPage(page, async () => handleDiscoverUi({ page: 'main', url: 'https://flow.google.com/' }));
      expect(res.status).toBe('discovered');
      expect(fs.existsSync(configDir)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('does not parse calendar dates (e.g. "Jun 15, 10:21 PM") as aspect ratios', async () => {
    const page = await makePage(`
      <html>
        <body>
          <div>Jun 15, 10:21 PM</div>
          <div>Oct 10, 3:45 PM</div>
          <button>16:9</button>
          <button>1:1</button>
        </body>
      </html>
    `);
    try {
      const res = await withPage(page, async () => handleDiscoverUi({ page: 'main', url: 'https://flow.google.com/' }));
      expect(res.status).toBe('discovered');
      expect(res.elements.visible_ratios).not.toContain('Jun 15, 10:21 PM');
      expect(res.elements.visible_ratios).not.toContain('Oct 10, 3:45 PM');
      expect(res.elements.visible_ratios.some(r => r.includes('16:9'))).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('W06 Truthful Feature Handlers — Characters and 404 Handling', () => {
  it('flow_open_characters returns blocked on 404 page', async () => {
    const page = await makePage({
      '/character': '<html><head><title>404 Not Found</title></head><body><h1>Error: 404</h1></body></html>',
      default: VALID_PROJECT_SHELL,
    }, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleOpenCharacters({ project_url: PROJECT_URL }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('page_not_found');
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_import_character returns blocked on 404 page', async () => {
    const dummyFile = path.join(getFlowHome(), 'char-test.json');
    fs.mkdirSync(path.dirname(dummyFile), { recursive: true });
    fs.writeFileSync(dummyFile, JSON.stringify({ name: 'Hero', description: 'A test hero' }));

    const page = await makePage({
      '/character': '<html><head><title>404 Not Found</title></head><body><h1>Error: 404</h1></body></html>',
      default: VALID_PROJECT_SHELL,
    }, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleImportCharacter({ file_path: dummyFile, project_url: PROJECT_URL }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('page_not_found');
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_create_character blocks when only ordinary video composer is displayed, refusing to type into composer', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div contenteditable="true" aria-label="Prompt box">Original video prompt</div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleCreateCharacter({
        name: 'Hero',
        description: 'A brave knight with shiny armor',
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('character_form_not_found');

      const composerText = await page.textContent('[contenteditable="true"]');
      expect(composerText).not.toContain('A brave knight');
    } finally {
      await page.close();
    }
  });
});

describe('W06 Truthful Feature Handlers — Scenes and Tools Gallery', () => {
  it('flow_create_scene blocks when scene builder form is absent, never reporting ready from ordinary composer', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div contenteditable="true">Regular composer</div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleCreateScene({
        prompt: 'Dramatic sunset on a cliff',
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('scene_form_not_found');
    } finally {
      await page.close();
    }
  });

  it('flow_open_tools_gallery blocks if sidebar navigation fails or remains in All media', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item aria-current="page">All media</mat-list-item></nav>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleOpenToolsGallery());
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('tools_gallery_not_opened');
    } finally {
      await page.close();
    }
  });
});

describe('W06 Truthful Feature Handlers — Grid Architect and Arbitrary Tools', () => {
  it('flow_use_flow_tool returns blocked on 404 page', async () => {
    const page = await makePage({
      '/tools/grid-architect': '<html><head><title>404 Not Found</title></head><body><h1>Error: 404</h1></body></html>',
      default: VALID_PROJECT_SHELL,
    }, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleUseFlowTool({ tool_name: 'Grid Architect', project_url: PROJECT_URL }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('tool_not_found');
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_use_grid_architect blocks when account requires Upgrade to create/remix entitlement', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><a href="#/tools">Tools</a></nav>
          <a href="#/grid">Grid Architect</a>
          <div class="modal">
            <h2>Upgrade to create or remix</h2>
            <p>This template requires a Pro subscription.</p>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleUseGridArchitect({
        theme_prompt: 'Cyberpunk city at night',
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('entitlement_required');
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_use_grid_architect blocks when tool form is missing, refusing to write theme into video composer', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <textarea placeholder="Ask Flow to generate a video...">Original theme</textarea>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleUseGridArchitect({
        theme_prompt: 'Cyberpunk city at night',
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('blocked');
      expect(res.reason).toBe('grid_architect_form_not_found');

      const composerText = await page.inputValue('textarea');
      expect(composerText).not.toContain('Cyberpunk city');
    } finally {
      await page.close();
    }
  }, 30000);
});

describe('W06 Truthful Generation Handlers — Video and Image', () => {
  it('flow_generate_video marks multi-shot plan as plan-only metadata with explicit notice', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div class="prompt-bar-container">
            <div contenteditable="true" aria-label="Prompt box"></div>
            <button aria-label="Agent mode" aria-pressed="false">Agent</button>
            <button>Video · 720p · 4s · 16:9 · x1</button>
            <button>Generate</button>
          </div>
          <div role="dialog" class="cdk-overlay-pane">
            <button class="mat-mdc-menu-trigger">Veo 3.1 - Fast</button>
            <button>16:9</button>
            <button>x1</button>
            <button>Image</button>
            <button>Video</button>
            <button>4s</button>
            <button>8s</button>
            <button>720p</button>
            <div>Generating will use 1 credit</div>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleGenerateVideo({
        prompt: 'A hero walking in the rain',
        shots: [
          { prompt: 'Close up of boots stepping into puddle', duration: '4s' },
          { prompt: 'Wide shot of hero walking away', duration: '6s' },
        ],
        auto_confirm: false,
        project_url: PROJECT_URL,
      }));
      // Fixture exposes Veo Fast while the default request is Omni; an
      // unverifiable model selection must not become a spend-ready plan.
      expect(res.status).toBe('prepared_unverified');
      expect(res.message).toMatch(/verification is incomplete/i);
      expect(res.shots_plan_only).toBe(true);
      expect(res.shots_notice).toMatch(/plan-only metadata/i);
      expect(res.settings_verification).toBeDefined();
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_generate_image defaults to 1:1 ratio and quantity 1 with settings_verification', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div class="prompt-bar-container">
            <div contenteditable="true" aria-label="Prompt box"></div>
            <button aria-label="Agent mode" aria-pressed="false">Agent</button>
            <button>Nano Banana Pro · 1:1 · x1</button>
            <button>Generate</button>
          </div>
          <div role="dialog" class="cdk-overlay-pane">
            <button class="mat-mdc-menu-trigger">Nano Banana Pro</button>
            <button>1:1</button>
            <button>x1</button>
            <button>Image</button>
            <button>Video</button>
            <div>Generating will use 0 credits</div>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleGenerateImage({
        prompt: 'A majestic mountain peak at sunrise',
        auto_confirm: false,
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('ready_for_confirmation');
      expect(res.ratio).toBe('1:1');
      expect(res.quantity).toBe(1);
      expect(res.settings_verification).toBeDefined();
      expect(res.settings_verification.verified).toBe(true);
      expect(res.settings_verification.actual.model).toBe('Nano Banana Pro');
      expect(res.settings_verification.actual.ratio).toBe('1:1');
      expect(res.settings_verification.actual.quantity).toBe(1);
      expect(res.settings_verification.requested.ratio).toBe('1:1');
      expect(res.settings_verification.requested.quantity).toBe(1);
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_generate_image returns prepared_unverified when observed model does not match requested model', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div class="prompt-bar-container">
            <div contenteditable="true" aria-label="Prompt box"></div>
            <button aria-label="Agent mode" aria-pressed="false">Agent</button>
            <button>Nano Banana 2.1 · 1:1 · x1</button>
            <button>Generate</button>
          </div>
          <div role="dialog" class="cdk-overlay-pane">
            <button class="mat-mdc-menu-trigger">Nano Banana 2.1</button>
            <button>1:1</button>
            <button>x1</button>
            <button>Image</button>
            <div>Generating will use 0 credits</div>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleGenerateImage({
        prompt: 'A majestic mountain peak at sunrise',
        model: 'Imagen 4',
        auto_confirm: false,
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('prepared_unverified');
      expect(res.settings_verification.verified).toBe(false);
      expect(res.settings_verification.requested.model).toBe('Imagen 4');
      expect(res.settings_verification.actual.model).toBe('Nano Banana 2.1');
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_generate_image returns prepared_unverified when observed model is missing', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div class="prompt-bar-container">
            <div contenteditable="true" aria-label="Prompt box"></div>
            <button aria-label="Agent mode" aria-pressed="false">Agent</button>
            <button>1:1 · x1</button>
            <button>Generate</button>
          </div>
          <div role="dialog" class="cdk-overlay-pane">
            <button>1:1</button>
            <button>x1</button>
            <button>Image</button>
            <div>Generating will use 0 credits</div>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleGenerateImage({
        prompt: 'A majestic mountain peak at sunrise',
        auto_confirm: false,
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('prepared_unverified');
      expect(res.settings_verification.verified).toBe(false);
      expect(res.settings_verification.actual.model).not.toBe('Nano Banana Pro');
    } finally {
      await page.close();
    }
  }, 40000);

  it('flow_generate_image returns prepared_unverified when required reference_images fail attachment', async () => {
    const tempRef = path.join(getFlowHome(), 'temp-test-reference.png');
    fs.mkdirSync(path.dirname(tempRef), { recursive: true });
    fs.writeFileSync(tempRef, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div class="prompt-bar-container">
            <div contenteditable="true" aria-label="Prompt box"></div>
            <button aria-label="Agent mode" aria-pressed="false">Agent</button>
            <button>Nano Banana Pro · 1:1 · x1</button>
            <button>Generate</button>
          </div>
          <div role="dialog" class="cdk-overlay-pane">
            <button class="mat-mdc-menu-trigger">Nano Banana Pro</button>
            <button>1:1</button>
            <button>x1</button>
            <button>Image</button>
            <div>Generating will use 0 credits</div>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleGenerateImage({
        prompt: 'A majestic mountain peak at sunrise',
        reference_images: [tempRef],
        auto_confirm: false,
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('prepared_unverified');
      expect(res.settings_verification.verified).toBe(false);
      expect(res.references.verified).toBe(false);
    } finally {
      await page.close();
      try { fs.unlinkSync(tempRef); } catch { /* ignore */ }
    }
  }, 40000);

  it('flow_generate_image returns prepared_unverified when required mention references fail', async () => {
    const page = await makePage(`
      <html>
        <body>
          <nav class="sidebar"><mat-list-item>All media</mat-list-item></nav>
          <div class="prompt-bar-container">
            <div contenteditable="true" aria-label="Prompt box"></div>
            <button aria-label="Agent mode" aria-pressed="false">Agent</button>
            <button>Nano Banana Pro · 1:1 · x1</button>
            <button>Generate</button>
          </div>
          <div role="dialog" class="cdk-overlay-pane">
            <button class="mat-mdc-menu-trigger">Nano Banana Pro</button>
            <button>1:1</button>
            <button>x1</button>
            <button>Image</button>
            <div>Generating will use 0 credits</div>
          </div>
        </body>
      </html>
    `, PROJECT_URL);
    try {
      const res = await withPage(page, async () => handleGenerateImage({
        prompt: 'A majestic mountain peak at sunrise',
        use_character: 'GhostCharacter',
        auto_confirm: false,
        project_url: PROJECT_URL,
      }));
      expect(res.status).toBe('prepared_unverified');
      expect(res.settings_verification.verified).toBe(false);
      expect(res.ingredients_failed).toContain('GhostCharacter');
    } finally {
      await page.close();
    }
  }, 40000);
});
