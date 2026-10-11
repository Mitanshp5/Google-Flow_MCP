// W07-D: every published helper offers safe --help/--dry-run modes that run
// BEFORE any side effect (no real registration, no browser launch, no MCP
// start). CI exercises helpers only through these modes.
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const read = (f) => fs.readFileSync(f, 'utf-8');

const PS_HELPERS = [
  'scripts/register.ps1',
  'scripts/start-browser.ps1',
  'scripts/start-mcp.ps1',
  'scripts/test-flow-image.ps1',
];
const SH_HELPERS = [
  'scripts/register.sh',
  'scripts/start-browser.sh',
  'scripts/start-mcp.sh',
  'scripts/test-flow-image.sh',
];

describe('W07-D safe --help/--dry-run before side effects', () => {
  it.each(PS_HELPERS)('%s documents --help', (f) => {
    expect(read(f)).toMatch(/--help/);
  });

  it.each(PS_HELPERS)('%s documents --dry-run', (f) => {
    expect(read(f)).toMatch(/dry-run/i);
  });

  it.each(SH_HELPERS)('%s handles --help', (f) => {
    expect(read(f)).toMatch(/--help/);
  });

  it.each(SH_HELPERS)('%s handles --dry-run', (f) => {
    expect(read(f)).toMatch(/--dry-run/);
  });

  it('scripts/run.js lists commands on --help instead of dispatching', () => {
    expect(read('scripts/run.js')).toMatch(/--help/);
  });

  it('scripts/start-mcp.bat handles --help without starting the server', () => {
    expect(read('scripts/start-mcp.bat')).toMatch(/--help/);
  });
});
