/**
 * Drug / Pharmacy — PDF Validation
 *
 * Requirement 2 mirror of tests/planMaterials/planMaterials.spec.js. Handles every
 * accordion under the '<YEAR> Pharmacy and Prescription Benefits Documents'
 * section of the drug page — Comprehensive Formulary, Changes to the
 * Formulary, Medication Safety, Transition Policy, Rx Mail Order Form,
 * Prior Authorization Grid, Step Therapy Grid, J-Code Step Therapy,
 * Out-of-Network Pharmacies, Coverage Determination Request Form, etc.
 * Each accordion + plan is one row in data/DrugData.xlsx.
 *
 * Business flow (Molina Medicare "<year> Pharmacy and Prescription Benefits
 * Documents" page):
 *   Step 1  Launch Drug Page
 *   Step 2  Navigate to <year> Pharmacy and Prescription Benefits Documents
 *   Step 3  Expand target Accordion (Comprehensive Formulary, PA Grid, etc.)
 *   Step 4  Validate Plan Availability            (per plan)
 *   Step 5  Open PDF                              (per plan — must be new tab)
 *   Step 6  Validate PDF URL                      (per plan)
 *
 * The drug page DOM is IDENTICAL to the plan materials page (same accordion
 * classes, same aria attributes), so this spec is a near-clone of
 * `tests/planMaterials/planMaterials.spec.js` with the following swaps:
 *
 *   • frameworkConfig.planMaterials  →  frameworkConfig.drug
 *   • PlanMaterialsPage              →  DrugPage (thin subclass with
 *                                       sectionSuffix = "Pharmacy and
 *                                       Prescription Benefits Documents")
 *   • Report folder                  →  reports/drug/<scope-slug>/
 *   • Data source                    →  DrugData.xlsx / drugExpectedPlans.json
 *
 * Reused unchanged:
 *   • fixtures/planMaterialsFixture.js  (accepts PageClass + sectionLabel)
 *   • helpers/evidencePanel.js          (HTML report widgets)
 *   • reporting/reportGenerator.js      (HTML + PDF + zip)
 *   • utils/screenshotHelpers.js        (blank-detect + fallback)
 */

const fs = require('fs');
const path = require('path');

const XLSX = require('xlsx');
const { test: base, expect } = require('@playwright/test');

