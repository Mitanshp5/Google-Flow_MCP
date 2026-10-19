import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { get, getFlowHome } from './config.js';
import { FlowError } from './errors.js';

export function projectCreditCap() {
  const cap = Number(get('projectCreditCap', 50));
  if (!Number.isFinite(cap) || cap < 0) throw new FlowError('INVALID_PARAMS', 'projectCreditCap must be a finite non-negative number');
  return cap;
}

// Persist the quote BEFORE the click. Unknown submissions remain charged to
// this local budget: this is not a Google balance or a claim of actual billing.
// A short filesystem lock serializes multiple server processes; fail closed.
export function reserveProjectCredits({ account, projectId, operationId, credits, cap = projectCreditCap(), home = getFlowHome() }) {
  if (!account || !projectId || !operationId || !Number.isFinite(credits) || credits < 0 || !Number.isFinite(cap) || cap < 0) {
    throw new FlowError('INVALID_PARAMS', 'Project credit reservation requires account, project, operation and a known non-negative quote/cap');
  }
  const key = createHash('sha256').update(JSON.stringify([account, projectId])).digest('hex');
  const dir = path.join(home, 'project-credit-budgets');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch { throw new FlowError('MANUAL_VERIFICATION_REQUIRED', 'Project credit budget is locked; no generation permitted. Inspect existing submission before retrying.'); }
  try {
    const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, entries: [] };
    if (ledger.version !== 1 || !Array.isArray(ledger.entries) || ledger.entries.some(e => !Number.isFinite(e.credits) || e.credits < 0)) {
      throw new FlowError('MANUAL_VERIFICATION_REQUIRED', 'Invalid project credit ledger; no generation permitted');
    }
    if (ledger.entries.some(e => e.operationId === operationId)) {
      throw new FlowError('MANUAL_VERIFICATION_REQUIRED', 'Operation already reserved; inspect it instead of submitting twice');
    }
    const used = ledger.entries.reduce((sum, entry) => sum + entry.credits, 0);
    if (used + credits > cap) {
      throw new FlowError('MANUAL_VERIFICATION_REQUIRED', `Project credit cap ${cap} exceeded: ${used} reserved + ${credits} quoted. No Generate click made.`);
    }
    ledger.entries.push({ operationId, credits, reservedAt: new Date().toISOString() });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(ledger, null, 2));
    fs.renameSync(temp, file);
    return { cap, reserved: used + credits, remaining: cap - used - credits };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
