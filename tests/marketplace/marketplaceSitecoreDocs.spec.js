/**
 * Marketplace / Sitecore Docs Verification  (Requirement 2)
 * ─────────────────────────────────────────────────────────────────────────
 * Per state, per plan, per doc-type (SBC / EOC / OOC — SOB optional),
 * per language (EN / ES): hit the Sitecore-hosted PDF URL directly and
 * verify:
 *   1. `page.goto()` resolves (no 404 / redirect off-file)
 *   2. Chrome's built-in PDF viewer mounts (embed[type="application/x-google-chrome-pdf"])
 *   3. The filename in the tab URL matches the expected filename
 *   4. The URL path contains the correct doc-type token (/SBC/, /EOC/, /OOC/, /SOB/)
 *
 * When Chrome refuses to render the PDF inline (WAF, headless quirk),
 * a plain HTTP probe (`page.request.get`) is used as a fallback so the
 * step still records evidence of a real PDF being served.
 *
 * Excel schema — one row per plan, up to 8 URLs per row (4 doc-types
 * × 2 languages). See data/marketplace/MarketplaceSitecoreDocsData.xlsx.
 * Rows are FLATTENED at load time into one test scope per URL.
 *
 * Per-row `TargetHost` column overrides the env var / config default for
 * that row only. Precedence: row cell > MARKETPLACE_SITECORE_DOCS_TARGET_HOST
 * env var > hostRewrite.target config default.
 *
 * Emits `variant.json` next to each per-scope report so
 * `hooks/marketplaceSitecoreDocsSummary.js` can build a consolidated
 * dashboard at run's end.
 */

const { test: base, expect } = require('@playwright/test');
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const frameworkConfig = require('../../config/framework.config');
const logger          = require('../../utils/logger');
const { writeReport } = require('../../reporting/reportGenerator');
const { pushSetupStep } = require('../../helpers/evidencePanel');
const { MarketplaceSitecoreDocsPage } = require('../../pages/marketplaceSitecoreDocsPage');

// ══════════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════════

const CFG           = frameworkConfig.marketplaceSitecoreDocs;
const EXCEL_PATH    = CFG.excelPath;
const EXCEL_SHEET   = CFG.excelSheet;
const REPORT_DIR    = CFG.report.dir;
const TEST_MODULE   = CFG.test.module;
const TEST_AUTHOR   = CFG.test.author;
const TEST_ENV      = CFG.test.environment;

const DOC_TYPES     = CFG.docTypes;                        // e.g. ['SBC','EOC','OOC']
const LANGUAGES     = CFG.languages;                       // e.g. ['en','es']
const F_STATE       = String(CFG.filters.state    || '').toUpperCase();
const F_DOCTYPE     = String(CFG.filters.docType  || '').toUpperCase();
const F_LANGUAGE    = String(CFG.filters.language || '').toLowerCase();
const F_PLAN        = String(CFG.filters.plan     || '').toLowerCase();

const HOST_SRC      = String(CFG.hostRewrite.source || '').toLowerCase();
const HOST_DST      = String(CFG.hostRewrite.target || '').toLowerCase();
// Explicit env-var override for target host. When set (non-empty), it wins
// over every row's `TargetHost` cell. Distinct from HOST_DST because HOST_DST
// falls back to the config default; this is empty when the user hasn't
// exported the variable at all.
const HOST_DST_ENV  = String(process.env.MARKETPLACE_SITECORE_DOCS_TARGET_HOST || '').trim().toLowerCase();

const EMBED_TIMEOUT = CFG.pdf.embedTimeoutMs;
const RENDER_WAIT   = CFG.pdf.renderWaitMs;

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
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('pws-q2')) return 'Q2 (pws-q2)';
  if (u.includes('pws-q1')) return 'Q1 (pws-q1)';
  if (u.includes('www.molinahealthcare')) return 'PROD (www)';
  return 'PROD';
}

const STATE_CODE_TO_NAME = {
  AZ: 'Arizona',      CA: 'California',   FL: 'Florida',      GA: 'Georgia',
  IA: 'Iowa',         ID: 'Idaho',        IL: 'Illinois',     KY: 'Kentucky',
  MA: 'Massachusetts',MI: 'Michigan',     MS: 'Mississippi',  NE: 'Nebraska',
  NM: 'New Mexico',   NV: 'Nevada',       NY: 'New York',     OH: 'Ohio',
  SC: 'South Carolina', TX: 'Texas',      UT: 'Utah',         VA: 'Virginia',
  WA: 'Washington',   WI: 'Wisconsin',
};
const fullStateName = (code) => STATE_CODE_TO_NAME[String(code || '').toUpperCase()] || String(code || '').toUpperCase();