const frameworkConfig = require('../../../config/framework.config');
const logger = require('../../../utils/logger');
const {
  pushPlanStep,
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
const { DrugPage } = require('../../../pages/drugPage');
const { writeReport } = require('../../../reporting/reportGenerator');

// ══════════════════════════════════════════════════════════════════════════
// Configuration — drug suite
// ══════════════════════════════════════════════════════════════════════════

const DR = frameworkConfig.drug;

const URL_TEMPLATE     = DR.urls.template;
const APP_URL_OVERRIDE = DR.urls.override;

const FILTER_STATE     = String(DR.filters.state).trim();
const FILTER_YEAR      = String(DR.filters.year).trim();
const FILTER_ACCORDION = String(DR.filters.accordion).trim();

const TEST_ID          = DR.test.id;
const TEST_MODULE      = DR.test.module;
const TEST_AUTHOR      = DR.test.author;
const TEST_ENVIRONMENT = DR.test.environment
  || ((APP_URL_OVERRIDE || URL_TEMPLATE).includes('pws-q1') ? 'QA (pws-q1)' : 'PROD');

const REPORT_DIR      = DR.report.dir;
const NEW_TAB_TIMEOUT = DR.pdf.newTabTimeoutMs;
const PDF_RENDER_WAIT = DR.pdf.renderWaitMs;

const EXPECTED_PLANS_EXCEL = DR.data.excelPath;
const EXPECTED_PLANS_JSON  = DR.data.jsonPath;
const EXPECTED_PLANS_SHEET = DR.data.sheetName;

// Section label used inside the fixture (Step 2 messages + scroll target).
const SECTION_LABEL = 'Pharmacy and Prescription Benefits Documents';

// ══════════════════════════════════════════════════════════════════════════
// Utilities (identical to planMaterials.spec.js — different config, same logic)
// ══════════════════════════════════════════════════════════════════════════

function slugifyScope(state, year, accordion) {
  const clean = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${clean(state)}-${clean(year)}-${clean(accordion)}`;
}

function appUrlForState(state) {
  if (APP_URL_OVERRIDE) return APP_URL_OVERRIDE;
  return URL_TEMPLATE.replace(/\{state\}/gi, String(state || '').toLowerCase());
}

/**
 * Load the drug test matrix from Excel (preferred) or JSON fallback.
 * Same row shape as plan materials (Run/State/Year/Accordion/PlanName/ExpectedUrl).
 */
function loadTestMatrix() {
  const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const norm = (s) => String(s || '').trim();

  const passesFilters = (state, year, accordion) => {
    if (FILTER_STATE     && !eq(state,     FILTER_STATE))     return false;
    if (FILTER_YEAR      && !eq(year,      FILTER_YEAR))      return false;
    if (FILTER_ACCORDION && !eq(accordion, FILTER_ACCORDION)) return false;
    return true;
  };

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

        const groups = new Map();
        for (const r of active) {
          const state = norm(r.State);
          const year = norm(r.Year);
          const accordion = norm(r.Accordion);
          if (!state || !year || !accordion) continue;
          const key = `${state.toUpperCase()}|${year}|${accordion}`;
          if (!groups.has(key)) {
            groups.set(key, { state, year, accordion, testId: norm(r.TestId), plans: [], source: 'excel' });
          }
          const scope = groups.get(key);
          // First non-empty TestId in the group wins; warn on mismatch.
          const rowTestId = norm(r.TestId);
          if (rowTestId && !scope.testId) scope.testId = rowTestId;
          else if (rowTestId && scope.testId && rowTestId !== scope.testId) {
            logger.warn('DATA',
              `Scope ${key} has conflicting TestIds ("${scope.testId}" vs "${rowTestId}") — keeping "${scope.testId}"`);
          }
          const name = norm(r.PlanName);
          const url  = norm(r.ExpectedUrl);
          if (name) scope.plans.push({ name, url });
        }

        if (groups.size) {
          const scopes = Array.from(groups.values()).map(s => ({ ...s, appUrl: appUrlForState(s.state) }));
          const result = finalize(scopes);
          logger.info('DATA',
            `Loaded ${result.length}/${scopes.length} drug scope(s) with ${result.reduce((n, s) => n + s.plans.length, 0)} plan(s) from Excel: ${path.basename(EXPECTED_PLANS_EXCEL)}`);
          if (result.length) return result;
        }
      }
    }
  } catch (err) {
    logger.warn('DATA', `Failed to read Drug Excel (${EXPECTED_PLANS_EXCEL}): ${err.message.substring(0, 120)}`);
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
        `Loaded ${result.length}/${scopes.length} drug scope(s) with ${result.reduce((n, s) => n + s.plans.length, 0)} plan(s) from JSON: ${path.basename(EXPECTED_PLANS_JSON)}`);
    }
    return result;
  } catch (err) {
    logger.warn('DATA', `Failed to load drug test matrix (${EXPECTED_PLANS_JSON}): ${err.message.substring(0, 120)}`);
    return [];
  }
}

/**
 * URL normaliser — identical to plan materials. Ignores query string / fragment.
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

// PDF page-level screenshot capture (identical to planMaterials.spec.js)

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

    // Native capture came back blank — Chrome's PDF viewer paints into a
    // compositor surface outside the DOM. Fall back to rendering page 1 of
    // the PDF ourselves via pdfjs-dist so the report still shows the real
    // document cover instead of a placeholder.
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

const TEST_MATRIX = loadTestMatrix();

if (TEST_MATRIX.length === 0) {
  logger.warn('MATRIX', 'No drug scopes matched the current filters — the test run will be empty.');
}

function registerTestsForScope(scope) {
  const scopeLabel   = `${scope.state} · ${scope.year} · ${scope.accordion}`;
  const baseSlug     = slugifyScope(scope.state, scope.year, scope.accordion);

  // Sanitize the descriptive TestId marketplace-style so it can be used as
  // both a filesystem folder AND a self-identifying report filename.
  // Rules (mirror tests/marketplace/marketplace.spec.js):
  //   - Strip Windows-invalid path chars (\ / : * ? " < > |)
  //   - Drop parentheses
  //   - Collapse whitespace to underscores
  const sanitizeForFs = (s) => s
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');

  const testIdSlug = scope.testId ? sanitizeForFs(scope.testId) : '';
  const scopeSlug  = testIdSlug || baseSlug;
  const scopeDir     = path.join(REPORT_DIR, scopeSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  // Self-identifying report filename — the sanitized TestId, matching
  // marketplace's convention where every HTML file names its own test.
  const reportBasename = testIdSlug || 'DrugPage_Report';
  const reportFile     = path.join(scopeDir, `${reportBasename}.html`);

  // Short TC-code (first whitespace-separated token) — keeps screenshot
  // filenames terse ("TC001_Plan1_Step1_OpenPDF.png") while the full
  // descriptive TestId lives on the folder + report + describe title.
  const shortTestCode = scope.testId ? String(scope.testId).trim().split(/\s+/)[0] : '';

  const testName        = `Drug — ${scope.accordion} PDF Validation`;
  const testDescription =
    `Launch the Molina Medicare Drug page for state "${scope.state}", ` +
    `expand the "${scope.accordion}" accordion under "${scope.year} ${SECTION_LABEL}", ` +
    `then for each expected plan click the link, verify a new tab opens, and ` +
    `verify the resulting PDF URL matches the expected URL supplied by the data file.`;

  // Describe title uses the descriptive TestId verbatim when present
  // (e.g. "TC001 DRUG Comprehensive Formulary NE-2027"), otherwise falls
  // back to the legacy "Drug — <scopeLabel>" heading.
  const describeTitle = scope.testId || `Drug — ${scopeLabel}`;

  base.describe(describeTitle, () => {
    base.describe.configure({ retries: 0, mode: 'serial' });

    const setupSteps       = [];
    const planCards        = [];
    const responsiveShots  = [];
    const runStart         = Date.now();

    // Same fixture factory as plan materials — but with PageClass = DrugPage
    // and sectionLabel = "Pharmacy and Prescription Benefits Documents".
    const scopedTest = base.extend({
      planMaterialsCtx: [
        createPlanMaterialsFixture({
          scope,
          screenshotsDir,
          setupSteps,
          planCards,
          responsiveShots,
          scopeLabel,
          PageClass:    DrugPage,
          sectionLabel: SECTION_LABEL,
        }),
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
            id: scope.testId || TEST_ID,
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

        // Also emit a small companion JSON so hooks/drugSummary.js can build
        // the consolidated dashboard without having to parse each per-scope
        // HTML report (which can be several MB with embedded PNGs).
        try {
          const setupFailed = setupSteps.some(s => s.status === 'FAIL');
          const cardFailed  = planCards.some(c => c.status === 'FAIL');
          const overallStatus = (setupFailed || cardFailed) ? 'FAIL' : (planCards.length ? 'PASS' : 'FAIL');
          const variantJson = path.join(scopeDir, 'variant.json');
          fs.writeFileSync(variantJson, JSON.stringify({
            schemaVersion: 1,
            testId:      scope.testId || TEST_ID,
            state:       scope.state,
            year:        String(scope.year),
            accordion:   scope.accordion,
            appUrl:      scope.appUrl,
            status:      overallStatus,
            durationMs,
            testName,
            testDescription,
            setupSteps:  setupSteps.map(s => ({
              id:         s.id,
              name:       s.name,
              status:     s.status,
              durationMs: s.durationMs,
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
            reportFile: path.relative(path.join(process.cwd(), 'reports', 'drug'), reportFile)
                              .split(path.sep).join('/'),
          }, null, 2), 'utf8');
        } catch (jsonErr) {
          logger.warn('REPORT', `[${scopeLabel}] Variant JSON write failed: ${jsonErr.message.substring(0, 160)}`);
        }
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
        await validateOnePlan(target, i + 1, planMaterialsCtx, shortTestCode);
      });
    });
  });
}

/**
 * Validate a single plan against `ctx` (from the fixture).
 * Identical logic to plan materials — this validates any PDF link regardless
 * of which page it came from. The 1-based `index` becomes the plan-card id.
 */
async function validateOnePlan(target, index, ctx, scopeTestId) {
  const { context, materials, accordion, scope, screenshotsDir, planCards } = ctx;
  const isDataDriven = true;
  const shotPrefix = scopeTestId
    ? `${scopeTestId}_Plan${index}`
    : `Plan${index}`;
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

  // Guard: plan expected by data file but not found on page.
  if (target.missing) {
    card.status = 'FAIL';
    card.error = `Plan "${target.name}" was not found under the ${scope.accordion} accordion.`;
    const missShot = path.join(screenshotsDir, `${shotPrefix}_NotFound.png`);
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

    const openShot = path.join(screenshotsDir, `${shotPrefix}_Step1_OpenPDF.png`);
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

    const urlShot = path.join(screenshotsDir, `${shotPrefix}_Step2_VerifyURL.png`);
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

    card.status = card.validations.every(v => v.status === 'PASS') ? 'PASS' : 'FAIL';

    expect(urlNotEmpty, `[${target.name}] PDF URL should not be empty`).toBeTruthy();
    expect(urlHasPdf,   `[${target.name}] PDF URL should contain ".pdf"`).toBeTruthy();
    if (urlMatchesExpected !== null) {
      expect(urlMatchesExpected, `[${target.name}] PDF URL should equal expected URL`).toBeTruthy();
    }
  });

  if (pdfPage) { await pdfPage.close().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════════════════
// Register the matrix
// ══════════════════════════════════════════════════════════════════════════

if (TEST_MATRIX.length === 0) {
  base.describe('Drug — matrix', () => {
    base('No drug scopes matched the current filters', () => {
      throw new Error(
        `Drug test matrix is empty. Check:\n` +
        `  • Excel file: ${EXPECTED_PLANS_EXCEL}\n` +
        `  • JSON file:  ${EXPECTED_PLANS_JSON}\n` +
        `  • Any rows with Run=Y? \n` +
        `  • Filters: STATE="${FILTER_STATE}", YEAR="${FILTER_YEAR}", ACCORDION="${FILTER_ACCORDION}"`
      );
    });
  });
} else {
  for (const scope of TEST_MATRIX) registerTestsForScope(scope);
}
