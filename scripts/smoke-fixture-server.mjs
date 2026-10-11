#!/usr/bin/env node
// W07-E: minimal initialized fixture MCP server for smoke tests.
// No browser, no config, no side effects. Tools:
//   smoke_ping -> { ok: true } (positive path)
//   smoke_fail -> isError:true PLAYWRIGHT_ERROR fixture (negative path, F12)
//   smoke_struct_error -> text-only generic structured error, no isError flag
//   smoke_empty -> empty content array
// Failure modes for lifetime tests (W07-A3), selected via argv:
//   --mode stall-init : accept stdio, never answer (initialize stalls)
//   --mode stall-call : initialize works, tools/call never answers
//   --mode malformed  : write a non-JSON-RPC line and exit non-zero
// Importing this module must NOT start the server (test import safety);
// fixtureServerEntry() resolves its own path for runSmoke().
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import path from 'path';

export function fixtureServerEntry() {
  return fileURLToPath(import.meta.url);
}

function isMain() {
  try {
    return (
      process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fixtureServerEntry()
    );
  } catch {
    return false;
  }
}

function cliMode() {
  const i = process.argv.indexOf('--mode');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const mode = cliMode();
  if (mode === 'stall-init') {
    // Never answer anything (not even initialize); the client's total
    // deadline must settle this as SMOKE_TIMEOUT and reap this process.
    // NOTE: a bare pending promise does NOT keep the event loop alive, so
    // hold a real repeating timer handle here.
    setInterval(() => {}, 60 * 60 * 1000);
    await new Promise(() => {});
    return;
  }
  if (mode === 'malformed') {
    process.stdout.write('this is not json-rpc\n');
    process.exit(3);
  }
  const server = new Server({ name: 'w07-smoke-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'smoke_ping', description: 'Positive fixture tool.', inputSchema: { type: 'object', properties: {} } },
      { name: 'smoke_fail', description: 'Negative fixture tool (isError).', inputSchema: { type: 'object', properties: {} } },
      { name: 'smoke_struct_error', description: 'Text-only structured error, no isError flag.', inputSchema: { type: 'object', properties: {} } },
      { name: 'smoke_empty', description: 'Empty content array.', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (mode === 'stall-call') {
      // Initialize succeeds; the call itself never answers.
      await new Promise(() => {});
    }
    if (request.params.name === 'smoke_ping') {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fixture: true }) }] };
    }
    if (request.params.name === 'smoke_fail') {
      return {
        content: [{ type: 'text', text: 'PLAYWRIGHT_ERROR fixture failure (intentional)' }],
        isError: true,
      };
    }
    if (request.params.name === 'smoke_struct_error') {
      return {
        content: [{ type: 'text', text: '{"error":true,"code":"BLOCKING","message":"blocked"}' }],
      };
    }
    if (request.params.name === 'smoke_empty') {
      return { content: [] };
    }
    return {
      content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
      isError: true,
    };
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMain()) {
  main().catch((err) => {
    console.error(`fixture server failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
