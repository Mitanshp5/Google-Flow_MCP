import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAccount } from '../src/browser/account-check.js';
import { verifyAccountState } from '../src/browser/app-state.js';

vi.mock('../src/utils/screenshots.js', () => ({ takeScreenshot: vi.fn() }));

const page = html => ({ content: async () => html });
afterEach(() => vi.unstubAllEnvs());

describe('optional account restriction', () => {
  it.each(['first@gmail.com', 'creator@company.example'])('accepts signed-in %s without a pin', async email => {
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', '');
    expect(await verifyAccount(page(`<button aria-label="Google Account: Creator (${email})"></button>`)))
      .toMatchObject({ verified: true, account: email });
  });
  it('keeps explicit email restrictions', async () => {
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', 'expected@example.com');
    await expect(verifyAccount(page('<span data-account-email="other@example.com"></span>')))
      .rejects.toMatchObject({ code: 'WRONG_GOOGLE_ACCOUNT' });
    expect(await verifyAccount(page('<span data-account-email="expected@example.com"></span>')))
      .toMatchObject({ verified: true, account: 'expected@example.com' });
  });
  it.each([
    '<button>Sign in</button>',
    '<p>contact@example.com</p>',
    '<span data-account-email="a@example.com"></span><span data-account-email="b@example.com"></span>',
    '<script>const email="a@example.com";</script>',
  ])('does not claim an unidentified or ambiguous account is signed in', async html => {
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', '');
    expect(await verifyAccount(page(html))).toMatchObject({ verified: false, account: null });
  });
  it('status accepts a valid observed email without a pin, but not malformed evidence', () => {
    expect(verifyAccountState({ observed: 'creator@example.com' }).state).toBe('verified');
    expect(verifyAccountState({ observed: 'not an email' }).state).toBe('unverified');
    expect(verifyAccountState().state).toBe('unverified');
  });
});
