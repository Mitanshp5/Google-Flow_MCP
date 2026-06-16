#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Register the Google-Flow MCP server for various clients (OpenCode, Gemini)
# Makes backup before modifying JSON files.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ENTRY="$PROJECT_DIR/src/index.js"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required but was not found in PATH."

# --- Parse Arguments ---
OPT_OPENCODE=0
OPT_GEMINI=0

if [[ $# -eq 0 ]]; then
  OPT_OPENCODE=1
  OPT_GEMINI=1
else
  for arg in "$@"; do
    case "$arg" in
      --opencode) OPT_OPENCODE=1 ;;
      --gemini)   OPT_GEMINI=1 ;;
      *) warn "Unknown argument: $arg" ;;
    esac
  done
fi

SUCCESS_COUNT=0

# --- OpenCode Registration ---
if [[ $OPT_OPENCODE -eq 1 ]]; then
  log "--- Registering for OpenCode ---"
  CONFIG_PATH=""
  CANDIDATES=(
    "$HOME/.config/opencode/opencode.json"
    "$HOME/.config/opencode/opencode.jsonc"
    "$HOME/Library/Application Support/OpenCode/opencode.json"
    "$HOME/Library/Application Support/OpenCode/opencode.jsonc"
  )

  for c in "${CANDIDATES[@]}"; do
    if [[ -f "$c" ]]; then
      CONFIG_PATH="$c"
      break
    fi
  done

  if [[ -z "$CONFIG_PATH" ]]; then
    warn "OpenCode config not found in standard locations. Skipping OpenCode."
  else
    BACKUP="${CONFIG_PATH}.backup-$(date +%Y%m%d_%H%M%S)"
    cp "$CONFIG_PATH" "$BACKUP"
    
    RESULT=$(node -e "
    const fs = require('fs');
    try {
      const data = fs.readFileSync('$CONFIG_PATH', 'utf8');
      const json = JSON.parse(data);
      if (!json.mcp) json.mcp = {};
      if (json.mcp['Google-Flow']) {
        console.log('ALREADY_REGISTERED');
        process.exit(0);
      }
      json.mcp['Google-Flow'] = {
        type: 'local',
        command: ['node', '$SERVER_ENTRY'],
        enabled: true
      };
      fs.writeFileSync('$CONFIG_PATH', JSON.stringify(json, null, 2), 'utf8');
      console.log('SUCCESS');
    } catch(e) {
      console.error(e.message);
      process.exit(1);
    }
    " 2>/dev/null || echo "FAILED")

    if [[ "$RESULT" == "ALREADY_REGISTERED" ]]; then
      warn "Google-Flow MCP already registered in OpenCode. Skipping."
    elif [[ "$RESULT" == "SUCCESS" ]]; then
      log "Google-Flow MCP registered in OpenCode config."
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
      warn "Failed to update OpenCode config at $CONFIG_PATH."
    fi
  fi
fi

# --- Gemini CLI Registration ---
if [[ $OPT_GEMINI -eq 1 ]]; then
  log "--- Registering for Gemini CLI ---"
  if command -v gemini >/dev/null 2>&1; then
    if gemini mcp list 2>&1 | grep -q "Google-Flow"; then
      warn "Google-Flow MCP already registered in Gemini CLI. Skipping."
    else
      gemini mcp add Google-Flow "node '$SERVER_ENTRY'" >/dev/null 2>&1
      log "Google-Flow MCP registered in Gemini CLI."
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    fi
  else
    warn "Gemini CLI not found in PATH. Skipping Gemini."
  fi
fi

log ""
log "Registration script finished. Modified $SUCCESS_COUNT configurations."
log "IMPORTANT: Restart your AI client (OpenCode) for changes to take effect."
