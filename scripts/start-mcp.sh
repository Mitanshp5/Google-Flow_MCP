#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Start the Google Flow Browser MCP server on macOS and Linux.

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="$PROJECT_DIR/config/flow.config.json"

# --- Check Node.js ---
command -v node >/dev/null 2>&1 || die "Node.js is required but was not found in PATH."
log "Using Node.js: $(command -v node) ($(node --version))"

# --- Check CDP port ---
CDP_PORT=9222
if [[ -f "$CONFIG_PATH" ]]; then
  eval "$(node -e "
  const fs = require('fs');
  try {
    const cfg = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
    if (cfg.cdpPort) console.log('CDP_PORT=\"' + cfg.cdpPort + '\"');
  } catch(e) {}
  ")"
fi

if ! curl -s http://localhost:$CDP_PORT/json/version >/dev/null 2>&1; then
  warn "CDP port $CDP_PORT not responding — Chrome might not be running."
  warn "Run scripts/start-browser.sh first, or the MCP server will try to launch Chrome automatically."
fi

log "Starting Google Flow Browser MCP server..."
cd "$PROJECT_DIR"
exec node src/index.js
