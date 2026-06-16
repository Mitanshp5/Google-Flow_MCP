<#
.SYNOPSIS
  Register the Google-Flow MCP server in OpenCode's config.

.DESCRIPTION
  Adds a "Google-Flow" entry to OpenCode's mcp config so it can call this
  MCP server. Makes a timestamped backup of the config file before modifying
  it. Safe to re-run - skips if already registered.

.PARAMETER ConfigPath
  Path to opencode.json / opencode.jsonc. Auto-detected from standard locations.
#>

param(
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir  = Split-Path -Parent $ScriptDir
$ServerEntry = Join-Path $ProjectDir 'src\index.js'

function Write-Log {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] INFO  $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] WARN  $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] ERROR $Message" -ForegroundColor Red
}

if (-not $ConfigPath) {
    $candidates = @(
        (Join-Path $HOME '.config\opencode\opencode.json'),
        (Join-Path $HOME '.config\opencode\opencode.jsonc'),
        (Join-Path $env:APPDATA 'opencode\opencode.json'),
        (Join-Path $env:APPDATA 'opencode\opencode.jsonc')
    )

    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $ConfigPath = $c
            break
        }
    }

    if (-not $ConfigPath) {
        Write-Err "OpenCode config not found in standard locations."
        Write-Err 'Pass the correct path explicitly: .\register-opencode.ps1 -ConfigPath "C:\path\to\opencode.json"'
        exit 1
    }
}

if (-not (Test-Path $ConfigPath)) {
    Write-Err "OpenCode config not found: $ConfigPath"
    exit 1
}

# --- Backup ---
$timestamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupPath = "$ConfigPath.backup-$timestamp"
Copy-Item -Path $ConfigPath -Destination $backupPath -Force
Write-Log "Backup saved: $backupPath"

# --- Load and update JSON ---
$jsonText = Get-Content $ConfigPath -Raw
$json     = $jsonText | ConvertFrom-Json

# Ensure the 'mcp' key exists
if ($null -eq $json.mcp) {
    $json | Add-Member -MemberType NoteProperty -Name 'mcp' -Value ([PSCustomObject]@{}) -Force
}

# Check if already registered (use Names array to avoid PSObject method errors)
$existingKeys = @($json.mcp.PSObject.Properties.Name)
if ($existingKeys -contains 'Google-Flow') {
    Write-Warn 'Google-Flow MCP already registered. Skipping.'
    exit 0
}

# Build entry
$entry = [PSCustomObject]@{
    type    = 'local'
    command = @('node', $ServerEntry)
    enabled = $true
}

$json.mcp | Add-Member -MemberType NoteProperty -Name 'Google-Flow' -Value $entry -Force

# --- Save ---
$json | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Log 'Google-Flow MCP registered in OpenCode config'
Write-Log "Server command: node $ServerEntry"
Write-Log ''
Write-Log 'IMPORTANT: Restart OpenCode for the changes to take effect.'
