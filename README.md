# Google Flow Browser MCP

An MCP (Model Context Protocol) server that lets an AI agent drive
[Google Flow](https://labs.google/fx/tools/flow) (`labs.google/fx/tools/flow`)
through your own logged-in Chrome profile — generating images, videos,
characters, and scenes — without ever sharing your Google credentials with
the agent.

This guide focuses on **Windows**. The server itself is plain Node.js and
runs fine on macOS/Linux too, but the helper scripts in `scripts/` are
PowerShell (`.ps1`) and assume Windows paths by default.

---

## How it works

1. **Chrome** is launched with `--remote-debugging-port` (Chrome DevTools
   Protocol / CDP) using a real Chrome profile that's already signed in to
   your Google account.
2. The **MCP server** (`src/index.js`) connects to that Chrome instance via
   Playwright's `connectOverCDP` and drives the Google Flow web app — filling
   prompts, clicking buttons, reading results.
3. Your **AI agent** (Claude / OpenCode / any MCP client) talks to the MCP
   server over stdio and calls tools like `flow_generate_image`,
   `flow_generate_video`, `flow_create_character`, etc.

Because the agent never touches your Google password — it only sends
commands to a browser that's already logged in — there's no credential
sharing involved.

---

## Prerequisites

- **Windows 10/11**
- **[Node.js](https://nodejs.org/) 18 or later** (LTS recommended)
- **Google Chrome** installed normally (Playwright connects to your real
  Chrome via CDP — it does not need its own bundled browser for this)
- A **Google account already signed in** to a Chrome profile (e.g. "Profile
  3" — any profile works, you just need to tell the config which one)
- (Optional) **[OpenCode](https://opencode.ai)** if you want to register this
  MCP server with it

PowerShell scripts in this repo assume the default **PowerShell 5.1** that
ships with Windows (also works on PowerShell 7+).

---

## Setup

### 1. Clone and install dependencies

```powershell
git clone <this-repo-url>
cd google-flow-browser-mcp
npm install
```

`npm install` will also download Playwright's browser binaries. This project
doesn't use Playwright's bundled Chromium though — it connects to your real
installed Chrome.

### 2. Find your Chrome profile

You need a Chrome profile that's already signed in to the Google account you
want Flow to use.

1. Open Chrome and go to `chrome://version`
2. Look at **Profile Path** — it'll be something like:
   ```
   C:\Users\<you>\AppData\Local\Google\Chrome\User Data\Profile 3
   ```
3. Note two things from that path:
   - The **User Data directory**: `C:\Users\<you>\AppData\Local\Google\Chrome\User Data`
   - The **profile folder name**: `Profile 3` (could also be `Default`,
     `Profile 1`, etc.)

If you don't have a profile signed in yet, sign in to your Google account in
any Chrome profile first (`Settings → You and Google → Sign in`).

> ⚠️ **Close all running Chrome windows for that profile before using this
> tool** — Chrome locks its profile directory while running, so the MCP
> server's "direct + CDP" launch mode copies the profile into a temporary
> directory to avoid conflicts. If Chrome is running with that profile while
> you start the scripts, you may see a "profile already in use" issue.

### 3. Create your config file

Copy the example config and edit it:

```powershell
copy config\flow.config.example.json config\flow.config.json
```

Open `config\flow.config.json` and set at minimum:

```json
{
  "expectedAccount": "your-email@gmail.com",
  "chromeExecutable": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "chromeUserDataDir": "C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Google\\Chrome\\User Data",
  "chromeProfile": "Profile 3"
}
```

Notes:
- Use **double backslashes** (`\\`) in JSON paths on Windows.
- `chromeExecutable` — if omitted, the server auto-detects Chrome in the
  usual install locations (`Program Files\Google\Chrome\Application\chrome.exe`,
  `Program Files (x86)\...`, or under `%LOCALAPPDATA%`). Set it explicitly if
  Chrome is installed somewhere unusual.
- `chromeUserDataDir` / `chromeProfile` — together these point at the signed-in
  profile from step 2.
- `expectedAccount` — used by `flow_account_check` to confirm the browser is
  signed in as the right Google account.
- `flow.config.json` is gitignored — your paths and email stay local.

### 4. Start Chrome with CDP debugging

```powershell
.\scripts\start-browser.ps1
```

This launches Chrome with your configured profile and
`--remote-debugging-port=9222`. A Chrome window will open — leave it running.

If you see a Chrome window pop up and the script prints
`Chrome CDP ready on port 9222`, you're good.

> If PowerShell blocks the script with an "execution policy" error, run:
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\scripts\start-browser.ps1
> ```
> or, once per session:
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```

### 5. Start the MCP server (optional manual test)

In a **separate terminal**:

```powershell
.\scripts\start-mcp.ps1
```

This checks Node is installed, checks Chrome's CDP port is responding, and
runs `node src/index.js`. The server communicates over stdio (it's meant to
be launched by an MCP client, not used interactively) — but this confirms it
starts without errors. Press `Ctrl+C` to stop it.

### 6. Register with OpenCode (optional)

If you use OpenCode as your agent:

```powershell
.\scripts\register-opencode.ps1
```

This finds `opencode.json` (checks `%USERPROFILE%\.config\opencode\opencode.json`
and `%APPDATA%\opencode\opencode.json`), backs it up, and adds a
`google-flow-browser` entry to `mcpServers` pointing at
`node <project>\src\index.js`. **Restart OpenCode** afterwards.

If your `opencode.json` lives somewhere else, pass it explicitly:

```powershell
.\scripts\register-opencode.ps1 -ConfigPath "C:\path\to\opencode.json"
```

For **Claude Desktop** or other MCP clients, add an equivalent entry to their
MCP config manually, e.g.:

```json
{
  "mcpServers": {
    "google-flow-browser": {
      "command": "node",
      "args": ["C:\\path\\to\\google-flow-browser-mcp\\src\\index.js"]
    }
  }
}
```

### 7. Verify everything end-to-end

With Chrome running (step 4), run:

```powershell
.\scripts\test-flow-image.ps1
```

This sends a `flow_connect` tool call to the MCP server over stdio and prints
the raw response. You should see JSON output indicating the browser connected
and (if `open_flow: true`) navigated to Google Flow.

For a fuller check across multiple tools, run the Node-based end-to-end test:

```powershell
node scripts\test-e2e.mjs
```

---

## Typical workflow

1. `.\scripts\start-browser.ps1` — once per session, leave the Chrome window open
2. Your AI agent (with this MCP registered) calls:
   - `flow_connect` — attach to the running Chrome
   - `flow_account_check` — confirm the right Google account is signed in
   - `flow_generate_image` — create images in a Flow project
   - `flow_create_character` — create reusable characters
   - `flow_generate_video` — create videos, optionally referencing
     previously generated images/characters via `ingredients` (`@name`
     references)
   - `flow_list_mention_options` — see what images/characters are available
     to reference by name

The MCP server automatically creates a Google Flow **project** on first use
and reuses it for the rest of the session (tracked by project ID), so
everything ends up in one place instead of a new project per request.

---

## Available tools

| Tool | Purpose |
|---|---|
| `flow_connect` | Connect to / launch Chrome via CDP, optionally open Flow |
| `flow_disconnect` | Close the browser connection |
| `flow_status` | Report current connection/page status |
| `flow_account_check` | Verify the signed-in Google account matches `expectedAccount` |
| `flow_discover_ui` | Navigate to a Flow page and dump interactive elements (debugging) |
| `flow_generate_image` | Generate image(s) from a prompt in the current project |
| `flow_generate_video` | Generate video(s), optionally with `ingredients`/`use_character`/`use_scene` references |
| `flow_download_latest` | Download the most recently generated asset |
| `flow_create_character` | Create a new character (name + description + reference images) |
| `flow_import_character` | Import a character from a saved JSON file |
| `flow_open_characters` | Open the Characters page for a project |
| `flow_list_mention_options` | List images/characters available for `@name` references |
| `flow_create_scene` | Create a new scene, optionally referencing characters |
| `flow_open_tools_gallery` | Open Flow's Tools gallery |
| `flow_use_grid_architect` | Open the Grid Architect tool |
| `flow_use_tool` | Use an arbitrary tool from the Tools gallery |
| `flow_screenshot` | Take a debug screenshot of the current page |
| `flow_queue_status` | Check the status of queued generation jobs |

Run `flow_discover_ui` if Flow's UI changes and a tool starts failing — its
screenshot output (saved under `screenshots-debug/`) helps pinpoint what
changed.

---

## Configuration reference

All settings live in `config/flow.config.json` (copy from
`flow.config.example.json`). Key fields:

| Field | Description | Default |
|---|---|---|
| `expectedAccount` | Google account email `flow_account_check` expects | *(required)* |
| `chromeExecutable` | Full path to `chrome.exe` | auto-detected |
| `chromeUserDataDir` | Path to Chrome's "User Data" folder | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| `chromeProfile` | Profile folder name (e.g. `Profile 3`, `Default`) | `Profile 3` |
| `cdpPort` | Chrome DevTools Protocol port | `9222` |
| `flowUrl` | Base Google Flow URL | `https://labs.google/fx/tools/flow` |
| `headless` | Run Chrome headless | `true` |
| `jobTimeoutMs` | Max time to wait for a generation job | `300000` |
| `imageModels` / `videoModels` | Display name → internal model ID maps | see example config |
| `ratios` / `videoRatios` / `durations` / `quantities` | Allowed generation parameters | see example config |

---

## Troubleshooting

**"Chrome not found"**
Set `chromeExecutable` in `config/flow.config.json` to the full path of
`chrome.exe`, e.g. `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`.

**"Chrome profile not found"**
Double-check `chromeUserDataDir` + `chromeProfile` against `chrome://version`
→ Profile Path in your browser (see Setup step 2).

**"CDP port 9222 not responding"**
Run `.\scripts\start-browser.ps1` first and leave that Chrome window open
before starting the MCP server.

**PowerShell won't run the `.ps1` scripts**
Windows blocks unsigned scripts by default. Either run with:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-browser.ps1
```
or allow scripts for your current session:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

**Google sign-in / OAuth gets blocked ("This browser may not be secure")**
This is why the server connects to your *existing* signed-in Chrome profile
rather than launching a fresh automated browser — make sure you're using a
profile that's already logged in, and that `chromeUserDataDir`/`chromeProfile`
point at it correctly.

**The agent creates a new Flow project every time**
The server tracks one project per session by ID and reuses it — if this
happens, check the logs for `Session project no longer reachable` (the
project may have been deleted/renamed outside the session) and start a fresh
session.

**A tool returns `ui_discovered` / `discovery_needed` instead of doing
something**
Google Flow's UI changed and the tool's selectors no longer match. Run
`flow_discover_ui` for the relevant page and check the screenshot in
`screenshots-debug/` — this is the starting point for updating selectors.

---

## Project layout

```
config/
  flow.config.example.json   # template — copy to flow.config.json
  selectors.map.json          # auto-updated cache from flow_discover_ui
scripts/
  start-browser.ps1           # launch Chrome with CDP debugging
  start-mcp.ps1                # run the MCP server (manual check)
  register-opencode.ps1        # register this server with OpenCode
  test-flow-image.ps1           # quick flow_connect smoke test
  test-e2e.mjs                  # multi-tool Node end-to-end test
src/
  index.js                     # MCP server entry point — tool definitions
  browser/                      # Chrome/CDP connection logic
  navigation/                   # project navigation, @ mention references, rename helpers
  tools/                        # one file per MCP tool
  utils/                        # config, logging, screenshots, file output
```

---

## Safety notes

- This server only automates a browser you already control and are signed
  into — it does not store, transmit, or need your Google password.
- Image and video generation **consume Google Flow credits**. Generation
  tools default to safe "prepare only" behavior where reasonable
  (`auto_confirm: false`) — check each tool's description before relying on
  defaults.
- `config/flow.config.json` and the Chrome profile data referenced by it are
  gitignored — don't commit them.
