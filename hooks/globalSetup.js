/**
 * Slim cleanup for the standalone Plan Materials framework.
 *
 * Cleans the report folder(s) for the suite(s) being run so each new run
 * starts from a clean slate. Inspects `process.argv` to detect which spec
 * file was targeted:
 *
 *   • `playwright test tests/planMaterials/...`  →  cleans reports/plan-materials
 *   • `playwright test tests/drugs/...`          →  cleans reports/drug
 *   • `playwright test tests/marketplace/...`    →  cleans reports/marketplace
 *   • `playwright test` (no spec filter)         →  cleans ALL suite reports
 *
 * `reports/test-results` (Playwright traces / videos / failure screenshots)
 * and the legacy `test-results/` folder are always cleaned regardless of
 * which suite is running.
 *
 * Runs both as a stand-alone `npm run clean:artifacts` command and as
 * Playwright's `globalSetup` (before every test session).
 */

const fs   = require('fs');
const path = require('path');

// Map spec-path fragment → report folder that suite writes to.
const SUITE_REPORTS = [
  { match: /tests[\\/]planMaterials/i, dir: 'reports/plan-materials' },
  { match: /tests[\\/]drugs/i,         dir: 'reports/drug' },
  { match: /tests[\\/]marketplace/i,   dir: 'reports/marketplace' },
];

// Always cleaned — Playwright's own artifact folders.
const ALWAYS_CLEAN = [
  'reports/test-results',
  'test-results', // legacy path — remove once no stale folder remains at repo root
];

/**
 * Inspect argv to decide which suite report folder(s) to wipe. Returns the
 * full list of ALWAYS_CLEAN + any suite folders whose spec filter appears
 * in argv. If no spec filter is present (bare `playwright test`), all
 * suite folders are included.
 */
function resolveTargets() {
  const argv = process.argv.join(' ');
  const matchedSuites = SUITE_REPORTS.filter(s => s.match.test(argv));

  // No spec filter → assume "run everything" and clean every suite folder.
  const suiteDirs = matchedSuites.length
    ? matchedSuites.map(s => s.dir)
    : SUITE_REPORTS.map(s => s.dir);

  return [...suiteDirs, ...ALWAYS_CLEAN];
}

function removePath(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    console.log(`[CLEANUP] Removed: ${targetPath}`);
  } catch (error) {
    // Best-effort cleanup — never fail the run on a transient file lock.
    console.log(`[CLEANUP][WARN] Could not remove: ${targetPath} | ${error.code || error.message}`);
  }
}

function runCleanup() {
  console.log('[CLEANUP] Starting cleanup before test run');
  const cwd = process.cwd();
  resolveTargets().forEach(t => removePath(path.join(cwd, t)));
  console.log('[CLEANUP] Cleanup complete');
}

// Run directly when invoked via `node hooks/globalSetup.js`
if (require.main === module) {
  runCleanup();
}

// Export for Playwright globalSetup
module.exports = runCleanup;
