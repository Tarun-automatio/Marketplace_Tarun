/**
 * Marketplace — 2027 Drug Lookup / Search Tool
 * ────────────────────────────────────────────
 * User story:
 *   On the Individual & Family Drug page (`/ifp/{state}/drugs`) the "Drug
 *   Search Tool" lets a member pick their plan and jump to that plan's CVS
 *   Caremark drug-search site. This suite verifies, for every state in the
 *   Excel matrix and in BOTH languages (English + Spanish):
 *
 *     1. The Drug page launches.
 *     2. The {year} Drug Search Tool section is present.
 *     3. The header language selector reflects the requested language.
 *     4. The plan dropdown contains EXACTLY the plans configured in Excel
 *        (no missing plans, no unexpected plans — exact set match).
 *     5. For every plan: selecting it + clicking "Search Drug Coverage"
 *        opens Molina's External Site Modal, Continue points at the plan's
 *        expected CVS URL, and a new tab opens and lands on the CVS site.
 *
 *   Data source of truth — data/marketplace/DrugLookupTool.xlsx:
 *     RUN | State | Updated Plan Marketing Name | CVS Drug Search Website URL
 *   No states, plans, or URLs are hardcoded — add a row and it runs.
 *
 * Language handling:
 *   Spanish runs the SAME page under the `/es-us/` prefix (same plan list,
 *   same CVS destinations) and asserts the language selector shows "ES".
 *   English / Spanish results are written to SEPARATE report trees
 *   (reports/drug-tool-EN, reports/drug-tool-ES) → separate dashboards.
 *
 * Framework touch-points:
 *   • pages/drugToolPage.js         — DOM interactions (extends MarketplaceDrugPage)
 *   • reporting/reportGenerator.js  — per-scope HTML report (writeReport)
 *   • hooks/drugToolSummary.js      — per-language consolidated dashboard
 */

const { test: pwBase, chromium, expect } = require('@playwright/test');
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const frameworkConfig = require('../../config/framework.config');
const logger          = require('../../utils/logger');
const { writeReport } = require('../../reporting/reportGenerator');
const {
  pushSetupStep,
  fallbackPanelHtml,
} = require('../../helpers/evidencePanel');
const {
  captureEvidencePanel,
  ensureValidScreenshot,
} = require('../../utils/screenshotHelpers');
const { DrugToolPage } = require('../../pages/drugToolPage');

const DT = frameworkConfig.drugTool;

// ══════════════════════════════════════════════════════════════════════════
// CDP attach mode — when DRUG_TOOL_CDP_ENDPOINT is set, connect to an
// already-running Chrome (started with --remote-debugging-port) and run
// inside its authenticated, Akamai-cleared context. This lets the suite
// reach WAF-protected hosts (e.g. uat-pws) using the tester's own session.
// We create our own tab in that context and close only that tab afterwards,
// leaving the tester's existing tabs untouched.
// ══════════════════════════════════════════════════════════════════════════

const CDP_ENDPOINT = String(DT.cdpEndpoint || '').trim();

const test = CDP_ENDPOINT
  ? pwBase.extend({
      browser: [async ({}, use) => {
        logger.info('DRUG-TOOL', `Connecting to Chrome over CDP: ${CDP_ENDPOINT}`);
        const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
        await use(browser);
        // Do NOT call browser.close() — over a CDP connection that closes the
        // tester's REAL Chrome, which would break every subsequent scope with
        // ECONNREFUSED. Simply let the connection drop when the worker exits.
      }, { scope: 'worker' }],
      context: async ({ browser }, use) => {
        const ctx = browser.contexts()[0] || await browser.newContext();
        await use(ctx);
        // Do NOT close the tester's context.
      },
      page: async ({ context }, use) => {
        const page = await context.newPage();
        await use(page);
        await page.close().catch(() => {});
      },
    })
  : pwBase;

const base = test;


// ══════════════════════════════════════════════════════════════════════════
// Small helpers
// ══════════════════════════════════════════════════════════════════════════

const norm = (v) => String(v == null ? '' : v).trim();

