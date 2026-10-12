import { get } from '../utils/config.js';

// Local-only probe: which Chrome CDP ports answer? Lets callers point
// flow_connect at an already-open browser (e.g. {"cdpPort": 56930})
// instead of launching a duplicate. No browser connection needed.
const PROBE_PORTS = [9222, 56930, 9333, 9334];

export async function handleListBrowserTargets() {
  const configured = Number(get('cdpPort', 9222)) || 9222;
  const ports = [...new Set([configured, ...PROBE_PORTS])];
  const targets = [];
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}/json/version`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(t);
      if (!res || !res.ok) {
        targets.push({ port, listening: false });
        continue;
      }
      const info = await res.json().catch(() => ({}));
      targets.push({ port, listening: true, browser: info.Browser || null });
    } catch {
      targets.push({ port, listening: false });
    }
  }
  return { status: 'success', configuredPort: configured, targets };
}
