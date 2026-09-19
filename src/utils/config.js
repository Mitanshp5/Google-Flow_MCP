import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot() {
  // Works both from src/utils/* (dev) and bundled dist/index.js (prod):
  // - src/utils -> ../../ = root
  // - dist      -> ../     = root
  // Pick the first candidate containing package.json + config/.
  const candidates = [
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'config'))) {
        return c;
      }
    } catch { /* ignore */ }
  }
  return candidates[0];
}

const REPO_ROOT = findRepoRoot();

const configPath = path.join(REPO_ROOT, 'config', 'flow.config.json');
let config;

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    // stderr only — never stdout (breaks MCP stdio framing)
    process.stderr.write(`[CONFIG] Failed to load config from ${configPath}: ${err.message}\n`);
    return {};
  }
}

config = loadConfig();

export function reloadConfig() {
  config = loadConfig();
  return config;
}

export default config;

const ENV_MAP = {
  FLOW_HOME: 'flowHome',
  FLOW_URL: 'flowUrl',
  FLOW_EXPECTED_ACCOUNT: 'expectedAccount',
  FLOW_CHROME_EXECUTABLE: 'chromeExecutable',
  FLOW_CHROME_USER_DATA_DIR: 'chromeUserDataDir',
  FLOW_CHROME_PROFILE: 'chromeProfile',
  FLOW_CDP_PORT: 'cdpPort',
  FLOW_HEADLESS: 'headless',
  FLOW_JOB_TIMEOUT_MS: 'jobTimeoutMs',
};

function coerce(key, value) {
  if (value === undefined) return undefined;
  if (['cdpPort', 'jobTimeoutMs', 'actionDelayMs', 'generationPollIntervalMs', 'maxPollAttempts', 'downloadWaitMs', 'agentResponseTimeoutMs', 'generationTimeoutMs'].includes(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (['headless'].includes(key)) {
    if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
    return Boolean(value);
  }
  return value;
}

export function get(key, fallback = undefined) {
  // Env overrides win (FLOW_*), then config file, then fallback.
  for (const [env, cfgKey] of Object.entries(ENV_MAP)) {
    if (cfgKey === key && process.env[env] !== undefined) {
      const v = coerce(key, process.env[env]);
      if (v !== undefined) return v;
    }
  }
  const v = config[key];
  return v !== undefined ? v : fallback;
}

export function getFlowHome() {
  const raw = get('flowHome', REPO_ROOT);
  // Resolve relative to repo root (not process.cwd(), which is the MCP host dir
  // and non-deterministic). Absolute paths pass through.
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

export function getRepoRoot() {
  return REPO_ROOT;
}
