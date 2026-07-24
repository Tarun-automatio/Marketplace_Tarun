/**
 * Plan Materials — Accordion PDF Validation (generic)
 *
 * Handles every accordion under the "<year> Plan Materials" section of the
 * Molina Medicare Materials page — e.g. Annual Notice of Change (ANOC),
 * Summary of Benefits (SOB), Evidence of Coverage (EOC), Provider and
 * Pharmacy Directory, Quick Start Guide, Low Income Subsidy (LIS), etc.
 * The target accordion for each run is driven by the Excel matrix / config.
 *
 * Business flow (state · year · accordion — driven by the test matrix):
 *   Step 1  Launch Materials Page
 *   Step 2  Navigate to <year> Plan Materials
 *   Step 3  Expand <Accordion> Accordion
 *   Step 4  Validate Plan Availability            (per plan)
 *   Step 5  Open PDF                              (per plan)
 *   Step 6  Validate PDF URL                      (per plan)
 *   Step 7  Validate PDF Filename                 (per plan)
 *
 * Evidence strategy:
 *   • Setup steps (1-3)         — element / container screenshots (never full-page)
 *   • Plan visibility (4)       — accordion-container screenshot with the current
 *                                 plan link temporarily highlighted
 *   • PDF opened (5)            — evidence panel screenshot (Chrome PDF viewer
 *                                 cannot be captured reliably, so we render a
 *                                 self-contained HTML panel with the metadata)
 *   • URL validation (6)        — evidence panel
 *   • Filename validation (7)   — evidence panel (includes similarity score,
 *                                 normalised strings, and reason list)
 *
 * Every screenshot passes through `ensureValidScreenshot` — blank / white /
 * zero-dimension images are automatically replaced with a fallback evidence
 * panel so the report never contains an unusable image.
 *
 * Framework reuse:
 *   • pages/planMaterialsPage.js      — page object (section / accordion / links)
 *   • pages/HomePage.js               — PageCapture (used for navigation only)
 *   • utils/browserHelper.js          — launchFreshBrowser + stealth + cleanup
 *   • utils/screenshotHelpers.js      — element / panel / blank-detect helpers
 *   • helpers/planMaterials.js        — normalisation + similarity matcher
 *   • helpers/evidencePanel.js        — HTML panel builders + step trackers
 *   • fixtures/planMaterialsFixture.js — worker fixture (steps 1–3 setup)
 *   • reporting/reportGenerator.js    — self-contained HTML report writer
 *   • utils/logger.js                 — structured logging
 */

const fs = require('fs');
const path = require('path');

// R6: All environment loading + config resolution is centralised in
// config/framework.config.js. Nothing in this spec reads process.env directly.

const XLSX = require('xlsx');
const { test: base, expect } = require('@playwright/test');

const frameworkConfig = require('../../../config/framework.config');
const logger = require('../../../utils/logger');
const {
  pushPlanStep,
  esc,
  badgeHtml,
  pdfNewTabPanelHtml,
  urlValidationPanelHtml,
  fallbackPanelHtml,
} = require('../../../helpers/evidencePanel');
const {
  captureEvidencePanel,
  ensureValidScreenshot,
  renderPdfFirstPageAsDataUri,
} = require('../../../utils/screenshotHelpers');
const { createPlanMaterialsFixture } = require('../../../fixtures/planMaterialsFixture');
const { writeReport } = require('../../../reporting/reportGenerator');

// ══════════════════════════════════════════════════════════════════════════
// Configuration — all values come from framework.config.js (R6)
// ══════════════════════════════════════════════════════════════════════════

const PM = frameworkConfig.planMaterials;

// URL derivation (per-scope; see appUrlForState below).
const URL_TEMPLATE     = PM.urls.template;
const APP_URL_OVERRIDE = PM.urls.override;

// Optional matrix filters. Empty = all scopes with Run=Y.
const FILTER_STATE     = String(PM.filters.state).trim();
const FILTER_YEAR      = String(PM.filters.year).trim();
const FILTER_ACCORDION = String(PM.filters.accordion).trim();

