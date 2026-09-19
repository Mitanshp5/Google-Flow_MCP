import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { schemas } from '../src/utils/validate.js';

// P0-7: flow_open's handler + schema existed but were unreachable (no
// TOOL_DEFINITIONS entry, no switch case). index.js starts a live MCP
// server on import, so assert wiring via source text instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf-8');

describe('P0-7 flow_open is registered (not orphaned)', () => {
  it('has a TOOL_DEFINITIONS entry', () => {
    expect(indexSrc).toMatch(/name: 'flow_open'/);
  });

  it('has a handleToolCall case', () => {
    expect(indexSrc).toMatch(/case 'flow_open':/);
  });

  it('has a zod schema accepting empty/partial args', () => {
    expect(schemas.flow_open).toBeDefined();
    expect(schemas.flow_open.safeParse({}).success).toBe(true);
    expect(schemas.flow_open.safeParse({ url: 'https://flow.google.com/' }).success).toBe(true);
  });
});
