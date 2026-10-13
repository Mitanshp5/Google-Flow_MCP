import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/navigation/model-discovery.js', () => ({
  discoverModels: vi.fn(async () => ({ videoModels: ['Omni 1.1 Flash'] })),
  discoverCapabilities: vi.fn(async () => ({ probed: [] })),
}));
vi.mock('../src/browser/connect.js', async (importOriginal) => ({
  ...await importOriginal(),
  getPage: vi.fn(() => ({})),
}));

import { handleToolCall } from '../src/index.js';
import { discoverCapabilities } from '../src/navigation/model-discovery.js';

describe('model list refresh', () => {
  it('does not probe capabilities by default', async () => {
    vi.clearAllMocks();
    const result = await handleToolCall('flow_list_models', { refresh: true });
    expect(JSON.parse(result.content[0].text).videoModels).toEqual(['Omni 1.1 Flash']);
    expect(discoverCapabilities).not.toHaveBeenCalled();
  });

  it('allows an explicit capability probe', async () => {
    vi.clearAllMocks();
    await handleToolCall('flow_list_models', { refresh: true, probe_capabilities: true });
    expect(discoverCapabilities).toHaveBeenCalledOnce();
  });
});
