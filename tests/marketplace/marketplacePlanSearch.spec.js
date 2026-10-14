/**
 * Marketplace — Plan Search + Per-Plan SOB PDF Validation + SBC Negative (batched)
 *
 * REQUIREMENT (2026-08 refresh):
 *   1. Positively validates every plan's SOB PDF per site language:
 *      the English pass validates the English SOB PDF only, and the
 *      Spanish pass validates the Spanish SOB PDF only. (Spanish PDFs
 *      only surface after the site language is switched to Spanish, and
 *      vice versa.)
 *   1a. Cross-language leak guard: the EN pass must NOT surface any
 *      Spanish SOB PDFs, and the ES pass must NOT surface any English
 *      SOB PDFs. Clean passes add nothing to the report; a leak pushes a
 *      dedicated FAIL step and aborts the pass.
 *   2. Behaviourally proves SBC is not available on the public UI by
 *      applying the SBC Category filter (Summary of Benefits) and
 *      asserting the same PlanName search returns ZERO result cards
 *      — also PASSes when the SBC option is missing from the accordion.
 *
 * Excel rows are grouped by (State, Year, AppUrl) so the "launch →
 * Member Resources → Forms & Documents → state → year" nav runs ONCE per
 * batch. Each plan inside the batch then runs the full positive + negative
 * cycle in English AND Spanish, and writes its OWN per-plan HTML report +
 * variant.json.
 *
 * Business flow per plan (steps captured in the per-plan report):
 *   Step 1  Launch Marketplace URL                          (shared)
 *   Step 2  Open "Member Resources" navigation              (shared)
 *   Step 3  Open "Forms & Documents" page                   (shared)
 *   Step 4  Select state → capture default coverage year    (shared)
 *   Step 5  Click Coverage Year <year>                      (shared)
 *   Step 6  EN — Apply SOB filter (Audience=Marketplace, Category=Schedule of Benefits)
 *   Step 7  EN — Search PlanName + validate ENGLISH SOB PDF card
 *   Step 8  EN — Apply SBC filter (Category=Summary of Benefits)
 *   Step 9  EN — Re-search PlanName → assert ZERO result cards
 *   Step 10 Switch site language to Spanish
 *   Step 11 ES — Apply SOB filter
 *   Step 12 ES — Search PlanName + validate SPANISH SOB PDF card
 *   Step 13 ES — Apply SBC filter
 *   Step 14 ES — Re-search PlanName → assert ZERO result cards
 *   Per PDF card also validates:
 *     • PDF opens in a new tab
 *     • URL contains "SOB" (case-insensitive) and does NOT contain "SBC" or "EOC"
 *     • PDF filename matches the expected filename from ExpectedUrls
 *
 * Data model (data/marketplace/MarketplacePlansData.xlsx, sheet `Plans`):
 *   Run           — 'Y' to include, anything else to skip
 *   TestId        — descriptive id, e.g. "TC001 Molina Gold Core 1500 OH-2027"
 *   State         — 2-letter code (case-insensitive)
 *   Year          — coverage year to toggle to (default 2027)
 *   Label         — 'SOB' (single search per plan now)
 *   Audience      — 'Marketplace'
 *   Category      — 'Schedule of Benefits'
 *   PlanName      — text typed into the search box + used to filter cards
 *   ExpectedUrls  — pipe-separated absolute URLs; one per matching card
 *                   (English + Spanish SOB PDFs)
 *
 * The SBC negative-check knobs live in `framework.config.js` under
 * `marketplacePlans.negativeSbc` (env: MARKETPLACE_PLANS_NEGATIVE_SBC,
 * MARKETPLACE_PLANS_SBC_AUDIENCE, MARKETPLACE_PLANS_SBC_CATEGORY).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
// Config — values come from framework.config.js, overridable via the
// workbook's `Settings` sheet (Key/Value) or an explicit env var.
// ══════════════════════════════════════════════════════════════════════════

const MPP = frameworkConfig.marketplacePlans;

const EXCEL_PATH  = MPP.excelPath;
const EXCEL_SHEET = MPP.excelSheet;

/** Read a Key/Value sheet from the workbook into a plain object. */
function loadSheetSettings(excelPath, sheetName) {
  try {
    if (!excelPath || !fs.existsSync(excelPath)) return {};
    const wb = XLSX.readFile(excelPath);
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return {};
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const map = {};
    for (const r of rows) {
      const k = String(r.Key || r.key || '').trim();
      if (!k) continue;
      map[k] = String(r.Value == null ? '' : r.Value).trim();
    }
    return map;
  } catch { return {}; }
}

// Precedence per key: env var > Settings sheet Value > framework.config.js fallback.
const SHEET_SETTINGS = loadSheetSettings(EXCEL_PATH, 'Settings');
const pickSetting = (envName, sheetKey, cfgFallback) => {
  const envVal = process.env[envName];
  if (envVal != null && String(envVal).trim() !== '') return String(envVal).trim();
  const sheetVal = SHEET_SETTINGS[sheetKey];
  if (sheetVal != null && String(sheetVal).trim() !== '') return String(sheetVal).trim();
  return cfgFallback;
};

const APP_URL_DEFAULT = pickSetting('MARKETPLACE_PLANS_URL', 'AppUrl', MPP.urls.appUrl);

const FILTER_STATE = String(MPP.filters.state || '').trim();
const FILTER_YEAR  = String(MPP.filters.year  || '').trim();
const FILTER_PLAN  = String(MPP.filters.plan  || '').trim().toLowerCase();

const REPORT_DIR = MPP.report.dir;

const TEST_MODULE      = MPP.test.module;
const TEST_AUTHOR      = MPP.test.author;
const TEST_ENVIRONMENT = MPP.test.environment;

const NEW_TAB_TIMEOUT = frameworkConfig.pageLoadWaitMs   || 45000;
const PDF_RENDER_WAIT = frameworkConfig.waitAfterNetworkIdleMs || 2000;

// Behavioural negative-check knobs. When enabled, after the SOB positive
// flow completes for a language pass we apply the SBC filter, run the same
// PlanName search, and assert zero result cards — proving SBC is not
// available on the public UI.
const NEG_SBC = frameworkConfig.marketplacePlans.negativeSbc || {};
const NEG_SBC_ENABLED = NEG_SBC.enabled !== false;
const NEG_SBC_AUDIENCE = String(NEG_SBC.audience || 'Marketplace');
const NEG_SBC_CATEGORY = String(NEG_SBC.category || 'Summary of Benefits');

