import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFlowHome } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function findRepoLogDir() {
  // src/utils -> ../../logs (dev); dist -> ../logs (bundled prod)
  for (const cand of [path.resolve(__dirname, '../../logs'), path.resolve(__dirname, '../logs')]) {
    try {
      const root = path.dirname(cand);
      if (fs.existsSync(path.join(root, 'package.json'))) return cand;
    } catch { /* ignore */ }
  }
  return path.resolve(__dirname, '../../logs');
}
function currentLogDir() {
  try {
    return path.join(getFlowHome(), 'logs');
  } catch {
    return findRepoLogDir();
  }
}

let logStream = null;
let logDate = null;
let logDirActive = null;

function ensureLogDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getLogStream() {
  const today = todayStr();
  const dir = currentLogDir();
  // Reopen on day rollover (fixes midnight bug where old stream is cached forever)
  if (!logStream || logDate !== today || logDirActive !== dir) {
    dropStream();
    ensureLogDir(dir);
    const logFile = path.join(dir, `flow-${today}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', (e) => {
      process.stderr.write(`[logger] file write failed: ${e.message}\n`);
      dropStream();
    });
    logDate = today;
    logDirActive = dir;
  }
  return logStream;
}

function dropStream() {
  const s = logStream;
  logStream = null;
  logDate = null;
  logDirActive = null;
  try { s?.end(); } catch { /* ignore */ }
}

function timestamp() {
  return new Date().toISOString();
}

function writeLine(line) {
  // NEVER write to stdout — StdioServerTransport uses stdout for JSON-RPC framing.
  // All logs go to stderr + log file only.
  process.stderr.write(line + '\n');
  try {
    getLogStream().write(line + '\n');
  } catch (e) {
    process.stderr.write(`[logger] stream write failed: ${e.message}\n`);
    dropStream();
  }
}

export function getLogDir() {
  return currentLogDir();
}

export function closeLogger() {
  return new Promise((resolve) => {
    if (!logStream) return resolve();
    const s = logStream;
    logStream = null;
    logDate = null;
    logDirActive = null;
    s.end(() => resolve());
  });
}

// Flush + close on exit so no log lines are lost.
process.once('exit', () => {
  try { logStream?.end(); } catch { /* ignore */ }
});

export const logger = {
  info(msg, data = {}) {
    const line = `[${timestamp()}] INFO  ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    writeLine(line);
  },

  warn(msg, data = {}) {
    const line = `[${timestamp()}] WARN  ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    writeLine(line);
  },

  error(msg, data = {}) {
    const line = `[${timestamp()}] ERROR ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    writeLine(line);
  },

  debug(msg, data = {}) {
    const line = `[${timestamp()}] DEBUG ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`;
    if (process.env.DEBUG) {
      writeLine(line);
    } else {
      try {
        getLogStream().write(line + '\n');
      } catch { dropStream(); }
    }
  }
};
