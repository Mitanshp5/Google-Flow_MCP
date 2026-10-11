// W07-B: platform smoke wrappers delegate to the initialized portable
// client against the shipped entry (F12). No unconditional success text,
// no uninitialized raw-stdio path, no src-only target.
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const ps1 = () => fs.readFileSync('scripts/test-flow-image.ps1', 'utf-8');
const sh = () => fs.readFileSync('scripts/test-flow-image.sh', 'utf-8');

describe('W07-B smoke wrappers delegate to smoke-client on dist (F12)', () => {
  it('ps1 delegates to scripts/smoke-client.mjs', () => {
    expect(ps1()).toMatch(/smoke-client\.mjs/);
  });

  it('sh delegates to scripts/smoke-client.mjs', () => {
    expect(sh()).toMatch(/smoke-client\.mjs/);
  });

  it('ps1 targets the shipped dist entry, not src only', () => {
    expect(ps1()).toMatch(/dist\/index\.js|dist\\index\.js/);
  });

  it('sh targets the shipped dist entry, not src only', () => {
    expect(sh()).toMatch(/dist\/index\.js/);
  });

  it('ps1 has no unconditional success message', () => {
    // A bare "All tests passed" with no verdict gate is the F12 lie.
    expect(ps1()).not.toMatch(/Write-Log 'All tests passed\.'/);
  });

  it('sh has no unconditional success message', () => {
    expect(sh()).not.toMatch(/All tests passed\./);
  });

  it('ps1 fails closed on client failure (non-zero exit)', () => {
    expect(ps1()).toMatch(/exit 1|throw|\$LASTEXITCODE/);
  });

  it('sh fails closed on client failure (non-zero exit)', () => {
    expect(sh()).toMatch(/exit 1|exit \$|set -e/);
  });
});
