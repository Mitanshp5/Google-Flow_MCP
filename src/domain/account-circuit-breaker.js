import fs from 'fs';
import path from 'path';
import { getFlowHome } from '../utils/config.js';
import { ErrorCodes, FlowError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const UNUSUAL_ACTIVITY_COOLDOWN_SEC = 1800; // 30 minutes
export const RATE_LIMIT_COOLDOWN_SEC = 300;        // 5 minutes
export const CAPTCHA_GATE_COOLDOWN_SEC = 900;      // 15 minutes

const STORE_VERSION = 1;

export function normalizeAccountKey(accountKey) {
  if (typeof accountKey !== 'string') return '';
  return accountKey.trim().toLowerCase();
}

export function getCooldownStorePath(home = getFlowHome()) {
  return path.join(home, 'security', 'account-cooldowns.json');
}

function validateStoreShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FlowError(ErrorCodes.STORAGE_CORRUPT, 'Account cooldown store must be a JSON object', {});
  }
  if (raw.version !== STORE_VERSION) {
    throw new FlowError(ErrorCodes.STORAGE_VERSION_UNSUPPORTED, `Unsupported account cooldown store version: ${raw.version}`, { version: raw.version });
  }
  if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) {
    throw new FlowError(ErrorCodes.STORAGE_CORRUPT, 'Account cooldown store missing accounts map', {});
  }
  for (const [k, entry] of Object.entries(raw.accounts)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FlowError(ErrorCodes.STORAGE_CORRUPT, `Corrupt cooldown entry for account ${k}`, { accountKey: k });
    }
    if (typeof entry.heldUntil !== 'number' || !Number.isFinite(entry.heldUntil)) {
      throw new FlowError(ErrorCodes.STORAGE_CORRUPT, `Invalid heldUntil timestamp for account ${k}`, { accountKey: k });
    }
  }
  return raw;
}

export function readCooldownStore(home = getFlowHome()) {
  const file = getCooldownStorePath(home);
  if (!fs.existsSync(file)) {
    return { version: STORE_VERSION, accounts: {} };
  }
  let parsed;
  try {
    const content = fs.readFileSync(file, 'utf8');
    parsed = JSON.parse(content);
  } catch (err) {
    throw new FlowError(ErrorCodes.STORAGE_CORRUPT, `Failed to parse account cooldown store: ${err.message}`, { file });
  }
  return validateStoreShape(parsed);
}

function withCooldownLock(home, fn) {
  const file = getCooldownStorePath(home);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch {
    throw new FlowError(ErrorCodes.LOCK_HELD, 'Account cooldown store is locked by another operation', { lock });
  }
  try {
    return fn(file);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function writeCooldownStoreAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

export function getAccountCooldown(accountKey, { home = getFlowHome(), now = Date.now() } = {}) {
  const key = normalizeAccountKey(accountKey);
  if (!key) {
    return {
      active: false,
      accountKey: '',
      remainingSec: 0,
      heldUntil: null,
      heldAt: null,
      reason: null,
      rpc: null,
      details: null,
    };
  }
  const store = readCooldownStore(home);
  const entry = store.accounts[key];
  if (!entry) {
    return {
      active: false,
      accountKey: key,
      remainingSec: 0,
      heldUntil: null,
      heldAt: null,
      reason: null,
      rpc: null,
      details: null,
    };
  }
  const active = entry.heldUntil > now;
  const remainingSec = active ? Math.max(1, Math.ceil((entry.heldUntil - now) / 1000)) : 0;
  return {
    active,
    expired: !active,
    accountKey: key,
    remainingSec,
    heldUntil: entry.heldUntil,
    heldAt: entry.heldAt ?? null,
    reason: entry.reason ?? null,
    rpc: entry.rpc ?? null,
    details: entry.details ?? null,
  };
}

export function tripAccountCooldown(accountKey, {
  durationSec = UNUSUAL_ACTIVITY_COOLDOWN_SEC,
  reason = 'unusual_activity',
  rpc = null,
  details = null,
  home = getFlowHome(),
  now = Date.now(),
} = {}) {
  const key = normalizeAccountKey(accountKey);
  if (!key) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'tripAccountCooldown requires a non-empty accountKey', {});
  }
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `durationSec must be a positive finite number, got ${durationSec}`, { durationSec });
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'now timestamp must be a finite number', { now });
  }

  return withCooldownLock(home, (file) => {
    const store = readCooldownStore(home);
    const existing = store.accounts[key];
    const requestedUntil = now + Math.round(durationSec * 1000);

    // Monotonicity: never allow a shorter hold to truncate an active longer hold
    if (existing && existing.heldUntil > requestedUntil) {
      return getAccountCooldown(key, { home, now });
    }

    store.accounts[key] = {
      heldUntil: requestedUntil,
      heldAt: now,
      reason: String(reason || 'unusual_activity'),
      rpc: rpc ? String(rpc) : null,
      details: details ? String(details) : null,
    };
    writeCooldownStoreAtomic(file, store);
    logger.warn('Account safety circuit breaker tripped', {
      accountKey: key,
      durationSec,
      reason,
      rpc,
      heldUntilIso: new Date(requestedUntil).toISOString(),
    });
    return getAccountCooldown(key, { home, now });
  });
}