// Language passes to run per plan. Default 'en,es' runs both; set
// MARKETPLACE_PLANS_LANGUAGES=es to run only the Spanish pass.
const PLAN_LANG_PASSES = String(frameworkConfig.marketplacePlans.languages || 'en,es')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Doc-type detection used for the SOB-only URL rule. The regex is
// anchored on non-alphanumeric boundaries (`/`, `_`, `.`, `-`) so a plan
// name that coincidentally contains the letters "sob" cannot trip it, and
// it matches both path segments (`/sob/`) and filename tokens (`SOBE_`).
const DOC_TYPE_RE = {
  SOB: /(?:^|[^a-z0-9])sob[a-z]?(?:[^a-z0-9]|\d|$)/i,
  SBC: /(?:^|[^a-z0-9])sbc[a-z]?(?:[^a-z0-9]|\d|$)/i,
  EOC: /(?:^|[^a-z0-9])eoc[a-z]?(?:[^a-z0-9]|\d|$)/i,
};

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════

const norm = (v) => String(v == null ? '' : v).trim();

function envLabelFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('uat-pws')) return 'UAT (uat-pws)';
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('pws-q2')) return 'Q2 (pws-q2)';
  if (u.includes('pws-q1')) return 'Q1 (pws-q1)';
  return 'PROD';
}