// Test metadata (report header).
const TEST_ID          = PM.test.id;
const TEST_MODULE      = PM.test.module;
const TEST_AUTHOR      = PM.test.author;
const TEST_ENVIRONMENT = PM.test.environment
  || ((APP_URL_OVERRIDE || URL_TEMPLATE).includes('pws-q1') ? 'QA (pws-q1)' : 'PROD');

// Output + timing.
const REPORT_DIR      = PM.report.dir;
const NEW_TAB_TIMEOUT = PM.pdf.newTabTimeoutMs;
const PDF_RENDER_WAIT = PM.pdf.renderWaitMs;

// Data source.
const EXPECTED_PLANS_EXCEL = PM.data.excelPath;
const EXPECTED_PLANS_JSON  = PM.data.jsonPath;
const EXPECTED_PLANS_SHEET = PM.data.sheetName;

/**
 * Slugify a scope tuple into a filesystem-safe folder name.
 * Example: (MI, 2027, "Annual Notice of Change (ANOC)") -> "MI-2027-Annual-Notice-of-Change-ANOC"
 */
function slugifyScope(state, year, accordion) {
  const clean = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${clean(state)}-${clean(year)}-${clean(accordion)}`;
}

/**
 * Build the app URL for a given state by substituting `{state}` in the URL
 * template. `PLAN_MATERIALS_URL` (if set) forces every scope to that URL.
 */
function appUrlForState(state) {
  if (APP_URL_OVERRIDE) return APP_URL_OVERRIDE;
  return URL_TEMPLATE.replace(/\{state\}/gi, String(state || '').toLowerCase());
}

/**
 * Load the full test matrix — every distinct (state, year, accordion) scope
 * that has at least one `Run=Y` row, grouped with its plans and app URL.
 *
 * Optional env-var filters (PLAN_MATERIALS_STATE / _YEAR / _ACCORDION)
 * narrow the matrix to matching scopes only.
 *
 * Data sources:
 *   1. Excel (preferred) — testers edit `data/PlanMaterialsData.xlsx`
 *   2. JSON fallback — used when Excel is unreadable / has no matching rows
 *
 * Returns an array of scope objects:
 *   [{ state, year, accordion, appUrl, plans: [{ name, url }], source }]
 */
function loadTestMatrix() {
  const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const norm = (s) => String(s || '').trim();

  /**
   * Apply optional filters and drop scopes that don't match. Empty filters
   * pass everything through.
   */
  const passesFilters = (state, year, accordion) => {
    if (FILTER_STATE     && !eq(state,     FILTER_STATE))     return false;
    if (FILTER_YEAR      && !eq(year,      FILTER_YEAR))      return false;
    if (FILTER_ACCORDION && !eq(accordion, FILTER_ACCORDION)) return false;
    return true;
  };

  /** Turn a flat array of scopes into a stable-sorted result. */
  const finalize = (scopes) =>
    scopes
      .filter(s => passesFilters(s.state, s.year, s.accordion))
      .filter(s => s.plans.length > 0)
      .sort((a, b) =>
        a.state.localeCompare(b.state)
        || a.year.localeCompare(b.year)
        || a.accordion.localeCompare(b.accordion));

  // ── 1. Excel ──
  try {
    if (fs.existsSync(EXPECTED_PLANS_EXCEL)) {
      const wb = XLSX.readFile(EXPECTED_PLANS_EXCEL);
      const sheet = wb.Sheets[EXPECTED_PLANS_SHEET] || wb.Sheets[wb.SheetNames[0]];
      if (sheet) {
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const active = rows.filter(r => String(r.Run || '').trim().toUpperCase() === 'Y');

        // Group by (state, year, accordion)
        const groups = new Map();
        for (const r of active) {
          const state = norm(r.State);
          const year = norm(r.Year);
          const accordion = norm(r.Accordion);
          if (!state || !year || !accordion) continue;
          const key = `${state.toUpperCase()}|${year}|${accordion}`;
          if (!groups.has(key)) {
            groups.set(key, { state, year, accordion, plans: [], source: 'excel' });
          }
          const scope = groups.get(key);
          const name = norm(r.PlanName);
          const url  = norm(r.ExpectedUrl);
          if (name) scope.plans.push({ name, url });
        }

        if (groups.size) {
          const scopes = Array.from(groups.values()).map(s => ({ ...s, appUrl: appUrlForState(s.state) }));
          const result = finalize(scopes);
          logger.info('DATA',
            `Loaded ${result.length}/${scopes.length} scope(s) with ${result.reduce((n, s) => n + s.plans.length, 0)} plan(s) from Excel: ${path.basename(EXPECTED_PLANS_EXCEL)}`);
          if (result.length) return result;
        }
      }
    }
  } catch (err) {
    logger.warn('DATA', `Failed to read Excel (${EXPECTED_PLANS_EXCEL}): ${err.message.substring(0, 120)}`);
  }

  // ── 2. JSON fallback ──
  try {
    if (!fs.existsSync(EXPECTED_PLANS_JSON)) return [];
    const raw = JSON.parse(fs.readFileSync(EXPECTED_PLANS_JSON, 'utf8'));
    const sections = Array.isArray(raw.sections) ? raw.sections : [];
    const scopes = sections
      .filter(s => s.state && s.year && s.accordion && Array.isArray(s.plans))
      .map(s => ({
        state: norm(s.state),
        year: norm(s.year),
        accordion: norm(s.accordion),
        appUrl: appUrlForState(s.state),
        source: 'json',
        plans: s.plans
          .map(p => ({ name: norm(p.name), url: norm(p.url) }))
          .filter(p => p.name),
      }));
    const result = finalize(scopes);
    if (result.length) {
      logger.info('DATA',
        `Loaded ${result.length}/${scopes.length} scope(s) with ${result.reduce((n, s) => n + s.plans.length, 0)} plan(s) from JSON: ${path.basename(EXPECTED_PLANS_JSON)}`);
    }
    return result;
  } catch (err) {
    logger.warn('DATA', `Failed to load test matrix (${EXPECTED_PLANS_JSON}): ${err.message.substring(0, 120)}`);
    return [];
  }
}

/**
 * Normalise a URL for comparison — lowercase host, strip trailing slash,
 * ignore query string / fragment. Falls back to a lenient string compare
 * if URL parsing throws.
 */
function normalizeUrlForCompare(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return String(url).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

// Data model
//
// setupSteps[] — timeline for a single scope (state, year, accordion)
//   { id, name, expected, actual, status, screenshotPath, screenshotLabel }
// planCards[] — one card per plan in a scope
//   { id, name, href, pdfUrl, status, error, steps, validations }
//
// Both arrays are created FRESH per scope inside registerTestsForScope()
// so R5 can run many scopes in one execution without cross-contamination.
//
// Step-tracker functions (pushSetupStep, pushPlanStep) and HTML evidence-
// panel builders (esc, badgeHtml, pdfNewTabPanelHtml, urlValidationPanelHtml,
// fallbackPanelHtml) have been extracted to helpers/evidencePanel.js and are
// imported at the top of this file.

// ── PDF page-level screenshot capture ────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detect a solid / near-uniform PNG buffer (black, white, or single colour).
 * Chrome's built-in PDF viewer is not painted into Blink's compositor, so
 * page.screenshot() often returns a solid black rectangle. Uniform PNGs
 * compress to a tiny fraction of a byte per pixel — real PDF renders are
 * usually >0.05 bpp. Threshold picked conservatively.
 */
function isUniformPngBuffer(buf) {
  if (!buf || buf.length < 24) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return false;
  const width  = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const pixels = width * height;
  if (pixels <= 0) return false;
  const bytesPerPixel = buf.length / pixels;
  return bytesPerPixel < 0.01;
}

/**
 * Take a viewport screenshot of a PDF tab and return it as a base64 data URI.
 * Returns null when the capture fails, looks blank, or looks like a solid
 * rectangle (Chrome PDF viewer did not paint). The caller renders a
 * friendly placeholder in that case.
 *
 * Chrome's PDF viewer paints into a separate compositor surface, not the DOM,
 * so the default `page.screenshot()` returns a black rectangle. We first try
 * CDP `Page.captureScreenshot` with `fromSurface: false`, which grabs the
 * on-screen framebuffer (plugin surfaces included). If that still comes out
 * uniform, we fall back to the placeholder.
 */
async function capturePdfPageAsDataUri(pdfPage) {
  try {
    // Give the PDF viewer time to render pixels after 'load'.
    try { await pdfPage.waitForLoadState('load', { timeout: NEW_TAB_TIMEOUT }); } catch { /* ignore */ }
    await pdfPage.waitForTimeout(PDF_RENDER_WAIT);

    // Attempt 1 — CDP capture including plugin/compositor surfaces.
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

    // Attempt 2 — regular Playwright screenshot (works headed, usually black headless).
    if (!buf || buf.length < 3000 || isUniformPngBuffer(buf)) {
      buf = await pdfPage.screenshot({ fullPage: false, type: 'png' });
    }

    if (buf && buf.length >= 3000 && !isUniformPngBuffer(buf)) {
      return `data:image/png;base64,${buf.toString('base64')}`;
    }

    // Attempt 3 — render page 1 ourselves via pdfjs-dist inside a fresh
    // Playwright page. This produces the real PDF cover image regardless of
    // whether Chrome's PDF viewer painted its compositor surface.
    const pdfUrl = pdfPage.url();
    if (/\.pdf(\?|#|$)/i.test(pdfUrl)) {
      logger.info('PDF', `Native PDF viewer capture blank — rendering page 1 via pdfjs-dist for ${pdfUrl.split('/').pop()}`);
      const rendered = await renderPdfFirstPageAsDataUri(pdfPage.context(), pdfUrl);
      if (rendered) return rendered;
    }

    logger.warn('SCREENSHOT', `PDF preview unavailable (native blank, pdfjs render failed) — using placeholder.`);
    return null;
  } catch (err) {
    logger.warn('SCREENSHOT', `PDF page screenshot failed: ${err.message.substring(0, 120)}`);
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════
// Test suite — MATRIX driven
// ══════════════════════════════════════════════════════════════════════════
//
// The matrix is loaded ONCE at file-require time so Playwright can register
// one describe() per scope and one test() per plan before any browser runs.
//
// A scope = { state, year, accordion, appUrl, plans: [{name, url}], source }.
// Each scope becomes its own describe block with its own worker-scoped
// fixture, its own setupSteps/planCards, and its own report file at
// `reports/plan-materials/<scope-slug>/PlanMaterials_Report.html`.
//
// Env-var filters (PLAN_MATERIALS_STATE / _YEAR / _ACCORDION) narrow which
// scopes are registered. Empty filters → all Run=Y scopes from Excel.
// ══════════════════════════════════════════════════════════════════════════

const TEST_MATRIX = loadTestMatrix();

if (TEST_MATRIX.length === 0) {
  logger.warn('MATRIX', 'No scopes matched the current filters — the test run will be empty.');
}

/**
 * Register all tests for a single scope. Called once per scope in the
 * matrix. Each call creates:
 *   • a describe() block scoped to the (state, year, accordion) tuple
 *   • a worker-scoped fixture that opens the accordion and yields context
 *   • one test() per plan
 *   • an afterAll() that writes the scope's HTML report
 */
function registerTestsForScope(scope) {
  const scopeLabel   = `${scope.state} · ${scope.year} · ${scope.accordion}`;
  const scopeSlug    = slugifyScope(scope.state, scope.year, scope.accordion);
  const scopeDir     = path.join(REPORT_DIR, scopeSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile     = path.join(scopeDir, 'PlanMaterials_Report.html');

  // Per-scope test metadata for the report header.
  const testName        = `Plan Materials — ${scope.accordion} PDF Validation`;
  const testDescription =
    `Launch the Molina Medicare Materials page for state "${scope.state}", ` +
    `expand the "${scope.accordion}" accordion under "${scope.year} Plan Materials", ` +
    `then for each expected plan click the link, verify a new tab opens, and ` +
    `verify the resulting PDF URL matches the expected URL supplied by the data file.`;

  base.describe(`Plan Materials — ${scopeLabel}`, () => {
    // Serial: per-plan tests share the same accordion page opened in the fixture.
    base.describe.configure({ retries: 0, mode: 'serial' });

    // ── Per-scope state (fresh instances every describe registration) ──
    const setupSteps       = [];
    const planCards        = [];
    const responsiveShots  = [];
    const runStart         = Date.now();

    // Scope-local fixture: opens the accordion for THIS scope's (appUrl, year, accordion).
    // The fixture body is defined in fixtures/planMaterialsFixture.js — this
    // keeps the spec focused on business flow (assertions + reporting) while
    // the setup-step choreography lives in one reusable module.
    const scopedTest = base.extend({
      planMaterialsCtx: [
        createPlanMaterialsFixture({ scope, screenshotsDir, setupSteps, planCards, responsiveShots, scopeLabel }),
        { scope: 'worker' },
      ],
    });

    scopedTest.afterAll(async () => {
      const durationMs = Date.now() - runStart;
      try {
        writeReport({
          reportDir: scopeDir,
          reportFile,
          testMeta: {
            name: testName,
            id: TEST_ID,
            module: TEST_MODULE,
            description: testDescription,
            author: TEST_AUTHOR,
            environment: TEST_ENVIRONMENT,
          },
          appUrl: scope.appUrl,
          year: scope.year,
          accordionLabel: scope.accordion,
          setupSteps,
          planCards,
          responsiveShots,
          durationMs,
          timestamp: new Date().toLocaleString(),
        });
        logger.info('REPORT', `[${scopeLabel}] Report written: ${reportFile}`);
      } catch (repErr) {
        logger.warn('REPORT', `[${scopeLabel}] Failed to write report: ${repErr.message}`);
      }
    });

    // ── One test() per plan in this scope ──
    // Detect duplicate plan names within this scope and warn once. Then
    // ALWAYS prefix the test title with an index so two rows sharing a
    // name never collide in Playwright's title registry.
    const dupNames = new Map();
    scope.plans.forEach((p) => {
      const key = String(p.name).trim().toLowerCase();
      dupNames.set(key, (dupNames.get(key) || 0) + 1);
    });
    const duplicates = [...dupNames.entries()].filter(([, n]) => n > 1);
    if (duplicates.length) {
      logger.warn('DATA',
        `[${scopeLabel}] Duplicate PlanName in data sheet — ${duplicates.map(([n, c]) => `"${n}" (×${c})`).join(', ')}. ` +
        `Test titles will be prefixed with '#N · ...' to avoid collision. Please make each plan name unique in the Excel.`);
    }
    scope.plans.forEach((plan, i) => {
      const title = `#${i + 1} · ${plan.name}`;
      scopedTest(title, async ({ planMaterialsCtx }) => {
        // Match by INDEX (positional), not by name — keeps duplicate-name
        // rows aligned with their own targets/PDF URLs.
        const target = planMaterialsCtx.targets[i]
          || { name: plan.name, expectedUrl: plan.url, discovered: null, missing: true };
        await validateOnePlan(target, i + 1, planMaterialsCtx);
      });
    });
  });
}

