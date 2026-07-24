/**
 * Marketplace — Plan Search + Per-Plan PDF Validation (Requirement 2)
 *
 * Business flow (per Excel row):
 *   Step 1  Launch Marketplace URL (cookie banner dismissed implicitly)
 *   Step 2  Open "Member Resources" navigation
 *   Step 3  Open "Forms & Documents" page
 *   Step 4  Select state → capture default coverage year (2026)
 *           → assert URL contains `year=2026`
 *   Step 5  Click Coverage Year 2027 → assert URL contains `year=2027`
 *   Step 6  Apply filters: Audience + Category (both from the data sheet
 *           so testers can vary them without touching code)
 *   Step 7  Type PlanName in the search box → click Search
 *   Step 8+ For each cell in `ExpectedUrls` (pipe-separated), match the
 *           result card whose title equals PlanName AND whose href
 *           pathname matches the expected URL pathname, click it, wait
 *           for the new tab, capture its URL, and validate against
 *           ExpectedUrls[i]. Each expected URL produces ONE plan
 *           card in the HTML report.
 *
 * Data model (data/MarketplacePlansData.xlsx, sheet `Plans`):
 *   Run           — 'Y' to include, anything else to skip
 *   TestId        — descriptive id, e.g. "TC001 MP-PLANS <Category> <Plan> OH-2027"
 *   State         — 2-letter code (case-insensitive)
 *   Year          — coverage year to toggle to (default 2027)
 *   Audience      — checkbox value, e.g. "Member" / "Medicare"
 *   Category      — checkbox value, e.g. "Summary of Benefits"
 *   PlanName      — text typed into the search box + used to filter cards
 *   ExpectedUrls  — pipe-separated absolute or relative URLs; one per
 *                   matching card (in card DOM order)
 *
 * Framework reuse (nothing new introduced):
 *   • pages/marketplacePage.js — shared page object (extended with filter/
 *                                search/card helpers)
 *   • fixtures/planMaterialsFixture.js — NOT used (linear flow, no shared
 *                                accordion state to hand-off between tests)
 *   • utils/browserHelper.js   — launchFreshBrowser + stealth + cleanup
 *   • utils/screenshotHelpers.js — ensureValidScreenshot + real-PDF preview
 *   • helpers/evidencePanel.js — panel HTML builders
 *   • reporting/reportGenerator.js — writeReport (planCards shape)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { test: base, expect } = require('@playwright/test');

const frameworkConfig = require('../../config/framework.config');
const logger = require('../../utils/logger');
const { MarketplacePage } = require('../../pages/marketplacePage');
const {
  pushSetupStep,
  pushPlanStep,
  pdfNewTabPanelHtml,
  urlValidationPanelHtml,
  fallbackPanelHtml,
} = require('../../helpers/evidencePanel');
const {
  captureEvidencePanel,
  ensureValidScreenshot,
  renderPdfFirstPageAsDataUri,
} = require('../../utils/screenshotHelpers');
const { writeReport } = require('../../reporting/reportGenerator');

// ══════════════════════════════════════════════════════════════════════════
// Config — all values come from framework.config.js
// ══════════════════════════════════════════════════════════════════════════

const MPP = frameworkConfig.marketplacePlans;

const APP_URL_DEFAULT = MPP.urls.appUrl;
const EXCEL_PATH      = MPP.excelPath;
const EXCEL_SHEET     = MPP.excelSheet;
const ADDITIONAL_SHEET = MPP.additionalSearchesSheet || 'AdditionalSearches';

const FILTER_STATE = String(MPP.filters.state || '').trim();
const FILTER_YEAR  = String(MPP.filters.year  || '').trim();
const FILTER_PLAN  = String(MPP.filters.plan  || '').trim().toLowerCase();

const REPORT_DIR = MPP.report.dir;

const TEST_MODULE      = MPP.test.module;
const TEST_AUTHOR      = MPP.test.author;
const TEST_ENVIRONMENT = MPP.test.environment;

const NEW_TAB_TIMEOUT    = frameworkConfig.pageLoadWaitMs   || 45000;
const PDF_RENDER_WAIT    = frameworkConfig.waitAfterNetworkIdleMs || 2000;

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

const norm = (v) => String(v == null ? '' : v).trim();

/** Auto-detect environment label from an app URL. */
function envLabelFromUrl(url) {
  const u = String(url || '');
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('pws-q2')) return 'Q2 (pws-q2)';
  if (u.includes('pws-q1')) return 'Q1 (pws-q1)';
  return 'PROD';
}

/**
 * Sanitize a descriptive TestId marketplace-style so it can be used as
 * both a filesystem folder AND a self-identifying report filename.
 * Rules (mirror tests/marketplace/marketplace.spec.js):
 *   - Strip Windows-invalid path chars (\ / : * ? " < > |)
 *   - Drop parentheses
 *   - Collapse whitespace to underscores
 */
function sanitizeForFs(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Normalize an expected URL for comparison against the actual PDF URL that
 * Chrome loads in the new tab. Compares by **pathname only** (case-insensitive,
 * trailing-slash-stripped) so environment-specific hosts — e.g. prod
 * `www.molinahealthcare.com` vs Q3 `pws-q3.molinahealthcare.com` — don't
 * cause false FAILs. Query string / fragment are ignored.
 */
function normalizeUrlForCompare(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url));
    return u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url).trim().toLowerCase()
      .replace(/^https?:\/\/[^/]+/, '')   // drop scheme + host
      .replace(/[?#].*$/, '')             // drop query + fragment
      .replace(/\/+$/, '');               // drop trailing slash
  }
}

