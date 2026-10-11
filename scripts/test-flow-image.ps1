<#
.SYNOPSIS
  Honest smoke test (W07-B, F12 repair).

.DESCRIPTION
  Delegates to the initialized portable SDK client
  (scripts/smoke-client.mjs) against the shipped dist entry.
  Default tool is flow_status (no browser needed). Live flow_connect
  remains opt-in via -Tool flow_connect (needs CDP Chrome).
  Exits non-zero on any SMOKE_* failure; never prints success
  unconditionally.
#>

param(
    [string]$Tool = 'flow_status',
    [string]$ArgsJson = '{}',
    [int]$TimeoutMs = 30000,
    [string]$Server = '',
    [switch]$Help,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

function Write-Log { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] INFO  $Message" }
function Write-Err { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] ERROR $Message" -ForegroundColor Red }

if ($Help) {
    & node (Join-Path $ScriptDir 'smoke-client.mjs') --help
    Write-Host 'test-flow-image.ps1 [-Tool <name>] [-ArgsJson <json>] [-TimeoutMs <n>] [-Server <path>] [-DryRun] [-Help] (also accepts --dry-run / --help)'
    exit 0
}
foreach ($a in $args) {
    if ($a -eq '--help' -or $a -eq '-h') {
        & node (Join-Path $ScriptDir 'smoke-client.mjs') --help
        exit 0
    }
    if ($a -eq '--dry-run') { $DryRun = $true }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err 'Node.js is required but was not found in PATH.'
    exit 1
}

if (-not $Server) {
    $Server = Join-Path $ProjectDir 'dist\index.js'
}
if (-not (Test-Path $Server)) {
    Write-Err "SMOKE_SPAWN_ERROR server entry missing: $Server (run npm run build first)"
    exit 1
}
if ($DryRun) {
    Write-Log "--dry-run: would run smoke-client --server $Server --tool $Tool (nothing executed)."
    exit 0
}
if ($Tool -eq 'flow_connect') {
    Write-Log 'Live opt-in: flow_connect requires CDP Chrome (see scripts\start-browser.ps1).'
}

Write-Log "Smoke: initialized client -> $Server tool=$Tool"
& node (Join-Path $ScriptDir 'smoke-client.mjs') --server $Server --tool $Tool --args-json $ArgsJson --timeout-ms $TimeoutMs
if ($LASTEXITCODE -ne 0) {
    Write-Err "Smoke FAILED (client exit $LASTEXITCODE)."
    exit 1
}
Write-Log "Smoke passed (initialized verdict, tool=$Tool)."
