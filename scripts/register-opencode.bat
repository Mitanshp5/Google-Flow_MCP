@echo off
setlocal EnableDelayedExpansion

:: Register the Google Flow Browser MCP in OpenCode config
:: Makes backup before modifying
:: Requires: Node.js (used in place of jq for JSON manipulation)

set "SCRIPT_DIR=%~dp0"
:: Resolve PROJECT_DIR as parent of SCRIPT_DIR (remove trailing backslash first)
set "SCRIPT_DIR_TRIM=%SCRIPT_DIR:~0,-1%"
for %%i in ("%SCRIPT_DIR_TRIM%") do set "PROJECT_DIR=%%~dpi"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

set "OPENCODE_CONFIG=%APPDATA%\opencode\opencode.json"
set "MCP_SERVER_CMD=node %PROJECT_DIR%\src\index.js"

:: ── logging helpers ──────────────────────────────────────────────────────────

call :log "INFO" "Project dir: %PROJECT_DIR%"

:: Check for Node.js (used for JSON editing in place of jq)
where node >nul 2>&1
if !errorlevel! NEQ 0 (
    call :log "ERROR" "Node.js is required"
    exit /b 1
)

:: Check config exists
if not exist "%OPENCODE_CONFIG%" (
    call :log "ERROR" "OpenCode config not found: %OPENCODE_CONFIG%"
    exit /b 1
)

:: Backup
for /f "tokens=1-3 delims=/ " %%a in ("%DATE:~-10%") do set "_D=%%c%%a%%b"
for /f "tokens=1-3 delims=:." %%a in ("%TIME: =0%") do set "_T=%%a%%b%%c"
set "BACKUP=%OPENCODE_CONFIG%.backup-%_D%_%_T%"
copy "%OPENCODE_CONFIG%" "%BACKUP%" >nul
call :log "INFO" "Backup saved: %BACKUP%"

:: Check if already registered (using Node.js inline)
node -e "const c=require('fs').readFileSync('%OPENCODE_CONFIG:\=\\%','utf8');const j=JSON.parse(c);if(j.mcpServers&&j.mcpServers['google-flow-browser']){process.exit(0);}else{process.exit(1);}" >nul 2>&1
if !errorlevel! == 0 (
    call :log "WARN" "google-flow-browser MCP already registered. Skipping."
    exit /b 0
)

:: Add the MCP entry using Node.js inline script
set "INDEX_PATH=%PROJECT_DIR%\src\index.js"
set "INDEX_PATH_ESC=%INDEX_PATH:\=\\%"
set "CONFIG_PATH_ESC=%OPENCODE_CONFIG:\=\\%"

node -e ^
  "const fs=require('fs');" ^
  "const cfg='%CONFIG_PATH_ESC%';" ^
  "const idx='%INDEX_PATH_ESC%';" ^
  "const c=JSON.parse(fs.readFileSync(cfg,'utf8'));" ^
  "c.mcpServers=c.mcpServers||{};" ^
  "c.mcpServers['google-flow-browser']={command:'node',args:[idx],disabled:false,autoApprove:[]};" ^
  "fs.writeFileSync(cfg,JSON.stringify(c,null,2));"

if !errorlevel! NEQ 0 (
    call :log "ERROR" "Failed to update OpenCode config"
    exit /b 1
)

call :log "INFO" "google-flow-browser MCP registered in OpenCode config"
call :log "INFO" "Server command: %MCP_SERVER_CMD%"
call :log "INFO" ""
call :log "INFO" "IMPORTANT: Restart OpenCode for the changes to take effect."
exit /b 0

:: ── helpers ──────────────────────────────────────────────────────────────────
:log
set "_LEVEL=%~1"
set "_MSG=%~2"
for /f "tokens=1-2 delims=T" %%a in ("%DATE:~-10%T%TIME: =0%") do set "_TS=%%a %%b"
echo [%_TS:~0,19%] %_LEVEL%  %_MSG% 1>&2
exit /b 0
