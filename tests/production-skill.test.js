import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/index.js';
import { schemas } from '../src/utils/validate.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillRoot = path.join(root, 'skills', 'google-flow-production');
const read = relative => fs.readFileSync(path.join(skillRoot, relative), 'utf8').replace(/\r\n/g, '\n');
const styles = [
  '01-cinematic', '02-3d-cgi', '03-cartoon', '04-comic-to-video',
  '05-fight-scenes', '06-motion-design-ad', '07-ecommerce-ad',
  '08-anime-action', '09-product-360', '10-music-video',
  '11-social-hook', '12-brand-story', '13-fashion-lookbook',
  '14-food-beverage', '15-real-estate',
];

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(target) : target.endsWith('.md') ? [target] : [];
  });
}

describe('Google Flow production documentation contract (static, no live generation)', () => {
  it('provides a discoverable entry point with required sections and short frontmatter', () => {
    const text = read('SKILL.md');
    expect(text.startsWith('---\n')).toBe(true);
    const frontmatter = text.split('\n---\n')[0];
    expect(frontmatter).toContain('name: google-flow-production');
    const description = frontmatter.match(/^description: "([^"]+)"$/m)?.[1];
    expect(description).toBeDefined();
    expect(description.length).toBeLessThanOrEqual(60);
    expect(description.endsWith('.')).toBe(true);
    for (const section of ['When to Use', 'Prerequisites', 'Procedure', 'Pitfalls', 'Verification']) {
      expect(text).toContain(`## ${section}`);
    }
  });

  it('resolves every local markdown link without escaping the skill directory', () => {
    const files = markdownFiles(skillRoot);
    let checked = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const href = match[1];
        if (/^https?:\/\//.test(href) || href.startsWith('#')) continue;
        const target = path.resolve(path.dirname(file), href.split('#')[0]);
        expect(path.relative(skillRoot, target).startsWith('..'), href).toBe(false);
        expect(fs.statSync(target).isFile(), `${file}: ${href}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(styles.length);
  });

  it('ships all fifteen bounded, provider-neutral creative style cards', () => {
    expect(fs.readdirSync(path.join(skillRoot, 'references', 'styles')).sort()).toEqual(styles.map(name => `${name}.md`).sort());
    for (const style of styles) {
      const text = read(`references/styles/${style}.md`);
      expect(text.length).toBeGreaterThan(350);
      expect(text.length).toBeLessThan(5000);
      for (const section of ['Hook', 'Camera', 'Lighting', 'Beat', 'Avoid']) expect(text).toContain(`## ${section}`);
      expect(text).not.toMatch(/mcp__higgsfield__|<<<|seedance_2_0/);
    }
  });

  it('uses real advertised tool fields and valid prepare-only parameters in every example', () => {
    const examples = JSON.parse(read('templates/tool-calls.json'));
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) {
      const definition = TOOL_DEFINITIONS.find(tool => tool.name === example.tool);
      expect(definition, example.tool).toBeDefined();
      for (const required of definition.inputSchema.required || []) {
        expect(example.arguments, `${example.tool}.${required}`).toHaveProperty(required);
      }
      for (const field of Object.keys(example.arguments)) {
        expect(Object.keys(definition.inputSchema.properties), `${example.tool}.${field}`).toContain(field);
        const spec = definition.inputSchema.properties[field];
        const value = example.arguments[field];
        expect(Array.isArray(value) ? 'array' : typeof value, `${example.tool}.${field}`).toBe(spec.type);
        if (spec.enum) expect(spec.enum, `${example.tool}.${field}`).toContain(value);
      }
      // flow_list_models validates booleans directly in dispatch, not via Zod.
      if (schemas[example.tool]) {
        const parsed = schemas[example.tool].safeParse(example.arguments);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      } else {
        expect(example.tool).toBe('flow_list_models');
        expect(example.arguments.refresh).toBe(true);
      }
      if (example.tool === 'flow_generate_image' || example.tool === 'flow_create_character') {
        expect(example.arguments.auto_confirm).toBe(false);
      }
      if (example.tool === 'flow_generate_video') {
        expect(example.arguments.auto_confirm).toBe(false);
        expect(example.arguments.confirm_generate).toBe(false);
        const args = example.arguments;
        expect(Boolean(args.start_frame || args.end_frame) && Boolean(args.ingredients || args.reference_images)).toBe(false);
      }
      expect(example.tool).not.toBe('flow_generate_confirm');
    }
  });

  it('retains required attribution separately from the workflow instructions', () => {
    const notice = read('THIRD_PARTY_NOTICES.txt');
    expect(notice).toContain('Copyright (c) 2026 Charles J Dove');
    expect(notice).toContain('Permission is hereby granted, free of charge');
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(notice).toContain('ee59beb975d5488d4d73f0c9bae8a91785dc4cb9');
    expect(notice).toContain('https://github.com/charlesdove977/UGC-Factory');
    for (const file of markdownFiles(skillRoot)) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/UGC.Factory|ugc-factory|mcp__higgsfield__/);
    }
  });

  it('includes the skill in npm distribution and links it from the README', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('skills/');
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('skills/google-flow-production/SKILL.md');
  });
});
