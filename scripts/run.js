import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scriptName = process.argv[2];
if (!scriptName) {
  console.error('Error: Script name argument is required (e.g. node scripts/run.js start-browser).');
  process.exit(1);
}

const isWin = process.platform === 'win32';
const scriptExt = isWin ? 'ps1' : 'sh';
const scriptPath = path.join(__dirname, `${scriptName}.${scriptExt}`);

if (!fs.existsSync(scriptPath)) {
  console.error(`Error: Script file not found: ${scriptPath}`);
  process.exit(1);
}

const extraArgs = process.argv.slice(3);

let cmd;
let args;

if (isWin) {
  // Prefer pwsh (PowerShell 7) when available, fall back to Windows PowerShell.
  cmd = 'powershell';
  args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs];
  try {
    const { execSync } = await import('child_process');
    execSync('pwsh -NoProfile -Command "$PSVersionTable.PSVersion"', { stdio: 'ignore' });
    cmd = 'pwsh';
  } catch { /* keep Windows PowerShell */ }
} else {
  cmd = 'bash';
  args = [scriptPath, ...extraArgs];
}

console.log(`[runner] Executing: ${cmd} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

const child = spawn(cmd, args, {
  stdio: 'inherit'
});

// Forward signals so Ctrl+C stops the child (Chrome/MCP) cleanly.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    try { child.kill(sig); } catch { /* ignore */ }
  });
}

child.on('error', (err) => {
  console.error(`[runner] Failed to start process:`, err);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
