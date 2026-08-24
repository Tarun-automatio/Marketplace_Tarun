/**
 * Marketplace — Brochure & Formulary verification (Requirement 2b)
 * ─────────────────────────────────────────────────────────────────────────
 * Per state, on the Forms & Documents page (Coverage Year 2027), per language:
 *
 *   1. Apply filter Audience=Marketplace, Category=Formulary and Drug Lists
 *      → search by Formulary filename stem → verify each expected Formulary
 *        card opens the correct PDF (URL contains /formulary/, filename matches).
 *   2. Uncheck previous Category, apply Category=Member Handbooks and Coverage
 *      → search by Member Brochure filename stem → verify each expected Member
 *        Brochure card (EN + ES) opens the correct PDF.
 *   3. With the same "Member Handbooks and Coverage" filter still applied,
 *      re-search by Broker Brochure filename stem → verify each expected
 *      Broker Brochure card (EN + ES) opens the correct PDF.
 *   4. Repeat 1-3 under Spanish site language.
 *
 * Reuses:
 *   • pages/marketplacePage.js — nav + filter + search primitives (unchanged)
 *   • helpers/evidencePanel.js — step tables + evidence panel builders
 *   • reporting/reportGenerator.js — writeReport() renders the per-state HTML
 *
 * Excel schema (one row per state) is documented at the top of
 * `data/marketplace/MarketplaceBrochureFormularyData.xlsx` /
 * `scripts/createBrochureFormularyExcel.js`.
 *
 * Emits `variant.json` next to each per-state report so
 * `hooks/marketplaceBrochureFormularySummary.js` can build a consolidated
 * dashboard + flat share folder at run's end.
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { test: base, expect } = require('@playwright/test');

const frameworkConfig = require('../../config/framework.config');
const logger          = require('../../utils/logger');
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
// Config
// ══════════════════════════════════════════════════════════════════════════

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

const CFG = frameworkConfig.marketplaceBrochureFormulary;

const EXCEL_PATH      = CFG.excelPath;
const EXCEL_SHEET     = CFG.excelSheet;
const REPORT_DIR      = CFG.report.dir;

// Load the Settings sheet up-front so URL / filter labels / host swap /
// languages can be data-driven. Precedence per key:
//   1. explicit env var (for CI one-off overrides)
//   2. Excel Settings sheet
//   3. hardcoded fallback in framework.config.js
const SHEET_SETTINGS = loadSheetSettings(EXCEL_PATH, 'Settings');

const pickSetting = (envName, sheetKey, cfgFallback) => {
  const envVal   = process.env[envName];
  if (envVal != null && String(envVal).trim() !== '') return String(envVal).trim();
  const sheetVal = SHEET_SETTINGS[sheetKey];
  if (sheetVal != null && String(sheetVal).trim() !== '') return String(sheetVal).trim();
  return cfgFallback;
};

const APP_URL_DEFAULT = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_URL', 'AppUrl', CFG.urls.appUrl);

const F_STATE = String(CFG.matrixFilters.state || '').trim();
const F_YEAR  = String(CFG.matrixFilters.year  || '').trim();

const FILTER_AUDIENCE      = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_AUDIENCE',        'Audience',          CFG.filters.audience          || 'Marketplace');
const FILTER_CAT_FORMULARY = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_CATEGORY_FORM',   'FormularyCategory', CFG.filters.formularyCategory || 'Formulary and Drug Lists');
const FILTER_CAT_BROCHURE  = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_CATEGORY_BROCH',  'BrochureCategory',  CFG.filters.brochureCategory  || 'Member Handbooks and Coverage');

const HOST_SRC = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_SOURCE_HOST', 'SourceHost', CFG.hostRewrite.source || '').toLowerCase();
const HOST_DST = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_TARGET_HOST', 'TargetHost', CFG.hostRewrite.target || '').toLowerCase();

const LANGUAGES = (() => {
  const raw = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_LANGS', 'Languages', '');
  const parsed = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parsed.length) return parsed;
  return (Array.isArray(CFG.languages) && CFG.languages.length) ? CFG.languages : ['en', 'es'];
})();

const BROKER_ENABLED = (() => {
  const raw = pickSetting('MARKETPLACE_BROCHURE_FORMULARY_BROKER_ENABLED', 'BrokerEnabled', '');
  if (raw === '') return CFG.brokerBrochure.enabled !== false;
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
})();

const TEST_MODULE      = CFG.test.module;
const TEST_AUTHOR      = CFG.test.author;
const TEST_ENVIRONMENT = CFG.test.environment;

const NEW_TAB_TIMEOUT = frameworkConfig.pageLoadWaitMs        || 45000;
const PDF_RENDER_WAIT = frameworkConfig.waitAfterNetworkIdleMs || 2000;

// Doc-type detection for URL leak checks. Anchored on non-alphanumeric
// boundaries so a state name accidentally containing the letters can't
// trip the assertion.
const DOC_TYPE_RE = {
  FORMULARY: /(?:^|[^a-z0-9])formulary(?:[^a-z0-9]|\d|$)/i,
  BROCHURE:  /(?:^|[^a-z0-9])brochure(?:[^a-z0-9]|\d|$)/i,
};

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
  'TX-OX': 'Texas (Off-Exchange)',
};
function fullNameForStateCode(code) {
  const key = String(code || '').trim().toUpperCase();
  return STATE_CODE_TO_NAME[key] || key;
}

/** Rewrite an absolute URL's hostname when it matches `HOST_SRC`. */
function rewriteHost(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s || !HOST_SRC || !HOST_DST || HOST_SRC === HOST_DST) return s;
  try {
    const u = new URL(s);
    if (u.hostname.toLowerCase() === HOST_SRC) {
      u.hostname = HOST_DST;
      return u.toString();
    }
    return s;
  } catch { return s; }
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

