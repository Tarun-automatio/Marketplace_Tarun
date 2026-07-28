/**
 * Marketplace / Drug Pharmacy CTA Verification
 * ─────────────────────────────────────────────
 * User story:
 *   On the Individual & Family Drug page (`/ifp/{state}/drugs`) every
 *   external-site CTA (Find a pharmacy, Find a provider, mail-order form…)
 *   must open Molina's ExternalSiteModal popup, and clicking Continue
 *   should open the target site in a new tab that eventually lands on the
 *   expected external URL.
 *
 *   Modularity: the spec is driven by an Excel sheet where each row
 *   specifies { State, LinkLabel, ExpectedInitialUrl, ExpectedFinalUrl }.
 *   Adding a new CTA (e.g. "Find a provider") is a one-row Excel edit —
 *   no code change required.
 *
 * Report shape per test (setup steps):
 *   1. Launch Drug page for state=<state>
 *   2. Locate CTA "<LinkLabel>" in body copy
 *   3. Click CTA → verify External Site Modal appears
 *   4. Capture Continue link's href (URL before redirect chain)
 *   5. Click Continue → verify new tab opens and settles at final URL
 *   6. Assert final URL matches ExpectedFinalUrl AND initial URL matches
 *      ExpectedInitialUrl (both compared with lenient URL normalization).
 *
 * Also emits `variant.json` for the consolidated dashboard produced by
 * `hooks/marketplacePharmacySummary.js`.
 *
 * Framework touch-points:
 *   • pages/marketplaceDrugPage.js — DOM interactions
 *   • reporting/reportGenerator.js — per-test HTML report (writeReport)
 *   • hooks/marketplacePharmacySummary.js — dashboard aggregator
 */

const { test: base, expect } = require('@playwright/test');
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
  highlightLocator,
} = require('../../utils/screenshotHelpers');
const { MarketplaceDrugPage } = require('../../pages/marketplaceDrugPage');

// ══════════════════════════════════════════════════════════════════════════
// Helpers — filesystem sanitisation (mirrors the pattern used in the other
// marketplace specs so folder names look consistent across suites).
// ══════════════════════════════════════════════════════════════════════════

function sanitizeForFs(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

// ══════════════════════════════════════════════════════════════════════════
// Config / matrix loader
// ══════════════════════════════════════════════════════════════════════════

const MPP           = frameworkConfig.marketplacePharmacy;
const EXCEL_PATH    = MPP.excelPath;
const EXCEL_SHEET   = MPP.excelSheet;
const REPORT_DIR    = MPP.report.dir;
const TEST_MODULE   = MPP.test.module;
const TEST_AUTHOR   = MPP.test.author;
const TEST_ENVIRONMENT = MPP.test.environment;

const FILTER_STATE  = String(MPP.filters.state     || '').trim();
const FILTER_LABEL  = String(MPP.filters.linkLabel || '').trim().toLowerCase();

/** Trim + normalize a string field from Excel. */
const norm = (v) => String(v == null ? '' : v).trim();

/** Full-state-name lookup for headings — mirrors marketplacePlanSearch pattern. */
const STATE_CODE_TO_NAME = {
  AZ: 'Arizona',    CA: 'California',  FL: 'Florida',      GA: 'Georgia',
  IA: 'Iowa',       ID: 'Idaho',       IL: 'Illinois',     KY: 'Kentucky',
  MA: 'Massachusetts', MI: 'Michigan', MS: 'Mississippi',  NE: 'Nebraska',
  NM: 'New Mexico', NV: 'Nevada',      NY: 'New York',     OH: 'Ohio',
  SC: 'South Carolina', TX: 'Texas',   UT: 'Utah',         VA: 'Virginia',
  WA: 'Washington', WI: 'Wisconsin',
};
const fullNameForState = (code) => {
  const key = String(code || '').trim().toUpperCase();
  return STATE_CODE_TO_NAME[key] || key;
};

function envLabelFromUrl(url) {
  const u = String(url || '');
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('pws-q2')) return 'Q2 (pws-q2)';
  if (u.includes('pws-q1')) return 'Q1 (pws-q1)';
  return 'PROD';
}