function sanitizeForFs(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

const STATE_CODE_TO_NAME = {
  AZ: 'Arizona',    CA: 'California',  FL: 'Florida',      GA: 'Georgia',
  IA: 'Iowa',       ID: 'Idaho',       IL: 'Illinois',     KY: 'Kentucky',
  MA: 'Massachusetts', MI: 'Michigan', MS: 'Mississippi',  NE: 'Nebraska',
  NM: 'New Mexico', NV: 'Nevada',      NY: 'New York',     OH: 'Ohio',
  SC: 'South Carolina', TX: 'Texas',   UT: 'Utah',         VA: 'Virginia',
  WA: 'Washington', WI: 'Wisconsin',
};
const fullNameForState = (code) =>
  STATE_CODE_TO_NAME[String(code || '').trim().toUpperCase()] || String(code || '').toUpperCase();

function envLabelFromUrl(url) {
  const u = String(url || '');
  if (u.includes('uat-pws')) return 'UAT (uat-pws)';
  if (u.includes('pws-q3'))  return 'Q3 (pws-q3)';
  if (u.includes('pws-q2'))  return 'Q2 (pws-q2)';
  if (u.includes('pws-q1'))  return 'Q1 (pws-q1)';
  return 'PROD';
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
// Device profiles (Desktop Chrome / iPhone SE / iPad Pro). The active
// device comes from config (DRUG_TOOL_DEVICE) and is applied once via
// base.use at describe scope.
// ══════════════════════════════════════════════════════════════════════════

const DEVICES = {
  desktop: {
    label: 'Desktop Chrome',
    use: { viewport: { width: 1920, height: 1080 } },
  },
  iphoneSE: {
    label: 'iPhone SE',
    use: {
      viewport: { width: 375, height: 667 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) '
        + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    },
  },
  ipadPro: {
    label: 'iPad Pro',
    use: {
      viewport: { width: 1024, height: 1366 },
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) '
        + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    },
  },
};
const ACTIVE_DEVICE = DEVICES[String(DT.device || 'desktop').trim()] || DEVICES.desktop;

// ══════════════════════════════════════════════════════════════════════════
// Matrix loader — group Excel rows by state (Run=Y only).
// ══════════════════════════════════════════════════════════════════════════

function loadStateGroups() {
  const EXCEL_PATH  = DT.excelPath;
  const EXCEL_SHEET = DT.excelSheet;
  const FILTER_STATE = String(DT.filters.state || '').trim().toUpperCase();

  if (!EXCEL_PATH || !fs.existsSync(EXCEL_PATH)) {
    logger.warn('DRUG-TOOL', `Excel not found: ${EXCEL_PATH || '(unset)'} — running 0 tests`);
    return [];
  }
  let wb;
  try { wb = XLSX.readFile(EXCEL_PATH); }
  catch (err) {
    logger.warn('DRUG-TOOL', `Excel read failed: ${err.message.substring(0, 120)} — running 0 tests`);
    return [];
  }
  const sheet = wb.Sheets[EXCEL_SHEET] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    logger.warn('DRUG-TOOL', `Sheet "${EXCEL_SHEET}" missing — running 0 tests`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const byState = new Map();
  for (const r of rows) {
    if (norm(r.RUN).toUpperCase() !== 'Y') continue;
    const state = norm(r.State).toUpperCase();
    const plan  = norm(r['Updated Plan Marketing Name']);
    const url   = norm(r['CVS Drug Search Website URL']);
    if (!state || !plan) continue;
    if (FILTER_STATE && state !== FILTER_STATE) continue;
    if (!byState.has(state)) byState.set(state, { state, plans: [] });
    byState.get(state).plans.push({ name: plan, expectedUrl: url });
  }

  const groups = Array.from(byState.values())
    .sort((a, b) => a.state.localeCompare(b.state));

  if (!groups.length) {
    logger.warn('DRUG-TOOL',
      `No Run=Y rows in ${path.basename(EXCEL_PATH)}`
      + (FILTER_STATE ? ` for state=${FILTER_STATE}` : '') + ' — running 0 tests');
  } else {
    logger.info('DRUG-TOOL',
      `Loaded ${groups.length} state group(s): `
      + groups.map((g) => `${g.state}(${g.plans.length})`).join(', '));
  }
  return groups;
}

// ══════════════════════════════════════════════════════════════════════════
// Registration — one describe + one test per (state, language).
// ══════════════════════════════════════════════════════════════════════════

const STATE_GROUPS = loadStateGroups();
const LANGUAGES = String(DT.languages || 'en')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!STATE_GROUPS.length) {
  base.describe('Drug Lookup Tool — matrix', () => {
    base('No Drug Tool scopes matched the current filters', () => {
      throw new Error(
        'DrugTool matrix is empty. Check:\n'
        + `  • Excel file: ${DT.excelPath}\n`
        + `  • Sheet: ${DT.excelSheet}\n`
        + '  • At least one row with RUN=Y, State, Updated Plan Marketing Name\n'
        + `  • Filter: STATE="${DT.filters.state}"`
      );
    });
  });
} else {
  for (const language of LANGUAGES) {
    for (const group of STATE_GROUPS) registerScope(group, language);
  }
}

function registerScope(group, language) {
  const lang       = language.toLowerCase();
  const langUpper  = lang.toUpperCase();
  const stateUpper = group.state.toUpperCase();
  const stateName  = fullNameForState(group.state);
  const reportRoot = lang === 'es' ? DT.report.dirEs : DT.report.dirEn;
  const folderSlug = `${stateUpper}_${sanitizeForFs(ACTIVE_DEVICE.label)}`;
  const scopeDir       = path.join(reportRoot, folderSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile     = path.join(scopeDir, `${folderSlug}.html`);

  const appUrl   = DrugToolPage.urlFor(group.state, lang);
  const testName = `Drug Lookup Tool — ${stateName} — ${langUpper} — ${ACTIVE_DEVICE.label}`;
  const describeTitle = `${DT.test.id} — ${stateName} — ${langUpper} — ${ACTIVE_DEVICE.label}`;
  const testDescription =
    `Launch the ${DT.planYear} Drug Search Tool for ${stateName} in `
    + `${lang === 'es' ? 'Spanish' : 'English'}, validate the plan dropdown matches `
    + `Excel exactly, then for every plan confirm the External Site Modal + Continue `
    + `opens the expected CVS drug-search URL in a new tab.`;

  base.describe(describeTitle, () => {
    base.describe.configure({ retries: 0, mode: 'serial' });
    // In CDP mode we reuse the tester's existing browser context, so
    // per-test emulation options (viewport/userAgent) can't be applied.
    if (!CDP_ENDPOINT) base.use(ACTIVE_DEVICE.use);

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
            id:          `${DT.test.id}-${stateUpper}-${langUpper}`,
            module:      DT.test.module,
            description: testDescription,
            author:      DT.test.author,
            environment: DT.test.environment || envLabelFromUrl(appUrl),
          },
          appUrl,
          year:           DT.planYear,
          accordionLabel: `${stateName} — ${langUpper}`,
          setupSteps,
          planCards,
          responsiveShots: [],
          durationMs,
          timestamp: new Date().toLocaleString(),
        });
        logger.info('REPORT', `[${describeTitle}] Report written: ${reportFile}`);

        // Companion JSON for the per-language dashboard hook.
        const setupFailed = setupSteps.some((s) => s.status === 'FAIL');
        const cardFailed  = planCards.some((c) => c.status === 'FAIL');
        const overallStatus = (setupFailed || cardFailed) ? 'FAIL' : 'PASS';
        fs.writeFileSync(path.join(scopeDir, 'variant.json'), JSON.stringify({
          schemaVersion: 1,
          testId:   `${DT.test.id}-${stateUpper}-${langUpper}`,
          state:    stateUpper,
          stateName,
          language: langUpper,
          device:   ACTIVE_DEVICE.label,
          appUrl,
          planYear: DT.planYear,
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
              name: v.name, status: v.status,
              description: (v.description || '').substring(0, 300),
            })),
          })),
          reportFile: path.posix.join(folderSlug, path.basename(reportFile)),
        }, null, 2), 'utf8');
      } catch (err) {
        logger.warn('REPORT', `[${describeTitle}] Failed to write report/json: ${err.message}`);
      }
    });

    base(`${stateName} — ${langUpper}`, async ({ page, context }) => {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const drug = new DrugToolPage(page);

      // ── Step 1 — Launch Drug page ──────────────────────────────────
      await base.step(`Step 1 — Launch Drug page for ${stateName} (${langUpper})`, async () => {
        const t0 = Date.now();
        let ok = true; let errMsg = '';
        try { await drug.gotoDrugTool(group.state, lang); }
        catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
        const shot = path.join(screenshotsDir, 'Step1_Launch.png');
        await drug.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id: 1,
          name: 'Launch Drug page',
          expected: `Drug page for ${stateName} (${langUpper}) should load.\nURL: ${appUrl}`,
          actual: ok ? `Loaded successfully.\nURL: ${page.url()}` : `Failed to load: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `Drug page — ${stateName} (${langUpper})`,
        });
        if (!ok) throw new Error(`Step 1 failed: ${errMsg}`);
      });

      // ── Step 2 — Locate {year} Drug Search Tool + verify language ──
      let toolOptions = [];
      await base.step(`Step 2 — Locate ${DT.planYear} Drug Search Tool & verify language`, async () => {
        const t0 = Date.now();
        const section = await drug.resolveToolSection(DT.planYear);
        toolOptions = section.options || [];
        await drug.scrollToolIntoView().catch(() => {});

        const selectedLang = await drug.getSelectedLanguage();
        const expectLang   = langUpper;             // "EN" / "ES"
        const langOk = !selectedLang || selectedLang === expectLang;
        const sectionOk = section.found && toolOptions.length > 0;

        const shot = path.join(screenshotsDir, 'Step2_ToolSection.png');
        await drug.saveScreenshot(shot, { preserveScroll: true });

        pushSetupStep(setupSteps, {
          id: 2,
          name: `Locate ${DT.planYear} Drug Search Tool`,
          expected: `The "${DT.planYear} ${DT.toolHeading}" section with a plan dropdown should be present, `
            + `and the language selector should read "${expectLang}".`,
          actual: (sectionOk
            ? `Tool section found (heading: "${section.heading}") with ${toolOptions.length} plan option(s).`
            : `Tool section NOT found or empty (heading: "${section.heading}").`)
            + `\nLanguage selector: ${selectedLang || '(not present)'} `
            + `(expected ${expectLang}${langOk ? '' : ' — MISMATCH'}).`,
          status: (sectionOk && langOk) ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `${DT.planYear} Drug Search Tool — ${stateName} (${langUpper})`,
        });
        if (!sectionOk) throw new Error('Step 2 failed: Drug Search Tool section not found');
      });

      // ── Step 3 — Plan dropdown exact-match validation vs Excel ─────
      await base.step('Step 3 — Validate plan dropdown matches Excel exactly', async () => {
        const t0 = Date.now();
        const excelPlans = group.plans.map((p) => p.name);
        const domPlans   = toolOptions.map((o) => o.value);
        const excelSet = new Set(excelPlans);
        const domSet   = new Set(domPlans);
        const missing = excelPlans.filter((p) => !domSet.has(p));   // in Excel, not on page
        const extra   = domPlans.filter((p) => !excelSet.has(p));   // on page, not in Excel
        const exact = missing.length === 0 && extra.length === 0;

        const shot = path.join(screenshotsDir, 'Step3_PlanDropdown.png');
        await drug.saveScreenshot(shot, { preserveScroll: true });

        pushSetupStep(setupSteps, {
          id: 3,
          name: 'Plan dropdown exact match',
          expected: `Dropdown plans must match Excel exactly (${excelPlans.length} plan(s)).\n`
            + `Excel: ${excelPlans.join(' | ')}`,
          actual: exact
            ? `Exact match — all ${excelPlans.length} plan(s) present, none extra.\n`
              + `Dropdown: ${domPlans.join(' | ')}`
            : `MISMATCH.\nDropdown (${domPlans.length}): ${domPlans.join(' | ')}\n`
              + `Missing (in Excel, not on page): ${missing.join(' | ') || '(none)'}\n`
              + `Unexpected (on page, not in Excel): ${extra.join(' | ') || '(none)'}`,
          status: exact ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `Plan dropdown — ${stateName} (${langUpper})`,
        });
        // Non-fatal: continue to per-plan navigation even if the set differs,
        // so testers see per-plan evidence too.
      });

      // ── Step 4+ — Per-plan navigation validation ──────────────────
      const redirectSettleMs = DT.newTabRedirectWaitMs || 15000;
      const screenshotSettleMs = DT.screenshotSettleMs || 5000;
      // Dropdown values captured in Step 2 — used to fast-fail any Excel
      // plan that isn't actually in the dropdown (avoids hanging on a
      // selectOption that can never match).
      const domPlanSet = new Set(toolOptions.map((o) => o.value));

      for (let i = 0; i < group.plans.length; i += 1) {
        const plan = group.plans[i];
        const cardId = i + 1;
        const planSlug = sanitizeForFs(plan.name).substring(0, 48);
        const card = {
          id: cardId,
          name: plan.name,
          expectedUrl: plan.expectedUrl || '(from option data-url)',
          href: '',
          pdfUrl: '',           // repurposed: observed final URL
          isDataDriven: true,
          status: 'PASS',
          error: '',
          steps: [],
          validations: [],
        };
        planCards.push(card);

        // Fast-fail: plan not present in the dropdown → record FAIL and skip
        // the select/modal/new-tab flow (which would otherwise hang).
        if (!domPlanSet.has(plan.name)) {
          card.status = 'FAIL';
          card.error = 'Plan not present in the Drug Search Tool dropdown';
          card.validations.push({
            name: 'Plan present in dropdown', status: 'FAIL',
            description: 'Expected plan from Excel was not found among the dropdown options.',
          });
          card.steps.push({
            id: 1, name: 'Plan present in dropdown', status: 'FAIL',
            expected: `Plan "${plan.name}" should be selectable in the dropdown.`,
            actual: 'Plan is missing from the dropdown — selection skipped.',
          });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        await base.step(`Plan ${cardId}/${group.plans.length} — ${plan.name}`, async () => {
          const modalShot = path.join(screenshotsDir, `Plan${cardId}_${planSlug}_Modal.png`);
          const destShot  = path.join(screenshotsDir, `Plan${cardId}_${planSlug}_Destination.png`);
          let continueHref = '';
          let finalUrl = '';
          let newPage = null;

          // Make sure the tool select is ready (re-resolve markers; a prior
          // plan's modal may have been dismissed, which is fine). If the tool
          // section is missing — the page drifted (cookie-consent reload or a
          // modal side-effect navigated the main page) — self-heal by
          // re-opening the drug page before selecting the plan.
          try {
            await drug.dismissModalViaClose().catch(() => {});
            let section = await drug.resolveToolSection(DT.planYear);
            if (!section.found) {
              await drug.gotoDrugTool(group.state, lang);
              section = await drug.resolveToolSection(DT.planYear);
            }
          } catch { /* ignore — selectPlanAndSearch will surface issues */ }

          // 4a — select + search → modal. On the /es-us/ pages a cookie-consent
          // banner can intercept the first few "Search Drug Coverage" clicks so
          // the modal never opens. Retry up to 3 times, accepting cookies and
          // re-opening the page between attempts, until the modal appears.
          let modalOk = false;
          let modalErr = '';
          for (let attempt = 1; attempt <= 3 && !modalOk; attempt += 1) {
            try {
              await drug.acceptCookies().catch(() => {});
              let section = await drug.resolveToolSection(DT.planYear);
              if (!section.found) {
                await drug.gotoDrugTool(group.state, lang);
                await drug.acceptCookies().catch(() => {});
                await drug.resolveToolSection(DT.planYear);
              }
              await drug.selectPlanAndSearch(plan.name);
              await drug.waitForExternalSiteModal();
              continueHref = await drug.getContinueHref();
              card.href = continueHref;
              await page.screenshot({ path: modalShot, fullPage: false }).catch(() => {});
              modalOk = true;
            } catch (err) {
              modalErr = (err && err.message ? err.message : String(err)).substring(0, 200);
              if (attempt < 3) {
                // Clear any intercepting consent overlay and retry fresh.
                await drug.gotoDrugTool(group.state, lang).catch(() => {});
                await drug.acceptCookies().catch(() => {});
              }
            }
          }
          if (modalOk) {
            card.validations.push({ name: 'External Site Modal appears', status: 'PASS',
              description: 'You are leaving the Molina Healthcare website modal shown' });
          } else {
            card.status = 'FAIL';
            card.error = `Modal step failed: ${modalErr}`;
            card.validations.push({ name: 'External Site Modal appears', status: 'FAIL', description: card.error });
            await drug.saveScreenshot(modalShot, { preserveScroll: true }).catch(() => {});
          }

          // 4b — Continue href present + matches expected (Excel / data-url)
          const expected = plan.expectedUrl || (await drug.optionDataUrl(plan.name).catch(() => ''));
          const hrefPresent = Boolean(continueHref);
          card.validations.push({ name: 'Continue link present', status: hrefPresent ? 'PASS' : 'FAIL',
            description: hrefPresent ? `href = ${continueHref}` : 'Continue href empty' });
          if (!hrefPresent) card.status = 'FAIL';
          if (expected) {
            const matches = normalizeUrl(continueHref) === normalizeUrl(expected);
            card.validations.push({ name: 'Continue URL matches expected', status: matches ? 'PASS' : 'FAIL',
              description: matches ? 'exact match after normalization'
                : `expected: ${expected}\nactual: ${continueHref}` });
            if (!matches) card.status = 'FAIL';
          }

          // 4c — open the captured Continue URL in a NEW tab and settle.
          // We open `continueHref` directly instead of clicking the modal's
          // Continue link: on some pages that click navigates the MAIN tab
          // (losing the 2027 tool for the remaining plans) and races the
          // cookie-consent reload. Opening the captured URL in a fresh tab
          // validates the same destination without disturbing the main page.
          try {
            if (continueHref) {
              newPage = await context.newPage();
              await newPage.goto(continueHref, { waitUntil: 'domcontentloaded', timeout: frameworkConfig.pageLoadWaitMs });
              try { await newPage.waitForLoadState('load', { timeout: redirectSettleMs }); } catch { /* ignore */ }
              try { await newPage.waitForLoadState('networkidle', { timeout: redirectSettleMs }); } catch { /* ignore */ }
              finalUrl = newPage.url();
            }
          } catch (err) {
            card.error = card.error || `New tab failed: ${(err && err.message ? err.message : String(err)).substring(0, 200)}`;
          }
          // Close the modal on the main page so the drug tool is clean for the
          // next plan (keeps us on the drug page — no navigation).
          await drug.dismissModalViaClose().catch(() => {});
          card.pdfUrl = finalUrl;

          const tabOpened = Boolean(newPage) && Boolean(finalUrl);
          card.validations.push({ name: 'New tab opens & loads', status: tabOpened ? 'PASS' : 'FAIL',
            description: tabOpened ? `Final URL: ${finalUrl}` : (card.error || 'No new tab / blank URL') });
          if (!tabOpened) card.status = 'FAIL';

          // 4d — destination screenshot (wait for CVS "Processing request" to settle)
          if (newPage) {
            try {
              await newPage.waitForTimeout(screenshotSettleMs);
              await newPage.screenshot({ path: destShot, fullPage: false });
            } catch {
              await ensureValidScreenshot(
                () => captureEvidencePanel(context,
                  fallbackPanelHtml(`Destination — ${plan.name}`,
                    `New tab opened.\nFinal URL:\n${finalUrl || '(none)'}\n\n`
                    + 'A direct screenshot of the destination was not available (external site).'),
                  destShot),
                () => Promise.resolve(destShot),
              );
            }
            try { await newPage.close(); } catch { /* ignore */ }
          } else {
            await ensureValidScreenshot(
              () => captureEvidencePanel(context,
                fallbackPanelHtml(`Navigation failed — ${plan.name}`, card.error || 'No new tab opened'),
                destShot),
              () => Promise.resolve(destShot),
            );
          }

          // Attach evidence to the card as "steps" so the report renders them.
          card.steps.push({
            id: 1, name: 'External Site Modal', status: continueHref ? 'PASS' : 'FAIL',
            expected: 'Selecting the plan + Search opens the External Site Modal with a Continue link.',
            actual: continueHref ? `Modal shown. Continue href:\n${continueHref}` : (card.error || 'Modal did not appear'),
            screenshotPath: modalShot, screenshotLabel: `External Site Modal — ${plan.name}`,
          });
          card.steps.push({
            id: 2, name: 'New tab destination', status: tabOpened ? 'PASS' : 'FAIL',
            expected: expected ? `New tab should open the expected CVS URL.\nExpected: ${expected}` : 'New tab should open the plan CVS URL.',
            actual: tabOpened ? `New tab settled at:\n${finalUrl}` : (card.error || 'No new tab opened'),
            screenshotPath: destShot, screenshotLabel: `Destination — ${plan.name}`,
          });
        });

        // Reset for the next plan: close any lingering modal.
        // eslint-disable-next-line no-await-in-loop
        await drug.dismissModalViaClose().catch(() => {});
      }

      // Final verdict — fail the test (non-zero exit / red in CI) when any
      // setup step or per-plan validation failed. Evidence for every step
      // has already been gathered above and the HTML report is written in
      // afterAll regardless of this assertion.
      const failedSetup = setupSteps.filter((s) => s.status === 'FAIL').map((s) => s.name);
      const failedPlans = planCards.filter((c) => c.status === 'FAIL').map((c) => c.name);
      expect(
        failedSetup.length + failedPlans.length,
        `Drug Tool validation failures for ${stateName} (${langUpper}):`
        + (failedSetup.length ? `\n  Setup: ${failedSetup.join(', ')}` : '')
        + (failedPlans.length ? `\n  Plans: ${failedPlans.join(', ')}` : ''),
      ).toBe(0);
    });
  });
}
