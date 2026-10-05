/**
 * Marketplace / NM Plan Brochure — two-flow verification
 * ─────────────────────────────────────────────────────────────────────────
 * Validates two New Mexico Brochure PDFs (NMBrochure27.pdf and
 * NMMBRBrochure27.pdf) via two independent flows, each run in EN and ES.
 *
 *   FLOW 1 — Direct Materials page
 *     1. Open https://www.molinahealthcare.com/ifp/nm/materials
 *     2. Expand the "Plan Brochure" accordion
 *     3. Click the "NMBrochure27" link → verify PDF URL + filename
 *     4. Click the "NMMBRBrochure27" link → verify PDF URL + filename
 *
 *   FLOW 2 — Marketplace navigation flow
 *     1. Open https://www.molinahealthcare.com/
 *     2. Member Resources → Forms & Documents
 *     3. Select state NM, Coverage Year 2027
 *     4. Apply Audience="Marketplace", Category="Member Handbooks and Coverage"
 *     5. For each of ("NM Plan Brochure", "NM Broker Brochure"): search → click
 *        card → verify new-tab PDF URL + filename
 *
 * Each test writes its own per-test HTML report + variant.json so the
 * existing reportGenerator + dashboard tooling can pick them up.
 *
 * Hardcoded data (per user request — single-purpose smoke suite, not matrix).
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { test: base, expect } = require('@playwright/test');

const frameworkConfig = require('../../config/framework.config');
const logger          = require('../../utils/logger');
const { MarketplacePage } = require('../../pages/marketplacePage');
const { pushSetupStep, pushPlanStep } = require('../../helpers/evidencePanel');
const { writeReport } = require('../../reporting/reportGenerator');

// ══════════════════════════════════════════════════════════════════════════
// Config — hardcoded per spec scope
// ══════════════════════════════════════════════════════════════════════════

const MATERIALS_URL_EN = 'https://www.molinahealthcare.com/ifp/nm/materials';
const MATERIALS_URL_ES = 'https://www.molinahealthcare.com/es-us/ifp/nm/materials';
const HOME_URL         = 'https://www.molinahealthcare.com/';

const STATE_CODE = 'NM';
const STATE_NAME = 'New Mexico';
const YEAR       = '2027';

const FILTER_AUDIENCE = 'Marketplace';
const FILTER_CATEGORY = 'Member Handbooks and Coverage';

// Two Flow-1 items that live under the "Plan Brochure" accordion.
// `linkText` is what the <a> actually renders (visible text in the UI).
// `filename` is what the PDF URL must end in to count as a match.
const FLOW1_ITEMS = [
  {
    key:      'NMBrochure27',
    linkText: 'NMBrochure27',
    filename: 'NMBrochure27.pdf',
    expectedUrl: {
      en: 'https://www.molinahealthcare.com/-/media/project/pws/healthcare/pdf/pdf/ifp/nm/materials/brochure/2027/english/NMBrochure27.pdf',
      es: 'https://www.molinahealthcare.com/-/media/project/pws/healthcare/pdf/pdf/ifp/nm/materials/brochure/2027/spanish/NMBrochure27.pdf',
    },
  },
  {
    key:      'NMMBRBrochure27',
    linkText: 'NMMBRBrochure27',
    filename: 'NMMBRBrochure27.pdf',
    expectedUrl: {
      en: 'https://www.molinahealthcare.com/-/media/project/pws/healthcare/pdf/pdf/ifp/nm/materials/brochure/2027/english/NMMBRBrochure27.pdf',
      es: 'https://www.molinahealthcare.com/-/media/project/pws/healthcare/pdf/pdf/ifp/nm/materials/brochure/2027/spanish/NMMBRBrochure27.pdf',
    },
  },
];

// Two Flow-2 items reachable via Marketplace filter + search.
// Loaded from MarketplaceBrochureFormularyData.xlsx so title/URL edits
// in the sheet take effect without changing this file. The sheet's
// *_Name columns must contain the EXACT card title the Sitecore page
// renders — findCardByNameAndUrl() does an exact name+URL match.
const FLOW2_EXCEL_PATH = path.join(process.cwd(), 'data', 'marketplace', 'MarketplaceBrochureFormularyData.xlsx');

function loadFlow2ItemsFromExcel() {
  if (!fs.existsSync(FLOW2_EXCEL_PATH)) {
    logger.warn('MP-NM-BROCH', `Excel not found: ${FLOW2_EXCEL_PATH} — Flow 2 will have 0 items`);
    return [];
  }
  let wb;
  try { wb = XLSX.readFile(FLOW2_EXCEL_PATH); }
  catch (err) {
    logger.warn('MP-NM-BROCH', `Excel read failed: ${err.message.substring(0, 120)}`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const nmRow = rows.find((r) =>
    String(r.State || '').toUpperCase() === STATE_CODE
    && String(r.Run   || '').trim().toUpperCase() === 'Y');
  if (!nmRow) {
    logger.warn('MP-NM-BROCH', `No Run=Y NM row found in ${path.basename(FLOW2_EXCEL_PATH)}`);
    return [];
  }
  const cell = (k) => String(nmRow[k] == null ? '' : nmRow[k]).trim();

  const items = [
    {
      key:        'NM Plan Brochure',
      searchText: cell('MemberBrochure_Search') || 'NM Plan Brochure',
      cardName: {
        en: cell('MemberBrochure_EN_Name'),
        es: cell('MemberBrochure_ES_Name'),
      },
      expectedUrl: {
        en: cell('MemberBrochure_EN_URL'),
        es: cell('MemberBrochure_ES_URL'),
      },
    },
    {
      key:        'NM Broker Brochure',
      searchText: cell('BrokerBrochure_Search') || 'NM Broker Brochure',
      cardName: {
        en: cell('BrokerBrochure_EN_Name'),
        es: cell('BrokerBrochure_ES_Name'),
      },
      expectedUrl: {
        en: cell('BrokerBrochure_EN_URL'),
        es: cell('BrokerBrochure_ES_URL'),
      },
    },
  ];
  // Derive the expected PDF filename from each URL — avoids double-sourcing.
  for (const it of items) {
    it.filename = {
      en: filenameFromUrl(it.expectedUrl.en),
      es: filenameFromUrl(it.expectedUrl.es),
    };
  }
  return items;
}

const REPORT_DIR_ROOT = path.join(process.cwd(), 'reports', 'marketplace-nm-plan-brochure');
const NEW_TAB_TIMEOUT = frameworkConfig.pageLoadWaitMs || 45000;

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

const norm = (v) => String(v == null ? '' : v).trim();

function sanitizeForFs(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

function filenameFromUrl(u) {
  try { return (new URL(u).pathname.split('/').pop() || '').trim(); }
  catch {
    return String(u || '').split('?')[0].split('#')[0].split('/').pop() || '';
  }
}

function filenamesMatch(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** True when the URL path contains a `/spanish/` (ES) or `/english/` (EN) segment matching `lang`. */
function urlLangMatches(url, lang) {
  const p = String(url || '').toLowerCase();
  return lang === 'es' ? /\/spanish\//.test(p) : /\/english\//.test(p);
}

