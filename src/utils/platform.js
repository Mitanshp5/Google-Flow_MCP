import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Cross-platform defaults for locating Chrome and its profile directory.
 * Config values (chromeExecutable / chromeUserDataDir / chromeProfile) in
 * flow.config.json always take priority over these defaults.
 */

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Best-guess path to the Chrome executable for the current OS.
 * Returns null if none of the common locations exist — in that case the
 * user MUST set "chromeExecutable" in flow.config.json.
 */
export function getDefaultChromePath() {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');

    return firstExisting([
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }

  if (platform === 'darwin') {
    return firstExisting([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]);
  }

  // Linux and other Unix-likes
  return firstExisting([
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ]);
}

/**
 * Default Chrome "User Data" directory for the current OS — the parent
 * folder that contains "Profile 1", "Profile 2", "Default", etc.
 */
export function getDefaultChromeUserDataDir() {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }

  return path.join(home, '.config', 'google-chrome');
}

/**
 * Full path to a specific Chrome profile directory
 * (e.g. ".../User Data/Profile 3" or ".../google-chrome/Profile 3").
 */
export function getChromeProfileSourcePath(profileName = 'Profile 3') {
  return path.join(getDefaultChromeUserDataDir(), profileName);
}
