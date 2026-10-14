/**
 * ConnectiCare — Connecticut (CT) Drug Lookup Tool  (2027 Plan Year)
 * ─────────────────────────────────────────────────────────────────────────
 * End-to-end validation of the CT Drug Lookup Tool reached through the
 * ConnectiCare members site:
 *
 *   TC1  Launch home → verify it loads + "Member Resources" is visible.
 *   TC2  Open Member Resources → click "Search Drugs" → the
 *        "Select your plan to look up covered drugs" popup opens (Year + Plan).
 *   TC3  Select plan year 2027 → the Plan dropdown populates.
 *   TC4  Validate the Plan dropdown against the Excel CT plans (exact set;
 *        flag missing / unexpected / blank-value plans).
 *   TC5  For every CT plan: select it, capture its CVS Caremark drug-search
 *        URL, open that URL in a new tab, confirm the drug-search site loads,
 *        and (best-effort) run a drug search. Compare the URL to Excel.
 *
 * Source of truth — data/marketplace/DrugLookupTool.xlsx rows where State=CT:
 *   RUN | State | Updated Plan Marketing Name | CVS Drug Search Website URL
 *
 * Evidence: a screenshot is captured at every major step and for every plan
 * (home, Member Resources, Search Drugs popup, Year 2027, plan selected,
 * drug-search destination). A per-run HTML report + variant.json are emitted
 * and a consolidated dashboard is written to the report root.
 *
 * Defect checks surfaced in the report: blank dropdown values, missing plans,
 * incorrect plan names, URL mismatches, drug-search site not loading, and
 * navigation/application errors. (UI-alignment & accessibility are captured
 * visually via the step screenshots for manual review.)
 */

const { test: base, expect } = require('@playwright/test');
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const frameworkConfig = require('../../config/framework.config');
const logger          = require('../../utils/logger');
const { writeReport } = require('../../reporting/reportGenerator');
const { pushSetupStep, fallbackPanelHtml } = require('../../helpers/evidencePanel');
const { captureEvidencePanel, ensureValidScreenshot } = require('../../utils/screenshotHelpers');
const { CtDrugToolPage } = require('../../pages/ctDrugToolPage');
const { generateDashboard } = require('../../hooks/drugToolSummary');

const CT = frameworkConfig.ctDrugTool;

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

function envLabelFromUrl(url) {
  const u = String(url || '');
  if (u.includes('pws-d1')) return 'QA (pws-d1)';
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('uat-pws')) return 'UAT (uat-pws)';
  if (u.includes('www.')) return 'PROD';
  return 'QA';
}

/** Normalize a URL for lenient comparison (lowercase host, strip trailing /, drop hash; keep query). */
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    let out = u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '');
    if (u.search) out += u.search;
    return out;
  } catch {
    return s.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Load CT plans from Excel (State=CT is the selection for this dedicated suite)
// ══════════════════════════════════════════════════════════════════════════

function loadCtPlans() {
  const EXCEL_PATH  = CT.excelPath;
  const EXCEL_SHEET = CT.excelSheet;
  const STATE       = String(CT.state || 'CT').toUpperCase();

  if (!EXCEL_PATH || !fs.existsSync(EXCEL_PATH)) {
    logger.warn('CT-DRUG', `Excel not found: ${EXCEL_PATH || '(unset)'} — running 0 plans`);
    return [];
  }
  let wb;
  try { wb = XLSX.readFile(EXCEL_PATH); }
  catch (err) { logger.warn('CT-DRUG', `Excel read failed: ${err.message.substring(0, 120)}`); return []; }
  const sheet = wb.Sheets[EXCEL_SHEET] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) { logger.warn('CT-DRUG', `Sheet "${EXCEL_SHEET}" missing`); return []; }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const plans = rows
    .filter((r) => norm(r.State).toUpperCase() === STATE)
    .map((r) => ({ name: norm(r['Updated Plan Marketing Name']), expectedUrl: norm(r['CVS Drug Search Website URL']) }))
    .filter((p) => p.name);

  logger.info('CT-DRUG', `Loaded ${plans.length} CT plan(s) from ${path.basename(EXCEL_PATH)}`);
  return plans;
}

