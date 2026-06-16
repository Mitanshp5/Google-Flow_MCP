#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Register the Google Flow Browser MCP in OpenCode config
# Makes backup before modifying

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ENTRY="$PROJECT_DIR/src/index.js"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required but was not found in PATH."

# --- Detect OpenCode Config Location ---
CONFIG_PATH=""
CANDIDATE1="$HOME/.config/opencode/opencode.json"
CANDIDATE2="$HOME/Library/Application Support/OpenCode/opencode.json"

if [[ -f "$CANDIDATE1" ]]; then
  CONFIG_PATH="$CANDIDATE1"
elif [[ -f "$CANDIDATE2" ]]; then
  CONFIG_PATH="$CANDIDATE2"
else
  # Check if path is overridden via argument
  if [[ $# -ge 1 && -n "$1" ]]; then
    CONFIG_PATH="$1"
  else
    die "OpenCode config not found at:
  $CANDIDATE1
  $CANDIDATE2
Please pass the correct path as an argument, e.g. scripts/register-opencode.sh /path/to/opencode.json"
  fi
fi

# Allow command line argument override if the candidate existed but argument was passed anyway
if [[ $# -ge 1 && -n "$1" ]]; then
  CONFIG_PATH="$1"
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  die "OpenCode config not found: $CONFIG_PATH"
fi

BACKUP="${CONFIG_PATH}.backup-$(date +%Y%m%d_%H%M%S)"
cp "$CONFIG_PATH" "$BACKUP"
log "Backup saved: $BACKUP"

# --- Update config using Node ---
RESULT=$(node -e "
const fs = require('fs');
try {
  const data = fs.readFileSync('$CONFIG_PATH', 'utf8');
  const json = JSON.parse(data);
  if (!json.mcpServers) json.mcpServers = {};
  if (json.mcpServers['google-flow-browser']) {
    console.log('ALREADY_REGISTERED');
    process.exit(0);
  }
  json.mcpServers['google-flow-browser'] = {
    command: 'node',
    args: ['$SERVER_ENTRY'],
    disabled: false,
    autoApprove: []
  };
  fs.writeFileSync('$CONFIG_PATH', JSON.stringify(json, null, 2), 'utf8');
  console.log('SUCCESS');
} catch(e) {
  console.error(e.message);
  process.exit(1);
}
" 2>/dev/null || echo "FAILED")

if [[ "$RESULT" == "ALREADY_REGISTERED" ]]; then
  warn "google-flow-browser MCP already registered. Skipping."
  exit 0
elif [[ "$RESULT" == "SUCCESS" ]]; then
  log "google-flow-browser MCP registered in OpenCode config"
  log "Server command: node $SERVER_ENTRY"
  log ""
  log "IMPORTANT: Restart OpenCode for the changes to take effect."
else
  die "Failed to update OpenCode config at $CONFIG_PATH."
fi
