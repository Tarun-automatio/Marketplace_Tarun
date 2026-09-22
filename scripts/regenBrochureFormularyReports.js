/**
 * scripts/regenBrochureFormularyReports.js
 * ─────────────────────────────────────────────────────────────────────────
 * Re-run the Brochure & Formulary aggregator against whatever
 * `variant.json` files exist on disk under
 * `reports/marketplace-brochure-formulary/`. Refreshes:
 *   • Consolidated.html            (all states)
 *   • Consolidated-<STATE>.html    (per state)
 *   • all-reports-<STATE>/         (flat share folder)
 *
 * Use this when a run's globalTeardown produced a short flat folder due
 * to a filesystem-flush race — this reader-only pass never fails and
 * always picks up every folder that has a variant.json.
 *
 *   npm run report:regen:brochure
 */

const path = require('path');
const fs = require('fs');
const { generateBrochureFormularyDashboard } = require('../hooks/marketplaceBrochureFormularySummary');

function main() {
  const rootDir = path.join(process.cwd(), 'reports', 'marketplace-brochure-formulary');
  if (!fs.existsSync(rootDir)) {
    console.error(`[REGEN] Folder not found: ${rootDir}`);
    console.error('[REGEN] Run "npm run test:marketplace:brochure" first.');
    process.exit(1);
  }

  const r = generateBrochureFormularyDashboard({ rootDir });
  console.log(`[REGEN] Consolidated.html                  ${r.file}  (${r.count} states)`);
  for (const p of r.perState) {
    console.log(`[REGEN] Consolidated-${p.state}.html      ${p.file}  (${p.count} states)`);
  }
  for (const f of r.flat) {
    const onDisk = fs.readdirSync(f.dir).filter((x) => x.endsWith('.html')).length;
    console.log(`[REGEN] all-reports-${f.state}/           ${f.dir}  (${onDisk} HTMLs on disk, ${f.htmlCount} reported)`);
  }
}

if (require.main === module) main();
