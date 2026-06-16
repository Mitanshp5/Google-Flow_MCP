<#
.SYNOPSIS
  Start the Google Flow Browser MCP server.

.DESCRIPTION
  Checks that Node.js is available and that Chrome's CDP debug port is
  responding (started via start-browser.ps1), then runs the MCP server.
  If Chrome isn't running yet, the server will attempt to launch it itself.
#>

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ConfigPath = Join-Path $ProjectDir 'config\flow.config.json'

function Write-Log  { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] INFO  $Message" }
function Write-Warn { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] WARN  $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] ERROR $Message" -ForegroundColor Red }

# --- Check Node.js ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err 'Node.js is required but was not found in PATH.'
    Write-Err 'Install it from https://nodejs.org/ (LTS version) and restart your terminal.'
    exit 1
}
Write-Log "Using Node.js: $($node.Source) ($(& node --version))"

# --- Check CDP port ---
$CdpPort = 9222
if (Test-Path $ConfigPath) {
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($cfg.cdpPort) { $CdpPort = $cfg.cdpPort }
    } catch { }
}

try {
    Invoke-WebRequest -Uri "http://localhost:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch {
    Write-Warn "CDP port $CdpPort not responding - Chrome might not be running."
    Write-Warn 'Run scripts\start-browser.ps1 first, or the MCP server will try to launch Chrome automatically.'
}

Write-Log 'Starting Google Flow Browser MCP server...'
Set-Location $ProjectDir
& node src/index.js
exit $LASTEXITCODE