/**
 * If an ExpectedUrls entry is a bare path (starts with `/`), prepend the
 * app URL's origin so the comparison keeps working after Molina serves the
 * PDF from an absolute Akamai host at click time.
 */
function absolutizeUrl(u, baseAppUrl) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  try {
    const origin = new URL(baseAppUrl).origin;
    if (s.startsWith('/')) return origin + s;
    return origin + '/' + s;
  } catch {
    return s;
  }
}

/**
 * Convert a 2-letter US state code to its full name for use in the report
 * (e.g. "OH" → "Ohio"). Only includes the 17 states Molina lists in its
 * marketplace state dropdown — for any other code the raw code is returned.
 */
const STATE_CODE_TO_NAME = {
  AZ: 'Arizona',
  CA: 'California',
  ID: 'Idaho',
  IA: 'Iowa',
  IL: 'Illinois',
  KY: 'Kentucky',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MS: 'Mississippi',
  NV: 'Nevada',
  NM: 'New Mexico',
  OH: 'Ohio',
  TX: 'Texas',
  UT: 'Utah',
  VA: 'Virginia',
  WA: 'Washington',
  WI: 'Wisconsin',
};
function fullNameForStateCode(code) {
  const key = String(code || '').trim().toUpperCase();
  return STATE_CODE_TO_NAME[key] || key;
}

// ══════════════════════════════════════════════════════════════════════════
// Matrix loader
// ══════════════════════════════════════════════════════════════════════════

function loadTestMatrix() {
  if (!EXCEL_PATH || !fs.existsSync(EXCEL_PATH)) {
    logger.warn('MP-PLANS', `Excel not found: ${EXCEL_PATH || '(unset)'} — running 0 tests`);
    return [];
  }
  let wb;
  try {
    wb = XLSX.readFile(EXCEL_PATH);
  } catch (err) {
    logger.warn('MP-PLANS', `Excel read failed (${EXCEL_PATH}): ${err.message.substring(0, 120)} — running 0 tests`);
    return [];
  }
  const primarySheet = wb.Sheets[EXCEL_SHEET] || wb.Sheets[wb.SheetNames[0]];
  if (!primarySheet) {
    logger.warn('MP-PLANS', `Sheet "${EXCEL_SHEET}" missing — running 0 tests`);
    return [];
  }

  const rows   = XLSX.utils.sheet_to_json(primarySheet, { defval: '' });
  const active = rows.filter(r => norm(r.Run).toUpperCase() === 'Y');

  // ── Companion sheet: additional searches joined by TestId ──────────────
  // Each row = { TestId, Label, Audience, Category, ExpectedUrls }. Testers
  // add one row per additional search-and-verify pass. Missing sheet or
  // zero matching rows → the test just runs its primary search.
  const addSheet = wb.Sheets[ADDITIONAL_SHEET];
  const additionalRows = addSheet
    ? XLSX.utils.sheet_to_json(addSheet, { defval: '' })
    : [];

  /** Build a `search` sub-object from a raw row (primary or additional). */
  const toSearch = (r) => ({
    label:        norm(r.Label),          // e.g. 'SBC', 'SOB'
    audience:     norm(r.Audience),       // filter checkbox value
    category:     norm(r.Category),       // filter checkbox value
    expectedUrls: norm(r.ExpectedUrls)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean),
  });

  const scopes = active.map((r, i) => {
    const state    = norm(r.State).toUpperCase();
    const year     = norm(r.Year);
    const plan     = norm(r.PlanName);
    const testId   = norm(r.TestId);

    // Primary search from the `Plans` row.
    const searches = [toSearch(r)];

    // Additional searches: rows in AdditionalSearches whose TestId matches
    // (case-insensitive). Preserved in sheet order.
    const testIdKey = testId.toLowerCase();
    additionalRows
      .filter(ar => norm(ar.TestId).toLowerCase() === testIdKey)
      .forEach(ar => searches.push(toSearch(ar)));

    return {
      row:  i + 2,           // Excel row number (header is row 1)
      testId,
      state,
      year:  year || String(frameworkConfig.marketplace?.years?.alternate || '2027'),
      planName: plan,
      searches,
      appUrl:   APP_URL_DEFAULT,
      source:   'excel',
    };
  })
  .filter((s) => s.state && s.planName && s.searches[0] && s.searches[0].expectedUrls.length > 0)
  .filter((s) => !FILTER_STATE || s.state === FILTER_STATE.toUpperCase())
  .filter((s) => !FILTER_YEAR  || s.year  === FILTER_YEAR)
  .filter((s) => !FILTER_PLAN  || s.planName.toLowerCase().includes(FILTER_PLAN));

  if (!scopes.length) {
    const filters = [FILTER_STATE && `state=${FILTER_STATE}`, FILTER_YEAR && `year=${FILTER_YEAR}`, FILTER_PLAN && `plan~${FILTER_PLAN}`]
      .filter(Boolean).join(', ');
    logger.warn('MP-PLANS',
      `No Run=Y rows in ${path.basename(EXCEL_PATH)}${filters ? ` matching filter(s) ${filters}` : ''} — running 0 tests`);
    return [];
  }
  const totalSearches = scopes.reduce((n, s) => n + s.searches.length, 0);
  logger.info('MP-PLANS',
    `Loaded ${scopes.length} scope(s) with ${totalSearches} search(es) total from ${path.basename(EXCEL_PATH)}`);
  return scopes;
}