export function clearAccountCooldown(accountKey, { home = getFlowHome() } = {}) {
  const key = normalizeAccountKey(accountKey);
  if (!key) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'clearAccountCooldown requires a non-empty accountKey', {});
  }
  return withCooldownLock(home, (file) => {
    const store = readCooldownStore(home);
    const existed = Object.prototype.hasOwnProperty.call(store.accounts, key);
    if (existed) {
      delete store.accounts[key];
      writeCooldownStoreAtomic(file, store);
      logger.info('Account safety circuit breaker cleared', { accountKey: key });
    }
    return { cleared: existed, accountKey: key };
  });
}

export function assertAccountActive(accountKey, { home = getFlowHome(), now = Date.now() } = {}) {
  const key = normalizeAccountKey(accountKey);
  if (!key) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'assertAccountActive requires a valid accountKey', {});
  }
  const cooldown = getAccountCooldown(key, { home, now });
  if (cooldown.active) {
    throw new FlowError(
      ErrorCodes.ACCOUNT_COOLDOWN_ACTIVE,
      `Generation blocked: account "${key}" is in safety cooldown for ${cooldown.remainingSec}s (reason: ${cooldown.reason}). Read-only inspection remains permitted.`,
      { ...cooldown },
    );
  }
  return cooldown;
}

export function detectSafetySignal({ status = null, body = '', html = '' } = {}) {
  const text = `${String(body || '')}\n${String(html || '')}`;

  if (/PUBLIC_ERROR_UNUSUAL_ACTIVITY|unusual[\s_-]+activity/i.test(text)) {
    return {
      tripped: true,
      reason: 'unusual_activity',
      durationSec: UNUSUAL_ACTIVITY_COOLDOWN_SEC,
      details: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY',
    };
  }

  if (status === 429 || /RESOURCE_EXHAUSTED|too\s+many\s+requests/i.test(String(body || ''))) {
    return {
      tripped: true,
      reason: 'rate_limit',
      durationSec: RATE_LIMIT_COOLDOWN_SEC,
      details: status === 429 ? 'HTTP_429' : 'RESOURCE_EXHAUSTED',
    };
  }

  if (/unusual\s+traffic\s+from\s+your\s+computer|verify\s+you\s+are\s+human/i.test(text)
    || /<iframe[^>]+src=["'][^"']*recaptcha\/(?:enterprise\/)?bframe/i.test(String(html || ''))) {
    return {
      tripped: true,
      reason: 'captcha_gate',
      durationSec: CAPTCHA_GATE_COOLDOWN_SEC,
      details: 'CAPTCHA_OR_HUMAN_VERIFICATION_GATE',
    };
  }

  return { tripped: false };
}
