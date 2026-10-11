/**
 * W00 finding-ownership registry (F01-F16 / R01-R04).
 * Declares the owning work package + starter repro reference for every
 * confirmed QA finding. W00 owns only the harness + starter repros for
 * F01/F03/F04/F12/F13; other rows now point to their landed local regression evidence.
 * Full acceptance and live limits are recorded in implementation-progress.md.
 */
export const W00_QA_REVISION = '6d56c2467df7922d4766c74a1d81626d65232cce';

export const W00_FINDING_REGISTRY = [
  { id: 'F01', owner: 'W00-starter', repro: 'w00-fixture-dom: legacy button,a misses mat-list-item' },
  { id: 'F02', owner: 'W02', repro: 'w00-fixture-dom: 404 fixture present (route fix in W02)' },
  { id: 'F03', owner: 'W00-starter', repro: 'w00-fixture-dom: generic contenteditable != character form' },
  { id: 'F04', owner: 'W00-starter', repro: 'w00-fixture-dom: requested 4s/360p vs chip 8s/720p + changelog panel' },
  { id: 'F05', owner: 'W03', repro: 'tests/w03-model-catalog.test.js: observed exact live model and fallback provenance' },
  { id: 'F06', owner: 'W04', repro: 'tests/w04-upload-refs.test.js: acknowledged upload and exact stable slot identity' },
  { id: 'F07', owner: 'W04', repro: 'tests/w04-mentions-refs.test.js: picker scope, stable identity, rich rollback' },
  { id: 'F08', owner: 'W02', repro: 'tests/w02-reuse.test.js + tests/w04-list-refs.test.js: non-destructive inspection' },
  { id: 'F09', owner: 'W06', repro: 'tests/w03-read-tool-state.test.js + tests/w06-truthful-tools.test.js: status/account/model readback' },
  { id: 'F10', owner: 'W02', repro: 'tests/w02-app-state.test.js + tests/w02-flow-open.test.js: loading and 404 block' },
  { id: 'F11', owner: 'W01', repro: 'tests/w01-parent-corrections.test.js + tests/w06-truthful-tools.test.js: persisted selectors and fresh roots' },
  { id: 'F12', owner: 'W00-starter', repro: 'w00-pack-smoke: unconditional All-tests-passed' },
  { id: 'F13', owner: 'W00-starter', repro: 'w00-pack-smoke: files omits scripts/' },
  { id: 'F14', owner: 'W02', repro: 'tests/w02-rename.test.js: bounded rename and pending/failed states' },
  { id: 'F15', owner: 'W04', repro: 'tests/w04-download-refs.test.js: explicit intended asset menu and verified bytes' },
  { id: 'F16', owner: 'W06', repro: 'tests/w06-truthful-tools.test.js: honest plan-only multi-shot metadata' },
  { id: 'R01', owner: 'W05', repro: 'tests/w05-handler-integration.test.js: observed identity bound to trusted expected account' },
  { id: 'R02', owner: 'W05', repro: 'tests/w05-t3-poll-correlation.test.js: baseline and attempt attribution' },
  { id: 'R03', owner: 'W05', repro: 'tests/w05-submission-adapter.test.js + tests/w06-parent-boundaries.test.js: reset fences actions and durable unknown survives' },
  { id: 'R04', owner: 'W01', repro: 'tests/w00-import-dispatch.test.js + tests/w06-tool-integration.test.js: contract parity and explicit unsupported params' },
];
