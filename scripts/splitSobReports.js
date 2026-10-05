/**
 * scripts/splitSobReports.js
 * ─────────────────────────────────────────────────────────────────────────
 * Post-process `reports/marketplace-plans/` into two language-split
 * dashboard folders so SOB EN and SOB ES can be shared separately:
 *
 *   reports/marketplace-plans-SOB-EN/
 *   reports/marketplace-plans-SOB-ES/
 *
 * Each split folder contains, per plan:
 *   • variant.json  — filtered to that language's setup steps + plan cards
 *   • <testId>.html — original dual-language per-plan HTML, copied as-is
 *                     (drill-in evidence still shows both passes)
 *   • screenshots/  — copied as-is so links in the HTML keep working
 *
 * After splitting, generatePlansDashboard() is invoked against each root
 * so each language gets its own Consolidated.html, Consolidated-<STATE>.html
 * and all-reports/ flat share folder.
 *
 *   node scripts/splitSobReports.js
 */

const fs   = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(process.cwd(), 'reports', 'marketplace-plans');
const TARGETS = {
  EN: path.join(process.cwd(), 'reports', 'marketplace-plans-SOB-EN'),
  ES: path.join(process.cwd(), 'reports', 'marketplace-plans-SOB-ES'),
};

const { generatePlansDashboard } = require('../hooks/marketplacePlansSummary');

// ─── Classify a setup step by language ────────────────────────────────────
// Returns 'EN', 'ES', or 'BOTH' (shared setup — step id ≤ 5 or no tag).
function classifySetupStep(step) {
  const name = String(step.name || '');
  if (/\[EN\]/i.test(name))      return 'EN';
  if (/\[ES\]/i.test(name))      return 'ES';
  if (/switch site language to spanish/i.test(name)) return 'ES';
  // Leak-guard steps: "Spanish PDF leak in [EN] results" is an EN-pass check.
  if (/spanish pdf leak in \[EN\]/i.test(name)) return 'EN';
  if (/english pdf leak in \[ES\]/i.test(name)) return 'ES';
  return 'BOTH';
}

function classifyPlanCard(card) {
  const name = String(card.name || '');
  if (/^\s*\[EN\]/i.test(name)) return 'EN';
  if (/^\s*\[ES\]/i.test(name)) return 'ES';
  return null;
}

function buildSplitVariant(data, lang) {
  const steps = (data.setupSteps || []).filter((s) => {
    const c = classifySetupStep(s);
    return c === lang || c === 'BOTH';
  });
  const cards = (data.planCards || []).filter((c) => classifyPlanCard(c) === lang);

  const setupFailed = steps.some((s) => s.status === 'FAIL');
  const cardFailed  = cards.some((c) => c.status === 'FAIL');
  const status = (setupFailed || cardFailed) ? 'FAIL' : (cards.length ? 'PASS' : (steps.length ? 'PASS' : 'FAIL'));

  return {
    ...data,
    searchLabels: `SOB ${lang}`,
    status,
    setupSteps: steps,
    planCards:  cards,
  };
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`[SPLIT] Source not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  // Fresh split folders every run — avoids stale per-plan residue.
  for (const dir of Object.values(TARGETS)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(dir, { recursive: true });
  }

  const planFolders = fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !/^all-reports/i.test(e.name))
    .map((e) => path.join(SOURCE_DIR, e.name));

  const stats = { EN: { plans: 0, cards: 0 }, ES: { plans: 0, cards: 0 } };
  for (const folder of planFolders) {
    const variantPath = path.join(folder, 'variant.json');
    if (!fs.existsSync(variantPath)) continue;

    let data;
    try { data = JSON.parse(fs.readFileSync(variantPath, 'utf8')); }
    catch (err) {
      console.warn(`[SPLIT] Skip ${folder}: ${err.message}`);
      continue;
    }

    const folderName = path.basename(folder);
    for (const lang of ['EN', 'ES']) {
      const split = buildSplitVariant(data, lang);
      if (!split.planCards.length && !split.setupSteps.length) continue;

      const dstFolder = path.join(TARGETS[lang], folderName);
      fs.mkdirSync(dstFolder, { recursive: true });

      // Filtered variant.json for the dashboard
      fs.writeFileSync(path.join(dstFolder, 'variant.json'), JSON.stringify(split, null, 2), 'utf8');

      // Copy per-plan HTML (full dual-language) + screenshots so drill-in works
      const htmlFile = (data.reportFile && path.basename(data.reportFile)) || `${folderName}.html`;
      copyFileIfExists(path.join(folder, htmlFile), path.join(dstFolder, htmlFile));
      copyDir(path.join(folder, 'screenshots'), path.join(dstFolder, 'screenshots'));

      stats[lang].plans += 1;
      stats[lang].cards += split.planCards.length;
    }
  }

  console.log(`[SPLIT] EN: ${stats.EN.plans} plan(s), ${stats.EN.cards} card(s)`);
  console.log(`[SPLIT] ES: ${stats.ES.plans} plan(s), ${stats.ES.cards} card(s)`);

  for (const lang of ['EN', 'ES']) {
    const r = generatePlansDashboard({ rootDir: TARGETS[lang] });
    for (const w of r.written) {
      console.log(`[SPLIT] ${lang} dashboard: ${w.file}  (${w.count} plan${w.count === 1 ? '' : 's'})`);
    }
    if (r.flat) {
      console.log(`[SPLIT] ${lang} flat: ${r.flat.flatDir}  (${r.flat.planCount} plan HTML + ${r.flat.dashboardCount} dashboard)`);
    }
  }
}

if (require.main === module) main();
