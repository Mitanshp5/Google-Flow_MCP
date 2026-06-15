<#
.SYNOPSIS
  Register the Google Flow Browser MCP server in OpenCode's config.

.DESCRIPTION
  Adds a "google-flow-browser" entry to OpenCode's mcpServers config so it
  can call this MCP server. Makes a timestamped backup of the config file
  before modifying it. Safe to re-run — skips if already registered.

.PARAMETER ConfigPath
  Path to opencode.json. Defaults to "$HOME\.config\opencode\opencode.json"
  (OpenCode uses this path on Windows too), falling back to
  "$env:APPDATA\opencode\opencode.json" if the first doesn't exist.
#>

param(
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerEntry = Join-Path $ProjectDir 'src\index.js'

function Write-Log  { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] INFO  $Message" }
function Write-Warn { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] WARN  $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] ERROR $Message" -ForegroundColor Red }

if (-not $ConfigPath) {
    $candidate1 = Join-Path $HOME '.config\opencode\opencode.json'
    $candidate2 = Join-Path $env:APPDATA 'opencode\opencode.json'

    if (Test-Path $candidate1) {
        $ConfigPath = $candidate1
    } elseif (Test-Path $candidate2) {
        $ConfigPath = $candidate2
    } else {
        Write-Err "OpenCode config not found at:`n  $candidate1`n  $candidate2"
        Write-Err 'Pass the correct path explicitly: .\register-opencode.ps1 -ConfigPath "C:\path\to\opencode.json"'
        exit 1
    }
}

if (-not (Test-Path $ConfigPath)) {
    Write-Err "OpenCode config not found: $ConfigPath"
    exit 1
}

# --- Backup ---
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupPath = "$ConfigPath.backup-$timestamp"
Copy-Item -Path $ConfigPath -Destination $backupPath -Force
Write-Log "Backup saved: $backupPath"

# --- Load and update JSON ---
$json = Get-Content $ConfigPath -Raw | ConvertFrom-Json

if (-not $json.mcpServers) {
    $json | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value (New-Object PSObject) -Force
}

if ($json.mcpServers.PSObject.Properties['google-flow-browser']) {
    Write-Warn 'google-flow-browser MCP already registered. Skipping.'
    exit 0
}

$entry = [PSCustomObject]@{
    command     = 'node'
    args        = @($ServerEntry)
    disabled    = $false
    autoApprove = @()
}

$json.mcpServers | Add-Member -MemberType NoteProperty -Name 'google-flow-browser' -Value $entry

# --- Save (pretty-printed, sufficient depth for nested objects) ---
$json | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Log 'google-flow-browser MCP registered in OpenCode config'
Write-Log "Server command: node $ServerEntry"
Write-Log ''
Write-Log 'IMPORTANT: Restart OpenCode for the changes to take effect.'
