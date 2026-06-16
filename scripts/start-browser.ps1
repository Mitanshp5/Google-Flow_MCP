<#
.SYNOPSIS
  Start Chrome with a configured Google profile and CDP debugging enabled.

.DESCRIPTION
  Launches Chrome with --remote-debugging-port so the MCP server can attach
  to it via Playwright's connectOverCDP. Run this BEFORE the MCP server
  (start-mcp.ps1), or let the MCP server launch Chrome automatically.

  Edit $ChromePath / $Profile / $CdpPort below if your setup differs, or set
  the matching values in config/flow.config.json (chromeExecutable,
  chromeUserDataDir, chromeProfile, cdpPort) — this script will use those if
  flow.config.json exists.
#>

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir  = Split-Path -Parent $ScriptDir
$ConfigPath  = Join-Path $ProjectDir 'config\flow.config.json'

function Write-Log  { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] INFO  $Message" }
function Write-Warn { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] WARN  $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] ERROR $Message" -ForegroundColor Red }

# --- Defaults (overridden by config/flow.config.json if present) ---
$ChromePath = Join-Path $env:PROGRAMFILES 'Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $ChromePath)) {
    $ChromePath = Join-Path ([System.Environment]::GetFolderPath('ProgramFilesX86')) 'Google\Chrome\Application\chrome.exe'
}
if (-not (Test-Path $ChromePath)) {
    $ChromePath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
}

$UserDataDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$Profile     = 'Default'
$CdpPort     = 9222

if (Test-Path $ConfigPath) {
    try {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ($cfg.chromeExecutable)  { $ChromePath  = $cfg.chromeExecutable }
        if ($cfg.chromeUserDataDir) { $UserDataDir = $cfg.chromeUserDataDir }
        if ($cfg.chromeProfile)     { $Profile     = $cfg.chromeProfile }
        if ($cfg.cdpPort)           { $CdpPort     = $cfg.cdpPort }
    } catch {
        Write-Warn "Could not parse $ConfigPath - using defaults. ($($_.Exception.Message))"
    }
}

if (-not (Test-Path $ChromePath)) {
    Write-Err "Chrome not found at: $ChromePath"
    Write-Err 'Install Google Chrome, or set "chromeExecutable" in config/flow.config.json to its full path.'
    exit 1
}

# --- Check if CDP port is already in use ---
$portInUse = $false
try {
    $tcp = Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction SilentlyContinue
    if ($tcp) { $portInUse = $true }
} catch { }

if ($portInUse) {
    Write-Warn "CDP port $CdpPort already in use - checking if it's responding to CDP..."
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) {
            Write-Log "Chrome already running on CDP port $CdpPort"
            exit 0
        }
    } catch {
        Write-Warn "Port $CdpPort is occupied but not responding to CDP."
        Write-Warn 'Close the process using that port, or change "cdpPort" in config/flow.config.json.'
        exit 1
    }
}

Write-Log "Launching Chrome with profile `"$Profile`" on CDP port $CdpPort"
Write-Log "Chrome path: $ChromePath"
Write-Log "User data dir: $UserDataDir"

$chromeArgs = @(
    "--user-data-dir=`"$UserDataDir`"",
    "--profile-directory=`"$Profile`"",
    "--remote-debugging-port=$CdpPort",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=ChromeWhatsNewUI',
    '--disable-background-networking',
    '--disable-component-update'
)

Start-Process -FilePath $ChromePath -ArgumentList $chromeArgs

Write-Log 'Chrome launched. Waiting for CDP to become ready...'

$ready = $false
for ($i = 1; $i -le 15; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}

if ($ready) {
    Write-Log "Chrome CDP ready on port $CdpPort"
    exit 0
} else {
    Write-Err "Chrome did not start CDP on port $CdpPort within 15 seconds"
    exit 1
}
