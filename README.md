# Google Flow Browser MCP

An MCP (Model Context Protocol) server that lets an AI agent drive
[Google Flow](https://flow.google.com/) (`flow.google.com`)
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

- **Node.js >= 20.11** (see `engines` in `package.json`; LTS recommended)
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
  "expectedAccount": null,
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

You can automatically configure OpenCode and Gemini CLI in one step:

```bash
npm run register
```
This will automatically find their configuration files and add the `Google-Flow` MCP server. 

*(You can also target specific clients: `npm run register -- --opencode` or `--gemini`)*

**Claude Desktop**
Currently, Claude Desktop requires manual configuration:
Add the following to your `claude_desktop_config.json` (run `npm run build` first — `dist/` is what ships):
```json
{
  "mcpServers": {
    "Google-Flow": {
      "command": "node",
      "args": ["/absolute/path/to/Google-Flow_MCP/dist/index.js"]
    }
  }
}
```

**Cursor (Codex)**
Currently, Cursor requires manual UI configuration:
1. Open Cursor Settings > Features > MCP.
2. Click **+ Add New MCP Server**.
3. Name: `Google-Flow`
4. Type: `command`
5. Command: `node /absolute/path/to/Google-Flow_MCP/dist/index.js`
   (run `npm run build` first; `src/index.js` works for dev only)

### 4. Verify everything end-to-end
With Chrome running (step 1), run unit tests plus a live smoke test:
```bash
npm test            # vitest unit tests (validation, queue, sanitizers)
npm run test:smoke  # flow_connect over stdio (needs Chrome running)
npm run build       # bundles src/ -> dist/ (required before register)
```

---

## Typical workflow

1. `npm run start-browser` — once per session, leave the Chrome window open (or reuse an already-open Chrome: `flow_list_browser_targets` finds its CDP port, `flow_connect` takes `cdpPort`)
2. Your AI agent (with this MCP registered) calls:
   - `flow_connect` — attach to the running Chrome (also refreshes the live model catalog)
   - `flow_account_check` — confirm the right Google account is signed in
   - `flow_list_models` — list live video/image models, ratios, durations (call once per session before generating; cache reports `stale`/`cacheAgeMs`)
   - `flow_create_project` — mint a brand-new project (never reuses/renames an existing one; pin it via `project_url`)
   - `flow_generate_image` — prepare (or with `auto_confirm:true`, generate) images in a Flow project
   - `flow_create_character` — create reusable characters (optional `archetype` starter card)
   - `flow_generate_video` — prepare (or with `confirm_generate:true`, paid-generate) videos, optionally referencing
     previously generated images/characters via `ingredients` (`@name`
     references)
   - `flow_generate_confirm` — live-click Generate for a verified `ready_for_confirmation` preparation, gated by `max_credits` (images ~0, Omni cheap, Veo ~20; never confirms `prepared_unverified`)
   - `flow_rename_character` — rename a character in its detail page (never the project title)
   - `flow_rename_image` — rename one image by exact title or media ID (never the project title)
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
| `flow_connect` | Connect to / launch Chrome via CDP, optionally open Flow (`cdpPort` reuses an already-open browser) |
| `flow_disconnect` | Close the browser connection |
| `flow_list_browser_targets` | Probe local CDP ports for a listening Chrome (no browser needed) |
| `flow_create_project` | Mint a brand-new project (never reuses/renames; pin via `project_url`) |
| `flow_list_projects` | List known projects from the local registry (no browser needed) |
| `flow_open` | Navigate the connected browser to a Flow URL without reconnecting |
| `flow_status` | Report current connection/page status |
| `flow_account_check` | Identify the signed-in Google account; enforce `expectedAccount` only if configured |
| `flow_discover_ui` | Navigate to a Flow page and dump interactive elements (debugging) |
| `flow_generate_image` | Generate image(s) from a prompt in the current project (prepare-only by default; `auto_confirm:true` spends credits) |
| `flow_generate_video` | Generate video(s), optionally with `ingredients`/`use_character`/`use_scene` references (prepare-only by default; `confirm_generate:true` spends credits) |
| `flow_generate_confirm` | Live-click Generate for a verified `ready_for_confirmation` job, gated by `max_credits` (never confirms `prepared_unverified`) |
| `flow_rename_character` | Rename a character in its detail page (never the project title) |
| `flow_rename_image` | Rename an existing image by exact `name` or `asset_id`, with `new_name` and optional project scope |
| `flow_list_models` | List video/image models, ratios, durations from Flow UI (live) or cache |
| `flow_download_latest` | Download the most recently generated asset |
| `flow_create_character` | Create a new character (name + description + optional `archetype` starter + reference images) |
| `flow_import_character` | Import a character from a saved JSON file |
| `flow_open_characters` | Open the Characters page for a project |
| `flow_list_mention_options` | List images/characters available for `@name` references |
| `flow_create_scene` | Create a new scene, optionally referencing characters |
| `flow_open_tools_gallery` | Open Flow's Tools gallery |
| `flow_use_grid_architect` | Open the Grid Architect tool |
| `flow_use_tool` | Use an arbitrary tool from the Tools gallery |
| `flow_screenshot` | Take a debug screenshot of the current page |
| `flow_queue_status` | Check the status of queued generation jobs |
| `flow_queue_reset` | Forcefully reset the job queue if a job is stuck in "running" state |

---

## Configuration reference

All settings live in `config/flow.config.json` (copy from `flow.config.example.json`). Key fields:

| Field | Description | Default |
|---|---|---|
| `expectedAccount` | Optional email restriction; `null` accepts any positively identified signed-in account | `null` |
| `chromeExecutable` | Full path to `chrome` executable (optional, auto-detected) | auto-detected |
| `chromeUserDataDir` | Path to Chrome's "User Data" folder | auto-detected per-OS |
| `chromeProfile` | Profile folder name (e.g. `Default`, `Profile 1`) | `Default` |
| `cdpPort` | Chrome DevTools Protocol port | `9222` |
| `flowUrl` | Base Google Flow URL | `https://flow.google.com/` |
| `headless` | Run Chrome headless (not recommended — Flow needs visible browser) | `false` |
| `jobTimeoutMs` | Watchdog: max time a job may stay `running` before auto-fail | `300000` |
| `jobHistoryLimit` | Bounded queue history kept in `flow_queue_status` | `50` |
| `actionDelayMs` | Delay between automated UI steps | `800` |
| `agentResponseTimeoutMs` / `generationTimeoutMs` | Agent dialog window / generation wait | `5000` / `120000` |
| `downloadWaitMs` | Wait for download to complete | `30000` |
| `imageModels` / `videoModels` | Display name → internal model ID maps (merged with live discovery) | see example config |
| `ratios` / `videoRatios` / `durations` (`4s,6s,8s,10s`) / `quantities` | Allowed generation parameters | see example config |

Env overrides win over the file: `FLOW_URL`, `FLOW_EXPECTED_ACCOUNT`, `FLOW_CHROME_PROFILE`, `FLOW_CDP_PORT`, `FLOW_HEADLESS`, `FLOW_JOB_TIMEOUT_MS`, `FLOW_CHROME_EXECUTABLE`, `FLOW_CHROME_USER_DATA_DIR`, `FLOW_HOME`.

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
  flow.config.example.json   # template — copy to flow.config.json (gitignored)
  flow.models.json           # live model catalog cache (gitignored, regenerated)
  selectors.map.json         # self-healing selector cache from flow_discover_ui (gitignored)
scripts/
  run.js                     # OS-independent dispatcher (prefers pwsh on Windows)
  start-browser.ps1 / .sh    # launch Chrome with CDP debugging
  start-mcp.ps1 / .sh / .bat # run the MCP server (manual check)
  register.ps1 / .sh         # register this server (prefers dist/, falls back to src/)
  test-flow-image.ps1 / .sh  # quick flow_connect smoke test (npm run test:smoke)
src/
  index.js                   # MCP server entry point (validated with zod, fail-closed errors)
  browser/                   # Chrome/CDP connection (non-destructive reuse, liveness)
  navigation/                # project registry, @ mention references, live model discovery
  queue/                     # single-job queue with watchdog + bounded history
  tools/                     # one file per MCP tool
  utils/                     # config, logger (stderr-only), screenshots, sanitize, validate,
                             # prompt QC, dynamic model universe, selector registry
tests/                       # vitest unit tests: sanitize, validate, job-queue,
                             # file-manager, video-quality, dynamic-catalog, prompt-bar
```

---

## Safety notes

- This server only automates a browser you already control and are signed into — it does not store, transmit, or need your Google credentials.
- Chrome is launched without the unsupported `--disable-blink-features=AutomationControlled` flag. Direct launches use a temporary copy of your configured profile; Google may still require manual sign-in or additional verification. The server does not bypass those checks.
- Video generation can consume Google Flow credits; image generations can be zero-credit. Tools default to safe "prepare only" behavior (`auto_confirm: false`; video live-generate additionally requires `confirm_generate: true`). `flow_create_character` also defaults to `false`.
- The native character image form does not expose the regular image-composer credit label. If the account owner confirms free character image pricing, configure `freeCharacterImages: {"account":"you@example.com","models":["Nano Banana 2.1"]}` in `config/flow.config.json`. Confirmation requires that exact signed-in account, native character form, prepared description and allowlisted image model. The result labels this as account-owner policy, not an observed UI quote. Video, unknown models and conflicting credit labels never inherit this policy.
- `flow_disconnect` never kills your personal Chrome tabs — it detaches unless the server launched Chrome itself.
- `flow_account_check` is fail-closed: without positive evidence it returns `verified:false, needsManualCheck:true` (never `assumed:true`).
- `config/flow.config.json` is gitignored — do not commit it. Runtime caches (`flow.models.json`, `selectors.map.json`, `flow.projects.json`) are gitignored too.

---

## License

This project is licensed under the [MIT License](LICENSE).
# Project credit budget

Live image, video and character submissions share a persistent **50-credit total budget per account/project** by default. Set `projectCreditCap` in `config/flow.config.json` to change it. Optional `max_credits` only adds a per-submission ceiling; it does not increase the project budget. Quotes are reserved before clicking Generate and remain reserved for uncertain/failed submissions to avoid accidental overspending. This ledger tracks locally authorized quotes, not Google's billing balance; earlier generations made before this feature are not automatically reconstructed. Restart the MCP after rebuilding to apply code changes.
