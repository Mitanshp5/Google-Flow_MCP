#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Start Chrome with configured Google profile and CDP debugging
# Runs cross-platform on macOS and Linux. Reads settings from config/flow.config.json if present.

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

# --- OS Detection and Defaults ---
OS_TYPE=$(uname -s)
CHROME=""
USER_DATA_DIR=""

if [[ "$OS_TYPE" == "Darwin" ]]; then
  # macOS defaults
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [[ -f "$candidate" ]]; then
      CHROME="$candidate"
      break
    fi
  done
  USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome"
else
  # Linux/Unix defaults
  for candidate in \
    "/opt/google/chrome/chrome" \
    "/usr/bin/google-chrome" \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/chromium-browser" \
    "/usr/bin/chromium" \
    "/snap/bin/chromium"; do
    if [[ -f "$candidate" ]]; then
      CHROME="$candidate"
      break
    fi
  done
  USER_DATA_DIR="$HOME/.config/google-chrome"
fi

PROFILE="Default"
CDP_PORT=9222

# --- Config Override ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="$PROJECT_DIR/config/flow.config.json"

if [[ -f "$CONFIG_PATH" ]]; then
  log "Found config file at $CONFIG_PATH, reading overrides..."
  # Use node to parse JSON to avoid external jq dependency
  eval "$(node -e "
  const fs = require('fs');
  try {
    const cfg = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
    if (cfg.chromeExecutable || cfg.chromePath) console.log('CHROME=\"' + (cfg.chromeExecutable || cfg.chromePath) + '\"');
    if (cfg.chromeUserDataDir) console.log('USER_DATA_DIR=\"' + cfg.chromeUserDataDir + '\"');
    if (cfg.chromeProfile) console.log('PROFILE=\"' + cfg.chromeProfile + '\"');
    if (cfg.cdpPort) console.log('CDP_PORT=\"' + cfg.cdpPort + '\"');
  } catch(e) {}
  ")"
fi

if [[ -z "$CHROME" ]]; then
  die "Google Chrome executable not found. Please set 'chromeExecutable' in config/flow.config.json or install Google Chrome."
fi

if [[ ! -f "$CHROME" ]]; then
  die "Chrome not found at $CHROME. Please check your path or set 'chromeExecutable' in config/flow.config.json."
fi

# --- Check if CDP port is already in use ---
if lsof -i :$CDP_PORT >/dev/null 2>&1; then
  warn "CDP port $CDP_PORT already in use — checking if it's our Chrome..."
  CURL_RESULT=$(curl -s http://localhost:$CDP_PORT/json/version 2>/dev/null || echo "")
  if [[ -n "$CURL_RESULT" ]]; then
    log "Chrome already running on CDP port $CDP_PORT"
    exit 0
  else
    warn "Port $CDP_PORT is occupied but not responding to CDP. Attempting to kill..."
    lsof -ti :$CDP_PORT | xargs kill -9 2>/dev/null || true
    sleep 2
  fi
fi

log "Launching Chrome on CDP port $CDP_PORT"
log "Chrome path: $CHROME"
log "User data dir: $USER_DATA_DIR"
log "Profile: $PROFILE"

"$CHROME" \
  --user-data-dir="$USER_DATA_DIR" \
  --profile-directory="$PROFILE" \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --disable-sync \
  --disable-features=ChromeWhatsNewUI \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync-preferences \
  &

CHROME_PID=$!
log "Chrome launched (PID: $CHROME_PID)"

for i in $(seq 1 15); do
  if curl -s http://localhost:$CDP_PORT/json/version >/dev/null 2>&1; then
    log "Chrome CDP ready on port $CDP_PORT"
    exit 0
  fi
  sleep 1
done

die "Chrome did not start CDP on port $CDP_PORT within 15 seconds"
