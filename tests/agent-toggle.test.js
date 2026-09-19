import { describe, it, expect } from 'vitest';
import { findAgentToggle, pressSelectAll, ensureManualMode } from '../src/browser/safe-actions.js';
import { mockButton, mockPage } from './helpers/mock-page.js';

// P2-1: agent-mode gating is safety-critical (Agent chat hijacks the prompt
// box) and previously had zero tests. takeScreenshot() degrades safely
// against the mock (no page.screenshot → caught → null), so ensureManualMode
// runs fully offline.
describe('findAgentToggle', () => {
  it('returns the bar toggle, skipping invisible buttons', async () => {
    const hidden = mockButton({ visible: false, evaluateResult: true });
    const toggle = mockButton({ visible: true, evaluateResult: true });
    const page = mockPage({ buttons: [hidden, toggle] });
    await expect(findAgentToggle(page)).resolves.toBe(toggle);
  });

  it('returns null when no button is inside the prompt bar', async () => {
    const page = mockPage({ buttons: [mockButton({ visible: true, evaluateResult: false })] });
    await expect(findAgentToggle(page)).resolves.toBe(null);
  });

  it('returns null when nothing is visible', async () => {
    const page = mockPage({ buttons: [mockButton({ visible: false, evaluateResult: true })] });
    await expect(findAgentToggle(page)).resolves.toBe(null);
  });
});

describe('pressSelectAll', () => {
  it('presses the platform modifier + a', async () => {
    const page = mockPage({});
    await pressSelectAll(page);
    expect(page.presses).toHaveLength(1);
    expect(page.presses[0]).toMatch(/\+a$/);
  });
});

describe('ensureManualMode', () => {
  it('already-off toggle returns off without clicking', async () => {
    let clicks = 0;
    const page = mockPage({
      buttons: [mockButton({ visible: true, evaluateResult: true, pressed: 'false', onClick: () => { clicks += 1; } })],
    });
    await expect(ensureManualMode(page)).resolves.toBe('off');
    expect(clicks).toBe(0);
  });

  it('stuck-on toggle throws MANUAL_VERIFICATION_REQUIRED', async () => {
    const page = mockPage({
      buttons: [mockButton({ visible: true, evaluateResult: true, pressed: 'true' })],
    });
    const err = await ensureManualMode(page, { tries: 1 }).catch((e) => e);
    expect(err?.code).toBe('MANUAL_VERIFICATION_REQUIRED');
  });

  it('missing toggle reports unknown-no-toggle', async () => {
    await expect(ensureManualMode(mockPage({ buttons: [] }))).resolves.toBe('unknown-no-toggle');
  });
});