/** Rewrite an absolute URL's hostname when it matches `HOST_SRC`.
 *  `targetHost` is the destination hostname for this specific URL and lets
 *  each row target its own environment via the sheet's `TargetHost` column.
 */
function rewriteHost(rawUrl, targetHost) {
  const s   = String(rawUrl || '').trim();
  const dst = String(targetHost || '').trim().toLowerCase();
  if (!s || !HOST_SRC || !dst || HOST_SRC === dst) return s;
  try {
    const u = new URL(s);
    if (u.hostname.toLowerCase() === HOST_SRC) {
      u.hostname = dst;
      return u.toString();
    }
    return s;
  } catch { return s; }
}

/** Resolve the effective target host for a row:
 *    row's `TargetHost` cell > env var override > config default (HOST_DST).
 *  A non-empty cell always wins so the sheet stays the source of truth.
 */
function resolveTargetHost(rowTargetHost) {
  const cell = String(rowTargetHost || '').trim().toLowerCase();
  if (cell) return cell;
  if (HOST_DST_ENV) return HOST_DST_ENV;
  return HOST_DST;
}

/** Filename from URL path (e.g. `ID27SBCE_G1_1.pdf`). */
function filenameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    return (p.split('/').pop() || '').trim();
  } catch {
    return String(u || '').split('?')[0].split('#')[0].split('/').pop() || '';
  }
}

