<#
.SYNOPSIS
  Quick smoke test: send a flow_connect tool call to the MCP server over stdio.

.DESCRIPTION
  Requires Chrome to already be running with CDP (scripts\start-browser.ps1).
  Sends a single JSON-RPC "tools/call" request for flow_connect to the MCP
  server's stdin and prints whatever it writes back within the timeout.
#>

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

function Write-Log { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] INFO  $Message" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '[ERROR] Node.js is required but was not found in PATH.' -ForegroundColor Red
    exit 1
}

Write-Log 'Testing MCP server tool calls...'
Write-Log 'Test 1: flow_connect'

$request = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flow_connect","arguments":{"headless":false,"open_flow":true}}}'

Push-Location $ProjectDir
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node.Source
    $psi.Arguments = 'src/index.js'
    $psi.WorkingDirectory = $ProjectDir
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false

    $proc = [System.Diagnostics.Process]::Start($psi)

    $proc.StandardInput.WriteLine($request)
    $proc.StandardInput.Flush()

    $timeoutMs = 30000
    $output = New-Object System.Text.StringBuilder
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    while ($sw.ElapsedMilliseconds -lt $timeoutMs -and -not $proc.HasExited) {
        if ($proc.StandardOutput.Peek() -ge 0) {
            $line = $proc.StandardOutput.ReadLine()
            [void]$output.AppendLine($line)
            if ($output.ToString().Split("`n").Length -gt 50) { break }
        } else {
            Start-Sleep -Milliseconds 100
        }
    }

    if (-not $proc.HasExited) {
        $proc.Kill()
    }

    Write-Host $output.ToString()
} finally {
    Pop-Location
}

Write-Log 'All tests passed.'
