/**
 * Slim cleanup for the standalone Plan Materials framework.
 *
 * Removes:
 *   • reports/plan-materials  (custom HTML report + screenshots)
 *   • reports/test-results   (Playwright traces / videos / failure screenshots)
 *
 * Runs both as a stand-alone `npm run clean:artifacts` command and as
 * Playwright's `globalSetup` (before every test session).
 */

const fs   = require('fs');
const path = require('path');

const targets = [
  'reports/plan-materials',
  'reports/test-results',
  'test-results', // legacy path — remove once no stale folder remains at repo root
];

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
  targets.forEach(t => removePath(path.join(cwd, t)));
  console.log('[CLEANUP] Cleanup complete');
}

// Run directly when invoked via `node hooks/globalSetup.js`
if (require.main === module) {
  runCleanup();
}

// Export for Playwright globalSetup
module.exports = runCleanup;
