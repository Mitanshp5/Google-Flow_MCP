import { describe, it, expect } from 'vitest';

// W03: exact model dropdown preserves current 2.1/Lite variants;
// fallback candidates are not actual availability (F05, §9.1).
// Live evidence: manual-live-image-models.json lists
// "Nano Banana Pro" / "Nano Banana 2 Lite" / "Nano Banana 2.1".

import {
  FALLBACK_CATALOG,
  getModelProvenance,
  resolveModel,
  isModelLiveVerified,
} from '../src/utils/models.js';

describe('W03 exact live model identities (F05)', () => {
  it('fallback catalog preserves versioned 2.1/Lite variants, not stale Nano Banana 2', () => {
    expect(FALLBACK_CATALOG.imageModels).toContain('Nano Banana Pro');
    expect(FALLBACK_CATALOG.imageModels).toContain('Nano Banana 2 Lite');
    expect(FALLBACK_CATALOG.imageModels).toContain('Nano Banana 2.1');
    expect(FALLBACK_CATALOG.imageModels).not.toContain('Nano Banana 2');
  });

  it('live 2.1 name resolves when observed (no MODEL_NOT_AVAILABLE on exact live name)', () => {
    // resolveModel reads merged universe (config+cache+fallback); with the
    // corrected fallback the exact live names must resolve.
    expect(resolveModel('Nano Banana 2.1', 'image')?.name).toBe('Nano Banana 2.1');
    expect(resolveModel('Nano Banana 2 Lite', 'image')?.name).toBe('Nano Banana 2 Lite');
    expect(resolveModel('Nano Banana Pro', 'image')?.name).toBe('Nano Banana Pro');
  });

  it('config is planning candidate, never observed availability (parent #4)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { getFlowHome } = await import('../src/utils/config.js');
    const f = path.join(getFlowHome(), 'config', 'flow.models.json');
    let had = null;
    try {
      had = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null;
      // Isolate: cache without Lite so fallback provenance is exercised.
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ imageModels: [], videoModels: [], source: 'live', observedAt: new Date().toISOString() }));
      // User config lists stale "Nano Banana 2" in this repo; it must not be
      // reported available:true (planning candidate only).
      const cfg = getModelProvenance('Nano Banana 2');
      expect(cfg.source).toBe('config');
      expect(cfg.available).toBe(false);
      // Fallback candidates are never live availability either.
      const lite = getModelProvenance('Nano Banana 2 Lite');
      expect(lite.source).toBe('fallback');
      expect(lite.available).toBe(false);
      expect(getModelProvenance('Nope Model 9.9').available).toBe(false);
      expect(getModelProvenance('Nope Model 9.9').source).toBe('unknown');
    } finally {
      if (had === null) { try { fs.rmSync(f); } catch {} } else { fs.writeFileSync(f, had); }
    }
  });

  it('stale cache is not available; live readback verifies regardless provenance', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { getFlowHome } = await import('../src/utils/config.js');
    const f = path.join(getFlowHome(), 'config', 'flow.models.json');
    let had = null;
    try {
      had = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({
        imageModels: ['Stale Test Model X'],
        videoModels: [],
        capabilitiesObservedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
        source: 'live',
      }));
      expect(getModelProvenance('Stale Test Model X').available).toBe(false);
    } finally {
      if (had === null) { try { fs.rmSync(f); } catch {} } else { fs.writeFileSync(f, had); }
    }
    // UI selection readback verifies exact model live regardless provenance.
    expect(isModelLiveVerified('Nano Banana 2.1', 'nano-banana-2.1')).toBe(true);
    expect(isModelLiveVerified('Nano Banana 2.1', 'Nano Banana Pro')).toBe(false);
  });

  it('stale family-only requests stay ambiguous (no silent substitution)', () => {
    expect(resolveModel('nano', 'image')).toBe(null);
  });
});
