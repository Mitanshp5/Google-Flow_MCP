#!/usr/bin/env bash
# W07-B: honest smoke test. Delegates to the initialized portable SDK client
# (scripts/smoke-client.mjs) against the shipped dist entry.
# Default tool is flow_status (no browser needed). Live flow_connect remains
# opt-in: ./scripts/test-flow-image.sh --tool flow_connect (needs CDP Chrome).
# Exits non-zero on any SMOKE_* failure; never prints success unconditionally.
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] INFO  $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] ERROR $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required but was not found in PATH."

# Portable node script path: git-bash/MSYS on Windows reports POSIX paths
# (/c/...) that a Windows node build cannot open; convert when possible.
to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
SMOKE_CLIENT="$(to_node_path "$SCRIPT_DIR/smoke-client.mjs")"

TOOL="flow_status"
ARGS_JSON="{}"
TIMEOUT_MS="30000"
SERVER="$PROJECT_DIR/dist/index.js"

WANT_DRY_RUN=0
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && WANT_DRY_RUN=1
done

for arg in "$@"; do
  case "$arg" in
    --help|-h) node "$SMOKE_CLIENT" --help; exit 0 ;;
    --dry-run) ;; # handled after full parse so the plan shows final values
    --tool=*) TOOL="${arg#--tool=}" ;;
    --args-json=*) ARGS_JSON="${arg#--args-json=}" ;;
    --timeout-ms=*) TIMEOUT_MS="${arg#--timeout-ms=}" ;;
    --server=*) SERVER="${arg#--server=}" ;;
    *) die "Unknown argument: $arg (see --help)" ;;
  esac
done

if [[ $WANT_DRY_RUN -eq 1 ]]; then
  log "--dry-run: would run smoke-client --server $SERVER --tool $TOOL (nothing executed)."
  exit 0
fi

[[ -f "$SERVER" ]] || die "SMOKE_SPAWN_ERROR server entry missing: $SERVER (run npm run build first)"
[[ "$TOOL" == "flow_connect" ]] && log "Live opt-in: flow_connect requires CDP Chrome (see scripts/start-browser.sh)."

log "Smoke: initialized client -> $SERVER tool=$TOOL"
node "$SMOKE_CLIENT" --server "$(to_node_path "$SERVER")" --tool "$TOOL" --args-json "$ARGS_JSON" --timeout-ms "$TIMEOUT_MS"
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  die "Smoke FAILED (client exit $STATUS)."
fi
log "Smoke passed (initialized verdict, tool=$TOOL)."
