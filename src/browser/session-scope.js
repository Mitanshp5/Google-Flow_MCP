/**
 * W00 scoped page/session boundary (AsyncLocalStorage).
 *
 * Lets real dispatch run against fixture pages without touching the live
 * global browser session in connect.js: getPage()/isBrowserConnected()
 * consult the ambient scope first, then fall back to live globals.
 * No exported mutable global page provider — scopes only exist inside
 * withSession/withPage callbacks, so nested/concurrent scopes restore
 * correctly by construction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const sessionStore = new AsyncLocalStorage();

export function getSessionScope() {
  return sessionStore.getStore() ?? null;
}

export function getScopedPage() {
  const scope = getSessionScope();
  return scope?.page ?? null;
}

export function getScopedConnection() {
  return getSessionScope()?.connection ?? null;
}

export function withSession(scope, fn) {
  return sessionStore.run({ ...(scope ?? {}) }, fn);
}

export function withPage(page, fn) {
  const parent = getSessionScope();
  return sessionStore.run({ ...(parent ?? {}), page }, fn);
}