/**
 * Validate a single plan against `ctx` (from the planMaterialsCtx fixture).
 * The 1-based `index` becomes the plan-card id used in the report.
 */
async function validateOnePlan(target, index, ctx) {
  const { context, materials, accordion, scope, screenshotsDir, planCards } = ctx;
  const isDataDriven = true; // Matrix mode: every scope is data-driven.
  const card = {
    id: index,
    name: target.name,
    expectedUrl: target.expectedUrl,
    href: target.discovered?.absoluteUrl || target.discovered?.href || '',
    pdfUrl: '',
    isDataDriven,
    status: 'PASS',
    error: '',
    steps: [],
    validations: [],
  };
  planCards.push(card);

  // ── Guard: plan expected by data file but not found on page ──
  if (target.missing) {
    card.status = 'FAIL';
    card.error = `Plan "${target.name}" was not found under the ${scope.accordion} accordion.`;
    const missShot = path.join(screenshotsDir, `Plan${card.id}_NotFound.png`);
    const missRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        fallbackPanelHtml(target.name, card.error),
        missShot),
      () => Promise.resolve(missShot),
    );
    pushPlanStep(card, {
      id: 1,
      name: 'Open PDF in New Tab',
      expected: `The plan "${target.name}" should be present under the "${scope.accordion}" accordion so that its link can be clicked.`,
      actual: card.error,
      status: 'FAIL',
      screenshotPath: missRes.filePath,
      screenshotLabel: `Plan not found — ${target.name}`,
    });
    card.validations.push({ name: 'Plan link present on page', status: 'FAIL', description: card.error });
    throw new Error(card.error);
  }

  // Shared state hoisted so both steps can read it. `base.step()` wraps each
  // phase so it appears as a labelled group in Playwright's trace viewer and
  // gets its own entry in test error messages.
  let pdfPage = null;
  let pdfOpened = false;
  let pdfPageDataUri = null;

  await base.step(`Step 1 — Open PDF in New Tab (${target.name})`, async () => {
    const linkEl = materials.planLinkByName(accordion.panel, target.name);
    if (!(await linkEl.count())) {
      throw new Error(`Plan link "${target.name}" not found in accordion at click time.`);
    }
    try { await linkEl.scrollIntoViewIfNeeded(); } catch { /* ignore */ }

    const [maybeNewPage] = await Promise.all([
      context.waitForEvent('page', { timeout: NEW_TAB_TIMEOUT }).catch(() => null),
      linkEl.click({ timeout: frameworkConfig.elementInteractionTimeoutMs }),
    ]);

    if (maybeNewPage) {
      pdfPage = maybeNewPage;
      try { await pdfPage.waitForURL(/\.pdf(\?|$|#)/i, { timeout: NEW_TAB_TIMEOUT }); } catch { /* continue */ }
      try { await pdfPage.waitForLoadState('domcontentloaded', { timeout: NEW_TAB_TIMEOUT }); } catch {}
      card.pdfUrl = pdfPage.url();
      pdfOpened = !!card.pdfUrl;
      pdfPageDataUri = await capturePdfPageAsDataUri(pdfPage);
    } else {
      card.error = 'No new tab opened within timeout';
    }

    const openShot = path.join(screenshotsDir, `Plan${card.id}_Step1_OpenPDF.png`);
    const openRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        pdfNewTabPanelHtml(target.name, card.pdfUrl, pdfPageDataUri, pdfOpened),
        openShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(target.name, 'Could not render the PDF new-tab evidence panel.'),
        openShot),
    );
    pushPlanStep(card, {
      id: 1,
      name: 'Open PDF in New Tab',
      expected: `Clicking the plan link "${target.name}" should open the PDF in a new browser tab.`,
      actual: pdfOpened
        ? `A new tab opened and loaded the PDF.\nURL: ${card.pdfUrl}`
        : `No new tab opened within ${NEW_TAB_TIMEOUT}ms after clicking the plan link.`,
      status: pdfOpened ? 'PASS' : 'FAIL',
      screenshotPath: openRes.filePath,
      screenshotLabel: `PDF opened in new tab — ${target.name}`,
    });
    card.validations.push({
      name: 'PDF opens in new tab',
      status: pdfOpened ? 'PASS' : 'FAIL',
      description: pdfOpened ? `Opened at ${card.pdfUrl}` : 'No new tab was detected within the timeout.',
    });
    expect(pdfOpened, `[${target.name}] Plan link should open a PDF in a new tab`).toBeTruthy();
  });

  await base.step(`Step 2 — Verify PDF URL (${target.name})`, async () => {
    const urlNotEmpty = !!card.pdfUrl;
    const urlHasPdf   = /\.pdf(\?|$|#|\b)/i.test(card.pdfUrl);
    const urlChecks = [
      { label: 'PDF URL not empty',       pass: urlNotEmpty, detail: card.pdfUrl || '(empty)' },
      { label: 'PDF URL contains ".pdf"', pass: urlHasPdf,   detail: card.pdfUrl },
    ];
    let urlMatchesExpected = null;
    if (target.expectedUrl) {
      urlMatchesExpected = normalizeUrlForCompare(card.pdfUrl) === normalizeUrlForCompare(target.expectedUrl);
      urlChecks.push({
        label: 'PDF URL matches expected',
        pass: urlMatchesExpected,
        detail: urlMatchesExpected ? 'exact match' : `expected: ${target.expectedUrl}`,
      });
    }
    const urlOverall = urlChecks.every(c => c.pass);

    const urlShot = path.join(screenshotsDir, `Plan${card.id}_Step2_VerifyURL.png`);
    const urlRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        urlValidationPanelHtml(target.name, card.pdfUrl, target.expectedUrl, urlChecks),
        urlShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(target.name, 'Could not render URL validation panel.'),
        urlShot),
    );
    pushPlanStep(card, {
      id: 2,
      name: 'Verify PDF URL',
      expected: target.expectedUrl
        ? `The PDF URL should be non-empty, contain ".pdf", and match the expected URL: ${target.expectedUrl}`
        : 'The PDF URL should be non-empty and contain the ".pdf" extension.',
      actual: urlOverall
        ? `All URL checks passed.\nURL: ${card.pdfUrl}`
        : `URL validation failed — ${urlChecks.filter(c => !c.pass).map(c => c.label).join('; ')}.\nURL: ${card.pdfUrl || '(empty)'}`,
      status: urlOverall ? 'PASS' : 'FAIL',
      screenshotPath: urlRes.filePath,
      screenshotLabel: `PDF URL Validation — ${target.name}`,
    });
    card.validations.push({ name: 'PDF URL not empty',       status: urlNotEmpty ? 'PASS' : 'FAIL', description: card.pdfUrl || '(empty)' });
    card.validations.push({ name: 'PDF URL contains ".pdf"', status: urlHasPdf   ? 'PASS' : 'FAIL', description: card.pdfUrl });
    if (urlMatchesExpected !== null) {
      card.validations.push({
        name: 'PDF URL matches expected',
        status: urlMatchesExpected ? 'PASS' : 'FAIL',
        description: urlMatchesExpected ? 'exact match' : `expected: ${target.expectedUrl}, actual: ${card.pdfUrl}`,
      });
    }

    // Roll up card status (both steps have run by now).
    card.status = card.validations.every(v => v.status === 'PASS') ? 'PASS' : 'FAIL';

    // Hard assertions — each becomes the visible reason for a failed test.
    expect(urlNotEmpty, `[${target.name}] PDF URL should not be empty`).toBeTruthy();
    expect(urlHasPdf,   `[${target.name}] PDF URL should contain ".pdf"`).toBeTruthy();
    if (urlMatchesExpected !== null) {
      expect(urlMatchesExpected, `[${target.name}] PDF URL should equal expected URL`).toBeTruthy();
    }
  });

  // Close the PDF tab after both steps are done (was after Step 2 previously).
  if (pdfPage) { await pdfPage.close().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════════════════
// Register the matrix
// ══════════════════════════════════════════════════════════════════════════

// Fallback describe when the matrix is empty — makes the failure visible in
// Playwright's output instead of a silent "0 tests found".
if (TEST_MATRIX.length === 0) {
  base.describe('Plan Materials — matrix', () => {
    base('No scopes matched the current filters', () => {
      throw new Error(
        `Test matrix is empty. Check:\n` +
        `  • Excel file: ${EXPECTED_PLANS_EXCEL}\n` +
        `  • Any rows with Run=Y? \n` +
        `  • Filters: STATE="${FILTER_STATE}", YEAR="${FILTER_YEAR}", ACCORDION="${FILTER_ACCORDION}"`
      );
    });
  });
} else {
  for (const scope of TEST_MATRIX) registerTestsForScope(scope);
}