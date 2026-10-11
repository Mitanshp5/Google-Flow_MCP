import { assertUiCurrent } from './ui-transaction.js';

const ORIGINAL_PAGE = Symbol.for('flow.originalPage');

// Keep Playwright's actual implementation and arguments. The proxy guards
// actions AND awaited readbacks, so a caught stale read cannot enable a later
// stale action. It never selects a different page, browser or transport.
export function guardUiPage(page, epoch) {
  const proxies = new WeakMap();
  const originals = new WeakMap();
  const unwrap = value => {
    if (originals.has(value)) return originals.get(value);
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrap(entry)]));
    }
    return value;
  };
  const wrap = value => {
    if (Array.isArray(value)) return value.map(wrap);
    if (!value || typeof value !== 'object') return value;
    if (!['locator', 'click', 'press', 'goto', 'evaluate'].some(key => typeof value[key] === 'function')) return value;
    if (proxies.has(value)) return proxies.get(value);
    const proxy = new Proxy(value, {
      get(target, key) {
        if (key === ORIGINAL_PAGE) return target;
        if (key === 'then') return undefined;
        const member = Reflect.get(target, key, target);
        if (typeof member !== 'function') return wrap(member);
        return (...args) => {
          assertUiCurrent(epoch);
          const result = member.apply(target, args.map(unwrap));
          if (result && typeof result.then === 'function') {
            return result.then(output => { assertUiCurrent(epoch); return wrap(output); });
          }
          assertUiCurrent(epoch);
          return wrap(result);
        };
      },
    });
    proxies.set(value, proxy);
    originals.set(proxy, value);
    return proxy;
  };
  return wrap(page);
}
