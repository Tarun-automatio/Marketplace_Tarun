#!/usr/bin/env node
/**
 * Launch the tester's Chrome with remote debugging enabled, using their
 * REAL default profile, so the Drug Tool suite can attach over CDP and run
 * inside an authenticated, Akamai-cleared session (reaching uat-pws).
 *
 * Usage:
 *   node scripts/launchChromeDebug.js [--port 9222] [--profile "<User Data dir>"]
 *
 * IMPORTANT: Close ALL existing Chrome windows first — Chrome can only
 * enable the debugging port on a profile that isn't already locked by a
 * running instance. After it opens, browse to the target site once (solve
 * any Akamai/login challenge) so the session is cleared, then run:
 *   npm run test:DrugTool:All:cdp
 */

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = argVal('--port', '9222');

function findChrome() {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

function defaultUserDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  }
  return path.join(os.homedir(), '.config/google-chrome');
}

const chrome = findChrome();
if (!chrome) {
  console.error('[launchChromeDebug] Could not find chrome.exe. Pass --profile and ensure Chrome is installed.');
  process.exit(1);
}
const profile = argVal('--profile', defaultUserDataDir());

// Warn if Chrome is already running (debugging port won't attach to a locked profile).
if (process.platform === 'win32') {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
    if (/chrome\.exe/i.test(out)) {
      console.warn('\n[launchChromeDebug] WARNING: Chrome appears to be running already.');
      console.warn('  The remote-debugging port only works on a profile that is NOT already open.');
      console.warn('  Close ALL Chrome windows, then re-run this command.\n');
    }
  } catch { /* ignore */ }
}

console.log(`[launchChromeDebug] Chrome:  ${chrome}`);
console.log(`[launchChromeDebug] Profile: ${profile}`);
console.log(`[launchChromeDebug] Port:    ${port}`);
console.log('[launchChromeDebug] Launching… In the window that opens, browse to your target site once');
console.log('                    (e.g. https://uat-pws.molinahealthcare.com/ifp/ca/drugs) to clear Akamai,');
console.log('                    then run:  npm run test:DrugTool:All:cdp\n');

const child = spawn(chrome, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
], { detached: true, stdio: 'ignore' });
child.unref();
