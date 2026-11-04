import { describe, it, expect } from 'vitest';
import { schemas, parseOrThrow } from '../src/utils/validate.js';

describe('tool schemas', () => {
  it('accepts empty or explicitly targeted flow_open params', () => {
    expect(schemas.flow_open.safeParse({}).success).toBe(true);
    expect(schemas.flow_open.safeParse({ url: 'https://flow.google.com/' }).success).toBe(true);
  });
  it('rejects empty prompt for image', () => {
    expect(() => parseOrThrow(schemas.flow_generate_image, {}, 'flow_generate_image')).toThrow(/prompt/);
    expect(() => parseOrThrow(schemas.flow_generate_image, { prompt: '  ' }, 'flow_generate_image')).toThrow();
  });
  it('accepts valid image params with safe defaults', () => {
    const v = parseOrThrow(schemas.flow_generate_image, { prompt: 'a cat' }, 'flow_generate_image');
    expect(v.prompt).toBe('a cat');
    expect(v.auto_confirm).toBe(false);
  });
  it('accepts numeric or string duration for video', () => {
    expect(parseOrThrow(schemas.flow_generate_video, { prompt: 'x', duration: '6s' }, 't').duration).toBe('6s');
    expect(parseOrThrow(schemas.flow_generate_video, { prompt: 'x', duration: 6 }, 't').duration).toBe(6);
  });
  it('create_character defaults to safe auto_confirm=false', () => {
    const v = parseOrThrow(schemas.flow_create_character, { name: 'Bob', description: 'd' }, 't');
    expect(v.auto_confirm).toBe(false);
  });
  it('use_tool requires tool_name', () => {
    expect(() => parseOrThrow(schemas.flow_use_tool, {}, 't')).toThrow(/tool_name/);
    expect(parseOrThrow(schemas.flow_use_tool, { tool_name: 'Grid Architect' }, 't').tool_name).toBe('Grid Architect');
  });
  it('queue_status clamps history_limit via schema', () => {
    const v = parseOrThrow(schemas.flow_queue_status, {}, 't');
    expect(v.history_limit).toBe(5);
  });
});