// Load Flow-2 matrix now that the URL helpers above are defined.
const FLOW2_ITEMS = loadFlow2ItemsFromExcel();
if (FLOW2_ITEMS.length) {
  logger.info('MP-NM-BROCH',
    `Flow 2 items loaded from Excel: `
    + FLOW2_ITEMS.map((it) => `${it.key} (EN="${it.cardName.en}" ES="${it.cardName.es}")`).join('; '));
}

// ══════════════════════════════════════════════════════════════════════════
// Click → new-tab → assert — shared primitive for both flows.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Click a locator that should open a PDF in a new tab, then validate:
 *   1. A new tab actually opened
 *   2. The tab's URL ends with the expected filename
 *   3. The URL's /english/ or /spanish/ segment matches `lang`
 *
 * Captures a screenshot of the opened tab and pushes PASS/FAIL to the
 * per-item plan card. Always closes the new tab on exit.
 */
async function clickOpenAndVerify({
  context, trigger, card, expectedUrl, expectedFilename, lang,
  screenshotsDir, screenshotLabel, logTag,
}) {
  const t0 = Date.now();
  let newPage = null;
  let settledUrl = '';
  let newTabOpened = false;

  try {
    const [maybeNewPage] = await Promise.all([
      context.waitForEvent('page', { timeout: NEW_TAB_TIMEOUT }).catch(() => null),
      trigger.click({ timeout: frameworkConfig.elementInteractionTimeoutMs }),
    ]);

    newPage = maybeNewPage;
    if (newPage) {
      newTabOpened = true;
      try { await newPage.waitForURL(/\.pdf(\?|#|$)/i, { timeout: NEW_TAB_TIMEOUT }); } catch { /* continue */ }
      try { await newPage.waitForLoadState('domcontentloaded', { timeout: NEW_TAB_TIMEOUT }); } catch {}
      settledUrl = newPage.url();
    }
  } catch (err) {
    pushPlanStep(card, {
      id: 1,
      name: 'Click link / open PDF in new tab',
      expected: `A new tab should open at ${expectedUrl}`,
      actual: `Click failed: ${(err && err.message ? err.message : String(err)).substring(0, 200)}`,
      status: 'FAIL',
      durationMs: Date.now() - t0,
    });
    card.status = 'FAIL';
    card.error = String(err && err.message ? err.message : err).substring(0, 300);
    return;
  }

  // Give the PDF viewer a moment to paint before the screenshot.
  const shot = path.join(screenshotsDir, `${sanitizeForFs(screenshotLabel)}.png`);
  if (newPage) {
    try { await newPage.waitForTimeout(frameworkConfig.waitAfterNetworkIdleMs || 1500); } catch {}
    try { await newPage.screenshot({ path: shot, fullPage: false }); }
    catch (err) { logger.warn(logTag, `Screenshot failed: ${err.message.substring(0, 120)}`); }
  }

  const actualFilename = filenameFromUrl(settledUrl);
  const filenameOk = filenamesMatch(actualFilename, expectedFilename);
  const langOk     = settledUrl ? urlLangMatches(settledUrl, lang) : false;
  const pass = newTabOpened && filenameOk && langOk;

  card.pdfUrl = settledUrl;
  pushPlanStep(card, {
    id: 1,
    name: 'Click link / open PDF in new tab',
    expected:
      `A new tab should open with URL ending in "${expectedFilename}" `
      + `and the URL path should contain /${lang === 'es' ? 'spanish' : 'english'}/.`,
    actual: newTabOpened
      ? `New tab opened.\nURL: ${settledUrl || '(empty)'}\n`
        + `Filename match: ${actualFilename}  ${filenameOk ? '✓' : '✗'}\n`
        + `Language segment match (/${lang === 'es' ? 'spanish' : 'english'}/): ${langOk ? '✓' : '✗'}`
      : 'No new tab opened within timeout.',
    status: pass ? 'PASS' : 'FAIL',
    durationMs: Date.now() - t0,
    screenshotPath: shot,
    screenshotLabel,
  });
  card.validations.push({
    name: 'PDF URL matches expected',
    status: pass ? 'PASS' : 'FAIL',
    description: pass
      ? `${actualFilename} opened successfully`
      : `expected=${expectedFilename}, actual=${actualFilename || '(empty)'}, newTab=${newTabOpened}, langSegOk=${langOk}`,
  });
  if (!pass) card.status = 'FAIL';

  if (newPage) { await newPage.close().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════════════════
// Report writer — compact wrapper around reportGenerator.writeReport.
// ══════════════════════════════════════════════════════════════════════════

function emitReport({
  testName, testId, lang, scopeDir, reportFile, appUrl, setupSteps, planCards, durationMs,
}) {
  try {
    writeReport({
      reportDir: scopeDir,
      reportFile,
      testMeta: {
        name:        testName,
        id:          testId,
        module:      'Marketplace / NM Plan Brochure',
        description:
          `Validate NM Plan Brochure (NMMBRBrochure27.pdf) and Broker Brochure `
          + `(NMBrochure27.pdf) via a two-flow pattern — direct Materials-page accordion `
          + `click (Flow 1) and Marketplace Member-Resources navigation (Flow 2). `
          + `This test runs the ${lang === 'es' ? 'Spanish' : 'English'} language variant.`,
        author:      'Molina QA Automation',
        environment: 'PROD (www)',
      },
      appUrl,
      year:           YEAR,
      accordionLabel: `${STATE_CODE} · ${YEAR} · ${lang.toUpperCase()}`,
      setupSteps,
      planCards,
      responsiveShots: [],
      durationMs,
      timestamp: new Date().toLocaleString(),
    });

    const overall = planCards.length
      && !planCards.some((c) => c.status === 'FAIL')
      && !setupSteps.some((s) => s.status === 'FAIL') ? 'PASS' : 'FAIL';
    const variantJson = path.join(scopeDir, 'variant.json');
    fs.writeFileSync(variantJson, JSON.stringify({
      schemaVersion: 1,
      testId,
      state:     STATE_CODE,
      stateName: STATE_NAME,
      year:      YEAR,
      language:  lang,
      status:    overall,
      durationMs,
      testName,
      planCards: planCards.map((c) => ({
        id: c.id, name: c.name, status: c.status,
        expectedUrl: c.expectedUrl, pdfUrl: c.pdfUrl,
        validations: c.validations,
      })),
      setupSteps: setupSteps.map((s) => ({
        id: s.id, name: s.name, status: s.status, durationMs: s.durationMs,
      })),
      reportFile: path.relative(REPORT_DIR_ROOT, reportFile).split(path.sep).join('/'),
    }, null, 2), 'utf8');
  } catch (err) {
    logger.warn('REPORT', `[${testId}] Failed to write report: ${err && err.message ? err.message.substring(0, 200) : String(err)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FLOW 1 — Materials page direct
// ══════════════════════════════════════════════════════════════════════════

base.describe('Marketplace NM Plan Brochure — Flow 1 (Materials page)', () => {
  for (const lang of ['en', 'es']) {
    const langLabel = lang.toUpperCase();
    const testId    = `NM_PBROCH_FLOW1_${langLabel}`;
    const testName  = `Flow 1 — NM Materials page · ${STATE_NAME} · ${YEAR} · ${langLabel}`;

    base(testName, async ({ page, context }) => {
      base.setTimeout(180_000);
      const scopeDir       = path.join(REPORT_DIR_ROOT, testId);
      const screenshotsDir = path.join(scopeDir, 'screenshots');
      const reportFile     = path.join(scopeDir, `${testId}.html`);
      fs.mkdirSync(screenshotsDir, { recursive: true });

      const marketplace = new MarketplacePage(page);
      const setupSteps  = [];
      const planCards   = [];
      const runStart    = Date.now();
      let stepId = 1;

      // ── Step 1 — Open Materials page (EN URL) ─────────────────
      await base.step(`Step ${stepId} — Open NM Materials page`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        let ok = true, errMsg = '';
        try { await marketplace.open(MATERIALS_URL_EN); }
        catch (err) { ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200); }
        const shot = path.join(screenshotsDir, `Step${id}_Materials_Page.png`);
        await marketplace.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id,
          name: 'Open NM Materials page',
          expected: `The ${MATERIALS_URL_EN} page should load successfully.`,
          actual: ok ? `Page loaded.\nURL: ${page.url()}` : `Failed: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'NM Materials page',
        });
        if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
      });

      // ── Step 2 — Switch to Spanish (ES tests only) ────────────
      if (lang === 'es') {
        await base.step(`Step ${stepId} — Switch site language to Spanish`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          const before = page.url();
          let ok = true, errMsg = '';
          try { await marketplace.switchLanguage('es'); }
          catch (err) { ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200); }

          // If the toggle bounced us off the materials page, re-navigate
          // to the Spanish materials URL directly so Step 3+ keep working.
          const urlAfterToggle = page.url();
          if (ok && !/\/ifp\/nm\/materials/i.test(urlAfterToggle)) {
            try { await marketplace.open(MATERIALS_URL_ES); }
            catch (err) { ok = false; errMsg = `Language toggle landed off-page; re-nav failed: ${err.message.substring(0, 160)}`; }
          }

          const shot = path.join(screenshotsDir, `Step${id}_Language_ES.png`);
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(setupSteps, {
            id,
            name: 'Switch site language to Spanish',
            expected: 'Language toggle should switch the site to Spanish; final URL should still be the NM Materials page.',
            actual: ok
              ? `Language switched to Spanish.\nURL before toggle: ${before}\nURL after:         ${page.url()}`
              : `Failed: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Materials page — Spanish',
          });
          if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
        });
      }

      // ── Step 3 — Expand "Plan Brochure" accordion ─────────────
      await base.step(`Step ${stepId} — Expand "Plan Brochure" accordion`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        // Molina IFP materials pages render each accordion as a button whose
        // text (English or Spanish) is "Plan Brochure" / "Folleto del plan".
        // We match on both so the same step works in either language.
        const header = page.locator(
          'button:has-text("Plan Brochure"), '
          + 'button:has-text("Folleto del plan"), '
          + 'button:has-text("Folleto")'
        ).first();
        let ok = true, errMsg = '';
        try {
          await header.waitFor({ state: 'visible', timeout: 20000 });
          await header.scrollIntoViewIfNeeded().catch(() => {});
          const expanded = (await header.getAttribute('aria-expanded').catch(() => '')) === 'true';
          if (!expanded) await header.click();
          // Give the accordion panel a beat to render its child links.
          await page.waitForTimeout(600);
        } catch (err) {
          ok = false;
          errMsg = (err && err.message ? err.message : String(err)).substring(0, 200);
        }
        const shot = path.join(screenshotsDir, `Step${id}_Accordion_Open.png`);
        await marketplace.saveScreenshot(shot, { preserveScroll: true });
        pushSetupStep(setupSteps, {
          id,
          name: 'Expand "Plan Brochure" accordion',
          expected: 'The "Plan Brochure" accordion should be expanded, revealing the brochure links.',
          actual: ok ? 'Accordion expanded.' : `Failed: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'Plan Brochure accordion open',
        });
        if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
      });

      // ── Per-item click + verify ───────────────────────────────
      let cardIdx = 0;
      for (const item of FLOW1_ITEMS) {
        cardIdx += 1;
        const card = {
          id: cardIdx,
          name: `[Flow 1 · ${langLabel}] ${item.linkText}`,
          status: 'PASS',
          expectedUrl: item.expectedUrl[lang],
          pdfUrl: '',
          href: '',
          isDataDriven: true,
          steps: [],
          validations: [],
          error: '',
        };
        planCards.push(card);

        await base.step(`Card #${cardIdx} — Click "${item.linkText}" link`, async () => {
          // The link in the accordion renders its exact filename as text
          // (no .pdf extension) — anchor the match so other overlapping
          // text (e.g. the accordion title "Plan Brochure") doesn't win.
          const link = page.locator('a').filter({
            hasText: new RegExp(`^\\s*${item.linkText}\\s*$`, 'i'),
          }).first();

          const exists = await link.count();
          if (!exists) {
            card.status = 'FAIL';
            card.error = `No link with exact text "${item.linkText}" was found on the materials page.`;
            pushPlanStep(card, {
              id: 1,
              name: 'Click link / open PDF in new tab',
              expected: `A link labelled exactly "${item.linkText}" should be present under "Plan Brochure".`,
              actual: card.error,
              status: 'FAIL',
              durationMs: 0,
            });
            return;
          }

          try { await link.scrollIntoViewIfNeeded(); } catch { /* ignore */ }
          try { card.href = await link.getAttribute('href') || ''; } catch { /* ignore */ }

          await clickOpenAndVerify({
            context,
            trigger: link,
            card,
            expectedUrl: item.expectedUrl[lang],
            expectedFilename: item.filename,
            lang,
            screenshotsDir,
            screenshotLabel: `Flow1_${langLabel}_${item.key}_PDF`,
            logTag: 'MP-NM-BROCH',
          });
        });
      }

      // ── Emit report ──
      const durationMs = Date.now() - runStart;
      emitReport({
        testName, testId, lang, scopeDir, reportFile,
        appUrl: lang === 'es' ? MATERIALS_URL_ES : MATERIALS_URL_EN,
        setupSteps, planCards, durationMs,
      });

      const failedCards = planCards.filter((c) => c.status === 'FAIL');
      expect(failedCards, `${failedCards.length} card(s) failed: ${failedCards.map((c) => c.name).join('; ')}`).toHaveLength(0);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// FLOW 2 — Marketplace navigation
// ══════════════════════════════════════════════════════════════════════════

base.describe('Marketplace NM Plan Brochure — Flow 2 (Member Resources → Forms & Documents)', () => {
  for (const lang of ['en', 'es']) {
    const langLabel = lang.toUpperCase();
    const testId    = `NM_PBROCH_FLOW2_${langLabel}`;
    const testName  = `Flow 2 — Marketplace nav · ${STATE_NAME} · ${YEAR} · ${langLabel}`;

    base(testName, async ({ page, context }) => {
      base.setTimeout(240_000);
      const scopeDir       = path.join(REPORT_DIR_ROOT, testId);
      const screenshotsDir = path.join(scopeDir, 'screenshots');
      const reportFile     = path.join(scopeDir, `${testId}.html`);
      fs.mkdirSync(screenshotsDir, { recursive: true });

      const marketplace = new MarketplacePage(page);
      const setupSteps  = [];
      const planCards   = [];
      const runStart    = Date.now();
      let stepId = 1;
      let runError = null;

      try {
      // ── Step 1 — Open home ──
      await base.step(`Step ${stepId} — Open Molina home`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        let ok = true, errMsg = '';
        try { await marketplace.open(HOME_URL); }
        catch (err) { ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200); }
        const shot = path.join(screenshotsDir, `Step${id}_Home.png`);
        await marketplace.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id,
          name: 'Open Molina home',
          expected: `The ${HOME_URL} page should load successfully.`,
          actual: ok ? `Home loaded.\nURL: ${page.url()}` : `Failed: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'Molina home',
        });
        if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
      });

      // ── Step 2 — Switch to Spanish (ES only) ──
      if (lang === 'es') {
        await base.step(`Step ${stepId} — Switch site language to Spanish`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          const before = page.url();
          let ok = true, errMsg = '';
          try { await marketplace.switchLanguage('es'); }
          catch (err) { ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200); }
          const shot = path.join(screenshotsDir, `Step${id}_Language_ES.png`);
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(setupSteps, {
            id,
            name: 'Switch site language to Spanish',
            expected: 'Clicking the Language toggle and selecting Spanish should load the ES home page (URL contains /es-us/).',
            actual: ok
              ? `Language switched to Spanish.\nURL before: ${before}\nURL after:  ${page.url()}`
              : `Failed: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Site language — Spanish',
          });
          if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
        });
      }

      // ── Step 3 — Member Resources menu ──
      await base.step(`Step ${stepId} — Open Member Resources menu`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        let ok = true, errMsg = '';
        try { await marketplace.openMemberResources(); }
        catch (err) { ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200); }
        const shot = path.join(screenshotsDir, `Step${id}_MemberResources.png`);
        await marketplace.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id,
          name: 'Open Member Resources menu',
          expected: 'The Member Resources menu should open successfully.',
          actual: ok ? 'Member Resources menu opened.' : `Failed: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'Member Resources menu',
        });
        if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
      });

      // ── Step 4 — Forms & Documents page ──
      await base.step(`Step ${stepId} — Open Forms & Documents`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        let ok = true, errMsg = '';
        try { await marketplace.openFormsAndDocuments(); }
        catch (err) { ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200); }
        const shot = path.join(screenshotsDir, `Step${id}_FormsAndDocuments.png`);
        await marketplace.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id,
          name: 'Open Forms & Documents',
          expected: 'The Forms & Documents page should load successfully.',
          actual: ok ? `Loaded.\nURL: ${page.url()}` : `Failed: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'Forms & Documents',
        });
        if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
      });

      // ── Step 5 — Select NM ──
      await base.step(`Step ${stepId} — Select state ${STATE_NAME}`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        const res = await marketplace.selectState(STATE_CODE);
        const shot = path.join(screenshotsDir, `Step${id}_State_NM.png`);
        await marketplace.saveScreenshot(shot, { preserveScroll: true });
        const ok = !!res.selected;
        pushSetupStep(setupSteps, {
          id,
          name: `Select state ${STATE_NAME}`,
          expected: `State "${STATE_NAME}" should be selected.`,
          actual: ok
            ? `State "${STATE_NAME}" selected.\nURL: ${page.url()}`
            : `Failed to select state. Reason: ${res.reason || '(unknown)'}; Available: [${(res.availableStates || []).join(', ')}]`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'State selected — NM',
        });
        if (!ok) throw new Error(`Step ${id} failed: state select`);
        await marketplace.scrollToAllFormsAndDocuments();
      });

      // ── Step 6 — Coverage year 2027 ──
      await base.step(`Step ${stepId} — Toggle Coverage Year to ${YEAR}`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        await marketplace.selectCoverageYear(YEAR);
        const yearInUrl  = marketplace.getYearFromUrl(page.url());
        const activeYear = await marketplace.getActiveYear();
        const ok = yearInUrl === YEAR && (activeYear == null || activeYear === YEAR);
        const shot = path.join(screenshotsDir, `Step${id}_Year_${YEAR}.png`);
        await marketplace.saveScreenshot(shot, { preserveScroll: true });
        pushSetupStep(setupSteps, {
          id,
          name: `Toggle Coverage Year to ${YEAR}`,
          expected: `Coverage Year ${YEAR} should be active.`,
          actual: ok
            ? `Coverage Year ${YEAR} is active.\nURL: ${page.url()}`
            : `Year did not become active. activeYear="${activeYear}" urlYear="${yearInUrl}"`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `Coverage year ${YEAR}`,
        });
        if (!ok) throw new Error(`Step ${id} failed: year toggle`);
      });

      // ── Step 7 — Filters ──
      await base.step(`Step ${stepId} — Apply filters Audience="${FILTER_AUDIENCE}" + Category="${FILTER_CATEGORY}"`, async () => {
        const id = stepId++;
        const t0 = Date.now();
        let ok = true, errMsg = '';
        try {
          await marketplace.scrollToAllFormsAndDocuments();
          // Clear any residual search text so the Category panel renders fully.
          try { await marketplace.searchByPlanName(''); } catch { /* ignore */ }
          await marketplace.selectFilterOption('Audience', FILTER_AUDIENCE);
          await marketplace.selectFilterOption('Category', FILTER_CATEGORY);
        } catch (err) {
          ok = false; errMsg = (err && err.message ? err.message : String(err)).substring(0, 200);
        }
        const shot = path.join(screenshotsDir, `Step${id}_Filters.png`);
        await marketplace.saveScreenshot(shot, { preserveScroll: true });
        pushSetupStep(setupSteps, {
          id,
          name: `Apply filters (${FILTER_AUDIENCE} / ${FILTER_CATEGORY})`,
          expected: `Audience="${FILTER_AUDIENCE}" and Category="${FILTER_CATEGORY}" should both be checked.`,
          actual: ok
            ? `Filters applied: Audience="${FILTER_AUDIENCE}", Category="${FILTER_CATEGORY}".`
            : `Failed to apply filters: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'Filters applied',
        });
        if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
      });

      // ── Per-item search + click + verify ──
      let cardIdx = 0;
      for (const item of FLOW2_ITEMS) {
        cardIdx += 1;
        const card = {
          id: cardIdx,
          name: `[Flow 2 · ${langLabel}] ${item.key}`,
          status: 'PASS',
          expectedUrl: item.expectedUrl[lang],
          pdfUrl: '',
          href: '',
          isDataDriven: true,
          steps: [],
          validations: [],
          error: '',
        };
        planCards.push(card);

        await base.step(`Card #${cardIdx} — Search "${item.searchText}" and open card`, async () => {
          const t0 = Date.now();
          const expectedCardName = item.cardName[lang] || item.searchText;
          const expectedFilename = item.filename[lang];
          try { await marketplace.searchByPlanName(item.searchText); }
          catch (err) {
            card.status = 'FAIL';
            card.error = `Search failed: ${(err && err.message ? err.message : String(err)).substring(0, 160)}`;
            pushPlanStep(card, {
              id: 1,
              name: 'Click link / open PDF in new tab',
              expected: `Search for "${item.searchText}" and click the matching card.`,
              actual: card.error,
              status: 'FAIL',
              durationMs: Date.now() - t0,
            });
            return;
          }
          await marketplace.scrollToAllFormsAndDocuments();

          // findCardByNameAndUrl() does an exact title + URL path match, so
          // we pass the Excel-provided card name (e.g. "NM Plan Brochure -
          // Marketplace 2027") rather than the shorter search needle.
          const matched = await marketplace.findCardByNameAndUrl(expectedCardName, item.expectedUrl[lang]);
          if (!matched) {
            card.status = 'FAIL';
            card.error =
              `No result card matched name="${expectedCardName}" + URL="${item.expectedUrl[lang]}" `
              + `under search "${item.searchText}".`;
            const shot = path.join(screenshotsDir, `Flow2_${langLabel}_${sanitizeForFs(item.key)}_NotFound.png`);
            await marketplace.saveScreenshot(shot, { preserveScroll: true }).catch(() => {});
            pushPlanStep(card, {
              id: 1,
              name: 'Click link / open PDF in new tab',
              expected:
                `A card titled exactly "${expectedCardName}" with href pointing to `
                + `${expectedFilename} should be present after searching "${item.searchText}".`,
              actual: card.error,
              status: 'FAIL',
              durationMs: Date.now() - t0,
              screenshotPath: shot,
              screenshotLabel: `No card found — ${item.key}`,
            });
            card.validations.push({ name: 'Result card present', status: 'FAIL', description: card.error });
            return;
          }

          card.href = matched.href || '';
          await clickOpenAndVerify({
            context,
            trigger: matched.linkLoc,
            card,
            expectedUrl: item.expectedUrl[lang],
            expectedFilename,
            lang,
            screenshotsDir,
            screenshotLabel: `Flow2_${langLabel}_${item.key}_PDF`,
            logTag: 'MP-NM-BROCH',
          });
        });
      }
      } catch (err) {
        // Capture the throw so the finally-block below can still write the
        // per-test HTML report + variant.json; we re-throw at the end.
        runError = err;
        logger.warn('MP-NM-BROCH',
          `Flow 2 ${langLabel} aborted mid-run: `
          + `${(err && err.message ? err.message : String(err)).substring(0, 200)}`);
      } finally {
        const durationMs = Date.now() - runStart;
        emitReport({
          testName, testId, lang, scopeDir, reportFile,
          appUrl: HOME_URL,
          setupSteps, planCards, durationMs,
        });
      }

      if (runError) throw runError;
      const failedCards = planCards.filter((c) => c.status === 'FAIL');
      expect(failedCards, `${failedCards.length} card(s) failed: ${failedCards.map((c) => c.name).join('; ')}`).toHaveLength(0);
    });
  }
});
