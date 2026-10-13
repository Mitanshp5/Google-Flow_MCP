import { it, expect } from 'vitest';
import { handleExportReel } from '../src/tools/export-reel.js';

it('rejects missing or duplicate clip identifiers before accessing browser or files', async () => {
  await expect(handleExportReel({})).rejects.toThrow('Exactly three');
  await expect(handleExportReel({ prompts: ['same prompt prefix', 'same prompt prefix', 'another prompt prefix'] })).rejects.toThrow('distinct');
});
