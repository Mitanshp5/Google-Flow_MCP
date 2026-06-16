# Google Flow Browser MCP

An MCP (Model Context Protocol) server that lets an AI agent drive
[Google Flow](https://labs.google/fx/tools/flow) (`labs.google/fx/tools/flow`)
through your own logged-in Chrome profile — generating images, videos,
characters, and scenes — without ever sharing your Google credentials with
the agent.

This server supports **Windows**, **macOS**, and **Linux** out of the box using unified npm commands that automatically dispatch platform-specific execution.

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

- **Node.js 18 or later** (LTS recommended)
- **Google Chrome** installed normally (Playwright connects to your real
  Chrome via CDP — it does not need its own bundled browser for this)
- A **Google account already signed in** to a Chrome profile (e.g. "Default" or "Profile 1" — any profile works, you just need to tell the config which one)
- (Optional) **[OpenCode](https://opencode.ai)** if you want to register this
  MCP server with it

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/Mitanshp5/Google-Flow_MCP.git
cd Google-Flow_MCP
npm install
```

`npm install` will also download Playwright's browser binaries. This project
doesn't use Playwright's bundled Chromium though — it connects to your real
installed Chrome.

### 2. Find your Chrome profile

You need a Chrome profile that's already signed in to the Google account you
want Flow to use.

1. Open Chrome and go to `chrome://version`
2. Look at **Profile Path** — note the **User Data directory** and **Profile folder name** (e.g. `Default`, `Profile 1`, `Profile 2`).

#### Default locations by platform:

*   **Windows**:
    *   *Executable*: `C:\Program Files\Google\Chrome\Application\chrome.exe` (Auto-detected)
    *   *User Data*: `C:\Users\<username>\AppData\Local\Google\Chrome\User Data`
*   **macOS**:
    *   *Executable*: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (Auto-detected)
    *   *User Data*: `/Users/<username>/Library/Application Support/Google/Chrome`
*   **Linux**:
    *   *Executable*: `/opt/google/chrome/chrome` or `/usr/bin/google-chrome` (Auto-detected)
    *   *User Data*: `/home/<username>/.config/google-chrome`

If you don't have a profile signed in yet, sign in to your Google account in
any Chrome profile first (`Settings → You and Google → Sign in`).

> ⚠️ **Close all running Chrome windows for that profile before using this
> tool** — Chrome locks its profile directory while running, so the MCP
> server's "direct + CDP" launch mode copies the profile into a temporary
> directory to avoid conflicts. If Chrome is running with that profile while
> you start the scripts, you may see a "profile already in use" issue.

### 3. Create your config file

Copy the example config and edit it:

**Windows (PowerShell):**
```powershell
copy config\flow.config.example.json config\flow.config.json
```

**macOS / Linux:**
```bash
cp config/flow.config.example.json config/flow.config.json
```

Open `config/flow.config.json` and set at minimum:

```json
{
  "expectedAccount": "your-email@gmail.com",
  "chromeProfile": "Default"
}
```

*Note: You only need to set `chromeUserDataDir` and `chromeExecutable` if Chrome is installed in a custom location, as the server will otherwise auto-detect them for your current platform.*

---

## Unified Commands

This project uses a Node.js dispatcher script under the hood, allowing you to run the same npm commands on Windows, macOS, or Linux. The runner will automatically execute the correct scripts (`.ps1` for Windows, `.sh` for Unix).

### 1. Start Chrome with CDP debugging
```bash
npm run start-browser
```
This launches Chrome with your configured profile and `--remote-debugging-port=9222`. A Chrome window will open — leave it running.

### 2. Start the MCP server (optional manual test)
In a **separate terminal**:
```bash
npm run start-mcp
```
This checks Node is installed, checks Chrome's CDP port is responding, and runs the MCP server. Press `Ctrl+C` to stop it.

### 3. Connect to AI Agents

**Claude Desktop**
Add the following to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "google-flow-browser": {
      "command": "node",
      "args": ["/absolute/path/to/google-flow-browser-mcp/src/index.js"]
    }
  }
}
```

**Cursor (Codex)**
1. Open Cursor Settings > Features > MCP.
2. Click **+ Add New MCP Server**.
3. Name: `google-flow-browser`
4. Type: `command`
5. Command: `node /absolute/path/to/google-flow-browser-mcp/src/index.js`

**Gemini CLI**
To add the server to Gemini CLI, run:
```bash
gemini mcp add google-flow-browser "node /absolute/path/to/google-flow-browser-mcp/src/index.js"
```

**OpenCode**
If you use OpenCode, you can auto-register the server:
```bash
npm run register-opencode
```
*(If your config is in a custom location, append `-- "/path/to/opencode.json"`)*

### 4. Verify everything end-to-end
With Chrome running (step 1), run:
```bash
npm run test
```
This sends a `flow_connect` tool call to the MCP server over stdio and prints the raw response.

You can also run the Node-based end-to-end test suite:
```bash
node scripts/test-e2e.mjs
```

---

## Typical workflow

1. `npm run start-browser` — once per session, leave the Chrome window open
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
   - `flow_create_scene` — create a new scene, optionally referencing characters

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

---

## Configuration reference

All settings live in `config/flow.config.json` (copy from `flow.config.example.json`). Key fields:

| Field | Description | Default |
|---|---|---|
| `expectedAccount` | Google account email `flow_account_check` expects | *(required)* |
| `chromeExecutable` | Full path to `chrome` executable | auto-detected |
| `chromeUserDataDir` | Path to Chrome's "User Data" folder | auto-detected |
| `chromeProfile` | Profile folder name (e.g. `Default`, `Profile 1`) | `Default` |
| `cdpPort` | Chrome DevTools Protocol port | `9222` |
| `flowUrl` | Base Google Flow URL | `https://labs.google/fx/tools/flow` |
| `headless` | Run Chrome headless | `true` |
| `jobTimeoutMs` | Max time to wait for a generation job | `300000` |
| `imageModels` / `videoModels` | Display name → internal model ID maps | see example config |
| `ratios` / `videoRatios` / `durations` / `quantities` | Allowed generation parameters | see example config |