function filenameFromUrl(url) {
  const p = pathLower(url);
  return (p.split('/').pop() || '').trim();
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
  } catch { return s; }
}

// ══════════════════════════════════════════════════════════════════════════
// Matrix loader — one row per state, expanded to a scope object
// ══════════════════════════════════════════════════════════════════════════

function loadTestMatrix() {
  if (!EXCEL_PATH || !fs.existsSync(EXCEL_PATH)) {
    logger.warn('MP-BF', `Excel not found: ${EXCEL_PATH || '(unset)'} — running 0 tests`);
    return [];
  }
  let wb;
  try { wb = XLSX.readFile(EXCEL_PATH); }
  catch (err) {
    logger.warn('MP-BF', `Excel read failed: ${err.message.substring(0, 120)} — running 0 tests`);
    return [];
  }
  const sheet = wb.Sheets[EXCEL_SHEET] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    logger.warn('MP-BF', `Sheet "${EXCEL_SHEET}" missing — running 0 tests`);
    return [];
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const scopes = rows
    .filter((r) => norm(r.Run).toUpperCase() === 'Y')
    .map((r, i) => {
      const state = norm(r.State).toUpperCase();
      const year  = norm(r.Year) || String(frameworkConfig.marketplace?.years?.alternate || '2027');
      return {
        row:    i + 2,
        testId: norm(r.TestId) || `Row${i + 2}`,
        state,
        year,
        appUrl: APP_URL_DEFAULT,
        formulary: {
          search: norm(r.Formulary_Search),
          items:  buildLangItems({
            enName: norm(r.Formulary_EN_Name),  esName: norm(r.Formulary_ES_Name),
            enUrl:  norm(r.Formulary_EN_URL),   esUrl:  norm(r.Formulary_ES_URL),
          }),
        },
        memberBrochure: {
          search: norm(r.MemberBrochure_Search),
          items:  buildLangItems({
            enName: norm(r.MemberBrochure_EN_Name), esName: norm(r.MemberBrochure_ES_Name),
            enUrl:  norm(r.MemberBrochure_EN_URL),  esUrl:  norm(r.MemberBrochure_ES_URL),
          }),
        },
        brokerBrochure: {
          search: norm(r.BrokerBrochure_Search) || norm(r.BrokerBrochure_EN_Name).replace(/\.pdf$/i, ''),
          items: buildLangItems({
            enName: norm(r.BrokerBrochure_EN_Name), esName: norm(r.BrokerBrochure_ES_Name),
            enUrl:  norm(r.BrokerBrochure_EN_URL),  esUrl:  norm(r.BrokerBrochure_ES_URL),
          }),
        },
        vanityFormulary: norm(r.VanityFormulary),
        notes:           norm(r.Notes),
      };
    })
    .filter((s) => s.state)
    .filter((s) => !F_STATE || s.state === F_STATE.toUpperCase())
    .filter((s) => !F_YEAR  || s.year  === F_YEAR);

  if (!scopes.length) {
    const bits = [F_STATE && `state=${F_STATE}`, F_YEAR && `year=${F_YEAR}`].filter(Boolean).join(', ');
    logger.warn('MP-BF',
      `No Run=Y state rows in ${path.basename(EXCEL_PATH)}${bits ? ` matching ${bits}` : ''} — running 0 tests`);
    return [];
  }
  logger.info('MP-BF',
    `Loaded ${scopes.length} state scope(s) from ${path.basename(EXCEL_PATH)}: `
    + scopes.map((s) => `${s.state}·${s.year}`).join(', '));
  return scopes;
}

/** Build a { en, es } → items map, dropping empty langs. */
function buildLangItems({ enName, esName, enUrl, esUrl }) {
  const items = [];
  if (enUrl) items.push({ lang: 'en', name: enName || filenameFromUrl(enUrl), url: rewriteHost(enUrl) });
  if (esUrl) items.push({ lang: 'es', name: esName || filenameFromUrl(esUrl), url: rewriteHost(esUrl) });
  return items;
}

const TEST_MATRIX = loadTestMatrix();

// ══════════════════════════════════════════════════════════════════════════
// Per-state batch timeouts
// ══════════════════════════════════════════════════════════════════════════

