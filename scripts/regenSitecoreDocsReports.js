/**
 * scripts/regenSitecoreDocsReports.js
 * ─────────────────────────────────────────────────────────────────────────
 * Re-run the Sitecore Docs aggregator against whatever variant.json files
 * exist on disk under `reports/marketplace-sitecore-docs/`. Refreshes:
 *   • Consolidated.html            (all states)
 *   • Consolidated-<STATE>.html    (per state)
 *   • all-reports-<STATE>/         (flat folder — one file per URL + dashboard)
 *
 * Use this when a run's globalTeardown produced a short flat folder due to
 * a filesystem-flush race — this reader-only pass never fails and always
 * picks up every folder that has a variant.json.
 *
 *   npm run report:regen:docs
 */

const path = require('path');
const fs = require('fs');
const { generateSitecoreDocsDashboard } = require('../hooks/marketplaceSitecoreDocsSummary');

function main() {
  const rootDir = path.join(process.cwd(), 'reports', 'marketplace-sitecore-docs');
  if (!fs.existsSync(rootDir)) {
    console.error(`[REGEN] Folder not found: ${rootDir}`);
    console.error('[REGEN] Run "npm run test:marketplace:docs" first.');
    process.exit(1);
  }

  const r = generateSitecoreDocsDashboard({ rootDir });
  console.log(`[REGEN] Consolidated.html                  ${r.file}  (${r.count} URLs)`);
  for (const p of r.perState) {
    console.log(`[REGEN] Consolidated-${p.state}.html      ${p.file}  (${p.count} URLs)`);
  }
  for (const f of r.flat) {
    const onDisk = fs.readdirSync(f.dir).filter((x) => x.endsWith('.html')).length;
    console.log(`[REGEN] all-reports-${f.state}/           ${f.dir}  (${onDisk} HTMLs on disk, ${f.htmlCount} reported)`);
  }
}

if (require.main === module) main();
