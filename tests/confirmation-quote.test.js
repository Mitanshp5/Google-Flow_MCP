import { describe, it, expect } from 'vitest';
import { parseConfirmationQuote, characterImagePolicyQuote } from '../src/tools/generate-confirm.js';

describe('confirmation reads owned credit labels', () => {
  it('supports a single-output live quote without inventing batch units', () => {
    expect(parseConfirmationQuote(['Generating will use 1 credits'], 1)).toMatchObject({ state: 'known', total: 1 });
    expect(parseConfirmationQuote(['Generating will use 1 credits'], 2).state).toBe('unquoted');
  });
  it('keeps explicit per-output and total batch costs distinct', () => {
    expect(parseConfirmationQuote(['2 credits per video'], 3).total).toBe(6);
    expect(parseConfirmationQuote(['2 credits total'], 3).total).toBe(2);
  });
  it('blocks missing, conflicting, unrelated, or malformed labels', () => {
    for (const labels of [[], ['1 credits', '2 credits'], ['100 credits remaining'], ['-1 credits'], ['1,000 credits'], ['1 credits and 2 credits total']]) {
      expect(parseConfirmationQuote(labels).state).toBe('unquoted');
    }
  });
  it('deduplicates identical leaf labels', () => {
    expect(parseConfirmationQuote(['0 credits', '0 credits'], 4)).toMatchObject({ state: 'known', total: 0 });
  });
});

describe('account-owner free character image policy', () => {
  const evidence = { policy: { account: 'qa@example.com', models: ['Nano Banana 2.1'] },
    account: 'qa@example.com', model: 'Nano Banana 2.1', type: 'character', url: 'https://flow.google.com/project/qa/character' };
  it('labels configured zero pricing as policy, not an observed credit label', () => {
    expect(characterImagePolicyQuote(evidence)).toMatchObject({ total: 0, source: 'account-owner-free-image-policy', raw: null });
  });
  it('never bypasses video, unknown models, another account or conflicting credit labels', () => {
    for (const patch of [{type:'video'}, {model:'Veo 3.1 - Fast'}, {account:'other@example.com'},
      {policy:null}, {url:'https://flow.google.com/project/qa'}, {labels:['20 credits']}, {labels:['unreadable credits']}]) {
      expect(characterImagePolicyQuote({...evidence, ...patch})).toBe(null);
    }
  });
});
