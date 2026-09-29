/**
 * Playwright global teardown — runs once after the whole test run.
 *
 * Marketplace project scope:
 *   • Marketplace toggle-check suite → aggregate all
 *     `reports/marketplace-toggleCheck/<STATE>-<LANG>-<DEVICE>-<Y1>-<Y2>`
 *     variant reports into one landing page per state:
 *     `reports/marketplace-toggleCheck/<STATE>-Consolidated-<Y1>-<Y2>.html`.
 *   • Marketplace plan-search suite → aggregate all
 *     `reports/marketplace-plans/<TCxxx>/` per-plan reports into ONE
 *     slim dashboard at `reports/marketplace-plans/Consolidated.html`
 *     with filters + expandable per-URL details (no screenshots embedded
 *     so it scales cleanly to 100+ plans).
 *   • Marketplace Drug Pharmacy CTA suite → aggregate all
 *     `reports/marketplace-pharmacy/<TCxxx>/` per-scope reports into one
 *     dashboard file that covers every state.
 *
 * All consolidated reports are purely ADDITIVE — the per-variant, per-plan
 * and per-scope standalone HTML reports are left untouched so any bookmarks
 * or previously shared links continue to work.
 *
 * Never throws — a teardown failure must not fail an otherwise passing
 * suite. All errors are logged to stderr and swallowed.
 */

const path = require('path');
const fs = require('fs');
const { generateMarketplaceSummaries }   = require('./marketplaceSummary');
const { generatePlansDashboard }         = require('./marketplacePlansSummary');
const { generatePharmacyDashboard }      = require('./marketplacePharmacySummary');
const { generateSitecoreDocsDashboard }  = require('./marketplaceSitecoreDocsSummary');
const { generateBrochureFormularyDashboard } = require('./marketplaceBrochureFormularySummary');

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

  // ── Marketplace Drug Pharmacy dashboard (single file, all states) ────
  const pharmacyDir = path.join(process.cwd(), 'reports', 'marketplace-pharmacy');
  try {
    const { file, count } = generatePharmacyDashboard({ rootDir: pharmacyDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Marketplace Drug Pharmacy dashboard written (${count} scope${count === 1 ? '' : 's'}):`);
      console.log(`  \u2022 ${file}`);
    } else {
      console.log('[TEARDOWN] No marketplace-pharmacy variant.json files found \u2014 dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace Drug Pharmacy dashboard failed: ${err && err.message}`);
  }

  // ── Marketplace Sitecore Docs dashboard (single file, all states) ────
  // Small pre-discovery settle so workers that finished mid-teardown have
  // a moment for their fs.writeFileSync flushes to land before we walk
  // the folder. Cheap insurance against a partial dashboard.
  const docsDir = path.join(process.cwd(), 'reports', 'marketplace-sitecore-docs');
  await new Promise((r) => setTimeout(r, 500));
  try {
    const { file, count, perState = [], flat = [] } = generateSitecoreDocsDashboard({ rootDir: docsDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Marketplace Sitecore Docs dashboard written (${count} URL${count === 1 ? '' : 's'}):`);
      console.log(`  \u2022 ${file}`);
      for (const p of perState) {
        console.log(`  \u2022 ${p.file}  (${p.count} URL${p.count === 1 ? '' : 's'})`);
      }
      for (const f of flat) {
        console.log(`  \u2022 ${f.dir}  (flat share folder \u00b7 ${f.htmlCount} HTML${f.htmlCount === 1 ? '' : 's'} + dashboard)`);
      }
    } else {
      console.log('[TEARDOWN] No marketplace-sitecore-docs variant.json files found \u2014 dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace Sitecore Docs dashboard failed: ${err && err.message}`);
  }

  // ── Marketplace Brochure & Formulary dashboard (single file, all states) ──
  const brochureDir = path.join(process.cwd(), 'reports', 'marketplace-brochure-formulary');
  try {
    const { file, count, flat } = generateBrochureFormularyDashboard({ rootDir: brochureDir });
    if (count > 0) {
      console.log(`[TEARDOWN] Marketplace Brochure & Formulary dashboard written (${count} state${count === 1 ? '' : 's'}):`);
      console.log(`  \u2022 ${file}`);
      if (flat) {
        console.log(`  \u2022 ${flat.dir}  (flat share folder \u00b7 ${flat.htmlCount} HTML${flat.htmlCount === 1 ? '' : 's'} + dashboard)`);
      }
    } else {
      console.log('[TEARDOWN] No marketplace-brochure-formulary variant.json files found \u2014 dashboard skipped.');
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace Brochure & Formulary dashboard failed: ${err && err.message}`);
  }

  // ── Marketplace Service Area Maps — gather every per-state report into
  //    a single `all_report/` folder. The per-state HTMLs embed screenshots
  //    as base64, so they stay fully viewable after being copied.
  const samDir = path.join(process.cwd(), 'reports', 'marketplace-serviceAreaMaps');
  try {
    if (fs.existsSync(samDir)) {
      const allDir = path.join(samDir, 'all_report');
      fs.rmSync(allDir, { recursive: true, force: true });  // rebuild fresh each run
      fs.mkdirSync(allDir, { recursive: true });
      let copied = 0;
      for (const entry of fs.readdirSync(samDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'all_report') continue;
        const stateDir = path.join(samDir, entry.name);
        for (const f of fs.readdirSync(stateDir)) {
          if (f.toLowerCase().endsWith('.html')) {
            fs.copyFileSync(path.join(stateDir, f), path.join(allDir, f));
            copied++;
          }
        }
      }
      if (copied > 0) {
        console.log(`[TEARDOWN] Marketplace Service Area Maps: collected ${copied} report(s) → ${allDir}`);
      } else {
        fs.rmSync(allDir, { recursive: true, force: true });  // nothing to collect
      }
    }
  } catch (err) {
    console.error(`[TEARDOWN] Marketplace Service Area Maps all_report failed: ${err && err.message}`);
  }
};
