import { describe, it, expect } from 'vitest';
import { describeLaunchPlan, classifyCdpError, checkHeadlessOption } from '../src/browser/session.js';

describe('W02 launch platform fixtures', () => {
  it('blocks headless explicitly', () => {
    expect(describeLaunchPlan({ cdpReachable: false, profileExists: true, headless: true }).path).toBe('blocked');
    expect(checkHeadlessOption(true).supported).toBe(false);
  });

  it('blocks cold launch when no CDP and profile missing', () => {
    const p = describeLaunchPlan({ cdpReachable: false, profileExists: false, port: 9222 });
    expect(p.path).toBe('blocked');
  });

  it('classifies port conflict vs absent CDP', () => {
    expect(classifyCdpError(new Error('EADDRINUSE address already in use')).kind).toBe('port-conflict');
    expect(classifyCdpError(new Error('ECONNREFUSED 127.0.0.1:9222')).kind).toBe('absent');
  });
});
