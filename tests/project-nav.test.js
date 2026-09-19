import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadProjects,
  saveProjects,
  registerTaskInProject,
  getActiveSidebarSection,
  getProjectContextInfo,
} from '../src/navigation/project-navigator.js';
import { mockPageRoutes } from './helpers/mock-page.js';

// P2-1 (full): registry I/O runs against a FLOW_HOME temp dir (never the
// real repo config); context readers run against the routes mock. Deep
// flows (rename/create/ensure/sidebar-navigate/switch-mode) stay live-only.
const OLD_FLOW_HOME = process.env.FLOW_HOME;
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-nav-test-'));
  process.env.FLOW_HOME = tmp;
});

afterEach(() => {
  if (OLD_FLOW_HOME === undefined) delete process.env.FLOW_HOME;
  else process.env.FLOW_HOME = OLD_FLOW_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('project registry persistence', () => {
  it('round-trips through an atomic write (no tmp leftovers)', () => {
    const data = { projects: [{ id: 'p1', name: 'N', tasks: [] }] };
    saveProjects(data);
    const dir = path.join(tmp, 'config');
    expect(fs.existsSync(path.join(dir, 'flow.projects.json'))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(loadProjects()).toEqual(data);
  });

  it('unreadable registry falls back to empty', () => {
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'flow.projects.json'), '{broken');
    expect(loadProjects()).toEqual({ projects: [] });
  });
});

describe('registerTaskInProject', () => {
  function seed() {
    saveProjects({
      projects: [{
        id: 'reg1',
        url: 'https://flow.google.com/project/url-9',
        urlProjectId: 'url-9',
        name: 'N',
        tasks: [],
      }],
    });
  }

  it('matches by URL-extracted project id', () => {
    seed();
    registerTaskInProject('url-9', { kind: 'gen' });
    const tasks = loadProjects().projects[0].tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe('gen');
    expect(typeof tasks[0].timestamp).toBe('string');
  });

  it('matches by registry id', () => {
    seed();
    registerTaskInProject('reg1', { kind: 'gen' });
    expect(loadProjects().projects[0].tasks).toHaveLength(1);
  });

  it('unknown project is a safe no-op', () => {
    seed();
    expect(() => registerTaskInProject('nope', { kind: 'gen' })).not.toThrow();
    expect(() => registerTaskInProject(null, { kind: 'gen' })).not.toThrow();
    expect(loadProjects().projects[0].tasks).toHaveLength(0);
  });
});

describe('getActiveSidebarSection', () => {
  it('returns the evaluated section', async () => {
    const page = mockPageRoutes([], { evaluateResult: 'All media' });
    // evaluateResult path (no impl): factory returns the scripted value.
    await expect(getActiveSidebarSection(page)).resolves.toBe('All media');
  });

  it('returns null when the page is unreadable', async () => {
    const page = mockPageRoutes([], {
      evaluateImpl: () => { throw new Error('detached'); },
    });
    await expect(getActiveSidebarSection(page)).resolves.toBe(null);
  });
});

describe('getProjectContextInfo', () => {
  it('reports project id and section inside a project', async () => {
    const page = mockPageRoutes([], {
      url: 'https://flow.google.com/project/abc/def',
      title: 'P',
      evaluateResult: 'Scenes',
    });
    const info = await getProjectContextInfo(page);
    expect(info).toMatchObject({ inProject: true, projectId: 'abc', activeSection: 'Scenes' });
  });

  it('reports non-project pages without evaluating', async () => {
    let evaluated = false;
    const page = mockPageRoutes([], {
      url: 'https://flow.google.com/',
      evaluateImpl: () => { evaluated = true; return null; },
    });
    const info = await getProjectContextInfo(page);
    expect(info).toMatchObject({ inProject: false, activeSection: null, projectId: null });
    expect(evaluated).toBe(false);
  });
});
