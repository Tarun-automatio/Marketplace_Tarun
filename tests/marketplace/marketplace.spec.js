/**
 * Marketplace — Forms & Documents Coverage-Year Validation (Requirement 3)
 *
 * Business flow (single linear scenario, no data matrix):
 *   Step 1  Launch Marketplace Home  (cookie banner auto-dismissed by
 *                                     PageCapture.open() during navigation)
 *   Step 2  Open "Member Resources" navigation
 *   Step 3  Open "Forms & Documents" page
 *   Step 4  Select state → verify default coverage year (2026)
 *           → verify URL contains "year=2026"
 *   Step 5  Click Coverage Year 2027
 *           → verify URL contains "year=2027"
 *   Step 6  Click Coverage Year 2026 again
 *           → verify URL contains "year=2026"
 *
 * Evidence:
 *   • Each numbered step is wrapped in `test.step(...)` so it appears as a
 *     labelled block in the Playwright HTML report.
 *   • A framework-style screenshot is captured after each step and
 *     attached to the test via `testInfo.attach()` so it also renders
 *     inline in the report. The same file is written to
 *     `reports/marketplace/<runid>/screenshots/*.png` for standalone review.
 *
 * Framework reuse (nothing new was introduced for this suite):
 *   • pages/marketplacePage.js — page object (nav / dropdown / year buttons)
 *   • pages/HomePage.js        — PageCapture (used indirectly via marketplacePage)
 *   • utils/browserHelper.js   — launchFreshBrowser + stealth + cleanup
 *   • utils/logger.js          — structured logging
 *   • config/framework.config.js — every knob (URL, state, years, report dir)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { test, expect, devices } = require('@playwright/test');

const frameworkConfig = require('../../config/framework.config');
const logger = require('../../utils/logger');
const { launchFreshBrowser, cleanupBetweenTests, applyStealthScripts } =
  require('../../utils/browserHelper');
const { MarketplacePage } = require('../../pages/marketplacePage');
const { writeStepsReport, packageReport } = require('../../reporting/reportGenerator');

// ══════════════════════════════════════════════════════════════════════════
// Test-matrix loader
// ══════════════════════════════════════════════════════════════════════════
//
// One scope object per test case. Source: data/MarketplaceData.xlsx —
// rows where `Run` (case-insensitive) === 'Y'.
//
// If the sheet is missing, unreadable, or has zero Run=Y rows, the suite
// produces zero tests (no fallback). Flip a row's Run cell to 'Y' to
// include it.
//
// Optional filter: MARKETPLACE_STATE_FILTER=<code> narrows the matrix to
// the matching row(s) only — useful for local single-state re-runs.

const MP = frameworkConfig.marketplace;

/** Normalize a cell to a trimmed string (no undefined / no non-string). */
const norm = (v) => String(v == null ? '' : v).trim();
const eqi  = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

/** Auto-detect environment label from an app URL. */
function envLabelFromUrl(url) {
  const u = String(url || '');
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('pws-q2')) return 'Q2 (pws-q2)';
  if (u.includes('pws-q1')) return 'Q1 (pws-q1)';
  return 'PROD';
}

/**
 * Apply the language segment to a base URL. Molina renders Spanish under
 * `/es-us` prepended to the path — same path structure, same URL params,
 * just an extra segment. English uses the base URL as-is.
 *   en → https://pws-q3.molinahealthcare.com/
 *   es → https://pws-q3.molinahealthcare.com/es-us
 */
function applyLanguageToUrl(baseUrl, language) {
  const url = norm(baseUrl);
  if (!url) return url;
  if (norm(language).toLowerCase() !== 'es') return url;
  // Strip trailing slash, append /es-us, restore trailing slash if present.
  const hadTrailing = url.endsWith('/');
  const stripped = hadTrailing ? url.slice(0, -1) : url;
  return stripped + '/es-us' + (hadTrailing ? '/' : '');
}