const SHARED_SETUP_BUDGET_MS = 120_000;
const PER_LANG_BUDGET_MS     = 180_000;
const BROKER_BUDGET_MS       = 90_000;
const STATE_SLACK_MS         = 60_000;

function timeoutForState(scope) {
  const langCount = LANGUAGES.length || 1;
  return SHARED_SETUP_BUDGET_MS + (langCount * PER_LANG_BUDGET_MS) + BROKER_BUDGET_MS + STATE_SLACK_MS;
}

// ══════════════════════════════════════════════════════════════════════════
// Test registration
// ══════════════════════════════════════════════════════════════════════════

if (TEST_MATRIX.length === 0) {
  base.describe('Marketplace Brochure & Formulary — matrix', () => {
    base('No state scopes matched the current filters', () => {
      throw new Error(
        'MarketplaceBrochureFormulary matrix is empty. Check:\n'
        + `  • Excel file: ${EXCEL_PATH}\n`
        + `  • Sheet: ${EXCEL_SHEET}\n`
        + '  • At least one row with Run=Y, State, and at least one URL cell\n'
        + `  • Filters: STATE="${F_STATE}", YEAR="${F_YEAR}"`
      );
    });
  });
} else {
  for (const scope of TEST_MATRIX) registerScope(scope);
}

// ─────────────────────────────────────────────────────────────────────────
// One describe + one test per state row.
// ─────────────────────────────────────────────────────────────────────────

