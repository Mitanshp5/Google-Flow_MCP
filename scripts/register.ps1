<#
.SYNOPSIS
  Register the Google-Flow MCP server for various clients (OpenCode, Claude, Gemini).

.DESCRIPTION
  Adds the "Google-Flow" entry to the configuration files of selected MCP clients.
  If no flags are provided, it attempts to register with all supported clients.

.PARAMETER OpenCode
  Register with OpenCode.

.PARAMETER Gemini
  Register with Gemini CLI.
#>

param(
    [switch]$OpenCode,
    [switch]$Gemini
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

# If no flags specified, default to all
if (-not $OpenCode -and -not $Gemini) {
    $OpenCode = $true
    $Gemini   = $true
}

$successCount = 0

# --- OpenCode Registration ---
if ($OpenCode) {
    Write-Log "--- Registering for OpenCode ---"
    $candidates = @(
        (Join-Path $HOME '.config\opencode\opencode.json'),
        (Join-Path $HOME '.config\opencode\opencode.jsonc'),
        (Join-Path $env:APPDATA 'opencode\opencode.json'),
        (Join-Path $env:APPDATA 'opencode\opencode.jsonc')
    )

    $ConfigPath = $null
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $ConfigPath = $c
            break
        }
    }

    if (-not $ConfigPath) {
        Write-Warn "OpenCode config not found in standard locations. Skipping OpenCode."
    } else {
        $timestamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
        $backupPath = "$ConfigPath.backup-$timestamp"
        Copy-Item -Path $ConfigPath -Destination $backupPath -Force
        
        $jsonText = Get-Content $ConfigPath -Raw
        $json     = $jsonText | ConvertFrom-Json

        if ($null -eq $json.mcp) {
            $json | Add-Member -MemberType NoteProperty -Name 'mcp' -Value ([PSCustomObject]@{}) -Force
        }

        $existingKeys = @($json.mcp.PSObject.Properties.Name)
        if ($existingKeys -contains 'Google-Flow') {
            Write-Warn 'Google-Flow MCP already registered in OpenCode. Skipping.'
        } else {
            $entry = [PSCustomObject]@{
                type    = 'local'
                command = @('node', $ServerEntry)
                enabled = $true
            }
            $json.mcp | Add-Member -MemberType NoteProperty -Name 'Google-Flow' -Value $entry -Force
            $json | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8
            Write-Log 'Google-Flow MCP registered in OpenCode config.'
            $successCount++
        }
    }
}

# --- Gemini CLI Registration ---
if ($Gemini) {
    Write-Log "--- Registering for Gemini CLI ---"
    if (Get-Command "gemini" -ErrorAction SilentlyContinue) {
        $check = gemini mcp list 2>&1
        if ($check -match "Google-Flow") {
            Write-Warn 'Google-Flow MCP already registered in Gemini CLI. Skipping.'
        } else {
            gemini mcp add Google-Flow "node `"$ServerEntry`""
            Write-Log 'Google-Flow MCP registered in Gemini CLI.'
            $successCount++
        }
    } else {
        Write-Warn "Gemini CLI not found in PATH. Skipping Gemini."
    }
}

Write-Log ""
Write-Log "Registration script finished. Modified $successCount configurations."
Write-Log "IMPORTANT: Restart your AI client (OpenCode) for changes to take effect."
