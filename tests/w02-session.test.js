import { describe, it, expect } from 'vitest';
import { selectFlowTab, checkHeadlessOption, describeLaunchPlan, createUiLease } from '../src/browser/session.js';

describe('W02 session ownership', () => {
  it('prefers an existing Flow tab over personal tabs', () => {
    const tabs = [{ url: 'https://mail.google.com/mail' }, { url: 'https://flow.google.com/project/abc' }];
    const sel = selectFlowTab(tabs);
    expect(sel.action).toBe('reuse');
    expect(sel.index).toBe(1);
  });

  it('never reuses a personal tab when no Flow tab exists', () => {
    const tabs = [{ url: 'https://mail.google.com/mail' }, { url: 'https://example.com/' }];
    const sel = selectFlowTab(tabs);
    expect(sel.action).toBe('create');
    expect(sel.index).toBe(null);
  });

  it('marks headless as explicitly unsupported', () => {
    const r = checkHeadlessOption(true);
    expect(r.supported).toBe(false);
    expect(String(r.blocker || '').toLowerCase()).toMatch(/headless/);
  });

  it('prefers CDP attach over cold launch when reachable', () => {
    const plan = describeLaunchPlan({ cdpReachable: true, profileExists: false });
    expect(plan.path).toBe('attach');
  });

  it('serializes UI transactions and fences stale epochs', async () => {
    const lease = createUiLease();
    const order = [];
    await Promise.all([
      lease.run(async () => { order.push(1); }),
      lease.run(async () => { order.push(2); }),
    ]);
    expect(order).toEqual([1, 2]);
    const epoch = lease.getEpoch();
    lease.fence();
    expect(lease.isCurrent(epoch)).toBe(false);
  });
});
