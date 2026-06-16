# Anchored Summary - Google Flow Browser MCP

## Goal
A comprehensive Model Context Protocol (MCP) server for Google Flow, allowing AI agents to securely drive the Flow UI using an existing Chrome session via Playwright CDP without needing credentials.

## Core Features & Constraints
- **Security First**: Never asks for passwords, uses existing Chrome sessions, and avoids bot detection by using `navigator.webdriver=false` through direct Chrome execution followed by CDP attach.
- **Project-based Context**: All operations are routed into projects to ensure context is retained (reusing or creating new projects).
- **Cross-Platform**: Natively supports Windows, macOS, and Linux using a unified `npm run` dispatcher (`scripts/run.js`) which automatically calls the correct OS scripts (`.ps1` or `.sh`).
- **Cost-Safe Design**: Generation tools default to `auto_confirm: false` to prep UI settings without automatically consuming Google Flow credits, requiring manual confirmation for expensive video generations.
- **Supported Clients**: OpenCode, Claude Desktop, Cursor (Codex), and Gemini CLI.

## Recent Progress (Done)
- **Cross-Platform Overhaul**: 
  - Migrated hardcoded paths and scripts to support dynamic OS-aware paths for Chrome and User Data locations.
  - Implemented `run.js` to dispatch `npm run start-browser`, `npm run start-mcp`, etc., intelligently.
  - Resolved complex Windows PowerShell escaping issues (`Start-Process` string splitting on spaces) and encoding (unicode em-dash bugs).
- **Documentation & Open Source Prep**: 
  - Restructured `README.md` with explicit multi-OS instructions and agent connection guides.
  - Standardized default Chrome profile examples to `Default` instead of `Profile 3`.
  - Added MIT License to the repository.
  - Cleaned up config templates (`flow.config.example.json`) to remove sensitive emails/paths.
  - Repo successfully pushed to `Mitanshp5/Google-Flow_MCP`.

## Architecture
- `src/index.js` — Core MCP server entry point and tool schemas.
- `src/browser/` — Connection and launch logic (avoiding Playwright bot detection).
- `src/tools/` — Specific handlers for Flow UI features (image generation, video generation, etc).
- `scripts/run.js` — Universal command dispatcher that invokes `.ps1` (Windows) or `.sh` (POSIX).

## Pending / Next Steps
- Verify end-to-end multi-agent usability using the newly documented connection steps.
- Maintain and update UI DOM selectors if Google Flow's interface changes in the future.
