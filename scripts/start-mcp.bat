@echo off
setlocal EnableDelayedExpansion

:: Start the Google Flow Browser MCP server
:: Requires Chrome to already be running with CDP (start-browser.bat)

set "SCRIPT_DIR=%~dp0"
:: Canonicalize (%%~fI) so the entry has no `scripts\..` segment even when
:: the package path contains spaces.
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_DIR=%%~fI"

:: ── resolve the server entry: shipped bundle first, src fallback for dev ──
:: Both --dry-run and real execution below use this SAME variable, so the
:: plan always reflects the real target (installed packages have no src/).
if exist "%PROJECT_DIR%\dist\index.js" (
    set "SERVER_ENTRY=%PROJECT_DIR%\dist\index.js"
) else (
    set "SERVER_ENTRY=%PROJECT_DIR%\src\index.js"
)

:: ── safe modes BEFORE any side effect (no server start below) ─────────────
if "%~1"=="--help" goto :help
if "%~1"=="-h" goto :help
if "%~1"=="--dry-run" (
    call :log "INFO" "--dry-run: would run node '%SERVER_ENTRY%' cdpPort=9222 (nothing started)."
    exit /b 0
)
goto :main
:help
call :log "INFO" "start-mcp.bat [--dry-run] [--help] — safe modes print this text or the planned server entry without starting anything."
exit /b 0
:main

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
node "%SERVER_ENTRY%"
exit /b %errorlevel%

:: ── helpers ──────────────────────────────────────────────────────────────────
:log
set "_LEVEL=%~1"
set "_MSG=%~2"
for /f "tokens=1-2 delims=T" %%a in ("%DATE:~-10%T%TIME: =0%") do set "_TS=%%a %%b"
echo [%_TS:~0,19%] %_LEVEL%  %_MSG% 1>&2
exit /b 0
