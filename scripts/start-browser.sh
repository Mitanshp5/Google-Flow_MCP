#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Start Chrome with configured Google profile and CDP debugging
# Runs cross-platform on macOS and Linux. Reads settings from config/flow.config.json if present.

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
warn() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] WARN  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

usage() {
  echo "start-browser.sh [--dry-run] [--help]"
  echo "Safe modes: --help prints this text; --dry-run prints the resolved"
  echo "Chrome path, profile and CDP port without launching anything."
}

# --- Safe modes BEFORE any side effect (no port kill, no launch below) ---
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) die "Unknown argument: $arg (see --help)" ;;
  esac
done

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
  # Use node to parse JSON to avoid external jq dependency. Convert to a
  # native path first: a Windows-native node cannot open MSYS POSIX paths
  # (same class as the start-mcp.sh server-entry fix).
  if command -v cygpath >/dev/null 2>&1; then
    CONFIG_PATH_NODE="$(cygpath -w "$CONFIG_PATH")"
  else
    CONFIG_PATH_NODE="$CONFIG_PATH"
  fi
  eval "$(node -e "
  const fs = require('fs');
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    if (cfg.chromeExecutable || cfg.chromePath) console.log('CHROME=\"' + (cfg.chromeExecutable || cfg.chromePath) + '\"');
    if (cfg.chromeUserDataDir) console.log('USER_DATA_DIR=\"' + cfg.chromeUserDataDir + '\"');
    if (cfg.chromeProfile) console.log('PROFILE=\"' + cfg.chromeProfile + '\"');
    if (cfg.cdpPort) console.log('CDP_PORT=\"' + cfg.cdpPort + '\"');
  } catch(e) {}
  " "$CONFIG_PATH_NODE")"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  if [[ -z "$CHROME" ]]; then
    log "--dry-run: Chrome executable unresolved on this machine (no default found, config override unreadable); would launch profile='$PROFILE' cdpPort='$CDP_PORT' (nothing launched)."
  else
    log "--dry-run: would launch '$CHROME' profile='$PROFILE' cdpPort='$CDP_PORT' userDataDir='$USER_DATA_DIR' (nothing launched)."
  fi
  exit 0
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
    # PORT_BLOCKED: the port is held by something that is not our CDP
    # endpoint. Never kill the occupant: it may be an unrelated user
    # process, and this launcher has no ownership evidence. Stop here with
    # an explicit blocker instead of `kill -9` + blind relaunch.
    die "PORT_BLOCKED port $CDP_PORT is occupied but not responding to CDP. Close the occupying process or set another cdpPort in config/flow.config.json; refusing to kill it."
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
  --disable-component-update \
  --disable-sync-preferences \
  &
# NOTE: do NOT add --disable-background-networking — it prevents the DevTools
# server from starting, so :9222/json/version never responds.

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