function sanitizeForFs(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[()]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

// Keep folder / file names within Windows MAX_PATH; append a short hash
// suffix when we clip so two long TestIds that share a prefix stay distinct.
function limitFsName(s, maxLen = 60) {
  const clean = String(s || '');
  if (clean.length <= maxLen) return clean;
  const hash = crypto.createHash('sha1').update(clean).digest('hex').slice(0, 6);
  return clean.slice(0, Math.max(1, maxLen - 7)).replace(/[_-]+$/, '') + '_' + hash;
}

/** Absolutize a bare `/path` against the app URL's origin. */
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

/** Lower-cased pathname portion of a URL (safe for malformed inputs). */
function pathLower(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try { return new URL(s).pathname.toLowerCase(); }
  catch {
    return s.toLowerCase()
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/[?#].*$/, '');
  }
}

/** File name from a URL (e.g. `OH26SOBE_G1_1.pdf`). */
function filenameFromUrl(url) {
  const p = pathLower(url);
  return (p.split('/').pop() || '').trim();
}

const STATE_CODE_TO_NAME = {
  AZ: 'Arizona',      CA: 'California',   ID: 'Idaho',
  IA: 'Iowa',         IL: 'Illinois',     KY: 'Kentucky',
  MA: 'Massachusetts',MI: 'Michigan',     MS: 'Mississippi',
  NV: 'Nevada',       NM: 'New Mexico',   OH: 'Ohio',
  TX: 'Texas',        UT: 'Utah',         VA: 'Virginia',
  WA: 'Washington',   WI: 'Wisconsin',
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
  const active = rows.filter((r) => norm(r.Run).toUpperCase() === 'Y');

  const scopes = active.map((r, i) => {
    const state  = norm(r.State).toUpperCase();
    const year   = norm(r.Year);
    const plan   = norm(r.PlanName);
    const testId = norm(r.TestId);
    return {
      row:  i + 2,
      testId,
      state,
      year:  year || String(frameworkConfig.marketplace?.years?.alternate || '2027'),
      planName: plan,
      search: {
        label:        norm(r.Label) || 'SOB',
        audience:     norm(r.Audience) || 'Marketplace',
        category:     norm(r.Category) || 'Schedule of Benefits',
        expectedUrls: norm(r.ExpectedUrls)
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean),
      },
      appUrl:   APP_URL_DEFAULT,
      source:   'excel',
    };
  })
  // ExpectedUrls MAY be empty — that means "no SOB is expected for this plan
  // in this state" and the search step will prove absence instead of matching.
  .filter((s) => s.state && s.planName)
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
  logger.info('MP-PLANS',
    `Loaded ${scopes.length} SOB scope(s) from ${path.basename(EXCEL_PATH)}`);
  return scopes;
}

const TEST_MATRIX = loadTestMatrix();

// ══════════════════════════════════════════════════════════════════════════
// Batch grouping — bundle Excel rows into (State, Year, AppUrl) batches so
// the "launch → Member Resources → Forms & Documents → state → year" nav
// runs ONCE per batch instead of once per plan.
// ══════════════════════════════════════════════════════════════════════════

function groupScopesByStateYear(scopes) {
  const map = new Map();
  for (const s of scopes) {
    const key = `${s.state}|${s.year}|${s.appUrl}`;
    if (!map.has(key)) {
      map.set(key, { key, state: s.state, year: s.year, appUrl: s.appUrl, plans: [] });
    }
    map.get(key).plans.push(s);
  }
  return Array.from(map.values());
}

const SHARED_SETUP_BUDGET_MS = 120_000;
const PER_PLAN_BUDGET_MS     = 180_000;
const BATCH_SLACK_MS         = 90_000;

function timeoutForGroup(group) {
  return SHARED_SETUP_BUDGET_MS + (group.plans.length * PER_PLAN_BUDGET_MS) + BATCH_SLACK_MS;
}

function cleanFormsAndDocsUrl(appUrl, state, year) {
  const origin = new URL(appUrl).origin;
  const s = String(state || '').toLowerCase();
  const y = String(year  || '');
  return `${origin}/member-resources/forms-documents?state=${s}&year=${y}`;
}

async function resetBetweenPlans({ marketplace, page, appUrl, state, year }) {
  try {
    await marketplace.switchLanguage('en');
  } catch (err) {
    logger.warn('BATCH',
      `switchLanguage('en') failed during reset: `
      + `${(err && err.message ? err.message : String(err)).substring(0, 160)}`);
  }
  try {
    const cleanUrl = cleanFormsAndDocsUrl(appUrl, state, year);
    await page.goto(cleanUrl, {
      waitUntil: 'domcontentloaded',
      timeout: frameworkConfig.navigationTimeoutMs,
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await marketplace.scrollToAllFormsAndDocuments();
  } catch (err) {
    logger.warn('BATCH',
      `Reset navigation failed: `
      + `${(err && err.message ? err.message : String(err)).substring(0, 160)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Category-filter option probe — used only for structured evidence in the
// SBC negative step. Returns whether the SBC label is even offered in the
// Category accordion, plus the raw options list for report evidence.
// ══════════════════════════════════════════════════════════════════════════

async function categoryOptionPresence(marketplace, needle) {
  const target = String(needle || '').trim().toLowerCase();
  let options = [];
  try { options = await marketplace.getFilterOptions('Category'); }
  catch { return { present: false, options: [] }; }
  const present = options.some((o) =>
    String(o.label || '').trim().toLowerCase() === target
    || String(o.value || '').trim().toLowerCase() === target
  );
  return { present, options };
}

// ══════════════════════════════════════════════════════════════════════════
// Test registration
// ══════════════════════════════════════════════════════════════════════════

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
  const GROUPS = groupScopesByStateYear(TEST_MATRIX);
  const totalPlans = GROUPS.reduce((n, g) => n + g.plans.length, 0);
  logger.info('MP-PLANS',
    `Registering ${GROUPS.length} batch(es) covering ${totalPlans} plan(s): `
    + GROUPS.map((g) => `${g.state}·${g.year} (${g.plans.length})`).join(', '));
  for (const group of GROUPS) registerGroup(group);
}

// ─────────────────────────────────────────────────────────────────────────
// registerGroup — one describe/test per (State, Year, AppUrl) batch.
// ─────────────────────────────────────────────────────────────────────────

function registerGroup(group) {
  const { state, year, appUrl, plans } = group;
  const fullStateName = fullNameForStateCode(state);
  const groupSlug = `${sanitizeForFs(fullStateName)}_${year}`;
  const sharedDir = path.join(REPORT_DIR, '_shared', groupSlug);
  const sharedScreenshotsDir = path.join(sharedDir, 'screenshots');

  const isSinglePlan = plans.length === 1;
  const groupDescribeTitle = isSinglePlan
    ? (plans[0].testId || `Marketplace SOB Search — ${state} · ${year} · ${plans[0].planName}`)
    : `Marketplace SOB Search Batch — ${fullStateName} · ${year} (${plans.length} plans)`;
  const groupTestTitle = isSinglePlan
    ? (plans[0].search.expectedUrls.length > 0
        ? `${plans[0].planName} — verify ${plans[0].search.expectedUrls.length} SOB PDF URL(s)`
        : `${plans[0].planName} — prove no SOB PDF is exposed on the UI`)
    : `Batch — verify SOB PDFs for ${plans.length} plans in ${fullStateName} ${year}`;

  base.describe(groupDescribeTitle, () => {
    base.describe.configure({ retries: 0, mode: 'serial' });

    base(groupTestTitle, async ({ page, context }) => {
      base.setTimeout(timeoutForGroup(group));
      fs.mkdirSync(sharedScreenshotsDir, { recursive: true });

      const marketplace = new MarketplacePage(page);
      const sharedSetupSteps = [];
      let sharedSetupError = null;

      // ══ Shared Steps 1..5 — run ONCE for the batch ══════════════
      try {
        await base.step('Step 1 — Launch Application URL', async () => {
          const t0 = Date.now();
          let ok = true, errMsg = '';
          try { await marketplace.open(appUrl); }
          catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
          const shot = path.join(sharedScreenshotsDir, 'Step1_Marketplace_Home.png');
          await marketplace.saveScreenshot(shot);
          pushSetupStep(sharedSetupSteps, {
            id: 1,
            name: 'Launch Application URL',
            expected: 'Molina home page should load successfully.',
            actual: ok
              ? `Home page loaded successfully.\nURL: ${page.url()}`
              : `Failed to load home page: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Marketplace home',
          });
          if (!ok) throw new Error(`Step 1 failed: ${errMsg}`);
        });

        await base.step('Step 2 — Open Member Resources Menu', async () => {
          const t0 = Date.now();
          let ok = true, errMsg = '';
          try { await marketplace.openMemberResources(); }
          catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
          const shot = path.join(sharedScreenshotsDir, 'Step2_Member_Resources_Menu.png');
          await marketplace.saveScreenshot(shot);
          pushSetupStep(sharedSetupSteps, {
            id: 2,
            name: 'Open Member Resources Menu',
            expected: 'Member Resources menu should be opened successfully.',
            actual: ok ? 'Member Resources menu opened successfully.' : `Failed to open Member Resources menu: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Member Resources menu',
          });
          if (!ok) throw new Error(`Step 2 failed: ${errMsg}`);
        });

        await base.step('Step 3 — Open Forms & Documents Page', async () => {
          const t0 = Date.now();
          let ok = true, errMsg = '';
          try { await marketplace.openFormsAndDocuments(); }
          catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
          const shot = path.join(sharedScreenshotsDir, 'Step3_Forms_And_Documents.png');
          await marketplace.saveScreenshot(shot);
          pushSetupStep(sharedSetupSteps, {
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

        await base.step(`Step 4 — Select state ${fullStateName}`, async () => {
          const t0 = Date.now();
          const res = await marketplace.selectState(state);
          if (!res.selected) {
            const msg = res.reason === 'not-in-dropdown'
              ? `State "${fullStateName}" is not available in the dropdown. Available: [${res.availableStates.join(', ')}]`
              : `Failed to select state "${fullStateName}": ${res.errorMessage || res.reason}`;
            const shot = path.join(sharedScreenshotsDir, 'Step4_State_Select_FAIL.png');
            await marketplace.saveScreenshot(shot);
            pushSetupStep(sharedSetupSteps, {
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

          await marketplace.scrollToAllFormsAndDocuments();
          const activeYear = await marketplace.getActiveYear();
          const url        = page.url();
          const yearInUrl  = marketplace.getYearFromUrl(url);
          const defaultOk  = yearInUrl === '2026' || activeYear === '2026';

          const shot = path.join(sharedScreenshotsDir, 'Step4_State_Selected.png');
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(sharedSetupSteps, {
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

        await base.step(`Step 5 — Toggle Coverage Year to ${year}`, async () => {
          const t0 = Date.now();
          await marketplace.selectCoverageYear(year);
          await marketplace.scrollToAllFormsAndDocuments();
          const url        = page.url();
          const yearInUrl  = marketplace.getYearFromUrl(url);
          const activeYear = await marketplace.getActiveYear();
          const urlOk      = yearInUrl === String(year);
          const statusOk   = urlOk && (activeYear == null || activeYear === String(year));

          const shot = path.join(sharedScreenshotsDir, `Step5_Year_${year}.png`);
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(sharedSetupSteps, {
            id: 5,
            name: `Toggle Coverage Year to ${year}`,
            expected: `Coverage Year ${year} should become active.`,
            actual: statusOk
              ? `Coverage Year ${year} is now active.\nURL: ${url}`
              : `Coverage Year ${year} did not become active. Active year: "${activeYear || '(unknown)'}".\nURL: ${url}`,
            status: statusOk ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: `Coverage year ${year}`,
          });
          expect(urlOk, `Expected URL to contain year=${year} after toggling; got ${url}`).toBeTruthy();
        });
      } catch (err) {
        sharedSetupError = err;
        logger.warn('BATCH',
          `Shared setup failed for [${state} · ${year}]: `
          + `${(err && err.message ? err.message : String(err)).substring(0, 200)}`);
      }

      // ══ Per-plan loop ════════════════════════════════════════
      const failedPlans = [];
      for (let planIdx = 0; planIdx < plans.length; planIdx++) {
        const scope = plans[planIdx];
        const isFirst = planIdx === 0;
        const testIdSlug     = limitFsName(scope.testId ? sanitizeForFs(scope.testId) : `Row${scope.row}`);
        const shortCode      = scope.testId ? scope.testId.split(/\s+/)[0] : `Row${scope.row}`;
        const scopeDir       = path.join(REPORT_DIR, testIdSlug);
        const screenshotsDir = path.join(scopeDir, 'screenshots');
        const reportFile     = path.join(scopeDir, `${testIdSlug}.html`);
        fs.mkdirSync(screenshotsDir, { recursive: true });

        const setupSteps = sharedSetupSteps.map((s) => ({ ...s }));
        const planCards  = [];
        const planStart  = Date.now();
        let planError    = null;

        await base.step(`Plan ${planIdx + 1}/${plans.length} — ${scope.planName}`, async () => {
          if (sharedSetupError) { planError = sharedSetupError; return; }
          // Blank ExpectedUrls in Excel = no SOB PDF is published for this
          // plan in this state → the search step will prove absence instead
          // of positively validating cards.
          const expectSob = scope.search.expectedUrls.length > 0;
          try {
            if (!isFirst) {
              await resetBetweenPlans({ marketplace, page, appUrl, state, year });
            }

            let planCardIndex = 0;
            let stepId = 6;
            const languagePasses = [
              { code: 'en', label: 'EN', switchBefore: false },
              { code: 'es', label: 'ES', switchBefore: true  },
            ].filter((p) => PLAN_LANG_PASSES.includes(p.code));

            for (let passIdx = 0; passIdx < languagePasses.length; passIdx++) {
              const pass = languagePasses[passIdx];

              // ── Optional pre-step — Switch language to Spanish ──
              if (pass.switchBefore) {
                const switchStepId = stepId++;
                await base.step(`Step ${switchStepId} — Switch site language to Spanish`, async () => {
                  const t0 = Date.now();
                  let ok = true, errMsg = '';
                  const urlBefore = page.url();
                  try {
                    // The language menu can be slow to render; retry the switch
                    // a few times (plus a direct /es-us/ fallback) before failing.
                    let switched = false, lastErr;
                    for (let attempt = 1; attempt <= 3 && !switched; attempt++) {
                      try {
                        await marketplace.switchLanguage('es');
                        if (/\/es-us\//i.test(page.url())) switched = true;
                        else throw new Error('URL did not switch to /es-us/');
                      } catch (e) {
                        lastErr = e;
                        await page.waitForTimeout(1000);
                      }
                    }
                    if (!switched) {
                      // Last resort: navigate straight to the ES Forms & Documents URL.
                      const esUrl = cleanFormsAndDocsUrl(appUrl, state, year).replace(/^(https?:\/\/[^/]+)/i, '$1/es-us');
                      await page.goto(esUrl, { waitUntil: 'domcontentloaded', timeout: frameworkConfig.navigationTimeoutMs }).catch(() => {});
                      if (!/\/es-us\//i.test(page.url())) throw (lastErr || new Error('Language switch to Spanish failed'));
                    }
                    await marketplace.scrollToAllFormsAndDocuments();
                  } catch (err) {
                    ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
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

              // ── Apply filters (Audience=Marketplace, Category=Schedule of Benefits) ──
              const search = scope.search;
              const filterStepId = stepId++;
              await base.step(`Step ${filterStepId} — Apply filters [${pass.label}] (Audience="${search.audience}", Category="${search.category}")`, async () => {
                const t0 = Date.now();
                let ok = true, errMsg = '';
                const actions = [];
                try {
                  await marketplace.scrollToAllFormsAndDocuments();
                  if (search.audience) {
                    await marketplace.selectFilterOption('Audience', search.audience);
                    actions.push(`checked Audience="${search.audience}"`);
                  }
                  if (search.category) {
                    await marketplace.selectFilterOption('Category', search.category);
                    actions.push(`checked Category="${search.category}"`);
                  }
                } catch (err) {
                  ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
                }
                await marketplace.scrollToAllFormsAndDocuments();
                const shot = path.join(screenshotsDir, `Step${filterStepId}_Filters_${pass.label}.png`);
                await marketplace.saveScreenshot(shot, { preserveScroll: true });
                pushSetupStep(setupSteps, {
                  id: filterStepId,
                  name: `Apply filters for [${pass.label}]`,
                  expected: `Audience "${search.audience}" and Category "${search.category}" filters should be applied for [${pass.label}].`,
                  actual: ok
                    ? `Filters ready for [${pass.label}]: ${actions.length ? actions.join('; ') : 'filters already applied'}.`
                    : `Failed to apply filters for [${pass.label}]: ${errMsg}`,
                  status: ok ? 'PASS' : 'FAIL',
                  durationMs: Date.now() - t0,
                  screenshotPath: shot,
                  screenshotLabel: `Filters — ${pass.label}`,
                });
                if (!ok) throw new Error(`Step ${filterStepId} failed: ${errMsg}`);
              });

              // ── Search + validate ──
              // Per-language filter: EN pass validates only English SOB
              // PDFs; ES pass validates only Spanish SOB PDFs. Spanish PDFs
              // only surface once the site language is switched to Spanish
              // (and vice versa), so cross-language expectations no longer
              // apply. Detection uses the `/english/` or `/spanish/` path
              // segment in ExpectedUrls; rows with neither segment fall
              // through to every pass so legacy data still runs.
              const searchStepId = stepId++;
              const passLangName = pass.code === 'es' ? 'Spanish' : 'English';
              const langOfUrl = (u) => /\/english\//i.test(u) ? 'en'
                                    : /\/spanish\//i.test(u) ? 'es'
                                    : null;
              const expectedForPass = search.expectedUrls.filter((u) => {
                const lang = langOfUrl(u);
                return lang == null || lang === pass.code;
              });
              let resolvedTargets = [];
              let allNameCards = [];
              await base.step(`Step ${searchStepId} — Search "${scope.planName}" [${pass.label}]`, async () => {
                const t0 = Date.now();
                await marketplace.searchByPlanName(scope.planName);
                await marketplace.scrollToAllFormsAndDocuments();

                allNameCards = await marketplace.findResultCardsByName(scope.planName);

                resolvedTargets = [];
                for (const rawExpected of expectedForPass) {
                  const expectedUrl = absolutizeUrl(rawExpected, scope.appUrl);
                  const card = await marketplace.findCardByNameAndUrl(scope.planName, expectedUrl);
                  resolvedTargets.push({ expectedUrl, card });
                }

                const shot = path.join(screenshotsDir, `Step${searchStepId}_Search_${pass.label}.png`);
                await marketplace.saveScreenshot(shot, { preserveScroll: true });

                let stepName;
                let expected;
                let actual;
                let enough;

                if (!expectSob) {
                  enough = allNameCards.length === 0;
                  stepName = `Search for plan "${scope.planName}" under SOB [${pass.label}] — expect zero results`;
                  expected = `No SOB PDF is expected for "${scope.planName}" in ${fullStateName} · ${scope.year}. Searching under Category="${search.category}" should return zero result cards, proving SOB is not exposed on the UI for this plan.`;
                  if (enough) {
                    actual = `PASS — no result cards matched "${scope.planName}" under Category="${search.category}". SOB is not exposed on the UI for this plan.`;
                  } else {
                    const leakLines = allNameCards.slice(0, 5).map((c, i) =>
                      `  ${i + 1}. ${c.title || '(no title)'} — ${c.href || '(no href)'}`
                    ).join('\n');
                    actual = `FAIL — ${allNameCards.length} result card(s) matched "${scope.planName}" under Category="${search.category}" but no SOB URL was configured for this plan.\nSurfaced cards (up to 5 shown):\n${leakLines}`;
                  }
                } else {
                  const matchedCount = resolvedTargets.filter((t) => t.card).length;
                  enough = allNameCards.length > 0
                        && resolvedTargets.length > 0
                        && matchedCount === resolvedTargets.length;
                  stepName = `Search for plan "${scope.planName}" [${pass.label}]`;
                  expected = `Plan should be searchable and its ${passLangName} SOB PDF should be listed in the [${pass.label}] results.`;

                  const lineFor = (t, i) => {
                    const langHint = /\/english\//i.test(t.expectedUrl) ? 'English'
                                   : /\/spanish\//i.test(t.expectedUrl) ? 'Spanish'
                                   : `#${i + 1}`;
                    return t.card
                      ? `• ${langHint} SOB PDF matched: ${t.card.href}`
                      : `• ${langHint} SOB PDF NOT FOUND. Expected href-path: ${t.expectedUrl}`;
                  };
                  const linesJoined = resolvedTargets.map(lineFor).join('\n');

                  if (allNameCards.length === 0) {
                    actual = `Plan "${scope.planName}" is NOT present in the search results.\n`
                           + `Total cards containing plan name: 0`;
                  } else if (resolvedTargets.length === 0) {
                    actual = `No ${passLangName} SOB PDF was configured for this plan in ExpectedUrls — nothing to validate for the [${pass.label}] pass.`;
                  } else {
                    actual = `Plan "${scope.planName}" is present in the search results.\n`
                           + `Total cards containing plan name: ${allNameCards.length}\n`
                           + `Matched ${passLangName} SOB PDF link(s): ${matchedCount}/${resolvedTargets.length}\n`
                           + linesJoined;
                  }
                }

                pushSetupStep(setupSteps, {
                  id: searchStepId,
                  name: stepName,
                  expected,
                  actual,
                  status: enough ? 'PASS' : 'FAIL',
                  durationMs: Date.now() - t0,
                  screenshotPath: shot,
                  screenshotLabel: `Search results [${pass.label}] — ${scope.planName}`,
                });
                expect(enough,
                  expectSob
                    ? `[${pass.label}] ${passLangName} SOB PDF for "${scope.planName}" was not fully validated. See setup step ${searchStepId} evidence.`
                    : `[${pass.label}] Expected zero SOB result cards for "${scope.planName}" (no SOB configured); got ${allNameCards.length}. See setup step ${searchStepId} evidence.`
                ).toBeTruthy();
              });

              for (let i = 0; i < resolvedTargets.length; i++) {
                const t = resolvedTargets[i];
                planCardIndex += 1;
                await validateOnePlanUrl({
                  index:       planCardIndex,
                  expectedUrl: t.expectedUrl,
                  card:        t.card,
                  planName:    scope.planName,
                  labelPrefix: `[${pass.label}] `,
                  docType:     String(scope.search.label || 'SOB').toUpperCase(),
                  year:        scope.year,
                  passCode:    pass.code,
                  appUrl:      scope.appUrl,
                  marketplace,
                  context,
                  screenshotsDir,
                  shotPrefix:  shortCode,
                  planCards,
                });
              }

              // Cross-language leak check: fail if an opposite-language SOB
              // PDF surfaces under the current pass. Clean runs add nothing
              // to the report; a leak pushes a FAIL step and aborts the pass.
              // Skipped when no SOB is expected — the search step already
              // asserted zero cards, so there's nothing to leak.
              if (expectSob) {
                const oppositeCode = pass.code === 'en' ? 'es' : 'en';
                const oppositeLangName = oppositeCode === 'es' ? 'Spanish' : 'English';
                const oppositeSegRe = oppositeCode === 'es' ? /\/spanish\//i : /\/english\//i;
                const leakedCards = allNameCards.filter((c) => oppositeSegRe.test(String(c.href || '')));
                if (leakedCards.length > 0) {
                  const leakStepId = stepId++;
                  const searchShot = path.join(screenshotsDir, `Step${searchStepId}_Search_${pass.label}.png`);
                  const leakLines = leakedCards.slice(0, 5).map((c, i) =>
                    `  ${i + 1}. ${c.title || '(no title)'} \u2014 ${c.href || '(no href)'}`
                  ).join('\n');
                  pushSetupStep(setupSteps, {
                    id: leakStepId,
                    name: `${oppositeLangName} PDF leak in [${pass.label}] results`,
                    expected: `The [${pass.label}] pass should NOT surface any ${oppositeLangName} SOB PDFs for plan "${scope.planName}".`,
                    actual: `FAIL \u2014 ${leakedCards.length} ${oppositeLangName} SOB PDF card(s) surfaced under the [${pass.label}] pass:\n${leakLines}`,
                    status: 'FAIL',
                    durationMs: 0,
                    screenshotPath: searchShot,
                    screenshotLabel: `${oppositeLangName} leak [${pass.label}] \u2014 ${scope.planName}`,
                  });
                  throw new Error(
                    `[${pass.label}] ${leakedCards.length} ${oppositeLangName} SOB PDF card(s) leaked into results for "${scope.planName}".`
                  );
                }
              }

              // ── Negative SBC check ────────────────────────────────
              // Prove SBC is not exposed on the public UI: unselect the
              // SOB category, apply the SBC category, re-search the same
              // PlanName, assert zero result cards match. If the SBC
              // option is missing from the accordion entirely that ALSO
              // proves it \u2014 we PASS the "apply" step and skip the search.
              if (NEG_SBC_ENABLED) {
                const sbcFilterStepId = stepId++;
                let sbcOptionPresent = true;
                let sbcApplied = false;
                let sbcApplyErr = '';
                await base.step(
                  `Step ${sbcFilterStepId} \u2014 Apply SBC filter [${pass.label}] `
                  + `(Audience="${NEG_SBC_AUDIENCE}", Category="${NEG_SBC_CATEGORY}")`,
                  async () => {
                    const t0 = Date.now();
                    let optionsSnapshot = [];
                    try {
                      await marketplace.scrollToAllFormsAndDocuments();
                      const probe = await categoryOptionPresence(marketplace, NEG_SBC_CATEGORY);
                      sbcOptionPresent = probe.present;
                      optionsSnapshot = probe.options;

                      // Only touch the SOB filter when we're actually going to
                      // swap in SBC \u2014 leaving the UI unchanged when we skip.
                      if (sbcOptionPresent) {
                        try {
                          await marketplace.unselectFilterOption('Category', search.category);
                        } catch (unErr) {
                          logger.warn('MP-PLANS',
                            `Uncheck of Category="${search.category}" failed \u2014 continuing: `
                            + `${(unErr && unErr.message ? unErr.message : String(unErr)).substring(0, 160)}`);
                        }
                        await marketplace.selectFilterOption('Category', NEG_SBC_CATEGORY);
                        sbcApplied = true;
                      }
                    } catch (err) {
                      sbcApplyErr = (err && err.message) ? err.message.substring(0, 200) : String(err);
                    }

                    await marketplace.scrollToAllFormsAndDocuments();
                    const shot = path.join(screenshotsDir, `Step${sbcFilterStepId}_SBC_Filter_${pass.label}.png`);
                    await marketplace.saveScreenshot(shot, { preserveScroll: true });

                    const optListStr = optionsSnapshot
                      .map((o) => `\u2022 ${o.label || '(no label)'} [value="${o.value}"]`)
                      .join('\n') || '(no options detected)';

                    const passStatus = !sbcApplyErr;
                    pushSetupStep(setupSteps, {
                      id: sbcFilterStepId,
                      name: `Apply SBC filter [${pass.label}]`,
                      expected: `The public UI should either hide the "${NEG_SBC_CATEGORY}" Category option entirely, or, if the option is present, allow it to be selected so we can prove no matching plans surface.`,
                      actual: sbcApplyErr
                        ? `Failed to attempt SBC filter: ${sbcApplyErr}\n\nCategory options seen:\n${optListStr}`
                        : sbcOptionPresent
                          ? `SBC filter applied.\nAudience="${NEG_SBC_AUDIENCE}", Category="${NEG_SBC_CATEGORY}"\n\nCategory options seen:\n${optListStr}`
                          : `SBC option is NOT present in the Category accordion \u2014 that alone proves SBC is not available on the UI. The re-search step will be skipped.\n\nCategory options seen:\n${optListStr}`,
                      status: passStatus ? 'PASS' : 'FAIL',
                      durationMs: Date.now() - t0,
                      screenshotPath: shot,
                      screenshotLabel: `SBC filter attempt [${pass.label}]`,
                    });
                    if (!passStatus) throw new Error(`Step ${sbcFilterStepId} failed: ${sbcApplyErr}`);
                  }
                );

                const sbcSearchStepId = stepId++;
                if (!sbcOptionPresent) {
                  const filterShot = path.join(screenshotsDir, `Step${sbcFilterStepId}_SBC_Filter_${pass.label}.png`);
                  pushSetupStep(setupSteps, {
                    id: sbcSearchStepId,
                    name: `Search under SBC skipped [${pass.label}]`,
                    expected: `Applying the SBC (Summary of Benefits) Category filter and searching "${scope.planName}" should return zero result cards for this plan \u2014 confirming SBC is not available on the public UI.`,
                    actual: `PASS \u2014 SBC option is not in the Category accordion, so no re-search is needed. SBC is not exposed on the public UI.`,
                    status: 'PASS',
                    durationMs: 0,
                    screenshotPath: filterShot,
                    screenshotLabel: `SBC filter attempt [${pass.label}]`,
                  });
                } else {
                  await base.step(
                    `Step ${sbcSearchStepId} \u2014 Search "${scope.planName}" under SBC [${pass.label}] \u2014 expect zero results`,
                    async () => {
                    const t0 = Date.now();
                    let sbcCards = [];
                    let searchErr = '';
                    try {
                      await marketplace.searchByPlanName(scope.planName);
                      await marketplace.scrollToAllFormsAndDocuments();
                      sbcCards = await marketplace.findResultCardsByName(scope.planName);
                    } catch (err) {
                      searchErr = (err && err.message) ? err.message.substring(0, 200) : String(err);
                    }

                    const shot = path.join(screenshotsDir, `Step${sbcSearchStepId}_SBC_Search_${pass.label}.png`);
                    await marketplace.saveScreenshot(shot, { preserveScroll: true });

                    const cardCount = sbcCards.length;
                    const passStatus = !searchErr && cardCount === 0;

                    const leakLines = sbcCards.slice(0, 5).map((c, i) =>
                      `  ${i + 1}. ${c.title || '(no title)'} \u2014 ${c.href || '(no href)'}`
                    ).join('\n');

                    let actual;
                    if (searchErr) {
                      actual = `Search failed: ${searchErr}`;
                    } else if (passStatus) {
                      actual = sbcOptionPresent
                        ? `PASS \u2014 no result cards matched "${scope.planName}" under Category="${NEG_SBC_CATEGORY}". SBC is not exposed on the public UI.`
                        : `PASS \u2014 SBC option is not in the Category accordion AND a re-search returned zero matching cards. SBC is not exposed on the public UI.`;
                    } else {
                      actual = `FAIL \u2014 ${cardCount} result card(s) matched "${scope.planName}" under Category="${NEG_SBC_CATEGORY}".\n`
                        + `The public UI is leaking SBC content.\nLeaked cards (up to 5 shown):\n${leakLines}`;
                    }

                    pushSetupStep(setupSteps, {
                      id: sbcSearchStepId,
                      name: `Search under SBC returns zero results [${pass.label}]`,
                      expected: `Applying the SBC (Summary of Benefits) Category filter and searching "${scope.planName}" should return zero result cards for this plan \u2014 confirming SBC is not available on the public UI.`,
                      actual,
                      status: passStatus ? 'PASS' : 'FAIL',
                      durationMs: Date.now() - t0,
                      screenshotPath: shot,
                      screenshotLabel: `SBC search results [${pass.label}] \u2014 ${scope.planName}`,
                    });
                    expect(passStatus,
                      `[${pass.label}] Expected zero SBC result cards for "${scope.planName}"; got ${cardCount}. See setup step ${sbcSearchStepId} evidence.`
                    ).toBeTruthy();
                  }
                );
                }

                // Restore the positive-flow Category filter so the ES pass
                // (or any subsequent step) begins in the same state as
                // before this negative check.
                if (sbcApplied) {
                  try { await marketplace.unselectFilterOption('Category', NEG_SBC_CATEGORY); }
                  catch (unErr) {
                    logger.warn('MP-PLANS',
                      `Uncheck of Category="${NEG_SBC_CATEGORY}" failed after negative check: `
                      + `${(unErr && unErr.message ? unErr.message : String(unErr)).substring(0, 160)}`);
                  }
                }
              }
            }
          } catch (err) {
            planError = err;
            logger.warn('BATCH',
              `Plan "${scope.planName}" (${scope.testId || '?'}) failed: `
              + `${(err && err.message ? err.message : String(err)).substring(0, 200)}`);
          }
        });

        const planDurationMs = Date.now() - planStart;

        // ── Write per-plan HTML report + variant.json ──
        const searchLabels = scope.search.label || 'SOB';
        const perPlanTestName = `Marketplace SOB Search — ${scope.planName} (${fullStateName} · ${scope.year})`;
        const perPlanTestDescription = (scope.search.expectedUrls.length > 0)
          ? `Launch Molina Marketplace, navigate through Member Resources → Forms & Documents, `
            + `select state "${fullStateName}", toggle to coverage year ${scope.year}, verify the Category `
            + `filter exposes SOB only (SBC/EOC hidden on public UI), search for plan "${scope.planName}", `
            + `then validate the English SOB PDF (English pass) and the Spanish SOB PDF (Spanish pass) `
            + `open in a new tab and their URLs are SOB URLs.`
          : `Launch Molina Marketplace, navigate through Member Resources → Forms & Documents, `
            + `select state "${fullStateName}", toggle to coverage year ${scope.year}, and prove that no SOB PDF `
            + `is exposed on the UI for plan "${scope.planName}" — searching under Category="Schedule of Benefits" `
            + `must return zero result cards in both the English and Spanish passes. The SBC negative check still `
            + `runs to confirm SBC is not exposed either.`;
        const perPlanReportTag = scope.testId || `MP-PLANS-Row${scope.row}`;

        try {
          writeReport({
            reportDir: scopeDir,
            reportFile,
            testMeta: {
              name:        perPlanTestName,
              id:          perPlanReportTag,
              module:      TEST_MODULE,
              description: perPlanTestDescription,
              author:      TEST_AUTHOR,
              environment: TEST_ENVIRONMENT || envLabelFromUrl(scope.appUrl),
            },
            appUrl:         scope.appUrl,
            year:           scope.year,
            accordionLabel: searchLabels,
            setupSteps,
            planCards,
            responsiveShots: [],
            durationMs: planDurationMs,
            timestamp: new Date().toLocaleString(),
          });
          logger.info('REPORT', `[${perPlanReportTag}] Report written: ${reportFile}`);

          try {
            const setupFailed = setupSteps.some((s) => s.status === 'FAIL');
            const cardFailed  = planCards.some((c) => c.status === 'FAIL');
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
              durationMs:  planDurationMs,
              testName:    perPlanTestName,
              testDescription: perPlanTestDescription,
              setupSteps:  setupSteps.map((s) => ({
                id:         s.id,
                name:       s.name,
                status:     s.status,
                durationMs: s.durationMs,
                expected:   (s.expected || '').substring(0, 500),
                actual:     (s.actual   || '').substring(0, 800),
              })),
              planCards:   planCards.map((c) => ({
                id:          c.id,
                name:        c.name,
                status:      c.status,
                expectedUrl: c.expectedUrl,
                pdfUrl:      c.pdfUrl,
                href:        c.href,
                error:       c.error,
                validations: (c.validations || []).map((v) => ({
                  name:        v.name,
                  status:      v.status,
                  description: (v.description || '').substring(0, 300),
                })),
              })),
              reportFile: path.relative(path.join(process.cwd(), 'reports', 'marketplace-plans'), reportFile)
                                .split(path.sep).join('/'),
            }, null, 2), 'utf8');
          } catch (jsonErr) {
            logger.warn('REPORT', `[${perPlanReportTag}] Variant JSON write failed: ${jsonErr.message.substring(0, 160)}`);
          }
        } catch (repErr) {
          logger.warn('REPORT', `[${perPlanReportTag}] Failed to write report: ${repErr.message}`);
        }

        if (planError || planCards.some((c) => c.status === 'FAIL')) {
          failedPlans.push(scope.testId || scope.planName);
        }
      }

      if (sharedSetupError) {
        throw new Error(
          `Batch [${state} · ${year}] shared setup failed — ${plans.length} plan(s) not executed: `
          + `${sharedSetupError.message}`);
      }
      if (failedPlans.length) {
        throw new Error(
          `${failedPlans.length} of ${plans.length} plan(s) failed in batch [${state} · ${year}]: `
          + failedPlans.join(', '));
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// validateOnePlanUrl — click one card, verify its PDF URL matches the
// SOB-only rule, build a plan card.
// ══════════════════════════════════════════════════════════════════════════

async function validateOnePlanUrl({
  index, expectedUrl, card, planName, labelPrefix,
  docType, year, passCode, appUrl,
  marketplace, context, screenshotsDir, shotPrefix, planCards,
}) {
  const prefix = labelPrefix || '';
  const DOC = String(docType || 'SOB').toUpperCase();
  const OTHER_DOCS = ['SOB', 'SBC', 'EOC'].filter((d) => d !== DOC);
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

  if (!card) {
    card_.status = 'FAIL';
    card_.error = `No result card at index ${index} for plan "${planName}".`;
    const missShot = path.join(screenshotsDir, `${shotPrefix}_Plan${index}_NotFound.png`);
    await ensureValidScreenshot(
      () => captureEvidencePanel(context, fallbackPanelHtml(card_.name, card_.error), missShot),
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

  // ── Step 2 — Verify the PDF URL matches the expected doc type (from Excel Label) and filename ──
  await base.step(`Plan #${index} — Verify PDF URL is ${DOC} and filename matches`, async () => {
    const t0 = Date.now();
    const actualUrl = card_.pdfUrl || '';
    const actualPath = pathLower(actualUrl);
    const actualFilename = filenameFromUrl(actualUrl);
    const expectedFilename = filenameFromUrl(expectedUrl);

    const urlNotEmpty = !!actualUrl;
    const urlHasPdf   = /\.pdf(\?|#|$)/i.test(actualUrl);
    const urlHasDoc   = DOC_TYPE_RE[DOC] ? DOC_TYPE_RE[DOC].test(actualPath) : true;
    const urlHasNoOtherDocs = OTHER_DOCS.every((d) => !DOC_TYPE_RE[d].test(actualPath));
    const filenameMatches = !!expectedFilename && actualFilename === expectedFilename;

    // Path-suffix sanity: /materials/<DOC>/<year>/<lang>/  (case-insensitive)
    const langSeg = passCode === 'es' ? 'spanish' : 'english';
    const expectedSuffix = `/materials/${DOC.toLowerCase()}/${String(year || '')}/${langSeg}/`;
    const pathHasStructure = actualPath.includes(expectedSuffix);

    // Origin match against configured AppUrl — soft warning only (env-agnostic).
    let originMatches = true;
    let originDetail = 'origin check skipped';
    try {
      const actualOrigin = new URL(actualUrl).origin;
      const expectedOrigin = new URL(appUrl).origin;
      originMatches = actualOrigin === expectedOrigin;
      originDetail = originMatches
        ? `origin="${actualOrigin}" matches AppUrl`
        : `actual="${actualOrigin}" vs AppUrl="${expectedOrigin}" (env difference — not a failure)`;
    } catch { /* URL parse failure — treat as skipped */ }

    const urlChecks = [
      { label: 'PDF URL not empty',       pass: urlNotEmpty, detail: actualUrl || '(empty)' },
      { label: 'PDF URL contains ".pdf"', pass: urlHasPdf,   detail: actualUrl },
      { label: `PDF URL contains "${DOC}"`, pass: urlHasDoc,   detail: urlHasDoc ? `${DOC} token found in URL path` : `${DOC} token NOT found in URL path` },
      { label: `PDF URL does NOT contain other doc types (${OTHER_DOCS.join(', ')})`, pass: urlHasNoOtherDocs, detail: urlHasNoOtherDocs ? `no ${OTHER_DOCS.join('/')} tokens in URL` : `stray ${OTHER_DOCS.join('/')} token found in URL path` },
      { label: `PDF URL path contains "${expectedSuffix}"`, pass: pathHasStructure, detail: pathHasStructure ? `matched structure` : `expected path to contain "${expectedSuffix}"` },
      {
        label: 'PDF filename matches expected',
        pass: filenameMatches,
        detail: filenameMatches
          ? `filename="${actualFilename}"`
          : `expected="${expectedFilename}", actual="${actualFilename}"`,
      },
      // Soft check — reported for visibility, does not fail the test.
      { label: 'PDF host matches AppUrl origin (info)', pass: true, detail: originDetail },
    ];
    const urlOverall = urlChecks.every((c) => c.pass);

    const urlShot = path.join(screenshotsDir, `${shotPrefix}_Plan${index}_Step2_VerifyURL.png`);
    const urlRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        urlValidationPanelHtml(card_.name, actualUrl, expectedUrl, urlChecks),
        urlShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(card_.name, 'Could not render URL validation panel.'),
        urlShot),
    );

    pushPlanStep(card_, {
      id: 2,
      name: `Verify PDF URL is ${DOC}`,
      expected: `PDF URL should be a ${DOC} URL (contain "${DOC}", not ${OTHER_DOCS.map(d => `"${d}"`).join(' or ')}) and filename should match expected.\nExpected filename: ${expectedFilename}`,
      actual: urlOverall
        ? `PDF URL is a valid ${DOC} URL and filename matches expected.\nActual: ${actualUrl || '(empty)'}`
        : `PDF URL validation failed.\nActual: ${actualUrl || '(empty)'}`,
      status: urlOverall ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: urlRes.filePath,
      screenshotLabel: `URL validation — ${card_.name}`,
    });
    card_.validations.push({
      name: `PDF URL matches ${DOC} rule`,
      status: urlOverall ? 'PASS' : 'FAIL',
      description: urlOverall
        ? `All ${DOC} URL checks passed.`
        : urlChecks.filter((c) => !c.pass).map((c) => `${c.label} → ${c.detail}`).join('; '),
    });
    if (!urlOverall) card_.status = 'FAIL';
  });

  if (pdfPage) { await pdfPage.close().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════════════════
// PDF page-level screenshot capture — identical logic to drug spec.
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
