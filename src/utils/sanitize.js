import path from 'path';
import { FlowError, ErrorCodes } from './errors.js';
import { get, getFlowHome } from './config.js';

// Google Flow moved: labs.google/fx/tools/flow --308--> flow.google.com/
// Both hosts are allowlisted; legacy labs path still accepted (it redirects).
const FLOW_HOSTS = ['flow.google.com', 'labs.google'];

export function isFlowUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return FLOW_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function sanitizeFileName(name, fallback = 'file') {
  const base = String(name ?? fallback).trim() || fallback;
  return base
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || fallback;
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Allowlist navigation URLs to Google Flow only.
 * Blocks file://, localhost, internal hosts (SSRF).
 */
export function assertFlowUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new FlowError(ErrorCodes.UNSUPPORTED_URL, `Invalid URL: ${url}`);
  }
  if (u.protocol !== 'https:') {
    throw new FlowError(ErrorCodes.UNSUPPORTED_URL, `Only https: Flow URLs are allowed: ${url}`);
  }
  const host = u.hostname.toLowerCase();
  if (!FLOW_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    throw new FlowError(
      ErrorCodes.UNSUPPORTED_URL,
      `URL must be on flow.google.com (Google Flow). Got: ${host}`
    );
  }
  // Legacy labs.google URLs must stay under /fx/tools/flow (the whole
  // labs.google domain hosts many experiments — only the Flow path is ours).
  if (host.endsWith('labs.google')) {
    if (!u.pathname.startsWith('/fx/tools/flow')) {
      throw new FlowError(
        ErrorCodes.UNSUPPORTED_URL,
        `URL must be under /fx/tools/flow. Got: ${u.pathname}`
      );
    }
  }
  return u.toString();
}

export function clampWaitFor(ms, def = 3000, max = 15000) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), 0), max);
}

/**
 * Resolve a user-supplied file path.
 * - Absolute paths are allowed but must exist (checked by caller).
 * - Relative paths resolve against flowHome (deterministic, not process.cwd()).
 * - Rejects null bytes.
 */
export function resolveSafePath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'File path must be a non-empty string');
  }
  if (inputPath.includes('\0')) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'File path contains null bytes');
  }
  const trimmed = inputPath.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(getFlowHome(), trimmed);
}

/**
 * Ensure an absolute path stays inside a base dir (traversal guard).
 * Returns normalized path or throws.
 */
export function assertInsideBase(absPath, baseDir) {
  const normBase = path.resolve(baseDir) + path.sep;
  const normTarget = path.resolve(absPath);
  if (normTarget !== normBase.slice(0, -1) && !normTarget.startsWith(normBase)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Path escapes allowed directory: ${absPath}`);
  }
  return normTarget;
}