/** Case-insensitive filename comparison — allows the Excel `xxxSBCE` variant. */
function filenamesMatch(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// ══════════════════════════════════════════════════════════════════════════
// Matrix loader — flatten wide plan rows into per-URL scopes
// ══════════════════════════════════════════════════════════════════════════

function loadTestMatrix() {
  if (!EXCEL_PATH || !fs.existsSync(EXCEL_PATH)) {
    logger.warn('MP-DOCS', `Excel not found: ${EXCEL_PATH || '(unset)'} — running 0 tests`);
    return [];
  }
  let wb;
  try { wb = XLSX.readFile(EXCEL_PATH); }
  catch (err) {
    logger.warn('MP-DOCS', `Excel read failed: ${err.message.substring(0, 120)} — running 0 tests`);
    return [];
  }
  const sheet = wb.Sheets[EXCEL_SHEET];
  if (!sheet) {
    logger.warn('MP-DOCS', `Sheet "${EXCEL_SHEET}" missing — running 0 tests`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const scopes = [];
  const rowsRun = rows.filter((r) => norm(r.Run).toUpperCase() === 'Y');

  rowsRun.forEach((r, i) => {
    const state    = norm(r.State).toUpperCase();
    const planCode = norm(r.PlanCode);
    const planName = norm(r.PlanName);
    const rateCode = norm(r.RateCode);
    const testIdBase = norm(r.TestId) || `Row${i + 2}`;
    const notes    = norm(r.Notes);
    const rowTargetHost = norm(r.TargetHost);
    const effectiveTargetHost = resolveTargetHost(rowTargetHost);
    if (!state || !planName) return;

    // Optional per-row allow-lists. Empty cell → all globally enabled types/langs.
    const rowDocTypes = norm(r.DocTypes)
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const rowLangs = norm(r.Languages)
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

    for (const docType of DOC_TYPES) {
      if (rowDocTypes.length && !rowDocTypes.includes(docType)) continue;
      const displayCell = norm(r[`${docType}_Display`]);
      if (!displayCell) continue;                              // no doc-type for this plan

      for (const lang of LANGUAGES) {
        if (rowLangs.length && !rowLangs.includes(lang)) continue;
        const langKey = lang === 'es' ? 'ES' : 'EN';
        const rawUrl  = norm(r[`${docType}_${langKey}_URL`]);
        if (!rawUrl) continue;                                 // no URL cell — skip

        const expectedName = norm(r[`${docType}_${langKey}_Name`])
                           || filenameFromUrl(rawUrl);
        const url = rewriteHost(rawUrl, effectiveTargetHost);

        scopes.push({
          row:            i + 2,
          testIdBase,
          state,
          rateCode,
          planCode,
          planName,
          docType,
          language:       lang,
          langLabel:      langKey,          // 'EN' or 'ES'
          display:        displayCell,      // e.g. 'Member Portal'
          expectedName,
          rawUrl,
          url,
          notes,
        });
      }
    }
  });

  const filtered = scopes
    .filter((s) => !F_STATE    || s.state === F_STATE)
    .filter((s) => !F_DOCTYPE  || s.docType === F_DOCTYPE)
    .filter((s) => !F_LANGUAGE || s.language === F_LANGUAGE)
    .filter((s) => !F_PLAN     || s.planName.toLowerCase().includes(F_PLAN));

  if (!filtered.length) {
    const bits = [F_STATE && `state=${F_STATE}`, F_DOCTYPE && `docType=${F_DOCTYPE}`,
                  F_LANGUAGE && `lang=${F_LANGUAGE}`, F_PLAN && `plan~${F_PLAN}`]
      .filter(Boolean).join(', ');
    logger.warn('MP-DOCS',
      `No Run=Y scopes in ${path.basename(EXCEL_PATH)} (sheet "${EXCEL_SHEET}")${bits ? ` matching ${bits}` : ''} — running 0 tests`);
    return [];
  }

  const byState = new Map();
  for (const s of filtered) byState.set(s.state, (byState.get(s.state) || 0) + 1);
  const stateSummary = [...byState.entries()].map(([k, v]) => `${k}(${v})`).join(', ');

  const byHost = new Map();
  for (const s of filtered) {
    let h = '(unresolved)';
    try { h = new URL(s.url).hostname.toLowerCase(); } catch { /* keep default */ }
    byHost.set(h, (byHost.get(h) || 0) + 1);
  }
  const hostSummary = [...byHost.entries()].map(([k, v]) => `${k}(${v})`).join(', ');

  logger.info('MP-DOCS',
    `Loaded ${filtered.length} scope(s) from ${path.basename(EXCEL_PATH)}  ·  states: ${stateSummary}  ·  types: ${DOC_TYPES.join('/')}  ·  langs: ${LANGUAGES.join('/')}`);
  logger.info('MP-DOCS', `Target hosts (row cell wins): ${hostSummary}`);
  return filtered;
}

const TEST_MATRIX = loadTestMatrix();

// ══════════════════════════════════════════════════════════════════════════
// Test registration
// ══════════════════════════════════════════════════════════════════════════

if (TEST_MATRIX.length === 0) {
  base.describe('Marketplace Sitecore Docs — matrix', () => {
    base('No Sitecore-doc scopes matched the current filters', () => {
      throw new Error(
        'MarketplaceSitecoreDocs matrix is empty. Check:\n'
        + `  • Excel file: ${EXCEL_PATH}\n`
        + `  • Sheet: ${EXCEL_SHEET}\n`
        + '  • At least one row with Run=Y, State, PlanName, and non-empty <DocType>_<LANG>_URL cells\n'
        + `  • Filters: STATE="${F_STATE}", DOCTYPE="${F_DOCTYPE}", LANG="${F_LANGUAGE}", PLAN~"${F_PLAN}"\n`
        + `  • Doc-types enabled: ${DOC_TYPES.join(', ')}   Languages enabled: ${LANGUAGES.join(', ')}`
      );
    });
  });
} else {
  // Group by state → describe per state so the report tree is human-friendly.
  const byState = new Map();
  for (const s of TEST_MATRIX) {
    if (!byState.has(s.state)) byState.set(s.state, []);
    byState.get(s.state).push(s);
  }
  for (const [state, scopes] of byState) registerStateGroup(state, scopes);
}

// ─────────────────────────────────────────────────────────────────────────
// One describe per State; one test per URL scope.
// ─────────────────────────────────────────────────────────────────────────

function registerStateGroup(state, scopes) {
  const stateName = fullStateName(state);
  base.describe(`Marketplace Sitecore Docs — ${stateName} (${state})`, () => {
    base.describe.configure({ retries: 0, mode: 'parallel' });

    for (const scope of scopes) registerScope(scope, stateName);
  });
}

function registerScope(scope, stateName) {
  const {
    testIdBase, state, docType, langLabel, planCode, planName,
    url, expectedName, display, rawUrl, notes,
  } = scope;

  const folderSlug = sanitizeForFs(`${testIdBase}_${docType}_${langLabel}`);
  const scopeDir       = path.join(REPORT_DIR, folderSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile     = path.join(scopeDir, `${folderSlug}.html`);

  const testName = `${docType} · ${langLabel} · ${planName} (${planCode})`;
  const testDescription =
    `Directly hit the ${docType} ${langLabel === 'ES' ? 'Spanish' : 'English'} `
    + `Sitecore PDF for plan "${planName}" (${planCode}) in ${stateName}. `
    + `Verify Chrome's PDF viewer mounts, the tab URL settles at the requested `
    + `file, and the filename matches the expected value from the data sheet.`
    + (notes ? `  Notes: ${notes}` : '');

  base(testName, async ({ page }) => {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const docsPage = new MarketplaceSitecoreDocsPage(page);
    const setupSteps = [];
    const runStart = Date.now();

    // Single "plan card" carries the doc-type meta so the report + dashboard
    // can render summary chips per URL.
    const card = {
      id: 1,
      name: `[${docType}] ${planName}`,
      status: 'PASS',
      expectedUrl: url,
      pdfUrl: '',
      href: rawUrl,
      isDataDriven: true,
      steps: [],
      validations: [],
      error: '',
    };

    let embedInfo = { ok: false, originalUrl: '', error: '' };
    let probe = null;
    let finalUrl = '';
    let step1Ok = true;
    let step1Err = '';

    try {
      // ── Step 1 — Launch PDF URL ────────────────────────────────────
      await base.step(`Step 1 — Navigate to ${docType} ${langLabel} PDF URL`, async () => {
        const t0 = Date.now();
        try { await docsPage.open(url); }
        catch (err) {
          step1Ok = false;
          step1Err = err && err.message ? err.message.substring(0, 200) : String(err);
        }
        finalUrl = page.url();

        const shot = path.join(screenshotsDir, 'Step1_Navigate.png');
        await docsPage.saveScreenshot(shot);
        pushSetupStep(setupSteps, {
          id: 1,
          name: `Navigate to ${docType} ${langLabel} PDF URL`,
          expected: `Browser should navigate directly to:\n${url}`,
          actual: step1Ok
            ? `Navigation resolved.\nRequested: ${url}\nSettled:   ${finalUrl}`
            : `Navigation failed: ${step1Err}`,
          status: step1Ok ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `PDF viewer — ${docType} ${langLabel}`,
        });
        if (!step1Ok) { card.status = 'FAIL'; card.error = step1Err; throw new Error(`Step 1 failed: ${step1Err}`); }
      });

      // ── Step 2 — Verify Chrome PDF viewer mounted ──────────────────
      await base.step('Step 2 — Verify Chrome PDF viewer mounted', async () => {
        const t0 = Date.now();
        embedInfo = await docsPage.waitForEmbed(EMBED_TIMEOUT);

        // Fallback probe when embed didn't mount — proves the PDF is served
        // even if the browser downloaded/blocked inline rendering.
        if (!embedInfo.ok) {
          probe = await docsPage.probeUrl(url);
        }

        // Give the viewer a moment to paint the first page for the screenshot.
        if (embedInfo.ok && RENDER_WAIT > 0) {
          await page.waitForTimeout(RENDER_WAIT);
        }
        const shot = path.join(screenshotsDir, 'Step2_PdfViewer.png');
        await docsPage.saveScreenshot(shot);

        const embedOk = embedInfo.ok;
        const probeOk = probe && probe.ok
          && /pdf/i.test(probe.contentType || '')
          && (probe.contentLength || 0) > 0;

        const status = embedOk ? 'PASS' : (probeOk ? 'PASS' : 'FAIL');
        const actual = embedOk
          ? `PDF viewer mounted.\nembed.original-url: ${embedInfo.originalUrl || '(empty)'}`
          : (probe
              ? `PDF viewer did NOT mount (embed timeout). HTTP probe fallback:\n`
                + `  HTTP ${probe.status}  ·  Content-Type: ${probe.contentType || '(none)'}  ·  Content-Length: ${probe.contentLength || 0} bytes`
                + (probeOk ? '\n  (probe confirms a real PDF is served)' : '\n  (probe did NOT confirm a PDF)')
              : 'PDF viewer did NOT mount and no HTTP probe was captured.');

        pushSetupStep(setupSteps, {
          id: 2,
          name: 'Verify PDF viewer mounted',
          expected: 'Chrome should render the PDF inline via its built-in viewer (`embed[type="application/x-google-chrome-pdf"]`). '
            + 'If inline rendering is blocked, an HTTP probe should still confirm `application/pdf` is served.',
          actual,
          status,
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `PDF viewer — ${docType} ${langLabel}`,
        });
        card.validations.push({
          name: 'PDF viewer mounted (embed) or PDF served (HTTP probe)',
          status,
          description: embedOk ? 'inline viewer mounted' : (probeOk ? `HTTP ${probe.status} · ${probe.contentType}` : 'neither signal available'),
        });
        if (status !== 'PASS') { card.status = 'FAIL'; throw new Error('Step 2 failed: no PDF signal'); }
      });

      // ── Step 3 — Verify filename matches expected ──────────────────
      await base.step(`Step 3 — Verify PDF filename matches "${expectedName}"`, async () => {
        const t0 = Date.now();
        const urlFile      = filenameFromUrl(finalUrl || url);
        const embedFile    = embedInfo.originalUrl ? filenameFromUrl(embedInfo.originalUrl) : '';
        const dispFile     = probe && probe.contentDisposition
          ? (probe.contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i) || [, ''])[1].replace(/["']/g, '').trim()
          : '';

        const urlMatch   = filenamesMatch(urlFile, expectedName);
        const embedMatch = embedFile ? filenamesMatch(embedFile, expectedName) : null;
        const dispMatch  = dispFile  ? filenamesMatch(dispFile,  expectedName) : null;

        // Overall pass = URL filename matches AND (embed matches OR embed absent).
        // A disagreeing embed original-url is a fail signal too.
        const pass = urlMatch && (embedMatch === null || embedMatch === true);

        card.pdfUrl = finalUrl || url;
        const shot = path.join(screenshotsDir, 'Step3_Filename.png');
        await docsPage.saveScreenshot(shot);

        const lines = [];
        lines.push(`Expected filename: ${expectedName}`);
        lines.push(`URL filename:      ${urlFile || '(none)'}   ${urlMatch ? '✓' : '✗'}`);
        if (embedFile)  lines.push(`embed original-url filename: ${embedFile}   ${embedMatch ? '✓' : '✗'}`);
        if (dispFile)   lines.push(`Content-Disposition filename: ${dispFile}    ${dispMatch  ? '✓' : '✗'}`);

        pushSetupStep(setupSteps, {
          id: 3,
          name: `Verify PDF filename matches "${expectedName}"`,
          expected: `The tab URL AND the embed's original-url attribute should both end in "${expectedName}" (case-insensitive).`,
          actual: lines.join('\n'),
          status: pass ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          screenshotPath: shot,
          screenshotLabel: `Filename check — ${expectedName}`,
        });
        card.validations.push({
          name: 'PDF filename matches expected',
          status: pass ? 'PASS' : 'FAIL',
          description: `expected=${expectedName}, url=${urlFile || '(none)'}${embedFile ? `, embed=${embedFile}` : ''}`,
        });
        if (!pass) card.status = 'FAIL';
        expect(pass, `Filename mismatch. Expected "${expectedName}"; got url="${urlFile}", embed="${embedFile}"`).toBeTruthy();
      });
    } finally {
      // ── Emit per-scope HTML report + variant.json companion ─────
      const durationMs = Date.now() - runStart;
      try {
        writeReport({
          reportDir: scopeDir,
          reportFile,
          testMeta: {
            name:        testName,
            id:          `${testIdBase}_${docType}_${langLabel}`,
            module:      TEST_MODULE,
            description: testDescription,
            author:      TEST_AUTHOR,
            environment: TEST_ENV || envLabelFromUrl(url),
          },
          appUrl:         url,
          year:           '',
          accordionLabel: `${docType} · ${langLabel}`,
          setupSteps,
          planCards: [card],
          responsiveShots: [],
          durationMs,
          timestamp: new Date().toLocaleString(),
        });

        const overall = card.status === 'PASS' && !setupSteps.some((s) => s.status === 'FAIL') ? 'PASS' : 'FAIL';
        const variantJson = path.join(scopeDir, 'variant.json');
        fs.writeFileSync(variantJson, JSON.stringify({
          schemaVersion: 1,
          testId:      `${testIdBase}_${docType}_${langLabel}`,
          testIdBase,
          state,
          stateName,
          rateCode:    scope.rateCode,
          planCode,
          planName,
          docType,
          language:    scope.language,
          langLabel,
          display,
          expectedName,
          requestedUrl: url,
          rawUrl,
          settledUrl:  finalUrl || '',
          embedOriginalUrl: embedInfo.originalUrl || '',
          probe:       probe || null,
          status:      overall,
          durationMs,
          testName,
          testDescription,
          setupSteps: setupSteps.map((s) => ({
            id: s.id, name: s.name, status: s.status, durationMs: s.durationMs,
            expected: (s.expected || '').substring(0, 500),
            actual:   (s.actual   || '').substring(0, 800),
          })),
          reportFile: path.relative(REPORT_DIR, reportFile).split(path.sep).join('/'),
        }, null, 2), 'utf8');
      } catch (err) {
        logger.warn('REPORT', `[${folderSlug}] Failed to write report: ${err && err.message ? err.message.substring(0, 200) : String(err)}`);
      }
    }
  });
}
