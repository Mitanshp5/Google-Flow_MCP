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

usage() {
  echo "start-mcp.sh [--dry-run] [--help]"
  echo "Safe modes: --help prints this text; --dry-run prints the resolved"
  echo "server entry and CDP port without starting the server."
}

# --- Safe modes BEFORE any side effect (no server start below) ---
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) die "Unknown argument: $arg (see --help)" ;;
  esac
done

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

# --- Resolve the server entry: shipped bundle first, src fallback for dev.
# Both --dry-run and real execution below use the resolved NODE_ENTRY, so
# the plan always reflects the real target (installed packages have no src/).
# Native-path robustness: MSYS/MinGW shells pass POSIX paths to native
# Windows node only when path conversion is enabled (MSYS_NO_PATHCONV may
# disable it); convert explicitly so the entry resolves either way.
if [[ -f "$PROJECT_DIR/dist/index.js" ]]; then
  SERVER_ENTRY="$PROJECT_DIR/dist/index.js"
else
  SERVER_ENTRY="$PROJECT_DIR/src/index.js"
fi
if command -v cygpath >/dev/null 2>&1; then
  NODE_ENTRY="$(cygpath -w "$SERVER_ENTRY")"
else
  NODE_ENTRY="$SERVER_ENTRY"
fi

log "Starting Google Flow Browser MCP server..."
if [[ $DRY_RUN -eq 1 ]]; then
  log "--dry-run: would exec node \"$NODE_ENTRY\" cdpPort='$CDP_PORT' (nothing started)."
  exit 0
fi
cd "$PROJECT_DIR"
exec node "$NODE_ENTRY"