function registerScope(scope) {
  const { state, year, appUrl } = scope;
  const fullStateName = fullNameForStateCode(state);
  const testIdSlug     = sanitizeForFs(scope.testId);
  const scopeDir       = path.join(REPORT_DIR, testIdSlug);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile     = path.join(scopeDir, `${testIdSlug}.html`);

  const describeTitle = scope.testId
    ? `${scope.testId} — ${fullStateName} · ${year}`
    : `Marketplace Brochure & Formulary — ${fullStateName} · ${year}`;
  const testName = `${fullStateName} (${state}) · ${year} — verify Formulary + Member Brochure + Broker Brochure via Marketplace filters (EN + ES)`;
  const testDescription =
    `Launch Molina Marketplace, navigate through Member Resources \u2192 Forms & Documents, `
    + `select state "${fullStateName}", toggle to coverage year ${year}, then run two filter passes per `
    + `language (EN + ES): (1) apply Audience="${FILTER_AUDIENCE}" Category="${FILTER_CAT_FORMULARY}", search + `
    + `verify Formulary PDF(s); (2) apply Audience="${FILTER_AUDIENCE}" Category="${FILTER_CAT_BROCHURE}", search + `
    + `verify Member Brochure PDF(s), then re-search under the same filter for the Broker Brochure filename and `
    + `verify those cards too.`
    + (scope.notes ? `  Notes: ${scope.notes}` : '');

  base.describe(describeTitle, () => {
    base.describe.configure({ retries: 0, mode: 'serial' });

    base(testName, async ({ page, context }) => {
      base.setTimeout(timeoutForState(scope));
      fs.mkdirSync(screenshotsDir, { recursive: true });

      const marketplace = new MarketplacePage(page);
      const setupSteps = [];
      const planCards  = [];   // one card per verified PDF URL
      const runStart   = Date.now();
      let sharedSetupError = null;
      let stepId = 1;

      // ══ Shared Steps 1..5 — nav to Forms & Documents ══════════════
      try {
        await base.step(`Step ${stepId} — Launch Application URL`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          let ok = true, errMsg = '';
          try { await marketplace.open(appUrl); }
          catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
          const shot = path.join(screenshotsDir, `Step${id}_Marketplace_Home.png`);
          await marketplace.saveScreenshot(shot);
          pushSetupStep(setupSteps, {
            id,
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
          if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
        });

        await base.step(`Step ${stepId} — Open Member Resources Menu`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          let ok = true, errMsg = '';
          try { await marketplace.openMemberResources(); }
          catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
          const shot = path.join(screenshotsDir, `Step${id}_Member_Resources_Menu.png`);
          await marketplace.saveScreenshot(shot);
          pushSetupStep(setupSteps, {
            id,
            name: 'Open Member Resources Menu',
            expected: 'Member Resources menu should open successfully.',
            actual: ok ? 'Member Resources menu opened successfully.' : `Failed: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Member Resources menu',
          });
          if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
        });

        await base.step(`Step ${stepId} — Open Forms & Documents Page`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          let ok = true, errMsg = '';
          try { await marketplace.openFormsAndDocuments(); }
          catch (err) { ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err); }
          const shot = path.join(screenshotsDir, `Step${id}_Forms_And_Documents.png`);
          await marketplace.saveScreenshot(shot);
          pushSetupStep(setupSteps, {
            id,
            name: 'Open Forms & Documents Page',
            expected: 'Forms & Documents page should load successfully.',
            actual: ok
              ? `Forms & Documents Page loaded successfully.\nURL: ${page.url()}`
              : `Failed: ${errMsg}`,
            status: ok ? 'PASS' : 'FAIL',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'Forms & Documents page',
          });
          if (!ok) throw new Error(`Step ${id} failed: ${errMsg}`);
        });

        await base.step(`Step ${stepId} — Select state ${fullStateName}`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          // TX-OX uses the /ifp/tx/ folder, but the state dropdown still
          // uses the underlying 2-letter code ("tx") — strip any -OX suffix.
          const dropdownState = String(state).split('-')[0];
          const res = await marketplace.selectState(dropdownState);
          if (!res.selected) {
            const msg = res.reason === 'not-in-dropdown'
              ? `State "${fullStateName}" is not available in the dropdown. Available: [${res.availableStates.join(', ')}]`
              : `Failed to select state "${fullStateName}": ${res.errorMessage || res.reason}`;
            const shot = path.join(screenshotsDir, `Step${id}_State_Select_FAIL.png`);
            await marketplace.saveScreenshot(shot);
            pushSetupStep(setupSteps, {
              id,
              name: `Select state ${fullStateName}`,
              expected: `State "${fullStateName}" should be selected.`,
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
          const shot = path.join(screenshotsDir, `Step${id}_State_Selected.png`);
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(setupSteps, {
            id,
            name: `Select state ${fullStateName}`,
            expected: `State "${fullStateName}" should be selected.`,
            actual: `State "${fullStateName}" selected. Active Coverage Year: "${activeYear || '(unknown)'}".\nURL: ${url}`,
            status: 'PASS',
            durationMs: Date.now() - t0,
            screenshotPath: shot,
            screenshotLabel: 'State selected',
          });
        });

        await base.step(`Step ${stepId} — Toggle Coverage Year to ${year}`, async () => {
          const id = stepId++;
          const t0 = Date.now();
          await marketplace.selectCoverageYear(year);
          await marketplace.scrollToAllFormsAndDocuments();
          const url        = page.url();
          const yearInUrl  = marketplace.getYearFromUrl(url);
          const activeYear = await marketplace.getActiveYear();
          const urlOk      = yearInUrl === String(year);
          const statusOk   = urlOk && (activeYear == null || activeYear === String(year));
          const shot = path.join(screenshotsDir, `Step${id}_Year_${year}.png`);
          await marketplace.saveScreenshot(shot, { preserveScroll: true });
          pushSetupStep(setupSteps, {
            id,
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
        logger.warn('MP-BF',
          `Shared setup failed for [${state} · ${year}]: `
          + `${(err && err.message ? err.message : String(err)).substring(0, 200)}`);
      }

      // ══ Per-language pass — Formulary + Member Brochure ══════════
      let cardIndex = 0;
      if (!sharedSetupError) {
        for (let passIdx = 0; passIdx < LANGUAGES.length; passIdx++) {
          const langCode  = LANGUAGES[passIdx];
          const langLabel = langCode === 'es' ? 'ES' : 'EN';

          if (langCode === 'es') {
            await base.step(`Step ${stepId} — Switch site language to Spanish`, async () => {
              const id = stepId++;
              const t0 = Date.now();
              let ok = true, errMsg = '';
              const urlBefore = page.url();
              try {
                await marketplace.switchLanguage('es');
                await marketplace.scrollToAllFormsAndDocuments();
              } catch (err) {
                ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
              }
              const urlAfter = page.url();
              const urlOk    = /\/es-us\//i.test(urlAfter);
              const passStatus = ok && urlOk;
              const shot = path.join(screenshotsDir, `Step${id}_LanguageSwitch_ES.png`);
              await marketplace.saveScreenshot(shot, { preserveScroll: true });
              pushSetupStep(setupSteps, {
                id,
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

          // ── Formulary flow ──────────────────────────────────
          if (scope.formulary.items.length) {
            const filterId = stepId++;
            await runFilterStep({
              stepId: filterId,
              name: `Apply Formulary filter [${langLabel}]`,
              audience: FILTER_AUDIENCE,
              category: FILTER_CAT_FORMULARY,
              previousCategory: null,
              marketplace,
              screenshotsDir,
              setupSteps,
              langLabel,
            });

            const searchId = stepId++;
            cardIndex = await runSearchAndValidate({
              stepId: searchId,
              docTypeLabel: 'Formulary',
              docTypeToken: 'FORMULARY',
              searchText: scope.formulary.search || 'Formulary',
              items: scope.formulary.items,
              scope, marketplace, context,
              screenshotsDir, setupSteps, planCards,
              langLabel, startCardIndex: cardIndex,
            });
          } else {
            const skipId = stepId++;
            pushSetupStep(setupSteps, {
              id: skipId,
              name: `Formulary [${langLabel}] — skipped (no expected URLs for this state)`,
              expected: 'A Formulary URL was expected in the data sheet.',
              actual: 'No Formulary URLs configured — skipping this doc-type for this state.',
              status: 'INFO',
              durationMs: 0,
            });
          }

          // ── Member Brochure flow (uncheck Formulary Category first) ─
          if (scope.memberBrochure.items.length) {
            const filterId = stepId++;
            await runFilterStep({
              stepId: filterId,
              name: `Apply Member Brochure filter [${langLabel}]`,
              audience: FILTER_AUDIENCE,
              category: FILTER_CAT_BROCHURE,
              previousCategory: scope.formulary.items.length ? FILTER_CAT_FORMULARY : null,
              marketplace,
              screenshotsDir,
              setupSteps,
              langLabel,
            });

            const searchId = stepId++;
            cardIndex = await runSearchAndValidate({
              stepId: searchId,
              docTypeLabel: 'Member Brochure',
              docTypeToken: 'BROCHURE',
              searchText: scope.memberBrochure.search || 'Brochure',
              items: scope.memberBrochure.items,
              scope, marketplace, context,
              screenshotsDir, setupSteps, planCards,
              langLabel, startCardIndex: cardIndex,
            });

            // Broker Brochure shares the same filter — just re-search
            // with the broker filename stem while the Member Handbooks
            // and Coverage filter stays applied.
            if (BROKER_ENABLED && scope.brokerBrochure.items.length) {
              const brokerSearchId = stepId++;
              cardIndex = await runSearchAndValidate({
                stepId: brokerSearchId,
                docTypeLabel: 'Broker Brochure',
                docTypeToken: 'BROCHURE',
                searchText: scope.brokerBrochure.search || 'Brochure',
                items: scope.brokerBrochure.items,
                scope, marketplace, context,
                screenshotsDir, setupSteps, planCards,
                langLabel, startCardIndex: cardIndex,
              });
            }

            // Reset the brochure filter so the ES pass (if any) starts clean.
            try { await marketplace.unselectFilterOption('Category', FILTER_CAT_BROCHURE); }
            catch (err) {
              logger.warn('MP-BF',
                `Uncheck Category="${FILTER_CAT_BROCHURE}" after [${langLabel}] failed — continuing: `
                + `${(err && err.message ? err.message : String(err)).substring(0, 160)}`);
            }
          } else {
            const skipId = stepId++;
            pushSetupStep(setupSteps, {
              id: skipId,
              name: `Member Brochure [${langLabel}] — skipped (no expected URLs for this state)`,
              expected: 'A Member Brochure URL was expected in the data sheet.',
              actual: 'No Member Brochure URLs configured — skipping this doc-type for this state.',
              status: 'INFO',
              durationMs: 0,
            });
          }
        }
      }

      // ══ Write per-state HTML report + variant.json ═══════════════
      const durationMs = Date.now() - runStart;
      try {
        writeReport({
          reportDir: scopeDir,
          reportFile,
          testMeta: {
            name:        testName,
            id:          scope.testId,
            module:      TEST_MODULE,
            description: testDescription,
            author:      TEST_AUTHOR,
            environment: TEST_ENVIRONMENT || envLabelFromUrl(appUrl),
          },
          appUrl,
          year,
          accordionLabel: `${state} · ${year}`,
          setupSteps,
          planCards,
          responsiveShots: [],
          durationMs,
          timestamp: new Date().toLocaleString(),
        });
        logger.info('REPORT', `[${scope.testId}] Report written: ${reportFile}`);

        // variant.json companion for the dashboard aggregator.
        try {
          const setupFailed = setupSteps.some((s) => s.status === 'FAIL');
          const cardFailed  = planCards.some((c) => c.status === 'FAIL');
          const overallStatus = (setupFailed || cardFailed) ? 'FAIL' : (planCards.length ? 'PASS' : 'FAIL');
          const variantJson = path.join(scopeDir, 'variant.json');
          fs.writeFileSync(variantJson, JSON.stringify({
            schemaVersion: 1,
            testId:          scope.testId,
            state,
            stateName:       fullStateName,
            year,
            appUrl,
            vanityFormulary: scope.vanityFormulary,
            status:          overallStatus,
            durationMs,
            testName,
            testDescription,
            setupSteps: setupSteps.map((s) => ({
              id: s.id, name: s.name, status: s.status, durationMs: s.durationMs,
              expected: (s.expected || '').substring(0, 500),
              actual:   (s.actual   || '').substring(0, 800),
            })),
            planCards: planCards.map((c) => ({
              id: c.id, name: c.name, status: c.status,
              docType: c.docType, langLabel: c.langLabel,
              expectedUrl: c.expectedUrl, pdfUrl: c.pdfUrl, href: c.href,
              error: c.error,
              validations: (c.validations || []).map((v) => ({
                name: v.name, status: v.status,
                description: (v.description || '').substring(0, 300),
              })),
            })),
            reportFile: path.relative(REPORT_DIR, reportFile).split(path.sep).join('/'),
          }, null, 2), 'utf8');
        } catch (jsonErr) {
          logger.warn('REPORT', `[${scope.testId}] Variant JSON write failed: ${jsonErr.message.substring(0, 160)}`);
        }
      } catch (repErr) {
        logger.warn('REPORT', `[${scope.testId}] Failed to write report: ${repErr.message}`);
      }

      // Re-throw shared setup failure so Playwright marks the test failed.
      if (sharedSetupError) throw sharedSetupError;

      const failed = planCards.filter((c) => c.status === 'FAIL');
      if (failed.length) {
        throw new Error(
          `${failed.length} of ${planCards.length} doc URL(s) failed for state [${state} · ${year}]: `
          + failed.map((c) => c.name).join('; '));
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// runFilterStep — apply Audience + Category; optionally uncheck a previous
// Category first so the two doc-type flows don't stack filters.
// ══════════════════════════════════════════════════════════════════════════

async function runFilterStep({
  stepId, name, audience, category, previousCategory,
  marketplace, screenshotsDir, setupSteps, langLabel,
}) {
  await base.step(`Step ${stepId} — ${name} (Audience="${audience}", Category="${category}")`, async () => {
    const t0 = Date.now();
    let ok = true, errMsg = '';
    const actions = [];
    try {
      await marketplace.scrollToAllFormsAndDocuments();
      if (previousCategory) {
        try {
          await marketplace.unselectFilterOption('Category', previousCategory);
          actions.push(`unchecked Category="${previousCategory}"`);
        } catch (err) {
          logger.warn('MP-BF',
            `Uncheck of Category="${previousCategory}" failed — continuing: `
            + `${(err && err.message ? err.message : String(err)).substring(0, 160)}`);
        }
        // Clear the search box too — otherwise the previous doc-type's
        // search leaves the results filtered, which trims the Category
        // options list on the page so the NEW category we're about to
        // check may not even be in the DOM.
        try {
          await marketplace.searchByPlanName('');
          actions.push('cleared search box');
        } catch (err) {
          logger.warn('MP-BF',
            `Clear search failed — continuing: `
            + `${(err && err.message ? err.message : String(err)).substring(0, 160)}`);
        }
        await marketplace.scrollToAllFormsAndDocuments();
      }
      if (audience) {
        await marketplace.selectFilterOption('Audience', audience);
        actions.push(`checked Audience="${audience}"`);
      }
      if (category) {
        await marketplace.selectFilterOption('Category', category);
        actions.push(`checked Category="${category}"`);
      }
    } catch (err) {
      ok = false; errMsg = (err && err.message) ? err.message.substring(0, 200) : String(err);
    }

    // Enrich failure with a live dump of the Category options actually
    // present in the DOM — turns "value not found" into "here's what IS
    // there" so QA can adjust the filter label in one edit.
    let optionsDump = '';
    if (!ok) {
      try {
        const audOpts = await marketplace.getFilterOptions('Audience');
        const catOpts = await marketplace.getFilterOptions('Category');
        const fmt = (opts) => opts.length
          ? opts.map((o) => `  \u2022 label="${o.label || '(none)'}"   value="${o.value || '(none)'}"`).join('\n')
          : '  (no options detected)';
        optionsDump = '\n\nActual Audience options on page:\n' + fmt(audOpts)
                    + '\n\nActual Category options on page:\n' + fmt(catOpts);
      } catch (dumpErr) {
        optionsDump = `\n\n(Could not enumerate filter options after failure: ${dumpErr.message.substring(0, 120)})`;
      }
    }

    await marketplace.scrollToAllFormsAndDocuments();
    const shot = path.join(screenshotsDir, `Step${stepId}_Filters_${langLabel}_${sanitizeForFs(category)}.png`);
    await marketplace.saveScreenshot(shot, { preserveScroll: true });
    pushSetupStep(setupSteps, {
      id: stepId,
      name,
      expected: `Audience "${audience}" and Category "${category}" filters should be applied for [${langLabel}].`,
      actual: ok
        ? `Filters ready for [${langLabel}]: ${actions.length ? actions.join('; ') : 'filters already applied'}.`
        : `Failed to apply filters for [${langLabel}]: ${errMsg}${optionsDump}`,
      status: ok ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: shot,
      screenshotLabel: `Filters — ${langLabel} — ${category}`,
    });
    if (!ok) throw new Error(`Step ${stepId} failed: ${errMsg}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// runSearchAndValidate — type the search text, then for each expected URL
// find the matching card, click it, verify the new-tab PDF URL + filename.
// Adds one planCard per expected URL.
// ══════════════════════════════════════════════════════════════════════════

async function runSearchAndValidate({
  stepId, docTypeLabel, docTypeToken, searchText, items,
  scope, marketplace, context, screenshotsDir, setupSteps, planCards,
  langLabel, startCardIndex,
}) {
  let resolvedTargets = [];
  let allNameCards = [];
  await base.step(`Step ${stepId} — Search "${searchText}" for ${docTypeLabel} [${langLabel}]`, async () => {
    const t0 = Date.now();
    await marketplace.searchByPlanName(searchText);
    await marketplace.scrollToAllFormsAndDocuments();
    allNameCards = await marketplace.findResultCardsByName(searchText);
    resolvedTargets = [];
    for (const item of items) {
      const expectedUrl = absolutizeUrl(item.url, scope.appUrl);
      const card = await marketplace.findCardByNameAndUrl(searchText, expectedUrl);
      resolvedTargets.push({ item, expectedUrl, card });
    }

    const shot = path.join(screenshotsDir, `Step${stepId}_Search_${langLabel}_${sanitizeForFs(docTypeLabel)}.png`);
    await marketplace.saveScreenshot(shot, { preserveScroll: true });

    const matchedCount = resolvedTargets.filter((t) => t.card).length;
    const enough = allNameCards.length > 0;

    const lineFor = (t) => {
      const langHint = t.item.lang === 'es' ? 'Spanish' : 'English';
      return t.card
        ? `\u2022 ${langHint} ${docTypeLabel} matched: ${t.card.href}`
        : `\u2022 ${langHint} ${docTypeLabel} NOT FOUND. Expected: ${t.expectedUrl}`;
    };
    const linesJoined = resolvedTargets.map(lineFor).join('\n');

    pushSetupStep(setupSteps, {
      id: stepId,
      name: `Search for ${docTypeLabel} "${searchText}" [${langLabel}]`,
      expected: `${docTypeLabel} card(s) matching "${searchText}" should be listed in the results.`,
      actual: enough
        ? `Search returned cards matching "${searchText}".\n`
          + `Total cards containing search text: ${allNameCards.length}\n`
          + `Matched expected PDF link(s): ${matchedCount}/${resolvedTargets.length}\n`
          + linesJoined
        : `No result cards contained "${searchText}".`,
      status: enough ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: shot,
      screenshotLabel: `Search results [${langLabel}] — ${docTypeLabel}`,
    });
    expect(enough,
      `[${langLabel}] No result cards contain "${searchText}" for ${docTypeLabel}. See step ${stepId} evidence.`
    ).toBeTruthy();
  });

  // Per-card open + URL validation.
  let cardIndex = startCardIndex;
  for (const t of resolvedTargets) {
    cardIndex += 1;
    // The card's language reflects the PDF URL's own /english/ or /spanish/
    // segment, NOT the outer site-language pass (both language passes
    // surface both EN and ES PDF cards).
    const itemLangLabel = t.item.lang === 'es' ? 'ES' : 'EN';
    await validateOneDocUrl({
      index: cardIndex,
      docTypeLabel,
      docTypeToken,
      langLabel: itemLangLabel,
      langHint: t.item.lang === 'es' ? 'Spanish' : 'English',
      expectedUrl: t.expectedUrl,
      expectedName: t.item.name,
      card: t.card,
      searchText,
      scope,
      marketplace,
      context,
      screenshotsDir,
      planCards,
    });
  }
  return cardIndex;
}

// ══════════════════════════════════════════════════════════════════════════
// validateOneDocUrl — click one card, verify its PDF URL follows the
// doc-type rule (contains the expected token, not the other doc-type's
// token) and filename matches. Same evidence shape as plan search.
// ══════════════════════════════════════════════════════════════════════════

async function validateOneDocUrl({
  index, docTypeLabel, docTypeToken, langLabel, langHint,
  expectedUrl, expectedName, card, searchText,
  scope, marketplace, context, screenshotsDir, planCards,
}) {
  const cardName = `[${langLabel} · ${docTypeLabel}] ${expectedName || filenameFromUrl(expectedUrl)}`;
  const card_ = {
    id: index,
    name: cardName,
    docType: docTypeLabel,
    langLabel,
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
    card_.error = `No result card matched expected URL for ${docTypeLabel} (${langHint}) under search "${searchText}".`;
    const missShot = path.join(screenshotsDir, `Card${index}_${sanitizeForFs(langLabel)}_${sanitizeForFs(docTypeLabel)}_NotFound.png`);
    await ensureValidScreenshot(
      () => captureEvidencePanel(context, fallbackPanelHtml(cardName, card_.error), missShot),
      () => Promise.resolve(missShot),
    );
    pushPlanStep(card_, {
      id: 1,
      name: 'Open PDF in New Tab',
      expected: `A card matching the expected URL should be present after searching for "${searchText}".`,
      actual: card_.error,
      status: 'FAIL',
      screenshotPath: missShot,
      screenshotLabel: 'Card not found',
    });
    card_.validations.push({ name: 'Result card present', status: 'FAIL', description: card_.error });
    return;
  }

  // ── Step 1 — Click the card, capture the new-tab URL ──
  let pdfPage = null;
  let pdfOpened = false;
  let pdfPageDataUri = null;

  await base.step(`Card #${index} — Open ${docTypeLabel} PDF in New Tab (${langHint})`, async () => {
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

    const openShot = path.join(screenshotsDir, `Card${index}_${sanitizeForFs(langLabel)}_${sanitizeForFs(docTypeLabel)}_OpenPDF.png`);
    const openRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        pdfNewTabPanelHtml(cardName, card_.pdfUrl, pdfPageDataUri, pdfOpened),
        openShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(cardName, 'Could not render the PDF new-tab evidence panel.'),
        openShot),
    );

    pushPlanStep(card_, {
      id: 1,
      name: 'Open PDF in New Tab',
      expected: `Clicking the ${docTypeLabel} card should open the PDF in a new tab.`,
      actual: pdfOpened
        ? `A new tab opened and loaded the PDF successfully.\nURL: ${card_.pdfUrl}`
        : `No new tab opened within ${NEW_TAB_TIMEOUT}ms after clicking the card.`,
      status: pdfOpened ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: openRes.filePath,
      screenshotLabel: `PDF opened in new tab — ${cardName}`,
    });
    card_.validations.push({
      name: 'PDF opens in new tab',
      status: pdfOpened ? 'PASS' : 'FAIL',
      description: pdfOpened ? `Opened at ${card_.pdfUrl}` : 'No new tab was detected within the timeout.',
    });
  });

  // ── Step 2 — Verify URL matches the doc-type rule and filename ──
  await base.step(`Card #${index} — Verify ${docTypeLabel} URL + filename`, async () => {
    const t0 = Date.now();
    const actualUrl = card_.pdfUrl || '';
    const actualPath = pathLower(actualUrl);
    const actualFilename = filenameFromUrl(actualUrl);
    const expectedFilename = filenameFromUrl(expectedUrl);

    const urlNotEmpty = !!actualUrl;
    const urlHasPdf   = /\.pdf(\?|#|$)/i.test(actualUrl);
    const otherToken  = docTypeToken === 'FORMULARY' ? 'BROCHURE' : 'FORMULARY';
    const urlHasSelf  = DOC_TYPE_RE[docTypeToken].test(actualPath);
    const urlHasOther = DOC_TYPE_RE[otherToken].test(actualPath);
    const filenameMatches = !!expectedFilename && actualFilename === expectedFilename;

    const urlChecks = [
      { label: 'PDF URL not empty',       pass: urlNotEmpty, detail: actualUrl || '(empty)' },
      { label: 'PDF URL contains ".pdf"', pass: urlHasPdf,   detail: actualUrl },
      { label: `PDF URL contains "${docTypeToken.toLowerCase()}"`,        pass: urlHasSelf,   detail: urlHasSelf   ? `${docTypeToken.toLowerCase()} token found in URL path` : `${docTypeToken.toLowerCase()} token NOT found in URL path` },
      { label: `PDF URL does NOT contain "${otherToken.toLowerCase()}"`,  pass: !urlHasOther, detail: !urlHasOther ? `no ${otherToken.toLowerCase()} token in URL` : `unexpected ${otherToken.toLowerCase()} token in URL` },
      { label: 'PDF filename matches expected', pass: filenameMatches,
        detail: filenameMatches ? `filename="${actualFilename}"` : `expected="${expectedFilename}", actual="${actualFilename}"` },
    ];
    const urlOverall = urlChecks.every((c) => c.pass);

    const urlShot = path.join(screenshotsDir, `Card${index}_${sanitizeForFs(langLabel)}_${sanitizeForFs(docTypeLabel)}_VerifyURL.png`);
    const urlRes = await ensureValidScreenshot(
      () => captureEvidencePanel(context,
        urlValidationPanelHtml(cardName, actualUrl, expectedUrl, urlChecks),
        urlShot),
      () => captureEvidencePanel(context,
        fallbackPanelHtml(cardName, 'Could not render URL validation panel.'),
        urlShot),
    );

    pushPlanStep(card_, {
      id: 2,
      name: `Verify ${docTypeLabel} URL + filename`,
      expected: `PDF URL should contain "${docTypeToken.toLowerCase()}" (not "${otherToken.toLowerCase()}") and filename should match expected.\nExpected filename: ${expectedFilename}`,
      actual: urlOverall
        ? `PDF URL is a valid ${docTypeLabel} URL and filename matches expected.\nActual: ${actualUrl || '(empty)'}`
        : `PDF URL validation failed.\nActual: ${actualUrl || '(empty)'}`,
      status: urlOverall ? 'PASS' : 'FAIL',
      durationMs: Date.now() - t0,
      screenshotPath: urlRes.filePath,
      screenshotLabel: `URL validation — ${cardName}`,
    });
    card_.validations.push({
      name: `${docTypeLabel} URL rule`,
      status: urlOverall ? 'PASS' : 'FAIL',
      description: urlOverall
        ? 'All checks passed.'
        : urlChecks.filter((c) => !c.pass).map((c) => `${c.label} → ${c.detail}`).join('; '),
    });
    if (!urlOverall) card_.status = 'FAIL';
  });

  if (pdfPage) { await pdfPage.close().catch(() => {}); }
}

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// PDF page-level screenshot capture — copy of the plan-search helper.
// Kept local so the specs remain independent.
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
