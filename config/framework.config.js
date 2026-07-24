/**
 * Framework configuration — the SINGLE source of truth for every knob.
 *
 * Precedence (highest wins):
 *   1. Shell environment variables (e.g. `$env:PLAN_MATERIALS_STATE = "NE"`)
 *   2. `config/globalproperties.env` (tester-facing dotenv file)
 *   3. Hardcoded defaults below
 *
 * Note: run mode (headless vs headed) is controlled by the CLI `--headed`
 * flag only — see the `headless` field below and the `test:headed` /
 * `test:drug:headed` npm scripts.
 *
 * Every consumer (spec, playwright.config.js, page objects, utils) should
 * import this file — nothing else should read `process.env.*` directly.
 */

const path = require('path');

// Load dotenv files FIRST so the env() helper below can see their values.
// globalproperties.env is the tester-editable file; the optional project-root
// .env is used as a secondary override for CI/CD-specific values.
require('dotenv').config({ path: path.join(__dirname, 'globalproperties.env') });
require('dotenv').config(); // default .env at project root (optional)

function env(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  if (fallback === true || fallback === false) return val === 'true' || val === '1';
  if (typeof fallback === 'number') { const n = Number(val); return Number.isNaN(n) ? fallback : n; }
  return val;
}

const config = {
  // ── Paths ──
  excelPath: env('EXCEL_PATH', 'data/ExecutionData.xlsx'),
  inputSheet: env('INPUT_SHEET', 'Config'),
  resultSheet: env('RESULT_SHEET', 'Results'),
  reportOutputDir: env('REPORT_OUTPUT_DIR', 'reports'),

  // ── Timeouts ──
  navigationTimeoutMs: env('NAVIGATION_TIMEOUT_MS', 240000),
  testTimeoutMs: env('TEST_TIMEOUT_MS', 1800000),
  waitAfterNetworkIdleMs: env('WAIT_AFTER_NETWORK_IDLE_MS', 2000),
  elementInteractionTimeoutMs: env('ELEMENT_INTERACTION_TIMEOUT_MS', 5000),
  elementProbeTimeoutMs: env('ELEMENT_PROBE_TIMEOUT_MS', 3000),
  networkIdleWaitMs: env('NETWORK_IDLE_WAIT_MS', 8000),
  pageLoadWaitMs: env('PAGE_LOAD_WAIT_MS', 45000),

  // ── Link validation ──
  maxLinksToValidatePerState: env('MAX_LINKS_VALIDATE', 100),
  linkValidationTimeoutMs: env('LINK_VALIDATION_TIMEOUT_MS', 10000),
  linkValidationConcurrency: env('LINK_VALIDATION_CONCURRENCY', 6),
  maxLinksForTitleComparison: env('MAX_LINKS_TITLE_COMPARISON', Infinity),
  destinationTitleTimeoutMs: env('DESTINATION_TITLE_TIMEOUT_MS', 30000),
  titleComparisonConcurrency: env('TITLE_COMPARISON_CONCURRENCY', 20),

  // ── Browser ──
  // Headless is the default (Playwright convention). Pass --headed on the
  // CLI (e.g. `npm run test:headed`) to launch a visible Chrome window.
  // playwright.config.js detects --headed in the main process and sets
  // PW_HEADED=1 so worker processes (which don't inherit argv) see it too.
  headless: process.env.PW_HEADED !== '1',
  viewport: {
    width: env('VIEWPORT_WIDTH', 1920),
    height: env('VIEWPORT_HEIGHT', 1080)
  },

  // ── Language ──
  languageDefaults: {
    locale: env('LOCALE', 'en-US'),
    acceptLanguageHeader: env('ACCEPT_LANGUAGE', 'en-US,en;q=0.9')
  },

  // ── Consent Texts ──
  consentButtonTexts: [
    'i agree', 'i accept', 'accept', 'accept all', 'accept all cookies',
    'allow all', 'allow all cookies', 'accept cookies', 'agree and continue',
    'agree', 'ok', 'okay', 'got it', 'continue',
    'aceptar', 'aceptar todo', 'aceptar cookies',
    'aceitar', 'aceitar tudo', 'aceitar cookies',
    'j accepte', 'accepter', 'tout accepter', 'accepter tout', 'accepter les cookies',
    'ich stimme zu', 'zustimmen', 'alle akzeptieren', 'cookies akzeptieren',
    'accetto', 'accetta', 'accetta tutto', 'accetta i cookie',
    'ik ga akkoord', 'alles accepteren', 'cookies accepteren',
    'zgadzam sie', 'zaakceptuj',
    'godkann', 'acceptera', 'acceptera alla',
    'aceitar todos', 'prihvatam',
    'kabul et', 'kabul ediyorum',
    'acepto', 'aceito', 'aceptar y continuar', 'akkoord', 'sutikti',
    'privacitat valasztasa', 'jah, ich stimme zu', 'acepta todo',
    'godkend alle', 'hyvaksy', 'hyvaksy kaikki', 'sve prihvati', 'povolit vse',
    'أوافق', 'موافق', 'قبول', 'موافقة', 'أقبل',
    '同意', '我同意', '接受', '全部接受',
    'tôi đồng ý', 'chấp nhận', 'đồng ý',
    '동의', '동의합니다', '수락',
  ],

  // ── Comparison Tolerance ──
  comparisonTolerance: {
    maxTextDeltaPercent: env('MAX_TEXT_DELTA_PERCENT', 20),
    requireTitleMatch: env('REQUIRE_TITLE_MATCH', false),
    requireTextDeltaCheck: env('REQUIRE_TEXT_DELTA_CHECK', false)
  },

  // ── Retry ──
  retryAttempts: env('RETRY_ATTEMPTS', 2),
  retryBaseDelayMs: env('RETRY_BASE_DELAY_MS', 1000),

  // ── Rate-limit / WAF protection ──
  testCooldownMs: env('TEST_COOLDOWN_MS', 10000),

  // ── DOM stability waits (replaces hard waitForTimeout values) ──
  domStableMs: env('DOM_STABLE_MS', 300),
  domStableTimeoutMs: env('DOM_STABLE_TIMEOUT_MS', 5000),
  animationSettleMs: env('ANIMATION_SETTLE_MS', 500),
  carouselSettleMs: env('CAROUSEL_SETTLE_MS', 600),

  // ── Plan Materials suite (R5 matrix + R6 consolidation) ──
  // Everything below is consumed by tests/planMaterials/*.spec.js and its
  // helpers so that spec file contains ZERO direct process.env reads.
  planMaterials: {
    // URL derivation. `template` is used per-scope with {state} substituted;
    // `override` (if set) forces every scope to use that exact URL.
    urls: {
      template: env('PLAN_MATERIALS_URL_TEMPLATE', 'https://pws-q1.molinahealthcare.com/medicare/{state}/materials'),
      override: env('PLAN_MATERIALS_URL', ''),
    },

    // Optional matrix filters — empty = all scopes with Run=Y in the data file.
    filters: {
      state:     env('PLAN_MATERIALS_STATE',     ''),
      year:      env('PLAN_MATERIALS_YEAR',      ''),
      accordion: env('PLAN_MATERIALS_ACCORDION', ''),
    },

    // Data source paths. Excel is preferred; JSON is a fallback.
    data: {
      excelPath: env('PLAN_MATERIALS_EXPECTED_EXCEL', path.join(process.cwd(), 'data', 'cy2027', 'PlanMaterialsData.xlsx')),
      jsonPath:  env('PLAN_MATERIALS_EXPECTED_FILE',  path.join(process.cwd(), 'data', 'planMaterialsExpectedPlans.json')),
      sheetName: env('PLAN_MATERIALS_EXPECTED_SHEET', 'Plans'),
    },

    // Fixed test metadata shown in the HTML report header.
    test: {
      id:          env('TEST_ID',     'PM-ANOC-001'),
      module:      env('TEST_MODULE', 'Plan Materials'),
      author:      env('TEST_AUTHOR', 'Molina QA Automation'),
      environment: env('TEST_ENVIRONMENT', ''),  // '' → auto-detect from URL
    },

    // PDF viewer timing.
    pdf: {
      newTabTimeoutMs: env('PDF_TAB_TIMEOUT_MS',  20000),
      renderWaitMs:    env('PDF_RENDER_WAIT_MS',  2500),
    },

    // Report output directory (per-scope subfolders are created under it).
    report: {
      dir: path.join(process.cwd(), env('PLAN_MATERIALS_REPORT_DIR', 'reports/plan-materials')),
    },
  },

  // ── Drug / Pharmacy suite (parallels planMaterials but points at the
  // Pharmacy and Prescription Benefits Documents page). Consumed by
  // tests/drugs/*.spec.js. Same shape as `planMaterials` above so specs and
  // fixtures can share code paths.
  drug: {
    urls: {
      template: env('DRUG_URL_TEMPLATE', 'https://pws-q1.molinahealthcare.com/medicare/{state}/drugs'),
      override: env('DRUG_URL', ''),
    },
    filters: {
      state:     env('DRUG_STATE',     ''),
      year:      env('DRUG_YEAR',      ''),
      accordion: env('DRUG_ACCORDION', ''),
    },
    data: {
      excelPath: env('DRUG_EXPECTED_EXCEL', path.join(process.cwd(), 'data', 'cy2027', 'DrugData.xlsx')),
      jsonPath:  env('DRUG_EXPECTED_FILE',  path.join(process.cwd(), 'data', 'drugExpectedPlans.json')),
      sheetName: env('DRUG_EXPECTED_SHEET', 'Plans'),
    },
    test: {
      id:          env('DRUG_TEST_ID',     'PM-DRUG-001'),
      module:      env('DRUG_TEST_MODULE', 'Drug / Pharmacy'),
      author:      env('DRUG_TEST_AUTHOR', 'Molina QA Automation'),
      environment: env('DRUG_TEST_ENVIRONMENT', ''),  // '' → auto-detect from URL
    },
    pdf: {
      newTabTimeoutMs: env('PDF_TAB_TIMEOUT_MS',  20000),
      renderWaitMs:    env('PDF_RENDER_WAIT_MS',  2500),
    },
    report: {
      dir: path.join(process.cwd(), env('DRUG_REPORT_DIR', 'reports/drug')),
    },
  },

  // ── Marketplace suite (Requirement 3) ──────────────────────────────────
  // Molina Marketplace home → Member Resources → Forms & Documents flow.
  // Verifies the default & alternate coverage year query-param toggling.
  // This flow is linear (no plan matrix, no PDF validation) so it is much
  // smaller than the plan-materials / drug config blocks above.
  marketplace: {
    urls: {
      appUrl: env('MARKETPLACE_URL', 'https://pws-q3.molinahealthcare.com/'),
    },
    // Data-driven matrix source. Rows where `Run=Y` become individual test
    // cases (one per state × year pair). If the sheet is missing, unreadable,
    // or has zero Run=Y rows, the suite runs zero tests — flip a row's Run
    // cell to 'Y' to include it.
    excelPath:  env('MARKETPLACE_EXCEL',       path.join(process.cwd(), 'data', 'marketplace', 'MarketplaceData.xlsx')),
    excelSheet: env('MARKETPLACE_EXCEL_SHEET', 'Marketplace'),
    // State to pick in the Forms & Documents dropdown (2-letter code, matches
    // the <option value> attribute — e.g. "tx", "ca", "az").
    state: env('MARKETPLACE_STATE', 'tx'),
    // Coverage years the test verifies. `default` is the initially-selected
    // year expected on page load; `alternate` is the year the test toggles to.
    years: {
      default:   env('MARKETPLACE_DEFAULT_YEAR',   '2026'),
      alternate: env('MARKETPLACE_ALTERNATE_YEAR', '2027'),
    },
    test: {
      id:          env('MARKETPLACE_TEST_ID',     'MP-COVYEAR-001'),
      module:      env('MARKETPLACE_TEST_MODULE', 'Marketplace / Forms & Documents'),
      author:      env('MARKETPLACE_TEST_AUTHOR', 'Molina QA Automation'),
      environment: env('MARKETPLACE_TEST_ENVIRONMENT', ''),  // '' → auto-detect from URL
    },
    report: {
      dir: path.join(process.cwd(), env('MARKETPLACE_REPORT_DIR', 'reports/marketplace-toggleCheck')),
    },
  },

  // ── Marketplace Plan Search suite ──────────────────────────────────────
  // Extends the base marketplace flow (state → coverage-year toggle) with
  // Audience/Category filters, plan-name search, and per-plan PDF URL
  // validation. Each Excel row is one plan search that may open N PDFs
  // (pipe-separated in the ExpectedUrls cell). Uses the same MarketplacePage
  // (composition, not a new page class) plus new filter/search/card methods.
  marketplacePlans: {
    urls: {
      appUrl: env('MARKETPLACE_PLANS_URL', 'https://pws-q3.molinahealthcare.com/'),
    },
    // Rows where `Run=Y` become individual tests (one per plan search).
    // If sheet is missing, unreadable, or has zero Run=Y rows → 0 tests.
    excelPath:  env('MARKETPLACE_PLANS_EXCEL',       path.join(process.cwd(), 'data', 'marketplace', 'MarketplacePlansData.xlsx')),
    excelSheet: env('MARKETPLACE_PLANS_EXCEL_SHEET', 'Plans'),
    // Optional companion sheet: additional plan-name searches to run AFTER
    // the primary one (from the `Plans` sheet). Rows are joined to a test
    // via the `TestId` column. If the sheet is missing or empty, each test
    // runs only its primary search.
    additionalSearchesSheet: env('MARKETPLACE_PLANS_ADDITIONAL_SHEET', 'AdditionalSearches'),
    // Optional filters — narrow the matrix without editing the sheet.
    filters: {
      state: env('MARKETPLACE_PLANS_STATE', ''),
      year:  env('MARKETPLACE_PLANS_YEAR',  ''),
      plan:  env('MARKETPLACE_PLANS_PLAN',  ''),   // substring match on PlanName
    },
    test: {
      id:          env('MARKETPLACE_PLANS_TEST_ID',     'MP-PLANS-001'),
      module:      env('MARKETPLACE_PLANS_TEST_MODULE', 'Marketplace / Plan Search'),
      author:      env('MARKETPLACE_PLANS_TEST_AUTHOR', 'Molina QA Automation'),
      environment: env('MARKETPLACE_PLANS_TEST_ENVIRONMENT', ''),
    },
    report: {
      dir: path.join(process.cwd(), env('MARKETPLACE_PLANS_REPORT_DIR', 'reports/marketplace-plans')),
    },
  },
};

module.exports = config;
