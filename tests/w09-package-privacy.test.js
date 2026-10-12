import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// Actual package privacy boundary: FLOW_HOME may be configured under a
// shipped directory. The package must still contain only build artifacts,
// not candidate/reference/media/runtime records. All sentinels are owned,
// unique local fixtures and are removed without touching existing files.
describe('W09 runtime-data package exclusion', () => {
  it('does not pack candidate runtime files placed beneath dist or scripts', () => {
    const name = `w09-private-${crypto.randomUUID()}`;
    const fixtureDirs = [path.join('dist', name), path.join('scripts', name)];
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/allow_?scripts/i.test(key)) delete env[key];
    }
    try {
      for (const dir of fixtureDirs) {
        fs.mkdirSync(path.join(dir, 'scripts', 'fixture', 'assets', 'originals'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'scripts', 'fixture', 'manifest.json'), JSON.stringify({ fixture: 'private-local-candidate-runtime' }), { flag: 'wx' });
        fs.writeFileSync(path.join(dir, 'scripts', 'fixture', 'assets', 'originals', 'fixture.png'), 'PRIVATE_LOCAL_FIXTURE_NOT_MEDIA', { flag: 'wx' });
      }
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = JSON.parse(execSync(`${npm} pack --dry-run --json`, {
        cwd: process.cwd(), env, encoding: 'utf8', timeout: 60000,
      }));
      expect(result).toHaveLength(1);
      const names = result[0].files.map(f => f.path.replaceAll('\\', '/'));
      expect(names.filter(n => n.includes('w09-private-'))).toEqual([]);
      expect(names.filter(n => n.startsWith('dist/')).sort()).toEqual(['dist/index.js', 'dist/index.js.map']);
      expect(names.some(n => /(?:^|\/)(?:qa-output|candidates|reviews|assets|stories|operations|consumed-children)(?:\/|$)/.test(n))).toBe(false);
    } finally {
      for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
