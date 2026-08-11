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
 *   • Drug / Pharmacy suite → aggregate all
 *     `reports/drug/<TCxxx>/` per-scope reports into ONE slim dashboard
 *     at `reports/drug/Consolidated.html` (same shape as plan-search;
 *     filters by state / accordion / status).
 *
 * All consolidated reports are purely ADDITIVE — the per-variant, per-plan
 * and per-scope standalone HTML reports are left untouched so any bookmarks
 * or previously shared links continue to work.
 *
 * Never throws — a teardown failure must not fail an otherwise passing
 * suite. All errors are logged to stderr and swallowed.
 */

const path = require('path');
const { generateMarketplaceSummaries } = require('./marketplaceSummary');
const { generatePlansDashboard }       = require('./marketplacePlansSummary');
const { generateDrugDashboard }        = require('./drugSummary');
const { generatePharmacyDashboard }    = require('./marketplacePharmacySummary');

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

  // ── Marketplace plan-search consolidated dashboard (per state) ────────
  const plansDir = path.join(process.cwd(), 'reports', 'marketplace-plans');
  try {
    const { written, count, flat } = generatePlansDashboard({ rootDir: plansDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Marketplace plan-search dashboards written (${written.length} state file${written.length === 1 ? '' : 's'}, ${count} plan${count === 1 ? '' : 's'} total):`);
      for (const w of written) console.log(`  \u2022 ${w.file}  (${w.count} plan${w.count === 1 ? '' : 's'})`);
      if (flat && (flat.planCount > 0 || flat.dashboardCount > 0)) {
        console.log(`[TEARDOWN] Flat share folder: ${flat.flatDir}  (${flat.planCount} plan HTML${flat.planCount === 1 ? '' : 's'} + ${flat.dashboardCount} dashboard${flat.dashboardCount === 1 ? '' : 's'})`);
      }
    } else {
      console.log('[TEARDOWN] No plan-search variant.json files found \u2014 dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace plan-search dashboard failed: ${err && err.message}`);
  }

  // ── Drug / Pharmacy consolidated dashboard (per state) ────────────────
  const drugDir = path.join(process.cwd(), 'reports', 'drug');
  try {
    const { written, count } = generateDrugDashboard({ rootDir: drugDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Drug / Pharmacy dashboards written (${written.length} state file${written.length === 1 ? '' : 's'}, ${count} scope${count === 1 ? '' : 's'} total):`);
      for (const w of written) console.log(`  \u2022 ${w.file}  (${w.count} scope${w.count === 1 ? '' : 's'})`);
    } else {
      console.log('[TEARDOWN] No drug variant.json files found \u2014 dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Drug / Pharmacy dashboard failed: ${err && err.message}`);
  }
  // ── Marketplace Drug Pharmacy dashboard (single file, all states) ────
  const pharmacyDir = path.join(process.cwd(), 'reports', 'marketplace-pharmacy');
  try {
    const { file, count } = generatePharmacyDashboard({ rootDir: pharmacyDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Marketplace Drug Pharmacy dashboard written (${count} scope${count === 1 ? '' : 's'}):`);
      console.log(`  • ${file}`);
    } else {
      console.log('[TEARDOWN] No marketplace-pharmacy variant.json files found — dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace Drug Pharmacy dashboard failed: ${err && err.message}`);
  }};
