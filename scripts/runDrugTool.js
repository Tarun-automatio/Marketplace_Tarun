#!/usr/bin/env node
/**
 * Drug Lookup Tool test runner — sets the suite's environment variables and
 * spawns Playwright. Keeps package.json scripts cross-platform (Windows cmd
 * can't set inline `VAR=val` prefixes) without adding a cross-env dependency.
 *
 * Usage:
 *   node scripts/runDrugTool.js --lang en|es|all --device desktop|iphoneSE|ipadPro [--headed] [--state ca]
 *                               [--cdp [endpoint]]
 *
 *   --cdp [endpoint]  Attach to an already-running Chrome started with
 *                     --remote-debugging-port (default endpoint
 *                     http://127.0.0.1:9222). Runs inside your authenticated,
 *                     Akamai-cleared session so WAF-protected hosts (uat-pws)
 *                     are reachable. Start that Chrome first:
 *                       npm run drugtool:chrome
 *
 * Any extra args after a bare `--` are forwarded to the Playwright CLI.
 */

const { spawnSync } = require('child_process');
const path = require('path');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const hasFlag = (flag) => process.argv.includes(flag);

const langArg   = String(argVal('--lang', 'all')).toLowerCase();
const deviceArg = argVal('--device', 'desktop');
const stateArg  = argVal('--state', '');
const headed    = hasFlag('--headed');
const cdp       = hasFlag('--cdp');
const cdpEndpoint = cdp ? argVal('--cdp', 'http://127.0.0.1:9222') : '';

const LANG_MAP = { en: 'en', english: 'en', es: 'es', spanish: 'es', all: 'en,es', both: 'en,es' };
const languages = LANG_MAP[langArg] || 'en,es';

const env = {
  ...process.env,
  DRUG_TOOL_LANGUAGES: languages,
  DRUG_TOOL_DEVICE: deviceArg,
};
if (stateArg) env.DRUG_TOOL_STATE = stateArg;
if (cdpEndpoint) env.DRUG_TOOL_CDP_ENDPOINT = cdpEndpoint;

// Forward anything after `--` to Playwright (e.g. --workers=2).
const passthroughIdx = process.argv.indexOf('--');
const passthrough = passthroughIdx !== -1 ? process.argv.slice(passthroughIdx + 1) : [];

const pwCli = path.join('node_modules', 'playwright', 'cli.js');
const args = [pwCli, 'test', 'tests/drugTool/drugTool.spec.js', '--workers=1'];
if (headed) args.push('--headed');
args.push(...passthrough);

console.log(`[runDrugTool] languages=${languages} device=${deviceArg}`
  + `${stateArg ? ` state=${stateArg}` : ''}${headed ? ' headed' : ''}`
  + `${cdpEndpoint ? ` cdp=${cdpEndpoint}` : ''}`);

const res = spawnSync(process.execPath, args, { stdio: 'inherit', env });
process.exit(res.status == null ? 1 : res.status);
