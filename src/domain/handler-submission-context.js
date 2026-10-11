// Internal scoped fixture integration. Neither MCP arguments nor config/env
// select this transport. Production continues through the adapter's early deny.
import { getSessionScope } from '../browser/session-scope.js';
import { readToolState, openBarSettings, closeSettingsPanel, isVerifiedSettingsPanel } from '../browser/safe-actions.js';
import { readComposerSnapshot } from '../browser/composer-state.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { extractProjectId } from '../navigation/project-navigator.js';
import { parseCostLabel, QUOTE_MAX_AGE_MS } from '../browser/cost-quote.js';
import { toTriState, makeCapabilityRecord } from '../browser/capabilities.js';
import { assertUiCurrent } from '../browser/ui-transaction.js';
import { digestRequest, deepEqual } from './contracts.js';
import { FlowError } from '../utils/errors.js';

function deny(binding) {
  throw new FlowError('POLICY_DENIED', 'Handler read-back does not bind the approved request', { binding });
}

/** Build evidence by invoking the existing real observers inside the handler.
 * The authorization carries intended identity, registry and transport only;
 * observed identity/settings/quote/capability timestamps never come from it.
 */
export async function buildHandlerSubmissionContext({ page, epoch, requestPayload, inputLocator, refs = [], mentionNames = [] }) {
  const trusted = getSessionScope()?.handlerSubmission;
  const trustedPage = trusted?.page?.[Symbol.for('flow.originalPage')] ?? trusted?.page;
  const actualPage = page?.[Symbol.for('flow.originalPage')] ?? page;
  if (!trusted || trustedPage !== actualPage || typeof trusted.submit !== 'function' ||
      typeof trusted.origin !== 'string' || !trusted.origin.startsWith('local-fixture:')) {
    return { executionMode: 'production' };
  }
  assertUiCurrent(epoch);
  // Existing upload readback proves file acceptance, not remote identity.
  // A path/name alone cannot authorize an asset's content/slot binding.
  if (refs.length) deny('local-reference-identity-unavailable');
  const approvedReferences = trusted.referenceBindings ?? [];
  if (!Array.isArray(approvedReferences) || approvedReferences.length !== mentionNames.length) deny('reference-set');
  for (let i = 0; i < mentionNames.length; i++) {
    const ref = approvedReferences[i];
    if (!ref?.assetId || ref.title !== mentionNames[i] || ref.role !== 'ingredient') deny('reference-identity-role');
  }
  const payload = approvedReferences.length ? { ...requestPayload, references: approvedReferences.map(({ assetId, title, role }) => ({ assetId, title, role })) } : requestPayload;
  const opened = await openBarSettings(page);
  if (!opened.panel) deny('capabilities-panel-unavailable');
  let observed;
  let structure;
  let panelObservedAt;
  try {
    structure = await isVerifiedSettingsPanel(opened.panel);
    observed = await opened.panel.evaluate(root => {
      const controls = [...root.querySelectorAll('button, [role="option"], [role="menuitem"], [role="tab"]')];
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const selected = el => ['aria-pressed', 'aria-checked', 'data-selected'].some(a => el.getAttribute(a) === 'true') || el.getAttribute('data-state') === 'on';
      const rows = controls.filter(visible).map(el => ({ text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '), enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true', selected: selected(el), modelRow: /menu-trigger/.test(String(el.className)) }));
      // Read one owned leaf label; page-wide footer/grid numbers are not quotes.
      const labels = [...root.querySelectorAll('*')].filter(el => visible(el) && el.children.length === 0)
        .map(el => (el.innerText || el.textContent || '').trim()).filter(t => /credits?/i.test(t));
      return { rows, labels };
    });
    panelObservedAt = Date.now();
  } finally {
    if (!(await closeSettingsPanel(page))) deny('settings-panel-restore');
  }
  if (!structure?.isSettings || !structure.structure || !observed) deny('capabilities-unreadable');
  const row = observed.rows.find(r => r.modelRow);
  const observedModel = row?.text.replace(/arrow_drop_down|arrow_drop_up/g, '').trim();
  const mode = observed.rows.find(r => r.selected && /^(Image|Video)$/i.test(r.text));
  const feature = mode?.text.toLowerCase();
  const dimensions = [requestPayload.ratio, `x${requestPayload.quantity}`, requestPayload.duration, requestPayload.quality].filter(Boolean);
  const selectedRows = dimensions.map(text => observed.rows.find(r => r.text === text && r.selected));
  const state = toTriState({ present: !!row && !!mode && selectedRows.every(Boolean), enabled: !!row?.enabled && !!mode?.enabled && selectedRows.every(r => r?.enabled) });
  const capabilityRecord = makeCapabilityRecord({ model: observedModel, feature, ratio: requestPayload.ratio, duration: requestPayload.duration, quality: requestPayload.quality, quantity: requestPayload.quantity, state: state.state, evidence: `${trusted.origin}:owned-settings-controls` });
  // makeCapabilityRecord is called for this actual scan; use the scan clock
  // consistently, rather than refreshing any cached catalog entry.
  capabilityRecord.observedAt = new Date(panelObservedAt).toISOString();
  const parsed = observed.labels.length === 1 ? parseCostLabel(observed.labels[0], { quantity: requestPayload.quantity }) : null;
  const quote = parsed?.state === 'known' ? {
    total: parsed.totalUpperBound, unit: parsed.unit, perGeneration: parsed.unit === 'per-generation' ? parsed.amount : undefined,
    model: observedModel, feature, quantity: parsed.quantity, raw: parsed.raw,
    observedAt: panelObservedAt, expiresAt: panelObservedAt + QUOTE_MAX_AGE_MS,
  } : null;
  const snapshot = await readComposerSnapshot(page, inputLocator);
  const settings = await readToolState(page);
  const settingsObservedAt = Date.now();
  const html = await page.content();
  const accountObservedAt = Date.now();
  const observedAccount = extractObservedAccount(html);
  const observedProjectId = extractProjectId(page.url());
  const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('img, video')].map(el => {
    const src = el.currentSrc || el.src || '';
    return el.tagName === 'VIDEO' ? src : src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/)?.[1];
  }).filter(Boolean))]);
  const baseline = { ids, observedAt: Date.now(), origin: `${trusted.origin}:visible-media-dom` };
  if (snapshot.text !== requestPayload.prompt) deny('prompt');
  if (!snapshot.chipsObservable || !snapshot.slotsObservable || !snapshot.uploadsObservable || snapshot.pendingUploads.length || Object.keys(snapshot.slots).length) deny('reference-observation');
  const actualReferences = snapshot.chips.map(({ assetId, title }) => ({ assetId, title, role: 'ingredient' }));
  if (!deepEqual(actualReferences, approvedReferences)) deny('references');
  if (settings.mode !== requestPayload.type || settings.agentMode !== 'off') deny('mode');
  const verifiedSettings = {
    ...settings,
    model: (settings.model === 'unknown' && observedModel) ? observedModel : settings.model,
  };
  for (const dimension of ['model', 'ratio', 'quantity', 'duration', 'quality']) {
    if (Object.hasOwn(requestPayload, dimension) && !deepEqual(verifiedSettings[dimension], requestPayload[dimension])) deny(dimension);
  }
  const verification = {
    account: { status: observedAccount ? 'verified' : 'unverified', observedAt: accountObservedAt, origin: `${trusted.origin}:account-html` },
    settings: { status: 'verified', observedAt: settingsObservedAt, origin: `${trusted.origin}:composer-readback` },
    quote: { status: quote ? 'verified' : 'unverified', observedAt: panelObservedAt, origin: `${trusted.origin}:owned-credit-label` },
    capabilities: { status: state.state === 'supported' ? 'verified' : 'unverified', observedAt: panelObservedAt, origin: capabilityRecord.evidence },
    references: { status: 'verified', observedAt: snapshot.takenAt, origin: `${trusted.origin}:composer-chip-slot-upload-readback` },
  };
  const policyContext = {
    account: { expected: trusted.expectedAccount, observed: observedAccount, verified: !!observedAccount, observedAt: accountObservedAt },
    project: { requiredId: trusted.intendedProjectId, observedId: observedProjectId },
    verification, quote, capabilities: { supported: state.state === 'supported', model: observedModel, feature, observedAt: panelObservedAt, record: capabilityRecord },
    requestDigest: digestRequest(payload), approval: trusted.approvalChild,
  };
  assertUiCurrent(epoch);
  return {
    executionMode: 'local-fixture', requestPayload: payload, observedAccount, observedProjectId,
    verifiedSettings, quote, baseline, policyContext, approvalChild: trusted.approvalChild,
    approvals: trusted.approvals, ledger: trusted.ledger, opStore: trusted.opStore,
    remoteSubmitFn: async invocation => {
      assertUiCurrent(epoch);
      const result = await trusted.submit(invocation);
      assertUiCurrent(epoch);
      return result;
    },
  };
}
