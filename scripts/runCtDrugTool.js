#!/usr/bin/env node
/**
 * ConnectiCare CT Drug Lookup Tool runner — sets the suite's environment
 * variables and spawns Playwright. Keeps package.json scripts cross-platform
 * (Windows cmd can't set inline `VAR=val` prefixes) without a cross-env dep.
 *
 * Usage:
 *   node scripts/runCtDrugTool.js --lang en|es|all --device desktop|iphoneSE|ipadPro [--headed]
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

const langArg   = String(argVal('--lang', 'en')).toLowerCase();
const deviceArg = argVal('--device', 'desktop');
const headed    = hasFlag('--headed');

const LANG_MAP = { en: 'en', english: 'en', es: 'es', spanish: 'es', all: 'en,es', both: 'en,es' };
const languages = LANG_MAP[langArg] || 'en';

const env = {
  ...process.env,
  CT_DRUG_TOOL_LANGUAGES: languages,
  CT_DRUG_TOOL_DEVICE: deviceArg,
};

const passthroughIdx = process.argv.indexOf('--');
const passthrough = passthroughIdx !== -1 ? process.argv.slice(passthroughIdx + 1) : [];

const pwCli = path.join('node_modules', 'playwright', 'cli.js');
const args = [pwCli, 'test', 'tests/drugTool/ctDrugTool.spec.js', '--workers=1'];
if (headed) args.push('--headed');
args.push(...passthrough);

console.log(`[runCtDrugTool] languages=${languages} device=${deviceArg}${headed ? ' headed' : ''}`);

const res = spawnSync(process.execPath, args, { stdio: 'inherit', env });
process.exit(res.status == null ? 1 : res.status);
