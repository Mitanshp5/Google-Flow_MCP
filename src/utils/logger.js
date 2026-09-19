import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function findLogDir() {
  // src/utils -> ../../logs (dev); dist -> ../logs (bundled prod)
  for (const cand of [path.resolve(__dirname, '../../logs'), path.resolve(__dirname, '../logs')]) {
    try {
      const root = path.dirname(cand);
      if (fs.existsSync(path.join(root, 'package.json'))) return cand;
    } catch { /* ignore */ }
  }
  return path.resolve(__dirname, '../../logs');
}
const LOG_DIR = findLogDir();

let logStream = null;
let logDate = null;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getLogStream() {
  const today = todayStr();
  // Reopen on day rollover (fixes midnight bug where old stream is cached forever)
  if (!logStream || logDate !== today) {
    try { logStream?.end(); } catch { /* ignore */ }
    ensureLogDir();
    const logFile = path.join(LOG_DIR, `flow-${today}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.on('error', (e) => {
      process.stderr.write(`[logger] file write failed: ${e.message}\n`);
    });
    logDate = today;
  }
  return logStream;
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
  }
}

export function getLogDir() {
  return LOG_DIR;
}

export function closeLogger() {
  return new Promise((resolve) => {
    if (!logStream) return resolve();
    const s = logStream;
    logStream = null;
    logDate = null;
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
      } catch { /* ignore */ }
    }
  }
};