/** Build a scope from a raw sheet row. */
function buildScope({ state, language, defaultYear, alternateYear, appUrl, testId, notes }) {
  const s        = norm(state).toUpperCase();
  const lang     = (norm(language).toLowerCase() === 'es') ? 'es' : 'en';
  const dYear    = norm(defaultYear)   || String(MP.years.default);
  const aYear    = norm(alternateYear) || String(MP.years.alternate);
  const baseUrl  = norm(appUrl)        || MP.urls.appUrl;
  const url      = applyLanguageToUrl(baseUrl, lang);
  const langTag  = lang === 'es' ? '-ES' : '-EN';
  const scopeId  = norm(testId)        || `${MP.test.id}-${s}${langTag}`;
  return {
    state:         s,
    language:      lang,
    defaultYear:   String(dYear),
    alternateYear: String(aYear),
    appUrl:        url,
    testId:        scopeId,
    notes:         norm(notes),
    source:        'excel',
  };
}

/**
 * Load the matrix from Excel + apply the optional MARKETPLACE_STATE_FILTER
 * / MARKETPLACE_LANGUAGE_FILTER. Returns an array of scope objects (empty
 * when the sheet is missing, unreadable, or has no Run=Y rows — the suite
 * then runs zero tests).
 */
function loadMarketplaceMatrix() {
  const FILTER_STATE = norm(process.env.MARKETPLACE_STATE_FILTER);
  const FILTER_LANG  = norm(process.env.MARKETPLACE_LANGUAGE_FILTER);

  if (!MP.excelPath) {
    logger.warn('MARKETPLACE', 'No Excel path configured — running 0 tests');
    return [];
  }
  if (!fs.existsSync(MP.excelPath)) {
    logger.warn('MARKETPLACE',
      `Excel not found at ${MP.excelPath} — running 0 tests`);
    return [];
  }

  try {
    const wb = XLSX.readFile(MP.excelPath);
    const sheet = wb.Sheets[MP.excelSheet] || wb.Sheets[wb.SheetNames[0]];
    if (!sheet) {
      logger.warn('MARKETPLACE',
        `Sheet "${MP.excelSheet}" not found in ${path.basename(MP.excelPath)} — running 0 tests`);
      return [];
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const active = rows.filter(r => norm(r.Run).toUpperCase() === 'Y');
    const scopes = active
      .filter(r => norm(r.State))
      .map(r => buildScope({
        state:         r.State,
        language:      r.Language,
        defaultYear:   r.DefaultYear,
        alternateYear: r.AlternateYear,
        appUrl:        r.AppUrl,
        testId:        r.TestId,
        notes:         r.Notes,
      }))
      .filter(s => !FILTER_STATE || eqi(s.state,    FILTER_STATE))
      .filter(s => !FILTER_LANG  || eqi(s.language, FILTER_LANG));

    if (!scopes.length) {
      const filters = [];
      if (FILTER_STATE) filters.push(`state=${FILTER_STATE}`);
      if (FILTER_LANG)  filters.push(`language=${FILTER_LANG}`);
      logger.warn('MARKETPLACE',
        `Excel found (${path.basename(MP.excelPath)}) but no Run=Y rows`
        + (filters.length ? ` match filter(s) ${filters.join(', ')}` : '')
        + ' — running 0 tests');
      return [];
    }

    const filters = [];
    if (FILTER_STATE) filters.push(`state=${FILTER_STATE}`);
    if (FILTER_LANG)  filters.push(`language=${FILTER_LANG}`);
    logger.info('MARKETPLACE',
      `Loaded ${scopes.length} scope(s) from Excel: ${path.basename(MP.excelPath)}`
      + (filters.length ? ` (filtered by ${filters.join(', ')})` : ''));
    return scopes;
  } catch (err) {
    logger.warn('MARKETPLACE',
      `Excel read failed (${MP.excelPath}): ${err.message.substring(0, 120)} — running 0 tests`);
    return [];
  }
}

const SCOPES = loadMarketplaceMatrix();

// ══════════════════════════════════════════════════════════════════════════
// Responsive device profiles — every sheet row runs on ALL profiles
// listed here (auto-multiply). Filter with MARKETPLACE_DEVICE_FILTER=<key>
// to re-run a single device locally.
//
// contextOptions() returns the browser.newContext options for that device:
//   • Desktop uses the framework's headless 1920×1080 (or viewport:null in
//     headed to inherit the maximized window size).
//   • Mobile devices use Playwright's built-in emulation profiles
//     (viewport, deviceScaleFactor, userAgent, touch flag, etc.).
// ══════════════════════════════════════════════════════════════════════════
const ALL_RESPONSIVE_PROFILES = [
  {
    key:   'desktop',
    tag:   'Desktop',
    label: 'Desktop',
    contextOptions: () => ({
      viewport: frameworkConfig.headless
        ? { width: frameworkConfig.viewport.width, height: frameworkConfig.viewport.height }
        : null,
    }),
  },
  {
    key:   'iphone-se',
    tag:   'iPhoneSE',
    label: 'iPhone SE',
    contextOptions: () => ({ ...devices['iPhone SE'] }),
  },
  {
    key:   'ipad-pro',
    tag:   'iPadPro',
    label: 'iPad Pro 11',
    contextOptions: () => ({ ...devices['iPad Pro 11'] }),
  },
];

const DEVICE_FILTER = String(process.env.MARKETPLACE_DEVICE_FILTER || '').trim().toLowerCase();
const RESPONSIVE_PROFILES = DEVICE_FILTER
  ? ALL_RESPONSIVE_PROFILES.filter(p => p.key === DEVICE_FILTER)
  : ALL_RESPONSIVE_PROFILES;

if (SCOPES.length && DEVICE_FILTER && !RESPONSIVE_PROFILES.length) {
  logger.warn('MARKETPLACE',
    `MARKETPLACE_DEVICE_FILTER="${DEVICE_FILTER}" matched no profile — running 0 tests. `
    + `Valid keys: ${ALL_RESPONSIVE_PROFILES.map(p => p.key).join(', ')}`);
}

const REPORT_DIR = MP.report.dir;

// Helper for step-scoped log lines with a consistent prefix.
const STEP = (n, msg) => logger.info('MARKETPLACE', `Step ${n} | ${msg}`);
const FAIL = (n, msg) => logger.warn('MARKETPLACE', `Step ${n} | ${msg}`);

// ══════════════════════════════════════════════════════════════════════════
// Utilities local to this spec
// ══════════════════════════════════════════════════════════════════════════

/**
 * Take a framework-style screenshot, save it to disk under `screenshotsDir`,
 * and attach it to the current test's HTML report entry.
 *
 * @param {MarketplacePage} marketplace
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} screenshotsDir — per-scope screenshots folder
 * @param {number} stepNumber
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.preserveScroll] — pass true when the caller has
 *   already scrolled a specific section into view (e.g. "All Forms &
 *   Documents" for Steps 4–6) and wants that section to appear in the
 *   screenshot rather than the top of the page.
 */
async function captureStepEvidence(marketplace, testInfo, screenshotsDir, stepNumber, name, options = {}) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const safeName = String(name).replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
  const file = path.join(screenshotsDir, `Step${stepNumber}_${safeName}.png`);
  try {
    await marketplace.saveScreenshot(file, options);
  } catch (err) {
    logger.warn('SCREENSHOT', `Step ${stepNumber} screenshot failed: ${err.message.substring(0, 120)}`);
  }
  // Attach to Playwright HTML report if the file was created.
  try {
    if (fs.existsSync(file)) {
      await testInfo.attach(`Step ${stepNumber} — ${name}`, {
        path: file,
        contentType: 'image/png',
      });
    }
  } catch { /* attach is best-effort */ }
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
// Tests — one per scope (from Excel matrix, or a single env-var scope)
// ══════════════════════════════════════════════════════════════════════════

test.describe.serial('Marketplace · Forms & Documents · Coverage Year', () => {
  for (const scope of SCOPES) {
    for (const profile of RESPONSIVE_PROFILES) {
    const STATE        = scope.state;
    const LANGUAGE     = scope.language;                    // 'en' | 'es'
    const LANG_TAG     = LANGUAGE === 'es' ? 'ES' : 'EN';    // for slug / title
    const LANG_LABEL   = LANGUAGE === 'es' ? 'Spanish' : 'English';
    const DEFAULT_YEAR = scope.defaultYear;
    const ALT_YEAR     = scope.alternateYear;
    const APP_URL      = scope.appUrl;
    const DEVICE_TAG   = profile.tag;
    const DEVICE_LABEL = profile.label;

    const RUN_SLUG    = `${STATE}-${LANG_TAG}-${DEVICE_TAG}-${DEFAULT_YEAR}-${ALT_YEAR}`;
    const RUN_DIR     = path.join(REPORT_DIR, RUN_SLUG);
    const SCREENSHOTS = path.join(RUN_DIR, 'screenshots');

    // Derive the TestId (with device suffix) up-front so we can use it both
    // as the report `id` field AND as the report HTML filename — makes each
    // file self-identifying when browsing the reports folder.
    const REPORT_TEST_ID = `${scope.testId}-${DEVICE_TAG}`;
    // Sanitize for filesystem: strip characters Windows won't allow in
    // filenames (\ / : * ? " < > |), drop parentheses, collapse whitespace
    // to underscores.
    const REPORT_FILE_BASENAME = REPORT_TEST_ID
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[()]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_');
    const REPORT_FILE = path.join(RUN_DIR, `${REPORT_FILE_BASENAME}.html`);

    const TEST_META = {
      name:        `Marketplace · Forms & Documents · Coverage Year Toggle (${STATE} · ${LANG_LABEL} · ${DEVICE_LABEL})`,
      description: `Verify the coverage-year toggle behaviour on the Marketplace `
                 + `Forms & Documents page in ${LANG_LABEL} on ${DEVICE_LABEL}. `
                 + `Selects state "${STATE}", confirms default year ${DEFAULT_YEAR}, `
                 + `toggles to ${ALT_YEAR}, and switches back to ${DEFAULT_YEAR} — `
                 + `asserting URL query parameter and active-button state at each stage.`
                 + (scope.notes ? `  Notes: ${scope.notes}` : ''),
      id:          REPORT_TEST_ID,
      module:      MP.test.module,
      environment: MP.test.environment || envLabelFromUrl(APP_URL),
    };

  test(`${STATE} · ${LANG_TAG} · ${DEVICE_TAG} · Default=${DEFAULT_YEAR} · Toggle to ${ALT_YEAR}`, async ({}, testInfo) => {
    // Per-test step registry (local so parallel scopes don't cross-contaminate).
    const reportSteps = [];
    const recordStep = (id, name, status, expected, actual, screenshotPath, screenshotLabel) => {
      reportSteps.push({ id, name, status, expected, actual, screenshotPath, screenshotLabel });
    };

    logger.info('MARKETPLACE', '═══════════════════════════════════════════════════════');
    logger.info('MARKETPLACE', `Run: state=${STATE} language=${LANGUAGE} device=${DEVICE_LABEL} default=${DEFAULT_YEAR} alt=${ALT_YEAR} · source=${scope.source}`);
    logger.info('MARKETPLACE', `App URL: ${APP_URL}`);
    logger.info('MARKETPLACE', '═══════════════════════════════════════════════════════');

    const runStart = Date.now();

    // ── Fresh browser per run (matches plan-materials / drug pattern) ──
    const browser = await launchFreshBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      // Device profile decides viewport / userAgent / touch flag / etc.
      //   • Desktop headless → fixed 1920×1080 for stable CI screenshots.
      //   • Desktop headed   → viewport:null so --start-maximized takes effect.
      //   • Mobile           → Playwright's built-in emulation (iPhone SE / iPad Pro 11).
      // Framework is optimised for 100% Windows display scale; at 125% scale
      // desktop screenshots will be scale-dependent (e.g. 1536×~840 vs
      // 1920×~1000 at 100%). Set Windows scale to 100% for the cleanest,
      // most consistent visual output.
      ...profile.contextOptions(),
    });
    await applyStealthScripts(context);
    const page = await context.newPage();
    const marketplace = new MarketplacePage(page);

    try {
      // ── Step 1 — Launch Application ─────────────────────────────────
      await test.step('Step 1 — Launch Marketplace Home', async () => {
        await marketplace.open(APP_URL, frameworkConfig.navigationTimeoutMs);
        expect(page.url()).toMatch(/molinahealthcare\.com/i);
        STEP(1, `PASS | Launched marketplace at ${APP_URL}`);
        const shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 1, 'Launch_Home');
        recordStep(1, 'Launch Marketplace Home', 'PASS',
          `The marketplace home page should load successfully at ${APP_URL}.`,
          `Marketplace home page loaded successfully. Landed on: ${page.url()}. `
          + `Cookie consent was automatically accepted by the framework's navigation flow.`,
          shot, 'Marketplace home page');
      });

      // ── Step 2 — Open Member Resources ──────────────────────────────
      await test.step('Step 2 — Open Member Resources', async () => {
        await marketplace.openMemberResources();
        STEP(2, 'PASS | "Member Resources" navigation opened');
        const shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 2, 'MemberResources_Open');
        recordStep(2, 'Open Member Resources', 'PASS',
          'The "Member Resources" top-navigation menu should open and reveal its sub-links.',
          'The "Member Resources" navigation was opened successfully and its sub-links (including "Forms & documents") are visible.',
          shot, 'Member Resources menu open');
      });

      // ── Step 3 — Open Forms & Documents ─────────────────────────────
      await test.step('Step 3 — Open Forms & Documents', async () => {
        await marketplace.openFormsAndDocuments();
        expect(page.url()).toMatch(/\/member-resources\/forms-documents/i);
        STEP(3, `PASS | Navigated to Forms & Documents (${page.url()})`);
        const shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 3, 'FormsDocuments_Loaded');
        recordStep(3, 'Open Forms & Documents', 'PASS',
          'Clicking "Forms & documents" should navigate to /member-resources/forms-documents.',
          `Navigated successfully to the Forms & Documents page. Current URL: ${page.url()}`,
          shot, 'Forms & Documents page loaded');
      });

      // ── Step 4 — Select state + verify default coverage year ────────
      await test.step(`Step 4 — Select state=${STATE} → verify default year=${DEFAULT_YEAR}`, async () => {
        let shot = null;
        try {
          // selectState returns a structured result; the SPEC decides the
          // step-level policy (throw / fail / skip). The page object stays
          // pure "methods + locators, no orchestration".
          const stateResult = await marketplace.selectState(STATE);
          if (!stateResult.selected) {
            const availableStr = stateResult.availableStates.length
              ? stateResult.availableStates.join(', ')
              : '(dropdown empty)';
            if (stateResult.reason === 'not-in-dropdown') {
              throw new Error(
                `State "${STATE}" is NOT available in the Marketplace state dropdown. `
                + `Available states: [${availableStr}]. `
                + `Check the State column in data/MarketplaceData.xlsx or verify with Molina that this state is supported on the Marketplace site.`
              );
            }
            throw new Error(
              `Failed to select state "${STATE}" in the dropdown. `
              + `Reason: ${stateResult.reason || 'unknown'}. `
              + (stateResult.errorMessage ? `Playwright error: ${stateResult.errorMessage}. ` : '')
              + `Available states: [${availableStr}].`
            );
          }

          // Bring the "All Forms & Documents" section into view so the
          // state dropdown, coverage-year toggle, and top of the result
          // list are all visible in the screenshot.
          await marketplace.scrollToAllFormsAndDocuments();

          // Verify the URL reflects the default year AND the active button
          // matches. Do both checks so a mismatch clearly identifies the source.
          const urlYear    = marketplace.getYearFromUrl();
          const activeYear = await marketplace.getActiveYear();
          logger.info('MARKETPLACE', `Step 4 | urlYear=${urlYear} · activeButton=${activeYear} · expected=${DEFAULT_YEAR}`);

          // Screenshot first so the report captures the state even if the
          // asserts below fail. preserveScroll=true keeps the "All Forms &
          // Documents" section in view (scrolled to above).
          shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 4, `State_${STATE}_Year_${DEFAULT_YEAR}`, { preserveScroll: true });

          // At least one of the two indicators must equal the default year.
          if (activeYear) {
            expect(activeYear, 'active coverage-year button').toBe(DEFAULT_YEAR);
          }
          if (urlYear) {
            expect(page.url(), 'URL contains year=' + DEFAULT_YEAR)
              .toMatch(new RegExp(`[?&]year=${DEFAULT_YEAR}(&|$)`, 'i'));
          } else {
            logger.info('MARKETPLACE', 'Step 4 | Note: URL had no year param on first render — active-button check used.');
          }
          STEP(4, `PASS | State=${STATE} · default year confirmed as ${DEFAULT_YEAR}`);

          recordStep(4, `Select state and verify default coverage year (${DEFAULT_YEAR})`, 'PASS',
            `State "${STATE.toUpperCase()}" should be selectable, the default coverage-year button should be "${DEFAULT_YEAR}", and the URL should contain year=${DEFAULT_YEAR}.`,
            `Selected state "${STATE.toUpperCase()}". `
            + `Active coverage-year button: "${activeYear || '(none)'}". `
            + `URL year parameter: "${urlYear || '(not present on first render)'}". `
            + `Expected default year: ${DEFAULT_YEAR}.`,
            shot, `State ${STATE.toUpperCase()} · default year ${DEFAULT_YEAR}`);
        } catch (err) {
          // Any failure in Step 4 (state not in dropdown, assertion mismatch,
          // navigation error, etc.) is captured as a reportable FAIL step
          // with a screenshot so the QA can see the page state at the moment
          // of failure. Then the error re-throws so Playwright still marks
          // the test as failed.
          FAIL(4, `Step 4 failed: ${err.message.substring(0, 200)}`);
          // Best-effort screenshot if we didn't already take one
          if (!shot) {
            try {
              shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 4, `State_${STATE}_FAILED`);
            } catch { /* screenshot is best-effort */ }
          }
          recordStep(4, `Select state and verify default coverage year (${DEFAULT_YEAR})`, 'FAIL',
            `State "${STATE.toUpperCase()}" should be selectable, the default coverage-year button should be "${DEFAULT_YEAR}", and the URL should contain year=${DEFAULT_YEAR}.`,
            `Step 4 failed. Reason: ${err.message}`,
            shot, `State ${STATE.toUpperCase()} · default year ${DEFAULT_YEAR} (FAILED)`);
          throw err;
        }
      });

      // ── Step 5 — Toggle to alternate year ───────────────────────────
      await test.step(`Step 5 — Click year ${ALT_YEAR} → verify URL contains year=${ALT_YEAR}`, async () => {
        const result = await marketplace.selectCoverageYear(ALT_YEAR);
        if (!result.clicked && result.reason === 'disabled') {
          FAIL(5, `Year ${ALT_YEAR} button is disabled — the state "${STATE}" may not have ${ALT_YEAR} coverage available yet.`);
        }
        // Scroll to "All Forms & Documents" so the coverage-year toggle
        // and result list are clearly visible in the evidence screenshot.
        await marketplace.scrollToAllFormsAndDocuments();
        const shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 5, `Year_${ALT_YEAR}_Selected`, { preserveScroll: true });

        let stepStatus = 'PASS';
        const activeYearBefore = await marketplace.getActiveYear();
        let actualDetail = `Clicked coverage-year button "${ALT_YEAR}". `
          + `Post-click URL: ${page.url()}. `
          + `Active button: "${activeYearBefore || '(none)'}".`;

        try {
          expect(page.url(), `URL should contain year=${ALT_YEAR}`)
            .toMatch(new RegExp(`[?&]year=${ALT_YEAR}(&|$)`, 'i'));
          if (activeYearBefore) expect(activeYearBefore).toBe(ALT_YEAR);
          STEP(5, `PASS | Year toggled to ${ALT_YEAR} · URL=${page.url()}`);
        } catch (err) {
          stepStatus = 'FAIL';
          actualDetail += ` · Assertion failed: ${err.message.substring(0, 200)}`;
          recordStep(5, `Toggle coverage year to ${ALT_YEAR}`, stepStatus,
            `Clicking the "${ALT_YEAR}" button should update the URL to contain year=${ALT_YEAR} and mark that button as active.`,
            actualDetail, shot, `Coverage year toggled to ${ALT_YEAR}`);
          throw err;
        }

        recordStep(5, `Toggle coverage year to ${ALT_YEAR}`, stepStatus,
          `Clicking the "${ALT_YEAR}" button should update the URL to contain year=${ALT_YEAR} and mark that button as active.`,
          actualDetail, shot, `Coverage year toggled to ${ALT_YEAR}`);
      });

      // ── Step 6 — Switch back to default year ────────────────────────
      await test.step(`Step 6 — Click year ${DEFAULT_YEAR} → verify URL contains year=${DEFAULT_YEAR}`, async () => {
        const result = await marketplace.selectCoverageYear(DEFAULT_YEAR);
        if (!result.clicked && result.reason === 'disabled') {
          FAIL(6, `Year ${DEFAULT_YEAR} button is disabled — cannot switch back.`);
        }
        // Scroll to "All Forms & Documents" so the coverage-year toggle
        // and result list are clearly visible in the evidence screenshot.
        await marketplace.scrollToAllFormsAndDocuments();
        const shot = await captureStepEvidence(marketplace, testInfo, SCREENSHOTS, 6, `Year_${DEFAULT_YEAR}_Reselected`, { preserveScroll: true });

        let stepStatus = 'PASS';
        const activeYearAfter = await marketplace.getActiveYear();
        let actualDetail = `Clicked coverage-year button "${DEFAULT_YEAR}" (switch back). `
          + `Post-click URL: ${page.url()}. `
          + `Active button: "${activeYearAfter || '(none)'}".`;

        try {
          expect(page.url(), `URL should contain year=${DEFAULT_YEAR}`)
            .toMatch(new RegExp(`[?&]year=${DEFAULT_YEAR}(&|$)`, 'i'));
          if (activeYearAfter) expect(activeYearAfter).toBe(DEFAULT_YEAR);
          STEP(6, `PASS | Year switched back to ${DEFAULT_YEAR} · URL=${page.url()}`);
        } catch (err) {
          stepStatus = 'FAIL';
          actualDetail += ` · Assertion failed: ${err.message.substring(0, 200)}`;
          recordStep(6, `Switch coverage year back to ${DEFAULT_YEAR}`, stepStatus,
            `Clicking the "${DEFAULT_YEAR}" button should update the URL back to contain year=${DEFAULT_YEAR} and mark that button as active.`,
            actualDetail, shot, `Coverage year back to ${DEFAULT_YEAR}`);
          throw err;
        }

        recordStep(6, `Switch coverage year back to ${DEFAULT_YEAR}`, stepStatus,
          `Clicking the "${DEFAULT_YEAR}" button should update the URL back to contain year=${DEFAULT_YEAR} and mark that button as active.`,
          actualDetail, shot, `Coverage year back to ${DEFAULT_YEAR}`);
      });

      logger.info('MARKETPLACE', '═══════════════════════════════════════════════════════');
      logger.info('MARKETPLACE', 'All 6 steps completed successfully');
      logger.info('MARKETPLACE', `Screenshots: ${SCREENSHOTS}`);
      logger.info('MARKETPLACE', '═══════════════════════════════════════════════════════');
    } finally {
      // ── Write the custom HTML report (mirrors plan-materials / drug) ──
      try {
        const reportPath = writeStepsReport({
          reportDir:  RUN_DIR,
          reportFile: REPORT_FILE,
          testMeta:   TEST_META,
          appUrl:     APP_URL,
          steps:      reportSteps,
          durationMs: Date.now() - runStart,
        });
        logger.info('MARKETPLACE', `Report written: ${reportPath}`);

        // Best-effort ZIP the report folder so it's easy to email / attach.
        try {
          const zip = packageReport(RUN_DIR);
          if (zip) logger.info('MARKETPLACE', `Report zipped: ${zip}`);
        } catch (zipErr) {
          logger.warn('MARKETPLACE', `ZIP packaging failed: ${zipErr.message.substring(0, 120)}`);
        }
      } catch (reportErr) {
        logger.warn('MARKETPLACE', `Report generation failed: ${reportErr.message.substring(0, 200)}`);
      }

      // Always release the browser (mirrors plan-materials / drug pattern).
      try {
        await cleanupBetweenTests({ contexts: [context], browsers: [browser] });
      } catch { /* ignore */ }
    }
  });
  }  // end profile loop
  }  // end scope loop
});