---

## Troubleshooting

**"Chrome not found"**
Make sure Chrome is installed normally. If it is in a custom path, set `chromeExecutable` in `config/flow.config.json`.

**"Chrome profile not found"**
Double-check `chromeUserDataDir` + `chromeProfile` against `chrome://version` in your browser.

**"CDP port 9222 not responding"**
Run `npm run start-browser` first and leave that Chrome window open.

**Google sign-in gets blocked ("This browser may not be secure")**
This is why the server connects to your *existing* signed-in Chrome profile. Ensure `chromeUserDataDir` / `chromeProfile` points to the profile you logged in with.

**The agent creates a new Flow project every time**
The server tracks one project per session by ID and reuses it. If this happens, check the logs for `Session project no longer reachable` and start a fresh session.

---

## Project layout

```
config/
  flow.config.example.json   # template — copy to flow.config.json
  selectors.map.json         # auto-updated cache from flow_discover_ui
scripts/
  run.js                     # OS-independent command dispatcher
  start-browser.ps1 / .sh    # launch Chrome with CDP debugging
  start-mcp.ps1 / .sh        # run the MCP server (manual check)
  register-opencode.ps1 / .sh# register this server with OpenCode
  test-flow-image.ps1 / .sh  # quick flow_connect smoke test
  test-e2e.mjs               # multi-tool Node end-to-end test
src/
  index.js                   # MCP server entry point
  browser/                   # Chrome/CDP connection logic
  navigation/                # project navigation, @ mention references
  tools/                     # one file per MCP tool
  utils/                     # config, logging, screenshots, file output
```

---

## Safety notes

- This server only automates a browser you already control and are signed into — it does not store, transmit, or need your Google credentials.
- Image and video generation **consume Google Flow credits**. Generation tools default to safe "prepare only" behavior (`auto_confirm: false`).
- `config/flow.config.json` is gitignored — do not commit it.

---

## License

This project is licensed under the [MIT License](LICENSE).