// ══════════════════════════════════════════════════════════════════════════
// Test registration
// ══════════════════════════════════════════════════════════════════════════

const TEST_MATRIX = loadTestMatrix();

if (TEST_MATRIX.length === 0) {
  base.describe('Marketplace Plan Search — matrix', () => {
    base('No plan-search scopes matched the current filters', () => {
      throw new Error(
        'MarketplacePlans matrix is empty. Check:\n'
        + `  • Excel file: ${EXCEL_PATH}\n`
        + '  • At least one row with Run=Y, TestId, State, PlanName, ExpectedUrls\n'
        + `  • Filters: STATE="${FILTER_STATE}", YEAR="${FILTER_YEAR}", PLAN~"${FILTER_PLAN}"`
      );
    });
  });
} else {
  for (const scope of TEST_MATRIX) registerScope(scope);
}

// ─────────────────────────────────────────────────────────────────────────
// One describe + one test per Excel row. Each ExpectedUrl becomes its own
// "plan card" in the HTML report so per-URL PASS/FAIL is clearly visible.
// ─────────────────────────────────────────────────────────────────────────

function registerScope(scope) {
  const testIdSlug   = scope.testId ? sanitizeForFs(scope.testId) : `Row${scope.row}`;
  const shortCode    = scope.testId ? scope.testId.split(/\s+/)[0] : `Row${scope.row}`;
  const scopeDir     = path.join(REPORT_DIR, testIdSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile   = path.join(scopeDir, `${testIdSlug}.html`);

  const describeTitle = scope.testId
    || `Marketplace Plan Search — ${scope.state} · ${scope.year} · ${scope.planName}`;

  const testName        = `Marketplace Plan Search — ${scope.planName} (${fullNameForStateCode(scope.state)} · ${scope.year})`;

  const primary = scope.searches[0];
  const totalUrls = scope.searches.reduce((n, s) => n + s.expectedUrls.length, 0);
  const searchLabels = scope.searches
    .map((s, i) => s.label ? s.label : `Search ${i + 1}`)
    .join(' + ');
  const testDescription =
    `Launch Molina Marketplace , navigate through Member Resources → Forms & Documents, `
    + `select state "${fullNameForStateCode(scope.state)}", toggle to coverage year ${scope.year}, `
    + `search for plan "${scope.planName}", then validate the plan is opening in new tab `
    + `for each document type (${searchLabels}).`;

  base.describe(describeTitle, () => {
    base.describe.configure({ retries: 0, mode: 'serial' });

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
            id:          scope.testId || `MP-PLANS-Row${scope.row}`,
            module:      TEST_MODULE,
            description: testDescription,
            author:      TEST_AUTHOR,
            environment: TEST_ENVIRONMENT || envLabelFromUrl(scope.appUrl),
          },
          appUrl:         scope.appUrl,
          year:           scope.year,
          accordionLabel: searchLabels,
          setupSteps,
          planCards,
          responsiveShots: [],
          durationMs,
          timestamp: new Date().toLocaleString(),
        });
        logger.info('REPORT', `[${describeTitle}] Report written: ${reportFile}`);

        // Also emit a small companion JSON so hooks/marketplacePlansSummary.js
        // can build the consolidated dashboard without having to parse each
        // per-plan HTML report (which can be many MB with embedded PNGs).
        try {
          const setupFailed = setupSteps.some(s => s.status === 'FAIL');
          const cardFailed  = planCards.some(c => c.status === 'FAIL');
          const overallStatus = (setupFailed || cardFailed) ? 'FAIL' : (planCards.length ? 'PASS' : 'FAIL');
          const variantJson = path.join(scopeDir, 'variant.json');
          fs.writeFileSync(variantJson, JSON.stringify({
            schemaVersion: 1,
            testId:      scope.testId,
            planName:    scope.planName,
            state:       scope.state,
            year:        scope.year,
            appUrl:      scope.appUrl,
            searchLabels,
            status:      overallStatus,
            durationMs,
            testName,
            testDescription,
            setupSteps:  setupSteps.map(s => ({
              id:         s.id,
              name:       s.name,
              status:     s.status,
              durationMs: s.durationMs,
              // Trim long text fields so the JSON stays small — the standalone
              // report still has the full detail if a reviewer needs it.
              expected:   (s.expected || '').substring(0, 500),
              actual:     (s.actual   || '').substring(0, 800),
            })),
            planCards:   planCards.map(c => ({
              id:          c.id,
              name:        c.name,
              status:      c.status,
              expectedUrl: c.expectedUrl,
              pdfUrl:      c.pdfUrl,
              href:        c.href,
              error:       c.error,
              validations: (c.validations || []).map(v => ({
                name:        v.name,
                status:      v.status,
                description: (v.description || '').substring(0, 300),
              })),
            })),
            reportFile: path.relative(path.join(process.cwd(), 'reports', 'marketplace-plans'), reportFile)
                              .split(path.sep).join('/'),
          }, null, 2), 'utf8');
        } catch (jsonErr) {
          logger.warn('REPORT', `[${describeTitle}] Variant JSON write failed: ${jsonErr.message.substring(0, 160)}`);
        }
      } catch (repErr) {
        logger.warn('REPORT', `[${describeTitle}] Failed to write report: ${repErr.message}`);
      }
    });

    base(`${scope.planName} — verify ${totalUrls} PDF URL(s) across ${scope.searches.length} search(es)`,
      async ({ page, context }) => {
        fs.mkdirSync(screenshotsDir, { recursive: true });
        const marketplace = new MarketplacePage(page);

        // ── Step 1 — Launch Application URL ──────────────────────────
        await base.step('Step 1 — Launch Application URL', async () => {
          const t0 = Date.now();
          let launchOk = true;
          let launchErr = '';
          try {
            await marketplace.open(scope.appUrl);
          } catch (err) {
            launchOk = false;
            launchErr = (err && err.message) ? err.message.substring(0, 200) : String(err);
          }
          const shot = path.join(screenshotsDir, 'Step1_Marketplace_Home.png');
          await marketplace.saveScreenshot(shot);
          pushSetupStep(setupSteps, {
            id: 1,
            name: 'Launch Application URL',
            expected: 'Molina home page should load successfully.',
            actual: launchOk
              ? `Home page loaded successfully.\nURL: ${page.url()}`
              : `Failed to load home page: ${launchErr}`,
            status: launchOk ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Marketplace home',
          });
          if (!launchOk) throw new Error(`Step 1 failed: ${launchErr}`);
        });

        // ── Step 2 — Open Member Resources Menu ──────────────────────
        // (Cookies are handled implicitly during Step 1's launch flow, so
        // there is no separate "Accept cookies" step in the report.)
        await base.step('Step 2 — Open Member Resources Menu', async () => {
          const t0 = Date.now();
          let ok = true;
          let errMsg = '';
          try {
            await marketplace.openMemberResources();
          } catch (err) {
            ok = false;
            errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
          }
          const shot = path.join(screenshotsDir, 'Step2_Member_Resources_Menu.png');
          await marketplace.saveScreenshot(shot);
          pushSetupStep(setupSteps, {
            id: 2,
            name: 'Open Member Resources Menu',
            expected: 'Member Resources menu should be opened successfully.',
            actual: ok
              ? 'Member Resources menu opened successfully.'
              : `Failed to open Member Resources menu: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Member Resources menu',
          });
          if (!ok) throw new Error(`Step 2 failed: ${errMsg}`);
        });

        // ── Step 3 — Open Forms & Documents Page ──────────────────────
        await base.step('Step 3 — Open Forms & Documents Page', async () => {
          const t0 = Date.now();
          let ok = true;
          let errMsg = '';
          try {
            await marketplace.openFormsAndDocuments();
          } catch (err) {
            ok = false;
            errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
          }
          const shot = path.join(screenshotsDir, 'Step3_Forms_And_Documents.png');
          await marketplace.saveScreenshot(shot);
          pushSetupStep(setupSteps, {
            id: 3,
            name: 'Open Forms & Documents Page',
            expected: 'Forms & Documents page should be loaded successfully.',
            actual: ok
              ? `Forms & Documents Page loaded successfully.\nURL: ${page.url()}`
              : `Failed to open Forms & Documents Page: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Forms & Documents page',
          });
          if (!ok) throw new Error(`Step 3 failed: ${errMsg}`);
        });

        // ── Step 4 — Select State (verify default year 2026) ────────────
        // Use the FULL state name (e.g. "Ohio") in the step title and the
        // step name — pulled from the dropdown's own <option> label so it
        // always matches Molina's spelling. The 2-letter code (e.g. "OH")
        // is still what selectState() looks up.
        const fullStateName = fullNameForStateCode(scope.state);
        await base.step(`Step 4 — Select state ${fullStateName}`, async () => {
          const t0 = Date.now();
          const res = await marketplace.selectState(scope.state);
          if (!res.selected) {
            const msg = res.reason === 'not-in-dropdown'
              ? `State "${fullStateName}" is not available in the dropdown. Available: [${res.availableStates.join(', ')}]`
              : `Failed to select state "${fullStateName}": ${res.errorMessage || res.reason}`;
            const shot = path.join(screenshotsDir, 'Step4_State_Select_FAIL.png');
            await marketplace.saveScreenshot(shot);
            pushSetupStep(setupSteps, {
              id: 4,
              name: `Select state ${fullStateName}`,
              expected: `State "${fullStateName}" should be selected and the page should default to Coverage Year 2026.`,
              actual: msg,
              status: 'FAIL',
              durationMs: Date.now() - t0,
              screenshotPath: shot,
              screenshotLabel: 'State selection failure',
            });
            throw new Error(msg);
          }

          // Scroll the state/year/filter section into view before evidence.
          await marketplace.scrollToAllFormsAndDocuments();

          const activeYear  = await marketplace.getActiveYear();
          const url         = page.url();
          const yearInUrl   = marketplace.getYearFromUrl(url);
          const defaultOk   = yearInUrl === '2026' || activeYear === '2026';

          const shot = path.join(screenshotsDir, 'Step4_State_Selected.png');
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(setupSteps, {
            id: 4,
            name: `Select state ${fullStateName}`,
            expected: `State "${fullStateName}" should be selected and the page should default to Coverage Year 2026.`,
            actual: defaultOk
              ? `State "${fullStateName}" selected. Active Coverage Year: "${activeYear || '(unknown)'}".\nURL: ${url}`
              : `State "${fullStateName}" selected but default Coverage Year is "${activeYear || '(unknown)'}" (expected 2026).\nURL: ${url}`,
            status: defaultOk ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'State selected — default coverage year',
          });
          expect(defaultOk, `Expected default coverage year 2026 after selecting state; got activeYear=${activeYear}, urlYear=${yearInUrl}`).toBeTruthy();
        });

        // ── Step 5 — Toggle to Coverage Year (scope.year) ────────────────
        await base.step(`Step 5 — Toggle Coverage Year to ${scope.year}`, async () => {
          const t0 = Date.now();
          await marketplace.selectCoverageYear(scope.year);
          await marketplace.scrollToAllFormsAndDocuments();
          const url         = page.url();
          const yearInUrl   = marketplace.getYearFromUrl(url);
          const activeYear  = await marketplace.getActiveYear();
          const urlOk       = yearInUrl === String(scope.year);
          const statusOk    = urlOk && (activeYear == null || activeYear === String(scope.year));

          const shot = path.join(screenshotsDir, `Step5_Year_${scope.year}.png`);
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(setupSteps, {
            id: 5,
            name: `Toggle Coverage Year to ${scope.year}`,
            expected: `Coverage Year ${scope.year} should become active.`,
            actual: statusOk
              ? `Coverage Year ${scope.year} is now active.\nURL: ${url}`
              : `Coverage Year ${scope.year} did not become active. Active year: "${activeYear || '(unknown)'}".\nURL: ${url}`,
            status: statusOk ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: `Coverage year ${scope.year}`,
          });
          expect(urlOk, `Expected URL to contain year=${scope.year} after toggling; got ${url}`).toBeTruthy();
        });

        // ── Steps 6/7 + 8/9 + … — One filter+search+validate cycle per entry
        //                          in scope.searches (typically 1–2 cycles).
        //
        // For the first cycle (primary search from the `Plans` sheet):
        //   * Step 6: check Audience + Category checkboxes
        //   * Step 7: type PlanName, search, resolve expected URLs
        //   * Then per-URL PDF validation as plan cards
        //
        // For each additional cycle (from `AdditionalSearches` sheet):
        //   * Step N: uncheck the PREVIOUS cycle's Audience, then check the
        //             new Audience (Category re-applied only if different)
        //   * Step N+1: search PlanName again, resolve expected URLs
        //   * Plan cards continue numbering globally so all evidence lives
        //     in ONE report.
        //
        // Plan-card names are prefixed with `[<Label>]` so the report
        // clearly groups SBC vs SOB (or whatever document types are used).
        //
        // Two language passes are run back-to-back on the SAME page (no
        // re-navigation from the home page for Spanish):
        //   1. English pass  — filter + search + verify for every search
        //   2. Language switch step (clicks the header Language dropdown)
        //   3. Spanish pass  — same searches repeated, labels get " · ES"
        // Plan-card names use [<Label> · EN] / [<Label> · ES] so the report
        // clearly separates the two language halves.
        let planCardIndex = 0;
        let stepId = 6;

        // Each language pass resets its own filter state because the site
        // may drop the Audience/Category selection when the URL prefix
        // changes on language switch.
        const languagePasses = [
          { code: 'en', label: 'EN', switchBefore: false },
          { code: 'es', label: 'ES', switchBefore: true  },
        ];

        for (const pass of languagePasses) {
          // ── Optional language switch between passes ─────────────────
          if (pass.switchBefore) {
            const switchStepId = stepId++;
            await base.step(`Step ${switchStepId} — Switch site language to Spanish`, async () => {
              const t0 = Date.now();
              let ok = true;
              let errMsg = '';
              const urlBefore = page.url();
              try {
                await marketplace.switchLanguage('es');
                await marketplace.scrollToAllFormsAndDocuments();
              } catch (err) {
                ok = false;
                errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
              }
              const urlAfter = page.url();
              const urlOk = /\/es-us\//i.test(urlAfter);
              const passStatus = ok && urlOk;

              const shot = path.join(screenshotsDir, `Step${switchStepId}_LanguageSwitch_ES.png`);
              await marketplace.saveScreenshot(shot, { preserveScroll: true });
              pushSetupStep(setupSteps, {
                id: switchStepId,
                name: 'Switch site language to Spanish',
                expected: 'Language dropdown should open and selecting "Spanish" should navigate to a URL containing "/es-us/".',
                actual: passStatus
                  ? `Language switched to Spanish successfully.\nURL before: ${urlBefore}\nURL after:  ${urlAfter}`
                  : ok
                    ? `Clicked "Spanish" but URL did not switch to /es-us/. URL after: ${urlAfter}`
                    : `Failed to switch language: ${errMsg}`,
                status: passStatus ? 'PASS' : 'FAIL',
                durationMs: Date.now() - t0,
                screenshotPath: shot,
                screenshotLabel: 'Site language switched to Spanish',
              });
              if (!passStatus) throw new Error(`Language switch to Spanish failed: ${errMsg || 'URL still English'}`);
            });
          }

          // Filter state is per-pass — the language switch may reset the
          // Audience / Category UI, so treat each pass's first search as
          // a fresh "apply filters" step.
          let prevAudience = null;
          let prevCategory = null;

          for (let searchIdx = 0; searchIdx < scope.searches.length; searchIdx++) {
            const search = scope.searches[searchIdx];
            const isFirst = searchIdx === 0;
            const baseLabel = search.label || `Search ${searchIdx + 1}`;
            // Label used everywhere (step titles, screenshot filenames,
            // plan-card prefixes) — includes the language tag so EN and
            // ES artefacts never overwrite one another.
            const label = `${baseLabel} · ${pass.label}`;

          // ── Filter application / transition ─────────────────────────
          const filterStepId = stepId++;
          const filterStepTitle = isFirst
            ? `Step ${filterStepId} — Apply filters [${label}] (Audience="${search.audience}", Category="${search.category}")`
            : `Step ${filterStepId} — Change filters to [${label}] (uncheck Audience="${prevAudience}", check Audience="${search.audience}")`;

          await base.step(filterStepTitle, async () => {
            const t0 = Date.now();
            let ok = true;
            let errMsg = '';
            const actions = [];
            try {
              // Ensure the filter sidebar is in the DOM/viewport before we
              // reach for the Audience/Category accordions. The year toggle
              // in Step 5 can leave the page scrolled to the top where the
              // filter panel isn't yet visible, causing openFilterSection
              // to time out waiting for `button.filterTitle`.
              await marketplace.scrollToAllFormsAndDocuments();
              if (!isFirst && prevAudience && prevAudience !== search.audience) {
                await marketplace.unselectFilterOption('Audience', prevAudience);
                actions.push(`unchecked Audience="${prevAudience}"`);
              }
              if (search.audience && search.audience !== prevAudience) {
                await marketplace.selectFilterOption('Audience', search.audience);
                actions.push(`checked Audience="${search.audience}"`);
              }
              if (!isFirst && prevCategory && prevCategory !== search.category) {
                await marketplace.unselectFilterOption('Category', prevCategory);
                actions.push(`unchecked Category="${prevCategory}"`);
              }
              if (search.category && search.category !== prevCategory) {
                await marketplace.selectFilterOption('Category', search.category);
                actions.push(`checked Category="${search.category}"`);
              }
            } catch (err) {
              ok = false;
              errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
            }
            await marketplace.scrollToAllFormsAndDocuments();
            const shot = path.join(screenshotsDir, `Step${filterStepId}_Filters_${sanitizeForFs(label)}.png`);
            await marketplace.saveScreenshot(shot, { preserveScroll: true });

            const expected = isFirst
              ? `Audience "${search.audience}" and Category "${search.category}" filters should be applied for [${label}].`
              : `Filters should transition from [${(scope.searches[searchIdx - 1].label || `Search ${searchIdx}`) + ' · ' + pass.label}] to [${label}]: uncheck Audience="${prevAudience}", check Audience="${search.audience}" (Category unchanged).`;
            const actualDone = actions.length ? actions.join('; ') : 'no filter changes required';
            pushSetupStep(setupSteps, {
              id: filterStepId,
              name: isFirst
                ? `Apply filters for [${label}]`
                : `Change filters to [${label}]`,
              expected,
              actual: ok
                ? `Filters ready for [${label}]: ${actualDone}.`
                : `Failed to apply filters for [${label}]: ${errMsg}`,
              status: ok ? 'PASS' : 'FAIL',
              durationMs: Date.now() - t0,
              screenshotPath: shot,
              screenshotLabel: `Filters — ${label}`,
            });
            if (!ok) throw new Error(`Step ${filterStepId} failed: ${errMsg}`);
          });

          prevAudience = search.audience || prevAudience;
          prevCategory = search.category || prevCategory;

          // ── Search + resolve expected URLs to cards ─────────────────
          const searchStepId = stepId++;
          let resolvedTargets = [];
          let allNameCards = [];
          await base.step(`Step ${searchStepId} — Search "${scope.planName}" [${label}]`, async () => {
            const t0 = Date.now();
            await marketplace.searchByPlanName(scope.planName);
            await marketplace.scrollToAllFormsAndDocuments();

            // Loose diagnostic: how many cards on the results page contain
            // the plan name (word-boundary match). This is what the report
            // shows testers as "Total cards containing plan name: N" and
            // is the pass criterion for Step 7 — Step 8+ then validates
            // each expected URL individually.
            allNameCards = await marketplace.findResultCardsByName(scope.planName);

            // Per-URL strict resolution: for each ExpectedUrl try to bind
            // to a card whose title equals PlanName AND whose href pathname
            // matches. Cards that don't strictly resolve are still tracked
            // and will be surfaced as FAIL in Step 8's per-plan validation.
            resolvedTargets = [];
            for (const rawExpected of search.expectedUrls) {
              const expectedUrl = absolutizeUrl(rawExpected, scope.appUrl);
              const card = await marketplace.findCardByNameAndUrl(scope.planName, expectedUrl);
              resolvedTargets.push({ expectedUrl, card });
            }

            const shot = path.join(screenshotsDir, `Step${searchStepId}_Search_${sanitizeForFs(label)}.png`);
            await marketplace.saveScreenshot(shot, { preserveScroll: true });

            const matchedCount = resolvedTargets.filter(t => t.card).length;
            const enough = allNameCards.length > 0;

            // Per-URL lines: English/Spanish label when the URL path
            // reveals the language; matched href on hit, expected path on miss.
            const lineFor = (t, i) => {
              const langHint = /\/english\//i.test(t.expectedUrl) ? 'English'
                             : /\/spanish\//i.test(t.expectedUrl) ? 'Spanish'
                             : `#${i + 1}`;
              return t.card
                ? `• ${langHint} PDF matched: ${t.card.href}`
                : `• ${langHint} PDF NOT FOUND. Expected href-path: ${t.expectedUrl}`;
            };
            const linesJoined = resolvedTargets.map(lineFor).join('\n');

            const actual = enough
              ? `Plan "${scope.planName}" is present in the search results.\n`
                + `Total cards containing plan name: ${allNameCards.length}\n`
                + `Matched PDF link(s): ${matchedCount}/${resolvedTargets.length}\n`
                + linesJoined
              : `Plan "${scope.planName}" is NOT present in the search results.\n`
                + `Total cards containing plan name: 0`;

            pushSetupStep(setupSteps, {
              id: searchStepId,
              name: `Search for plan "${scope.planName}" [${label}]`,
              expected: `Plan should be searchable and should be available in searched results. Pdf should be available for english and spanish version.`,
              actual,
              status: enough ? 'PASS' : 'FAIL',
              durationMs: Date.now() - t0,
              screenshotPath: shot,
              screenshotLabel: `Search results [${label}] — ${scope.planName}`,
            });
            expect(enough,
              `[${label}] No result cards contain the plan name "${scope.planName}". See setup step ${searchStepId} evidence.`
            ).toBeTruthy();
          });

          // ── Per-plan PDF validation ─────────────────────────────────
          // Plan cards from all searches flow into the same list, indexed
          // globally 1..N. Each card's `name` is prefixed with [<label>]
          // so testers see which search it came from at a glance.
          for (let i = 0; i < resolvedTargets.length; i++) {
            const t = resolvedTargets[i];
            planCardIndex += 1;
            await validateOnePlanUrl({
              index:       planCardIndex,
              expectedUrl: t.expectedUrl,
              card:        t.card,
              planName:    scope.planName,
              labelPrefix: `[${label}] `,
              marketplace,
              context,
              screenshotsDir,
              shotPrefix:  shortCode,
              planCards,
            });
          }
        }  // end inner for-searchIdx (searches within a language pass)
        }  // end outer for-pass (language passes: EN, then ES)

        // If any plan card failed, fail the whole test so CI catches it.
        const failed = planCards.filter(c => c.status === 'FAIL');
        if (failed.length) {
          const names = failed.map(f => `#${f.id} ${f.name}`).join(', ');
          throw new Error(`${failed.length} of ${planCards.length} URL validation(s) failed: ${names}`);
        }
      });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// validateOnePlanUrl — click one card, verify its PDF URL, build a plan card