const CT_PLANS = loadCtPlans();

// ══════════════════════════════════════════════════════════════════════════
// Registration
// ══════════════════════════════════════════════════════════════════════════

const STATE_NAME = 'Connecticut';
const YEAR       = String(CT.year || '2027');

// Device profiles (applied once per describe via base.use).
const DEVICES = {
  desktop:  { label: 'Desktop Chrome', use: { viewport: { width: 1920, height: 1080 } } },
  iphoneSE: { label: 'iPhone SE', use: {
    viewport: { width: 375, height: 667 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ipadPro:  { label: 'iPad Pro', use: {
    viewport: { width: 1024, height: 1366 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
};
const ACTIVE_DEVICE = DEVICES[String(CT.device || 'desktop').trim()] || DEVICES.desktop;
const LANGUAGES = String(CT.languages || 'en')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!CT_PLANS.length) {
  base.describe('CT Drug Lookup Tool — matrix', () => {
    base('No CT plans found in the Excel sheet', () => {
      throw new Error(
        'CT Drug Lookup matrix is empty. Check:\n'
        + `  • Excel file: ${CT.excelPath}\n`
        + `  • Sheet: ${CT.excelSheet}\n`
        + `  • At least one row with State=${CT.state} and "Updated Plan Marketing Name"`,
      );
    });
  });
} else {
  for (const language of LANGUAGES) registerCtSuite(language);
}

function registerCtSuite(language) {
  const lang        = String(language).toLowerCase();
  const langUpper   = lang.toUpperCase();
  const deviceLabel = ACTIVE_DEVICE.label;
  const reportRoot  = lang === 'es' ? CT.report.dirEs : CT.report.dirEn;
  const folderSlug  = `CT_${langUpper}_${sanitizeForFs(deviceLabel)}`;
  const scopeDir       = path.join(reportRoot, folderSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile     = path.join(scopeDir, `${folderSlug}.html`);

  const appUrl        = CtDrugToolPage.urlForLanguage(lang);
  const testName      = `CT Drug Lookup Tool — ${STATE_NAME} — ${YEAR} — ${langUpper} — ${deviceLabel}`;
  const describeTitle = `${CT.test.id} — ${STATE_NAME} — ${YEAR} — ${langUpper} — ${deviceLabel}`;
  const testDescription =
    `Launch the ConnectiCare site (${langUpper}), open Member Resources → Search Drugs, select plan year `
    + `${YEAR}, validate the CT plan dropdown against the Excel sheet, then for every plan `
    + `open its CVS Caremark drug-search URL and confirm the drug-search site loads.`;

  base.describe(describeTitle, () => {
    base.describe.configure({ retries: 0, mode: 'serial' });
    base.use(ACTIVE_DEVICE.use);

    const setupSteps = [];
    const planCards  = [];
    const runStart   = Date.now();

    base.afterAll(async () => {
      const durationMs = Date.now() - runStart;
      try {
        writeReport({
          reportDir: scopeDir,
          reportFile,
          testMeta: {
            name:        testName,
            id:          `${CT.test.id}-CT-${langUpper}`,
            module:      CT.test.module,
            description: testDescription,
            author:      CT.test.author,
            environment: CT.test.environment || envLabelFromUrl(appUrl),
          },
          appUrl,
          year:           YEAR,
          accordionLabel: `${STATE_NAME} — ${YEAR}`,
          setupSteps,
          planCards,
          responsiveShots: [],
          durationMs,
          timestamp: new Date().toLocaleString(),
        });
        logger.info('REPORT', `[${describeTitle}] Report written: ${reportFile}`);

        const setupFailed = setupSteps.some((s) => s.status === 'FAIL');
        const cardFailed  = planCards.some((c) => c.status === 'FAIL');
        const overallStatus = (setupFailed || cardFailed) ? 'FAIL' : 'PASS';
        fs.writeFileSync(path.join(scopeDir, 'variant.json'), JSON.stringify({
          schemaVersion: 1,
          testId:   `${CT.test.id}-CT-${langUpper}`,
          state:    'CT',
          stateName: STATE_NAME,
          language: langUpper,
          device:   deviceLabel,
          appUrl,
          planYear: YEAR,
          status:   overallStatus,
          durationMs,
          testName,
          planCount:  planCards.length,
          passPlans:  planCards.filter((c) => c.status === 'PASS').length,
          failPlans:  planCards.filter((c) => c.status === 'FAIL').length,
          setupSteps: setupSteps.map((s) => ({
            id: s.id, name: s.name, status: s.status, durationMs: s.durationMs,
            expected: (s.expected || '').substring(0, 500),
            actual:   (s.actual   || '').substring(0, 900),
          })),
          planCards: planCards.map((c) => ({
            id: c.id, name: c.name, status: c.status,
            expectedUrl: c.expectedUrl, actualUrl: c.pdfUrl, href: c.href,
            error: c.error,
            validations: (c.validations || []).map((v) => ({
              name: v.name, status: v.status, description: (v.description || '').substring(0, 300),
            })),
          })),
          reportFile: path.posix.join(folderSlug, path.basename(reportFile)),
        }, null, 2), 'utf8');

        // Self-contained dashboard (reuses the Drug Tool summary renderer).
        try { generateDashboard(reportRoot, { language: langUpper }); logger.info('REPORT', 'CT dashboard written'); }
        catch (e) { logger.warn('REPORT', `CT dashboard failed: ${e.message}`); }
      } catch (err) {
        logger.warn('REPORT', `[${describeTitle}] Failed to write report/json: ${err.message}`);
      }
    });

    base(`${STATE_NAME} — ${YEAR}`, async ({ page, context }) => {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const ct = new CtDrugToolPage(page, { language: lang });
      let toolOptions = [];

      // ── TC1 — Launch home + verify Member Resources ─────────────────
      await base.step('TC1 — Launch Drug Lookup Tool (home + Member Resources)', async () => {
        const t0 = Date.now();
        let ok = true, errMsg = '', mrVisible = false;
        try {
          await ct.gotoHome(appUrl);
          mrVisible = await ct.waitForMemberResources();
        } catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
        const shot = path.join(screenshotsDir, 'TC1_Home.png');
        await ct.rawShot(shot);
        pushSetupStep(setupSteps, {
          id: 1,
          name: 'Launch home & verify Member Resources',
          expected: `Home should load and the "Member Resources" navigation should be visible.\nURL: ${appUrl}`,
          actual: ok
            ? `Home loaded.\nURL: ${page.url()}\nMember Resources visible: ${mrVisible ? 'YES' : 'NO'}`
            : `Failed to load home: ${errMsg}`,
          status: (ok && mrVisible) ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'ConnectiCare home',
        });
        if (!ok || !mrVisible) throw new Error(`TC1 failed: ${errMsg || 'Member Resources not visible'}`);
      });

      // ── TC2 — Member Resources → Search Drugs popup ─────────────────
      await base.step('TC2 — Navigate to Search Drugs (popup opens)', async () => {
        const t0 = Date.now();
        let ok = true, errMsg = '', popupOpen = false, title = '';
        try {
          await ct.openMemberResources();
          await ct.openSearchDrugs();
          popupOpen = await ct.isPopupOpen();
          title = await ct.popupTitle().textContent().catch(() => '');
        } catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
        const shot = path.join(screenshotsDir, 'TC2_SearchDrugsPopup.png');
        await ct.rawShot(shot);
        pushSetupStep(setupSteps, {
          id: 2,
          name: 'Open Search Drugs popup',
          expected: 'Member Resources menu opens; clicking "Search Drugs" reveals the '
            + '"Select your plan to look up covered drugs" popup with Year and Plan dropdowns.',
          actual: ok
            ? `Popup open: ${popupOpen ? 'YES' : 'NO'}\nPopup title: "${(title || '').trim()}"`
            : `Failed to open Search Drugs popup: ${errMsg}`,
          status: (ok && popupOpen) ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'Search Drugs popup',
        });
        if (!ok || !popupOpen) throw new Error(`TC2 failed: ${errMsg || 'Search Drugs popup did not open'}`);
      });

      // ── TC3 — Select plan year 2027 ─────────────────────────────────
      await base.step(`TC3 — Select plan year ${YEAR}`, async () => {
        const t0 = Date.now();
        let ok = true, errMsg = '', selectedYear = '';
        try {
          await ct.ensureSearchDrugsOpen();
          await ct.selectYear(YEAR);
          selectedYear = await ct.getSelectedYear();
          toolOptions = await ct.getPlanOptions();
        } catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
        const yearOk = selectedYear === YEAR;
        const plansPopulated = toolOptions.length > 0;
        const shot = path.join(screenshotsDir, 'TC3_Year2027.png');
        await ct.rawShot(shot);
        pushSetupStep(setupSteps, {
          id: 3,
          name: `Select plan year ${YEAR}`,
          expected: `Selecting "${YEAR}" refreshes the Plan dropdown and displays the applicable CT plans.`,
          actual: ok
            ? `Selected year: ${selectedYear || '(none)'} (expected ${YEAR}${yearOk ? '' : ' — MISMATCH'})\n`
              + `Plan options populated: ${toolOptions.length}`
            : `Failed to select year: ${errMsg}`,
          status: (ok && yearOk && plansPopulated) ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `Year ${YEAR} selected`,
        });
        if (!ok || !yearOk || !plansPopulated) {
          throw new Error(`TC3 failed: ${errMsg || 'year not selected or plans did not populate'}`);
        }
      });

      // ── TC4 — Validate plan dropdown vs Excel (defect checks) ───────
      const excelUrlSet = new Set(CT_PLANS.map((p) => normalizeUrl(p.expectedUrl)).filter(Boolean));
      await base.step('TC4 — Validate CT plan dropdown against Excel', async () => {
        const t0 = Date.now();
        const excelPlans = CT_PLANS.map((p) => p.name);
        const domPlans   = toolOptions.map((o) => o.text);
        const excelSet = new Set(excelPlans);
        const domSet   = new Set(domPlans);
        const missing  = excelPlans.filter((p) => !domSet.has(p));     // in Excel, not on page
        const extra    = domPlans.filter((p) => !excelSet.has(p));     // on page, not in Excel
        const blankVal = toolOptions.filter((o) => !o.url).map((o) => o.text); // blank dropdown value defect
        const exact = missing.length === 0 && extra.length === 0;
        const shot = path.join(screenshotsDir, 'TC4_PlanDropdown.png');
        await ct.rawShot(shot);
        pushSetupStep(setupSteps, {
          id: 4,
          name: 'Plan dropdown matches Excel (defect checks)',
          expected: `Dropdown should list exactly the ${excelPlans.length} CT plan(s) from Excel, each with a non-blank URL.\n`
            + `Excel: ${excelPlans.join(' | ')}`,
          actual: `Dropdown (${domPlans.length}): ${domPlans.join(' | ')}\n`
            + `Missing (in Excel, not on page): ${missing.join(' | ') || '(none)'}\n`
            + `Unexpected (on page, not in Excel): ${extra.join(' | ') || '(none)'}\n`
            + `Blank dropdown values: ${blankVal.join(' | ') || '(none)'}`,
          status: (exact && blankVal.length === 0) ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: 'CT plan dropdown',
        });
        // Non-fatal — continue to per-plan evidence regardless.
      });

      // ── TC5 — Per-plan: select → capture URL → open drug-search site ─
      const redirectSettleMs   = CT.newTabRedirectWaitMs || 15000;
      const screenshotSettleMs = CT.screenshotSettleMs || 4000;
      const URL_CHECK_INFO = Boolean(CT.urlCheckInformational);
      const domPlanSet = new Set(toolOptions.map((o) => o.text));

      for (let i = 0; i < CT_PLANS.length; i += 1) {
        const plan = CT_PLANS[i];
        const cardId = i + 1;
        const planSlug = sanitizeForFs(plan.name).substring(0, 48);
        const card = {
          id: cardId,
          name: plan.name,
          expectedUrl: plan.expectedUrl || '(from option value)',
          href: '',
          pdfUrl: '',            // repurposed: observed destination URL
          isDataDriven: true,
          status: 'PASS',
          error: '',
          steps: [],
          validations: [],
        };
        planCards.push(card);

        // Defect: missing plan → record + skip the select/open flow.
        if (!domPlanSet.has(plan.name)) {
          card.status = 'FAIL';
          card.error = 'Plan not present in the CT drug-tool dropdown';
          card.validations.push({ name: 'Plan present in dropdown', status: 'FAIL',
            description: 'Expected plan from Excel was not found among the dropdown options.' });
          card.steps.push({ id: 1, name: 'Plan present in dropdown', status: 'FAIL',
            expected: `Plan "${plan.name}" should be selectable in the dropdown.`,
            actual: 'Plan is missing from the dropdown — selection skipped.' });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        await base.step(`Plan ${cardId}/${CT_PLANS.length} — ${plan.name}`, async () => {
          const selectShot = path.join(screenshotsDir, `Plan${cardId}_${planSlug}_Selected.png`);
          const destShot   = path.join(screenshotsDir, `Plan${cardId}_${planSlug}_DrugSearch.png`);
          let selectedUrl = '', finalUrl = '', newPage = null;

          // Re-open the popup if a prior plan's navigation collapsed it.
          try {
            if (!(await ct.isPopupOpen())) {
              await ct.openMemberResources();
              await ct.openSearchDrugs();
              await ct.selectYear(YEAR);
            }
          } catch { /* selectPlan will surface issues */ }

          card.validations.push({ name: 'Plan present in dropdown', status: 'PASS',
            description: 'Plan is selectable in the CT drug-tool dropdown.' });

          // 5a — select the plan + capture its Caremark URL
          try {
            const info = await ct.selectPlan(plan.name);
            selectedUrl = info.url || info.dataHref || '';
            card.href = selectedUrl;
            await ct.rawShot(selectShot);
          } catch (err) {
            card.status = 'FAIL';
            card.error = `Plan selection failed: ${(err && err.message ? err.message : String(err)).substring(0, 180)}`;
            await ct.rawShot(selectShot).catch(() => {});
          }

          // Defect: blank dropdown value
          const hasUrl = Boolean(selectedUrl);
          card.validations.push({ name: 'Plan has a non-blank drug-search URL', status: hasUrl ? 'PASS' : 'FAIL',
            description: hasUrl ? `URL = ${selectedUrl}` : 'Selected plan has a blank value (blank dropdown value defect).' });
          if (!hasUrl) card.status = 'FAIL';

          // 5b — URL matches Excel (strict by default; informational when configured)
          const expected = plan.expectedUrl;
          if (expected) {
            const matches = normalizeUrl(selectedUrl) === normalizeUrl(expected);
            card.validations.push({
              name: URL_CHECK_INFO ? 'Drug-search URL vs Excel (informational)' : 'Drug-search URL matches Excel',
              status: (matches || URL_CHECK_INFO) ? 'PASS' : 'FAIL',
              description: matches ? 'exact match after normalization'
                : `${URL_CHECK_INFO ? 'Informational (not failing): ' : ''}expected: ${expected}\nactual: ${selectedUrl}`,
            });
            if (!matches && !URL_CHECK_INFO) card.status = 'FAIL';
          }

          // 5c — open the drug-search site in a new tab + confirm it loads
          const open = await ct.openPlanUrlInNewTab(context, selectedUrl, { redirectSettleMs });
          newPage = open.newPage;
          finalUrl = open.url;
          card.pdfUrl = finalUrl;
          if (open.error && !card.error) card.error = open.error;
          const siteLoaded = Boolean(newPage) && Boolean(finalUrl) && /caremark\.com/i.test(finalUrl);
          card.validations.push({ name: 'Drug-search site opens & loads', status: siteLoaded ? 'PASS' : 'FAIL',
            description: siteLoaded ? `Destination: ${finalUrl}` : (open.error || `Unexpected destination: ${finalUrl || '(blank)'}`) });
          if (!siteLoaded) card.status = 'FAIL';

          // 5d — best-effort drug search on the external site (informational)
          let searchNote = '';
          if (newPage) {
            try {
              await newPage.waitForTimeout(screenshotSettleMs);
              const res = await ct.tryDrugSearch(newPage, CT.drugTerm);
              searchNote = res.note;
              card.validations.push({ name: 'Drug search executed (best-effort)', status: res.searched ? 'PASS' : 'PASS',
                description: res.note });
              await newPage.screenshot({ path: destShot, fullPage: false }).catch(() => {});
            } catch {
              await ensureValidScreenshot(
                () => captureEvidencePanel(context,
                  fallbackPanelHtml(`Drug search — ${plan.name}`,
                    `Drug-search site opened.\nFinal URL:\n${finalUrl || '(none)'}\n\nExternal site screenshot unavailable.`),
                  destShot),
                () => Promise.resolve(destShot));
            }
            try { await newPage.close(); } catch { /* ignore */ }
          } else {
            await ensureValidScreenshot(
              () => captureEvidencePanel(context,
                fallbackPanelHtml(`Drug search failed — ${plan.name}`, card.error || 'Drug-search site did not open'),
                destShot),
              () => Promise.resolve(destShot));
          }

          // Evidence steps for the report
          card.steps.push({
            id: 1, name: 'Plan selected in CT drug tool', status: hasUrl ? 'PASS' : 'FAIL',
            expected: `Selecting "${plan.name}" yields its CVS Caremark drug-search URL.`,
            actual: hasUrl ? `Selected. URL:\n${selectedUrl}` : (card.error || 'Plan selection produced no URL'),
            screenshotPath: selectShot, screenshotLabel: `Plan selected — ${plan.name}`,
          });
          card.steps.push({
            id: 2, name: 'Drug-search site', status: siteLoaded ? 'PASS' : 'FAIL',
            expected: expected ? `Opens the expected CVS drug-search URL.\nExpected: ${expected}` : 'Opens the plan CVS drug-search URL.',
            actual: (siteLoaded ? `Drug-search site loaded:\n${finalUrl}` : (card.error || 'Drug-search site did not load'))
              + (searchNote ? `\nDrug search: ${searchNote}` : ''),
            screenshotPath: destShot, screenshotLabel: `Drug search — ${plan.name}`,
          });
        });
      }

      // Final verdict — fail the run when any setup step or plan failed.
      const failedSetup = setupSteps.filter((s) => s.status === 'FAIL').map((s) => s.name);
      const failedPlans = planCards.filter((c) => c.status === 'FAIL').map((c) => c.name);
      expect(
        failedSetup.length + failedPlans.length,
        `CT Drug Lookup Tool validation failures:`
        + (failedSetup.length ? `\n  Setup: ${failedSetup.join(', ')}` : '')
        + (failedPlans.length ? `\n  Plans: ${failedPlans.join(', ')}` : ''),
      ).toBe(0);
    });
  });
}
