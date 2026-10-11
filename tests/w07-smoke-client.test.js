// W07-A: portable initialized SDK smoke client verdict parser.
// F12: smoke must fail on tool error / missing response / timeout /
// invalid executable, and pass only on a verified initialized ok result.
// Depends on core contracts (W01/W06 result shape); this lane asserts the
// client verdict only and marks live correlation as integration-dependent.
import { describe, it, expect } from 'vitest';
import { assertMcpSmokeOutput } from '../scripts/smoke-client.mjs';

describe('W07-A smoke client verdict (F12)', () => {
  it('passes a verified initialized ok tool result', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'smoke_ping',
      result: { ok: true },
      timedOut: false,
    });
    expect(verdict.pass).toBe(true);
  });

  it('fails on isError:true (the F12 negative repro)', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_connect',
      result: { isError: true, content: [{ type: 'text', text: 'PLAYWRIGHT_ERROR Chrome not found' }] },
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TOOL_ERROR/);
  });

  it('fails on PLAYWRIGHT_ERROR text even without isError flag', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_connect',
      result: { content: [{ type: 'text', text: 'PLAYWRIGHT_ERROR boom' }] },
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
  });

  it('fails on missing result', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_connect',
      result: undefined,
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_MISSING_RESULT/);
  });

  it('fails on timeout', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_connect',
      result: { ok: true },
      timedOut: true,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TIMEOUT/);
  });

  it('fails when initialize handshake never completed', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: false,
      toolName: 'flow_connect',
      result: { ok: true },
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_NOT_INITIALIZED/);
  });

  it('fails on invalid executable / spawn failure', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: false,
      toolName: 'flow_connect',
      result: undefined,
      timedOut: false,
      spawnError: 'spawn qa-nonexistent-chrome.exe ENOENT',
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_SPAWN_ERROR/);
  });

  it('fails on empty content array (parent probe: must not pass)', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_status',
      result: { content: [] },
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_(MISSING|EMPTY)_RESULT/);
  });

  it('fails on missing content with no top-level ok', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_status',
      result: {},
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_(MISSING|EMPTY)_RESULT/);
  });

  it('fails on text-only generic structured error (parent probe: must not pass)', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_status',
      result: {
        content: [{ type: 'text', text: '{"error":true,"code":"BLOCKING","message":"blocked"}' }],
      },
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TOOL_ERROR/);
  });

  it('fails on structured ok:false in text', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_status',
      result: { content: [{ type: 'text', text: '{"ok":false,"message":"denied"}' }] },
      timedOut: false,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TOOL_ERROR/);
  });

  it('passes a realistic positive envelope with benign JSON text', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'flow_status',
      result: {
        content: [{ type: 'text', text: '{"browser":false,"queue":{"totalJobs":0}}' }],
      },
      timedOut: false,
    });
    expect(verdict.pass).toBe(true);
  });

  it('passes unicode/newline content without corruption', () => {
    const verdict = assertMcpSmokeOutput({
      initialized: true,
      toolName: 'smoke_ping',
      result: { content: [{ type: 'text', text: '{"ok":true,"note":"héllo wörld ✓\nnewline"}' }] },
      timedOut: false,
    });
    expect(verdict.pass).toBe(true);
  });
});
