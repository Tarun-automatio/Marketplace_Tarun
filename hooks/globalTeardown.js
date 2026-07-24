/**
 * Playwright global teardown — runs once after the whole test run.
 *
 * Post-processing responsibilities:
 *   • Marketplace toggle-check suite → aggregate all
 *     `reports/marketplace-toggleCheck/<STATE>-<LANG>-<DEVICE>-<Y1>-<Y2>`
 *     variant reports into one landing page per state:
 *     `reports/marketplace-toggleCheck/<STATE>-Consolidated-<Y1>-<Y2>.html`.
 *   • Marketplace plan-search suite → aggregate all
 *     `reports/marketplace-plans/<TCxxx>/` per-plan reports into ONE
 *     slim dashboard at `reports/marketplace-plans/Consolidated.html`
 *     with filters + expandable per-URL details (no screenshots embedded
 *     so it scales cleanly to 100+ plans).
 *
 * Both consolidated reports are purely ADDITIVE — the per-variant and
 * per-plan standalone HTML reports are left untouched so any bookmarks
 * or previously shared links continue to work.
 *
 * Never throws — a teardown failure must not fail an otherwise passing
 * suite. All errors are logged to stderr and swallowed.
 */

const path = require('path');
const { generateMarketplaceSummaries } = require('./marketplaceSummary');
const { generatePlansDashboard }       = require('./marketplacePlansSummary');

module.exports = async function globalTeardown() {
  // ── Marketplace toggle-check consolidated report (per state) ──────────
  const marketplaceDir = path.join(process.cwd(), 'reports', 'marketplace-toggleCheck');
  try {
    const written = generateMarketplaceSummaries({ rootDir: marketplaceDir });
    if (written.length) {
      console.log(`[TEARDOWN] Marketplace toggle-check consolidated report(s) written (${written.length}):`);
      for (const f of written) console.log(`  \u2022 ${f}`);
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace toggle-check summary failed: ${err && err.message}`);
  }

  // ── Marketplace plan-search consolidated dashboard (single file) ──────
  const plansDir = path.join(process.cwd(), 'reports', 'marketplace-plans');
  try {
    const { file, count } = generatePlansDashboard({ rootDir: plansDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Marketplace plan-search dashboard written (${count} plan${count === 1 ? '' : 's'}):`);
      console.log(`  \u2022 ${file}`);
    } else {
      console.log('[TEARDOWN] No plan-search variant.json files found — dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace plan-search dashboard failed: ${err && err.message}`);
  }
};