function loadTestMatrix() {
  if (!EXCEL_PATH || !fs.existsSync(EXCEL_PATH)) {
    logger.warn('MP-PHARMACY', `Excel not found: ${EXCEL_PATH || '(unset)'} — running 0 tests`);
    return [];
  }
  let wb;
  try { wb = XLSX.readFile(EXCEL_PATH); }
  catch (err) {
    logger.warn('MP-PHARMACY', `Excel read failed: ${err.message.substring(0, 120)} — running 0 tests`);
    return [];
  }
  const sheet = wb.Sheets[EXCEL_SHEET];
  if (!sheet) {
    logger.warn('MP-PHARMACY', `Sheet "${EXCEL_SHEET}" missing — running 0 tests`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const scopes = rows
    .filter((r) => norm(r.Run).toUpperCase() === 'Y')
    .map((r, i) => ({
      row:                       i + 2,
      testId:                    norm(r.TestId),
      state:                     norm(r.State).toLowerCase(),
      linkLabel:                 norm(r.LinkLabel),
      expectedInitialUrl:        norm(r.ExpectedInitialUrl),
      expectedFinalUrl:          norm(r.ExpectedFinalUrl),
      // Optional Spanish columns — when SpanishLinkLabel is empty the
      // Spanish flow (Steps 6-8) is skipped entirely for that row.
      spanishLinkLabel:          norm(r.SpanishLinkLabel),
      spanishExpectedInitialUrl: norm(r.SpanishExpectedInitialUrl),
      spanishExpectedFinalUrl:   norm(r.SpanishExpectedFinalUrl),
      notes:                     norm(r.Notes),
    }))
    .filter((s) => s.state && s.linkLabel)
    .filter((s) => !FILTER_STATE || s.state === FILTER_STATE.toLowerCase())
    .filter((s) => !FILTER_LABEL || s.linkLabel.toLowerCase().includes(FILTER_LABEL));

  if (!scopes.length) {
    const filters = [FILTER_STATE && `state=${FILTER_STATE}`, FILTER_LABEL && `link~${FILTER_LABEL}`]
      .filter(Boolean).join(', ');
    logger.warn('MP-PHARMACY',
      `No Run=Y rows in ${path.basename(EXCEL_PATH)} (sheet "${EXCEL_SHEET}")` +
      `${filters ? ` matching filter(s) ${filters}` : ''} — running 0 tests`);
    return [];
  }
  logger.info('MP-PHARMACY', `Loaded ${scopes.length} pharmacy CTA scope(s) from ${path.basename(EXCEL_PATH)}`);
  return scopes;
}

// ══════════════════════════════════════════════════════════════════════════
// URL comparison helpers
// ══════════════════════════════════════════════════════════════════════════

/**
 * Normalize a URL for lenient comparison:
 *   • lowercase host
 *   • strip trailing slash from pathname
 *   • drop hash fragment
 *   • preserve query params (they carry session tokens & are meaningful)
 */
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

/** Origin-only comparison — matches when protocol+host+pathname align, ignoring queries. */
function urlOriginPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch { return ''; }
}

// ══════════════════════════════════════════════════════════════════════════
// Test registration
// ══════════════════════════════════════════════════════════════════════════

const TEST_MATRIX = loadTestMatrix();

if (TEST_MATRIX.length === 0) {
  base.describe('Marketplace Drug Pharmacy — matrix', () => {
    base('No pharmacy-CTA scopes matched the current filters', () => {
      throw new Error(
        'MarketplacePharmacy matrix is empty. Check:\n'
        + `  • Excel file: ${EXCEL_PATH}\n`
        + `  • Sheet: ${EXCEL_SHEET}\n`
        + '  • At least one row with Run=Y, TestId, State, LinkLabel\n'
        + `  • Filters: STATE="${FILTER_STATE}", LINK_LABEL~"${FILTER_LABEL}"`
      );
    });
  });
} else {
  for (const scope of TEST_MATRIX) registerScope(scope);
}

// ══════════════════════════════════════════════════════════════════════════
// One describe + one test per Excel row. Each row = one (State, LinkLabel).
// ══════════════════════════════════════════════════════════════════════════

function registerScope(scope) {
  // Keep folder/file names concise. TestId in Excel is descriptive
  // (e.g. "TC001 MP Find a Pharmacy Link (English)") — for filesystem
  // naming we only need the TC### prefix. Label lists may contain up
  // to 3 alternatives — pick the first for the slug.
  const tcPrefix   = String(scope.testId || `Row${scope.row}`).match(/^TC\d+/i);
  const testIdSlug = tcPrefix ? tcPrefix[0].toUpperCase() : `Row${scope.row}`;
  const stateName  = fullNameForState(scope.state);
  const firstLabel = String(scope.linkLabel).split('|')[0].trim();
  const linkSlug   = sanitizeForFs(firstLabel);
  const folderSlug = `${testIdSlug}_${scope.state.toUpperCase()}_${linkSlug}`;
  const scopeDir   = path.join(REPORT_DIR, folderSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile = path.join(scopeDir, `${folderSlug}.html`);

  const describeTitle = scope.testId
    ? `${scope.testId} — ${stateName} — ${scope.linkLabel}`
    : `${stateName} — ${scope.linkLabel}`;
  const testName        = `Marketplace Drug Pharmacy — ${stateName} — "${scope.linkLabel}"`;
  const drugUrl         = MarketplaceDrugPage.urlForState(scope.state);
  const testDescription =
    `Launch the Marketplace Individual & Family Drug page for state "${stateName}", `
    + `locate the "${scope.linkLabel}" external CTA in the body copy, click it to open `
    + `Molina's External Site Modal, click Continue, and verify the new tab lands at the `
    + `expected external URL.`
    + (scope.notes ? `  Notes: ${scope.notes}` : '');

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
            id:          scope.testId || `MP-PHARMACY-Row${scope.row}`,
            module:      TEST_MODULE,
            description: testDescription,
            author:      TEST_AUTHOR,
            environment: TEST_ENVIRONMENT || envLabelFromUrl(drugUrl),
          },
          appUrl:         drugUrl,
          year:           '',
          accordionLabel: scope.linkLabel,
          setupSteps,
          // Pharmacy CTA verification is fully captured in the 6 setup
          // steps — there's no per-plan PDF to verify, so we suppress
          // the "PDF Verification Details" section entirely by passing
          // an empty planCards array here. The internal `planCards`
          // list is still used to compute overall status and to emit
          // per-scope data into the consolidated dashboard's variant.json.
          planCards: [],
          responsiveShots: [],
          durationMs,
          timestamp: new Date().toLocaleString(),
        });
        logger.info('REPORT', `[${describeTitle}] Report written: ${reportFile}`);

        // Companion JSON for hooks/marketplacePharmacySummary.js.
        try {
          const setupFailed = setupSteps.some((s) => s.status === 'FAIL');
          const cardFailed  = planCards.some((c) => c.status === 'FAIL');
          const overallStatus = (setupFailed || cardFailed) ? 'FAIL' : 'PASS';
          const variantJson = path.join(scopeDir, 'variant.json');
          fs.writeFileSync(variantJson, JSON.stringify({
            schemaVersion: 1,
            testId:              scope.testId,
            state:               scope.state.toUpperCase(),
            stateName,
            linkLabel:           scope.linkLabel,
            expectedInitialUrl:  scope.expectedInitialUrl,
            expectedFinalUrl:    scope.expectedFinalUrl,
            drugUrl,
            status:              overallStatus,
            durationMs,
            testName,
            testDescription,
            setupSteps: setupSteps.map((s) => ({
              id:         s.id,
              name:       s.name,
              status:     s.status,
              durationMs: s.durationMs,
              expected:   (s.expected || '').substring(0, 500),
              actual:     (s.actual   || '').substring(0, 800),
            })),
            planCards: planCards.map((c) => ({
              id:          c.id,
              name:        c.name,
              status:      c.status,
              expectedUrl: c.expectedUrl,
              pdfUrl:      c.pdfUrl,     // reused field name — actually the observed final URL
              href:        c.href,       // the Continue link's href (initial URL)
              error:       c.error,
              validations: (c.validations || []).map((v) => ({
                name: v.name, status: v.status,
                description: (v.description || '').substring(0, 300),
              })),
            })),
            reportFile: path.relative(path.join(process.cwd(), 'reports', 'marketplace-pharmacy'), reportFile)
                              .split(path.sep).join('/'),
          }, null, 2), 'utf8');
        } catch (jsonErr) {
          logger.warn('REPORT', `[${describeTitle}] Variant JSON write failed: ${jsonErr.message.substring(0, 160)}`);
        }
      } catch (repErr) {
        logger.warn('REPORT', `[${describeTitle}] Failed to write report: ${repErr.message}`);
      }
    });

    base(`${stateName} — "${scope.linkLabel}"`, async ({ page, context }) => {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const drug = new MarketplaceDrugPage(page);

      // Per-CTA plan card that the report renders as the "validation".
      const cardIndex = 1;
      const card = {
        id: cardIndex,
        name: `${scope.linkLabel} (${stateName})`,
        expectedUrl: scope.expectedFinalUrl || scope.expectedInitialUrl || '(auto — read from Continue href)',
        href: '',
        pdfUrl: '',
        isDataDriven: true,
        status: 'PASS',
        error: '',
        steps: [],
        validations: [],
      };
      planCards.push(card);

      // ── Step 1 — Launch Drug page ──────────────────────────────────
      await base.step(`Step 1 — Launch Marketplace Drug page for state=${scope.state.toUpperCase()}`, async () => {
        const t0 = Date.now();
        let ok = true;
        let errMsg = '';
        try {
          await drug.open(drugUrl);
        } catch (err) {
          ok = false;
          errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
        }
        const shot = path.join(screenshotsDir, 'Step1_Drug_Page.png');
        await drug.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id: 1,
          name: 'Launch Marketplace Drug page',
          expected: `Marketplace Drug page for state "${stateName}" should load successfully.`,
          actual: ok
            ? `Drug page loaded successfully.\nURL: ${page.url()}`
            : `Failed to load drug page: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `Marketplace Drug page — ${stateName}`,
        });
        if (!ok) throw new Error(`Step 1 failed: ${errMsg}`);
      });

      // ── Step 2 — Locate the external CTA link ──────────────────────
      // `scope.linkLabel` may be a pipe-separated list of alternatives
      // (e.g. "Find a pharmacy|Pharmacy Location") — some Marketplace
      // state pages expose the same URL under either label. The first
      // one to match in DOM order wins.
      //
      // We also visually highlight the matched CTA in bright yellow
      // before taking the evidence screenshot. The highlight is removed
      // in a `finally` block so the click in Step 3 targets the DOM in
      // its original state.
      let matchedLabel = String(scope.linkLabel).split('|')[0].trim();
      await base.step(`Step 2 — Locate "${scope.linkLabel}" CTA in body copy`, async () => {
        const t0 = Date.now();
        let visible = false;
        let errMsg = '';
        let clearHighlight = async () => {};
        try {
          // ensureCtaAttached waits for the anchor to be in the DOM (may be
          // below the initial fold) AND scrolls it into view. Handles the
          // Molina drug page's slow hydration on some states, and returns
          // the specific aria-label that matched so we can display it in
          // downstream steps.
          const res = await drug.ensureCtaAttached(scope.linkLabel, { timeoutMs: 30000 });
          matchedLabel = res.matchedLabel || matchedLabel;
          // Apply yellow highlight so the CTA is unmistakable in the shot.
          clearHighlight = await highlightLocator(res.locator);
          visible = true;
        } catch (err) {
          errMsg = err && err.message ? err.message.substring(0, 200) : String(err);
        }
        const shot = path.join(screenshotsDir, 'Step2_CTA_Located.png');
        try {
          await drug.saveScreenshot(shot, { preserveScroll: true });
        } finally {
          // Always clear the highlight — even on screenshot failure — so
          // Step 3's click doesn't hit a decorated element.
          await clearHighlight();
        }
        pushSetupStep(setupSteps, {
          id: 2,
          name: `Locate "${scope.linkLabel}" CTA`,
          expected: `CTA as "${scope.linkLabel}" should be present in the drug-page.`,
          actual: visible
            ? `CTA present in the DOM (matched aria-label: "${matchedLabel}") and scrolled into view.`
            : `CTA not found or not attached to DOM: ${errMsg}`,
          status: visible ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `${matchedLabel} CTA — ${stateName}`,
        });
        if (!visible) throw new Error(`Step 2 failed: ${errMsg || 'CTA not attached'}`);
      });

      // ── Step 3 — Click the CTA → verify modal appears ──────────────
      // The modal-driven flow on Molina's Marketplace has proven fragile:
      // Molina's React app auto-dismisses the modal within seconds on
      // several states, which caused Playwright's Continue-link locator
      // to fail on Step 5. The captured `Continue href` IS the destination
      // URL, so we don't actually need to click Continue to reach it — we
      // can open the same URL directly in a fresh tab and get the same
      // redirect chain / final URL.
      //
      // What Step 3 does:
      //   1. click the body-copy CTA
      //   2. wait for the External Site Modal to appear (evidence the
      //      interceptor fired)
      //   3. capture the Continue anchor's href (initial URL)
      //   4. screenshot the modal (evidence)
      // The Continue-click + new-tab-open happens in Step 5 via direct
      // `context.newPage().goto(href)` — same result, no modal race.
      let continueHref = '';
      let finalUrl     = '';
      let newPage      = null;
      let step3Screenshot = path.join(screenshotsDir, 'Step3_ExternalSiteModal.png');
      let step5Screenshot = path.join(screenshotsDir, 'Step5_NewTab_FinalUrl.png');
      let clickContinueError = '';
      await base.step(`Step 3 — Click "${matchedLabel}" and verify External Site Modal appears`, async () => {
        const t0 = Date.now();
        let ok = true;
        let errMsg = '';
        try {
          // Pass the exact label that matched in Step 2 so we don't
          // re-resolve the OR-locator (avoids the tiny risk of matching
          // a different anchor if the DOM changed between steps).
          await drug.clickBodyExternalCta(matchedLabel);
          await drug.waitForExternalSiteModal();
          // Capture the href RIGHT NOW while the modal is fresh.
          continueHref = await drug.getContinueHref();
          // Screenshot the modal for evidence.
          //
          // IMPORTANT: use raw `page.screenshot` here — NOT the framework's
          // `drug.saveScreenshot()`. The framework's screenshot pipeline
          // (screenshotMethods.saveScreenshot → dismissAllPopups /
          // nukeAllPopups / _hideFixedElementsForScreenshot) intentionally
          // clicks the ExternalSiteModal's Close button before every shot,
          // which is the correct behaviour for plan/PDF verification tests
          // but wrong here — we specifically WANT the modal visible in
          // this screenshot. A raw viewport shot preserves the modal.
          await page.screenshot({ path: step3Screenshot, fullPage: false });
        } catch (err) {
          ok = false;
          errMsg = err && err.message ? err.message.substring(0, 200) : String(err);
          // Failure-path fallback: still try to grab a shot so the report
          // has something. Framework pipeline is fine here because there's
          // no modal to preserve (it never appeared).
          await drug.saveScreenshot(step3Screenshot, { preserveScroll: true }).catch(() => {});
        }
        pushSetupStep(setupSteps, {
          id: 3,
          name: 'External Site Modal appears',
          expected: `Clicking "${matchedLabel}" should open Molina's External Site Modal with Close / Stay / Continue buttons.`,
          actual: ok
            ? `External Site Modal opened successfully.`
            : `Modal did not appear: ${errMsg}`,
          status: ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: step3Screenshot,
          screenshotLabel: 'External Site Modal',
        });
        if (!ok) throw new Error(`Step 3 failed: ${errMsg}`);
      });

      // ── Step 4 — Capture and verify the link from continue button ──
      // Continue href was captured inside Step 3 to avoid a step-boundary
      // race — here we just validate the cached value against the
      // ExpectedInitialUrl (when the tester provided one in Excel).
      await base.step('Step 4 — Capture and verify the link from continue button', async () => {
        const t0 = Date.now();
        card.href = continueHref;
        const ok = Boolean(continueHref);
        const errMsg = ok ? '' : 'Continue link href was empty when captured in Step 3';

        // Compare against ExpectedInitialUrl when the tester provided one.
        const expected = scope.expectedInitialUrl;
        const cmpInitial = expected
          ? (normalizeUrl(continueHref) === normalizeUrl(expected))
          : null;

        pushSetupStep(setupSteps, {
          id: 4,
          name: 'Capture and verify the link from continue button',
          expected: expected
            ? `Continue link href should match the expected initial URL.\nExpected: ${expected}`
            : `Continue link should have a non-empty href.  (No ExpectedInitialUrl provided — capture-only.)`,
          actual: ok
            ? (expected
                ? (cmpInitial
                    ? `Continue href matches ExpectedInitialUrl.\nActual: ${continueHref}`
                    : `Continue href DIFFERS from ExpectedInitialUrl.\nActual: ${continueHref}\nExpected: ${expected}`)
                : `Continue href captured.\nActual: ${continueHref}`)
            : `Failed to capture href: ${errMsg}`,
          status: !ok ? 'FAIL' : (expected && !cmpInitial ? 'FAIL' : 'PASS'),
          durationMs: Date.now() - t0,
          // Reuse the Step 3 screenshot — modal state hasn't changed.
          screenshotPath: path.join(screenshotsDir, 'Step3_ExternalSiteModal.png'),
          screenshotLabel: 'Continue link href captured',
        });
        card.validations.push({
          name:        'Continue href present',
          status:      continueHref ? 'PASS' : 'FAIL',
          description: continueHref ? `href = ${continueHref}` : 'empty',
        });
        if (expected) {
          card.validations.push({
            name:        'Continue href matches ExpectedInitialUrl',
            status:      cmpInitial ? 'PASS' : 'FAIL',
            description: cmpInitial ? 'exact match after normalization' : `expected: ${expected}`,
          });
          if (!cmpInitial) card.status = 'FAIL';
        }
        if (!ok) throw new Error(`Step 4 failed: ${errMsg}`);
      });

      // ── Step 5 — Open captured Continue URL in a new tab ──────────
      // We open the URL captured in Step 3 directly via `context.newPage()`
      // rather than clicking the modal's Continue button. Rationale:
      // Molina's page has been observed to auto-dismiss the modal within
      // seconds on some states, which caused the Continue-button click to
      // race the DOM removal. Since Continue's job is simply to navigate
      // to `continueHref` in a new tab, we can do exactly that in a way
      // that isn't sensitive to the modal's lifetime.
      await base.step('Step 5 — Open Continue URL in a new tab and settle at final URL', async () => {
        const t0 = Date.now();
        const redirectSettleMs = frameworkConfig.marketplacePharmacy?.newTabRedirectWaitMs || 15000;
        try {
          if (!continueHref) {
            clickContinueError = 'No Continue href was captured in Step 3';
          } else {
            newPage = await context.newPage();
            await newPage.goto(continueHref, {
              waitUntil: 'domcontentloaded',
              timeout:   frameworkConfig.pageLoadWaitMs,
            });
            // Let the caremark redirect chain settle so `newPage.url()`
            // returns the actual landed URL rather than the entry URL.
            try { await newPage.waitForLoadState('load',        { timeout: redirectSettleMs }); } catch { /* ignore */ }
            try { await newPage.waitForLoadState('networkidle', { timeout: redirectSettleMs }); } catch { /* ignore */ }
            finalUrl = newPage.url();
          }
        } catch (err) {
          clickContinueError = err && err.message ? err.message.substring(0, 300) : String(err);
          if (newPage) { try { await newPage.close(); } catch { /* ignore */ } }
          newPage = null;
        }

        card.pdfUrl = finalUrl;   // repurposed field: "the observed URL"

        if (newPage) {
          // Screenshot the destination page — evidence of where Continue
          // would have taken the user. Fall back to an evidence panel if
          // the site blocks screenshots (Caremark occasionally does).
          try {
            await newPage.screenshot({ path: step5Screenshot, fullPage: false });
          } catch {
            await ensureValidScreenshot(
              () => captureEvidencePanel(context,
                fallbackPanelHtml(`Continue destination — ${matchedLabel}`,
                  `Continue URL opened in a new tab. Final URL:\n${finalUrl || '(none)'}\n\nA direct screenshot of the destination page was not available.`),
                step5Screenshot),
              () => Promise.resolve(step5Screenshot),
            );
          }
        } else {
          step5Screenshot = path.join(screenshotsDir, 'Step5_NewTab_FAIL.png');
          await ensureValidScreenshot(
            () => captureEvidencePanel(context,
              fallbackPanelHtml(`Continue navigation failed — ${matchedLabel}`, clickContinueError || 'No new tab detected'),
              step5Screenshot),
            () => Promise.resolve(step5Screenshot),
          );
        }

        pushSetupStep(setupSteps, {
          id: 5,
          name: 'Click Continue → new tab opens',
          expected: 'Opening the captured Continue URL in a new tab should settle at the destination URL after all redirects.',
          actual: newPage
            ? `New tab opened and settled.\nFinal URL: ${finalUrl}`
            : `New tab could not be opened: ${clickContinueError}`,
          status: newPage ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: step5Screenshot,
          screenshotLabel: newPage ? `Destination new tab — ${matchedLabel}` : 'New tab open failure',
        });
        card.validations.push({
          name:        'Continue opens new tab',
          status:      newPage ? 'PASS' : 'FAIL',
          description: newPage ? `Landed at ${finalUrl}` : clickContinueError,
        });
        if (!newPage) {
          card.status = 'FAIL';
          card.error  = clickContinueError;
          throw new Error(`Step 5 failed: ${clickContinueError}`);
        }
      });

      // Final-URL comparison against ExpectedFinalUrl is done here (silently)
      // so the plan-card status stays accurate — but no separate report step
      // is emitted. Step 5 already displays the final URL and the report's
      // KPI banner reflects the overall PASS/FAIL from card.status.
      const expectedFinal = scope.expectedFinalUrl;
      if (expectedFinal) {
        const strict = normalizeUrl(finalUrl) === normalizeUrl(expectedFinal);
        const loose  = !strict && urlOriginPath(finalUrl) === urlOriginPath(expectedFinal);
        const pass   = strict || loose;
        card.validations.push({
          name:        'Final URL matches ExpectedFinalUrl',
          status:      pass ? 'PASS' : 'FAIL',
          description: pass ? (strict ? 'exact match' : 'origin+path match; query differs') : `expected: ${expectedFinal}`,
        });
        if (!pass) card.status = 'FAIL';
        expect(pass, `Final URL ${finalUrl} does not match expected ${expectedFinal}`).toBeTruthy();
      }

      // ══════════════════════════════════════════════════════════════════
      // Spanish flow (Steps 6-8) — runs only when scope.spanishLinkLabel
      // is populated in Excel. The flow mirrors the English one but does
      // it on the /es-us/ drug page:
      //   Step 6 — close the English caremark tab, switch page to Spanish
      //   Step 7 — locate + click Spanish CTA, capture the modal + href
      //   Step 8 — open the captured Spanish URL in a new tab, verify
      //            destination (same caremark portal as English)
      //
      // Backward-compatible — if SpanishLinkLabel is empty for a row,
      // this block is a no-op and the report ends at Step 5.
      // ══════════════════════════════════════════════════════════════════
      if (scope.spanishLinkLabel) {
        let esContinueHref = '';
        let esFinalUrl     = '';
        let esNewPage      = null;
        let matchedEsLabel = String(scope.spanishLinkLabel).split('|')[0].trim();
        let step6Screenshot = path.join(screenshotsDir, 'Step6_SpanishDrugPage.png');
        let step7Screenshot = path.join(screenshotsDir, 'Step7_SpanishExternalSiteModal.png');
        let step8Screenshot = path.join(screenshotsDir, 'Step8_SpanishNewTab_FinalUrl.png');
        let esClickError   = '';

        // ── Step 6 — Close English tab, switch language to Spanish ────
        await base.step('Step 6 — Close English tab and switch drug page language to Spanish', async () => {
          const t0 = Date.now();
          let ok = true;
          let errMsg = '';
          try {
            // Close the caremark tab from Step 5 — browser focus returns
            // to the drug page automatically.
            if (newPage) { try { await newPage.close(); } catch { /* ignore */ } newPage = null; }
            // The External Site Modal from Step 3 is still open on the
            // drug page (Step 5 bypassed it by opening the URL in a new
            // tab directly, without clicking the modal's Continue button).
            // The modal's backdrop blocks header clicks, so dismiss it
            // via the close (X) button before touching the language
            // toggle. Idempotent — no-op when no modal is present.
            await page.bringToFront().catch(() => {});
            await drug.dismissModalViaClose().catch(() => {});
            // Toggle the header language dropdown → Spanish. Idempotent
            // and inherited from MarketplacePage.
            await drug.switchLanguage('es');
          } catch (err) {
            ok = false;
            errMsg = err && err.message ? err.message.substring(0, 200) : String(err);
          }
          await drug.saveScreenshot(step6Screenshot, { preserveScroll: true }).catch(() => {});
          pushSetupStep(setupSteps, {
            id: 6,
            name: 'Switch drug page to Spanish',
            expected: `Drug page for state "${stateName}" should reload under /es-us/ (Spanish UI).`,
            actual: ok
              ? `Spanish drug page loaded successfully.\nURL: ${page.url()}`
              : `Failed to switch language: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: step6Screenshot,
            screenshotLabel: `Spanish drug page — ${stateName}`,
          });
          if (!ok) throw new Error(`Step 6 failed: ${errMsg}`);
        });

        // ── Step 7 — Locate Spanish CTA, click it, capture modal + href ─
        await base.step(`Step 7 — Locate "${scope.spanishLinkLabel}" Spanish CTA and verify modal`, async () => {
          const t0 = Date.now();
          let ok = true;
          let errMsg = '';
          try {
            const res = await drug.ensureCtaAttached(scope.spanishLinkLabel, { timeoutMs: 30000 });
            matchedEsLabel = res.matchedLabel || matchedEsLabel;
            await drug.clickBodyExternalCta(matchedEsLabel);
            await drug.waitForExternalSiteModal();
            esContinueHref = await drug.getContinueHref();
            // Raw screenshot — bypass framework popup-dismissal so the
            // modal is preserved in evidence (same trick as Step 3).
            await page.screenshot({ path: step7Screenshot, fullPage: false });
          } catch (err) {
            ok = false;
            errMsg = err && err.message ? err.message.substring(0, 200) : String(err);
            await drug.saveScreenshot(step7Screenshot, { preserveScroll: true }).catch(() => {});
          }

          // Silent verification: Spanish continue href should match either
          // SpanishExpectedInitialUrl (when provided) OR the English
          // continueHref captured earlier (user note: "opens into new tab
          // as English" — the caremark URL is language-independent).
          const esExpectedInitial = scope.spanishExpectedInitialUrl || continueHref;
          const initialMatches = esExpectedInitial
            ? (normalizeUrl(esContinueHref) === normalizeUrl(esExpectedInitial))
            : Boolean(esContinueHref);

          pushSetupStep(setupSteps, {
            id: 7,
            name: `Locate Spanish CTA and capture Continue href`,
            expected: `An anchor matching "${scope.spanishLinkLabel}" should be present on the Spanish drug page and its Continue URL should match `
              + (scope.spanishExpectedInitialUrl
                   ? `SpanishExpectedInitialUrl.\nExpected: ${scope.spanishExpectedInitialUrl}`
                   : `the English Continue URL (Molina uses one caremark portal for both languages).\nExpected: ${continueHref}`),
            actual: ok
              ? (initialMatches
                   ? `Spanish CTA present (matched aria-label: "${matchedEsLabel}").\nContinue href: ${esContinueHref}`
                   : `Spanish CTA present (matched aria-label: "${matchedEsLabel}") but href DIFFERS.\nActual:   ${esContinueHref}\nExpected: ${esExpectedInitial}`)
              : `Failed: ${errMsg}`,
            status: (ok && initialMatches) ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: step7Screenshot,
            screenshotLabel: 'Spanish External Site Modal',
          });
          card.validations.push({
            name:        'Spanish Continue href matches expected',
            status:      (ok && initialMatches) ? 'PASS' : 'FAIL',
            description: initialMatches
              ? `href = ${esContinueHref}`
              : `expected: ${esExpectedInitial || '(none)'}, got: ${esContinueHref || '(none)'}`,
          });
          if (!ok) { card.status = 'FAIL'; throw new Error(`Step 7 failed: ${errMsg}`); }
          if (!initialMatches) { card.status = 'FAIL'; }
        });

        // ── Step 8 — Open Spanish Continue URL in a new tab ─────────────
        await base.step('Step 8 — Open Spanish Continue URL in a new tab and settle at final URL', async () => {
          const t0 = Date.now();
          const redirectSettleMs = frameworkConfig.marketplacePharmacy?.newTabRedirectWaitMs || 15000;
          try {
            if (!esContinueHref) {
              esClickError = 'No Spanish Continue href was captured in Step 7';
            } else {
              esNewPage = await context.newPage();
              await esNewPage.goto(esContinueHref, {
                waitUntil: 'domcontentloaded',
                timeout:   frameworkConfig.pageLoadWaitMs,
              });
              try { await esNewPage.waitForLoadState('load',        { timeout: redirectSettleMs }); } catch { /* ignore */ }
              try { await esNewPage.waitForLoadState('networkidle', { timeout: redirectSettleMs }); } catch { /* ignore */ }
              esFinalUrl = esNewPage.url();
            }
          } catch (err) {
            esClickError = err && err.message ? err.message.substring(0, 300) : String(err);
            if (esNewPage) { try { await esNewPage.close(); } catch { /* ignore */ } }
            esNewPage = null;
          }

          if (esNewPage) {
            try { await esNewPage.screenshot({ path: step8Screenshot, fullPage: false }); }
            catch {
              await ensureValidScreenshot(
                () => captureEvidencePanel(context,
                  fallbackPanelHtml(`Spanish Continue destination — ${matchedEsLabel}`,
                    `Spanish Continue URL opened in a new tab. Final URL:\n${esFinalUrl || '(none)'}\n\nA direct screenshot of the destination page was not available.`),
                  step8Screenshot),
                () => Promise.resolve(step8Screenshot),
              );
            }
          } else {
            step8Screenshot = path.join(screenshotsDir, 'Step8_SpanishNewTab_FAIL.png');
            await ensureValidScreenshot(
              () => captureEvidencePanel(context,
                fallbackPanelHtml(`Spanish Continue navigation failed — ${matchedEsLabel}`, esClickError || 'No new tab detected'),
                step8Screenshot),
              () => Promise.resolve(step8Screenshot),
            );
          }

          // Silent verification: SpanishExpectedFinalUrl (or English final).
          const esExpectedFinal = scope.spanishExpectedFinalUrl || finalUrl;
          const strict = esExpectedFinal && normalizeUrl(esFinalUrl) === normalizeUrl(esExpectedFinal);
          const loose  = esExpectedFinal && !strict
            && urlOriginPath(esFinalUrl) === urlOriginPath(esExpectedFinal);
          const finalMatches = Boolean(esNewPage) && (!esExpectedFinal || strict || loose);

          pushSetupStep(setupSteps, {
            id: 8,
            name: 'Open Spanish Continue URL → new tab opens',
            expected: 'Opening the captured Spanish Continue URL in a new tab should settle at '
              + (scope.spanishExpectedFinalUrl
                   ? `SpanishExpectedFinalUrl.\nExpected: ${scope.spanishExpectedFinalUrl}`
                   : `the same destination as the English flow.\nExpected: ${finalUrl}`),
            actual: esNewPage
              ? `Spanish new tab opened and settled.\nFinal URL: ${esFinalUrl}`
              : `Spanish new tab could not be opened: ${esClickError}`,
            status: finalMatches ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: step8Screenshot,
            screenshotLabel: esNewPage ? `Spanish destination — ${matchedEsLabel}` : 'Spanish new tab failure',
          });
          card.validations.push({
            name:        'Spanish Continue opens new tab at expected URL',
            status:      finalMatches ? 'PASS' : 'FAIL',
            description: esNewPage
              ? `Landed at ${esFinalUrl}${(!scope.spanishExpectedFinalUrl && !strict && !loose) ? '' : ''}`
              : esClickError,
          });
          if (!finalMatches) { card.status = 'FAIL'; }

          // Clean up the Spanish caremark tab.
          if (esNewPage) { try { await esNewPage.close(); } catch { /* ignore */ } }
        });
      }

      // Clean up the new tab if it's still open.
      if (newPage) { try { await newPage.close(); } catch { /* ignore */ } }

      // If the whole plan-card FAIL'd, surface at test level so CI catches it.
      if (card.status === 'FAIL') {
        throw new Error(`CTA validation FAIL — ${card.error || 'see setup step evidence'}`);
      }
    });
  });
}
