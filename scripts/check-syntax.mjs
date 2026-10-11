#!/usr/bin/env node
// W07 syntax gate: syntax-check every owned JS source with `node --check`.
// This is SYNTAX-ONLY (parse check). It is not typechecking, inference, or
// API verification, and must never be described as such.
// Usage: node scripts/check-syntax.mjs [dir...] [--help]
// Default dirs (resolved from the caller CWD): src scripts.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const JS_EXTENSIONS = new Set(['.js', '.mjs']);

export function collectJsFiles(rootDir) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile() && JS_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(full);
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

export function checkSyntax(dirs) {
  const files = [];
  for (const dir of dirs) files.push(...collectJsFiles(dir));
  const failures = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      failures.push(file);
    }
  }
  return { ok: failures.length === 0, checked: files.length, failures };
}

function printHelp() {
  console.log(`check-syntax.mjs: syntax-check owned JS sources (node --check).
Usage: node scripts/check-syntax.mjs [dir...] [--help]
Default dirs: src scripts (resolved from the caller CWD).
Exit 0 iff every discovered **/*.js|*.mjs file parses. Syntax-only: not a type gate.`);
}

import { fileURLToPath } from 'url';

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targetDirs = args.length > 0 ? args : ['src', 'scripts'];
  const res = checkSyntax(targetDirs);
  if (!res.ok) {
    console.error(`Syntax check failed for ${res.failures.length} files:`);
    for (const f of res.failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log(`Syntax check passed for ${res.checked} files.`);
  process.exit(0);
}
