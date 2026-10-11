#!/usr/bin/env node
// W07-A: portable initialized SDK smoke client (F12 repair).
// Speaks MCP over stdio via the shipped @modelcontextprotocol/sdk Client:
// initialize handshake first, then one tools/call. Verdict fails closed on
// isError / PLAYWRIGHT_ERROR text / missing result / timeout / spawn error /
// missing initialize. Never prints success on failure. No browser launched
// by this file itself; the target server entry decides that.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function resultText(result) {
  try {
    const parts = result?.content ?? [];
    return parts
      .filter((p) => typeof p?.text === 'string')
      .map((p) => p.text)
      .join('\n');
  } catch {
    return '';
  }
}

// A text part carrying a generic structured error (error:true, ok:false,
// success:false, isError:true at the top level of parsed JSON) is a tool
// failure even when the isError flag is absent.
export function hasStructuredError(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (
        parsed.error === true ||
        parsed.isError === true ||
        parsed.ok === false ||
        parsed.success === false
      );
    }
    return false;
  } catch {
    return false;
  }
}

// Pure verdict used by tests/w07-smoke-client.test.js. Returns
// { pass: boolean, reason: string }.
export function assertMcpSmokeOutput({ initialized, toolName, result, timedOut, spawnError }) {
  if (spawnError) {
    return { pass: false, reason: `SMOKE_SPAWN_ERROR tool=${toolName} error=${spawnError}` };
  }
  if (timedOut) {
    return { pass: false, reason: `SMOKE_TIMEOUT tool=${toolName} no result within budget` };
  }
  if (!initialized) {
    return { pass: false, reason: `SMOKE_NOT_INITIALIZED tool=${toolName} initialize handshake missing` };
  }
  if (result === undefined || result === null) {
    return { pass: false, reason: `SMOKE_MISSING_RESULT tool=${toolName} server returned no result` };
  }
  const text = `${resultText(result)} ${JSON.stringify(result)}`;
  if (result.isError === true) {
    return { pass: false, reason: `SMOKE_TOOL_ERROR tool=${toolName} isError:true ${resultText(result)}`.trim() };
  }
  if (/PLAYWRIGHT_ERROR|BROWSER_NOT_CONNECTED|CHROME_NOT_FOUND/i.test(text)) {
    return { pass: false, reason: `SMOKE_TOOL_ERROR tool=${toolName} error text present` };
  }
  const parts = Array.isArray(result.content) ? result.content : undefined;
  if (parts !== undefined && parts.length === 0 && result.ok !== true && result.success !== true) {
    return { pass: false, reason: `SMOKE_EMPTY_RESULT tool=${toolName} content array empty` };
  }
  if (parts === undefined && result.ok !== true && result.success !== true) {
    return { pass: false, reason: `SMOKE_MISSING_RESULT tool=${toolName} no content and no top-level ok` };
  }
  for (const p of parts ?? []) {
    if (typeof p?.text === 'string' && hasStructuredError(p.text)) {
      return { pass: false, reason: `SMOKE_TOOL_ERROR tool=${toolName} structured error in text content` };
    }
  }
  return { pass: true, reason: `SMOKE_PASS tool=${toolName} initialized ok result verified` };
}

function printHelp() {
  console.log(`w07 smoke-client: initialized MCP stdio smoke check
Usage: node scripts/smoke-client.mjs --server <entry.js> [--tool <name>] [--args-json <json>] [--timeout-ms <n>] [--cwd <dir>]
Exit 0 on SMOKE_PASS, non-zero on any SMOKE_* failure. No browser launched directly.`);
}

export function isValidSmokeTimeout(timeoutMs) {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
}

// Bounded entire lifetime: one deadline covers connect AND tools/call.
// The timer is always cleared and the child reaped via client/transport
// close, so importing this module never leaves a lingering timer.
// `launch` optionally overrides the spawn target to exercise a real
// launcher script end to end: { command, args }. Without it, the server
// entry is spawned directly with the current Node executable.
export async function runSmoke({ serverEntry, serverArgs = [], tool = 'flow_status', toolArgs = {}, timeoutMs = 30000, env, cwd, launch } = {}) {
  let spawnCommand = process.execPath;
  let spawnArgs = null;
  if (launch !== undefined) {
    if (typeof launch !== 'object' || typeof launch.command !== 'string' || !Array.isArray(launch.args)) {
      return { pass: false, reason: 'SMOKE_USAGE_ERROR launch must be { command: string, args: string[] }' };
    }
    spawnCommand = launch.command;
    spawnArgs = launch.args;
  } else {
    if (typeof serverEntry !== 'string' || serverEntry.length === 0) {
      return { pass: false, reason: `SMOKE_USAGE_ERROR serverEntry is required` };
    }
    spawnArgs = [serverEntry, ...serverArgs];
  }
  if (!isValidSmokeTimeout(timeoutMs)) {
    return { pass: false, reason: `SMOKE_USAGE_ERROR timeoutMs must be a finite positive number (got ${String(timeoutMs)})` };
  }
  let initialized = false;
  let result;
  let timedOut = false;
  let spawnError;
  let client;
  let transport;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('SMOKE_TIMEOUT'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const attempt = (async () => {
    transport = new StdioClientTransport({
      command: spawnCommand,
      args: spawnArgs,
      env,
      cwd,
    });
    client = new Client({ name: 'w07-smoke-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    initialized = true;
    return await client.callTool({ name: tool, arguments: toolArgs });
  })();
  try {
    result = await Promise.race([attempt, deadline]);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/SMOKE_TIMEOUT/.test(msg)) {
      timedOut = true;
    } else if (!initialized) {
      spawnError = msg;
    }
    // An initialized call error with no result falls through to
    // SMOKE_MISSING_RESULT via the verdict below.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Reap the child on every path (success, failure, timeout). Await both
    // closes; transport.close kills a stalled child so no orphan survives.
    // Attach a no-op catch first so a rejected attempt never becomes an
    // unhandled rejection after the deadline won the race.
    attempt.catch(() => {});
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
  }
  return assertMcpSmokeOutput({ initialized, toolName: tool, result, timedOut, spawnError });
}

import { pathToFileURL } from 'url';

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const server = get('--server', null);
  if (!server) {
    console.error('SMOKE_USAGE_ERROR --server <entry.js> is required');
    process.exit(2);
  }
  const tool = get('--tool', 'flow_status');
  let toolArgs = {};
  const rawArgs = get('--args-json', '{}');
  try {
    toolArgs = JSON.parse(rawArgs);
  } catch {
    console.error('SMOKE_USAGE_ERROR --args-json is not valid JSON');
    process.exit(2);
  }
  const timeoutMs = Number(get('--timeout-ms', '30000'));
  const cwd = get('--cwd', undefined);
  runSmoke({ serverEntry: server, tool, toolArgs, timeoutMs, cwd }).then((verdict) => {
    console.log(verdict.reason);
    process.exit(verdict.pass ? 0 : 1);
  });
}

// Keep linters honest about the main-guard helper.
