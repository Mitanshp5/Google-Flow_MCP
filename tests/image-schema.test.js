import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { schemas, parseOrThrow } from '../src/utils/validate.js';

// P0-5: flow_generate_image's 'brand' field advertised a model-selection
// capability the handler never implemented, so it was removed from both
// the MCP inputSchema and the zod schema. 'reference_images' stays: it is
// likewise unwired today, but P0-1 (later in execution order) implements
// it rather than removing it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf-8');

describe('P0-5 dead brand field removed', () => {
  it('zod image schema has no brand key', () => {
    expect('brand' in schemas.flow_generate_image.shape).toBe(false);
  });

  it('MCP surface no longer advertises brand model selection', () => {
    expect(indexSrc).not.toMatch(/Brand context for automatic model selection/);
  });

  it('reference_images is still advertised (owned by P0-1)', () => {
    expect('reference_images' in schemas.flow_generate_image.shape).toBe(true);
    expect(indexSrc).toMatch(/reference_images/);
  });

  it('full image args still validate (prompt required)', () => {
    const v = parseOrThrow(
      schemas.flow_generate_image,
      { prompt: 'x', model: 'auto' },
      'flow_generate_image'
    );
    expect(v.prompt).toBe('x');
    expect(() =>
      parseOrThrow(schemas.flow_generate_image, {}, 'flow_generate_image')
    ).toThrow();
  });
});