// ══════════════════════════════════════════════════════════════════════════

async function validateOnePlanUrl({
  index, expectedUrl, card, planName, labelPrefix,
  marketplace, context, screenshotsDir, shotPrefix, planCards,
}) {
  const prefix = labelPrefix || '';
  const card_ = {
    id: index,
    name: card ? `${prefix}${card.title}` : `${prefix}${planName} #${index}`,
    expectedUrl,
    href: card ? card.href : '',
    pdfUrl: '',
    isDataDriven: true,
    status: 'PASS',
    error: '',
    steps: [],
    validations: [],
  };
  planCards.push(card_);

  // Guard: no matching card at this index.
  if (!card) {
    card_.status = 'FAIL';
    card_.error = `No result card at index ${index} for plan "${planName}".`;
    const missShot = path.join(screenshotsDir, `${shotPrefix}_Plan${index}_NotFound.png`);
    await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        fallbackPanelHtml(card_.name, card_.error), missShot),
      () => Promise.resolve(missShot),
    );
    pushPlanStep(card_, {
      id: 1,
      name: 'Open PDF in New Tab',
      expected: `Result card #${index} should be present after searching for "${planName}".`,
      actual: card_.error,
      status: 'FAIL',
      screenshotPath: missShot,
      screenshotLabel: 'Card not found',
    });
    card_.validations.push({ name: 'Plan card present', status: 'FAIL', description: card_.error });
    return;
  }

  // ── Step 1 — Click the card, capture the new-tab URL ──
  let pdfPage = null;
  let pdfOpened = false;
  let pdfPageDataUri = null;

  await base.step(`Plan #${index} — Open PDF in New Tab (${card_.name})`, async () => {
    const t0 = Date.now();
    const linkLoc = card.linkLoc;
    try { await linkLoc.scrollIntoViewIfNeeded(); } catch { /* ignore */ }

    const [maybeNewPage] = await Promise.all([
      context.waitForEvent('page', { timeout: NEW_TAB_TIMEOUT }).catch(() => null),
      linkLoc.click({ timeout: frameworkConfig.elementInteractionTimeoutMs }),
    ]);

    if (maybeNewPage) {
      pdfPage = maybeNewPage;
      try { await pdfPage.waitForURL(/\.pdf(\?|#|$)/i, { timeout: NEW_TAB_TIMEOUT }); } catch { /* continue */ }
      try { await pdfPage.waitForLoadState('domcontentloaded', { timeout: NEW_TAB_TIMEOUT }); } catch {}
      card_.pdfUrl = pdfPage.url();
      pdfOpened = !!card_.pdfUrl;
      pdfPageDataUri = await capturePdfPageAsDataUri(pdfPage);
    } else {
      card_.error = 'No new tab opened within timeout';
    }

    const openShot = path.join(screenshotsDir, `${shotPrefix}_Plan${index}_Step1_OpenPDF.png`);
    const openRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        pdfNewTabPanelHtml(card_.name, card_.pdfUrl, pdfPageDataUri, pdfOpened),
        openShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(card_.name, 'Could not render the PDF new-tab evidence panel.'),
        openShot),
    );

    pushPlanStep(card_, {
      id: 1,
      name: 'Open PDF in New Tab',
      expected: `Clicking the plan "${card_.name}" should open the PDF in a new tab.`,
      actual: pdfOpened
        ? `A new tab opened and loaded the PDF successfully.\nURL: ${card_.pdfUrl}`
        : `No new tab opened within ${NEW_TAB_TIMEOUT}ms after clicking the plan.`,
      status: pdfOpened ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: openRes.filePath,
      screenshotLabel: `PDF opened in new tab — ${card_.name}`,
    });
    card_.validations.push({
      name: 'PDF opens in new tab',
      status: pdfOpened ? 'PASS' : 'FAIL',
      description: pdfOpened ? `Opened at ${card_.pdfUrl}` : 'No new tab was detected within the timeout.',
    });
  });

  // ── Step 2 — Verify the PDF URL against ExpectedUrls[i] ──
  await base.step(`Plan #${index} — Verify PDF URL against expected`, async () => {
    const t0 = Date.now();
    const urlNotEmpty = !!card_.pdfUrl;
    const urlHasPdf   = /\.pdf(\?|#|$)/i.test(card_.pdfUrl);
    const urlMatches  = normalizeUrlForCompare(card_.pdfUrl) === normalizeUrlForCompare(expectedUrl);

    const urlChecks = [
      { label: 'PDF URL not empty',       pass: urlNotEmpty, detail: card_.pdfUrl || '(empty)' },
      { label: 'PDF URL contains ".pdf"', pass: urlHasPdf,   detail: card_.pdfUrl },
      {
        label: 'PDF URL matches expected',
        pass: urlMatches,
        detail: urlMatches ? 'exact match (ignoring query/fragment/trailing slash)' : `expected: ${expectedUrl}`,
      },
    ];
    const urlOverall = urlChecks.every(c => c.pass);

    const urlShot = path.join(screenshotsDir, `${shotPrefix}_Plan${index}_Step2_VerifyURL.png`);
    const urlRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        urlValidationPanelHtml(card_.name, card_.pdfUrl, expectedUrl, urlChecks),
        urlShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(card_.name, 'Could not render URL validation panel.'),
        urlShot),
    );

    pushPlanStep(card_, {
      id: 2,
      name: 'Verify PDF URL',
      expected: `PDF URL should match the expected URL.\nExpected: ${expectedUrl}`,
      actual: urlOverall
        ? `PDF URL matches expected successfully.\nActual: ${card_.pdfUrl || '(empty)'}`
        : `PDF URL does not match expected.\nActual: ${card_.pdfUrl || '(empty)'}`,
      status: urlOverall ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: urlRes.filePath,
      screenshotLabel: `URL validation — ${card_.name}`,
    });
    card_.validations.push({
      name: 'PDF URL matches expected',
      status: urlOverall ? 'PASS' : 'FAIL',
      description: urlOverall ? 'All URL checks passed.' : urlChecks.filter(c => !c.pass).map(c => `${c.label} → ${c.detail}`).join('; '),
    });
    if (!urlOverall) card_.status = 'FAIL';
  });

  // Clean up the PDF tab so it doesn't leak into the next card's click.
  if (pdfPage) { await pdfPage.close().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════════════════
// PDF page-level screenshot capture — identical logic to drug spec.
// Chrome's PDF viewer paints outside the DOM so page.screenshot() returns
// a black rectangle. We try (1) CDP capture with fromSurface:false, (2)
// plain page.screenshot fallback, then (3) render page 1 ourselves via
// pdfjs-dist so the report always shows the real PDF cover.
// ══════════════════════════════════════════════════════════════════════════

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isUniformPngBuffer(buf) {
  if (!buf || buf.length < 24) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return false;
  const width  = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const pixels = width * height;
  if (pixels <= 0) return false;
  return (buf.length / pixels) < 0.01;
}

async function capturePdfPageAsDataUri(pdfPage) {
  try {
    try { await pdfPage.waitForLoadState('load', { timeout: NEW_TAB_TIMEOUT }); } catch { /* ignore */ }
    await pdfPage.waitForTimeout(PDF_RENDER_WAIT);

    let buf = null;
    try {
      const client = await pdfPage.context().newCDPSession(pdfPage);
      const { data } = await client.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: false,
        captureBeyondViewport: false,
      });
      await client.detach().catch(() => {});
      if (data) buf = Buffer.from(data, 'base64');
    } catch (cdpErr) {
      logger.warn('SCREENSHOT', `CDP PDF capture failed (${cdpErr.message.substring(0, 80)}), falling back to page.screenshot`);
    }

    if (!buf || buf.length < 3000 || isUniformPngBuffer(buf)) {
      buf = await pdfPage.screenshot({ fullPage: false, type: 'png' });
    }

    if (buf && buf.length >= 3000 && !isUniformPngBuffer(buf)) {
      return `data:image/png;base64,${buf.toString('base64')}`;
    }

    const pdfUrl = pdfPage.url();
    if (/\.pdf(\?|#|$)/i.test(pdfUrl)) {
      logger.info('PDF', `Native PDF viewer capture blank — rendering page 1 via pdfjs-dist for ${pdfUrl.split('/').pop()}`);
      const rendered = await renderPdfFirstPageAsDataUri(pdfPage.context(), pdfUrl);
      if (rendered) return rendered;
    }

    logger.warn('SCREENSHOT', 'PDF preview unavailable (native blank, pdfjs render failed) — using placeholder.');
    return null;
  } catch (err) {
    logger.warn('SCREENSHOT', `PDF page screenshot failed: ${err.message.substring(0, 120)}`);
    return null;
  }
}
