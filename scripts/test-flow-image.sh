#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Quick smoke test: send a flow_connect tool call to the MCP server over stdio on macOS/Linux.
# Requires Chrome to already be running with CDP (scripts/start-browser.sh).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required but was not found in PATH."

log "Testing MCP server tool calls..."
log "Test 1: flow_connect"

REQUEST='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flow_connect","arguments":{"headless":false,"open_flow":true}}}'

# Run Node to handle spawning, stdin piping, and stdout gathering with a timeout
node -e "
const cp = require('child_process');
const proc = cp.spawn('node', ['src/index.js'], { cwd: '$PROJECT_DIR' });

let output = '';
proc.stdout.on('data', (data) => {
  const str = data.toString();
  output += str;
  // If we receive the JSON-RPC response, we can close the connection
  if (output.includes('result') || output.split('\n').length > 50) {
    proc.kill();
  }
});

proc.stderr.on('data', (data) => {
  console.error(data.toString());
});

proc.stdin.write('$REQUEST\n');

// Timeout after 30 seconds
const timer = setTimeout(() => {
  proc.kill();
  console.error('Test timed out after 30 seconds');
  process.exit(1);
}, 30000);

proc.on('close', () => {
  clearTimeout(timer);
  console.log(output);
  console.log('All tests passed.');
  process.exit(0);
});
"
