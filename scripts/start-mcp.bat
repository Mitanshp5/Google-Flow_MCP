@echo off
setlocal EnableDelayedExpansion

:: Start the Google Flow Browser MCP server
:: Requires Chrome to already be running with CDP (start-browser.bat)

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

:: ── logging helpers ──────────────────────────────────────────────────────────
call :log "INFO" "Checking Node.js..."

where node >nul 2>&1
if !errorlevel! NEQ 0 (
    call :log "ERROR" "Node.js is required but was not found in PATH"
    exit /b 1
)

:: Check CDP port
curl -s "http://localhost:9222/json/version" >nul 2>&1
if !errorlevel! NEQ 0 (
    call :log "WARN" "CDP port 9222 not responding — Chrome might not be running."
    call :log "WARN" "Run scripts\start-browser.bat first, or the MCP server will launch Chrome automatically."
)

call :log "INFO" "Starting Google Flow Browser MCP server..."
cd /d "%PROJECT_DIR%"
node src/index.js
exit /b %errorlevel%

:: ── helpers ──────────────────────────────────────────────────────────────────
:log
set "_LEVEL=%~1"
set "_MSG=%~2"
for /f "tokens=1-2 delims=T" %%a in ("%DATE:~-10%T%TIME: =0%") do set "_TS=%%a %%b"
echo [%_TS:~0,19%] %_LEVEL%  %_MSG% 1>&2
exit /b 0
