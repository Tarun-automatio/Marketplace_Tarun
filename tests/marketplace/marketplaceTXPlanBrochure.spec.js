/**
 * Marketplace / Plan Brochure verification — two flows, EN + ES, multi-state.
 * Flow 1 is data-driven: every Run=Y state row in the brochure workbook is
 *   validated via the Marketplace Forms & Documents navigation.
 * Flow 2 is an explicit per-state list (NV, CA, WA, ID): each state's named
 *   brochure PDFs are validated via the state Materials page accordion.
 * Each state/flow/language combination writes a separate HTML report.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { test, expect } = require('@playwright/test');
const frameworkConfig = require('../../config/framework.config');
const logger = require('../../utils/logger');
const { MarketplacePage } = require('../../pages/marketplacePage');
const { pushSetupStep, pushPlanStep } = require('../../helpers/evidencePanel');
const { writeReport } = require('../../reporting/reportGenerator');

const YEAR = '2027';
const APP_URL = 'https://www.molinahealthcare.com/';
const FILTER_AUDIENCE = 'Marketplace';
const FILTER_CATEGORY = 'Member Handbooks and Coverage';
const REPORT_ROOT = process.env.MARKETPLACE_TX_BROCHURE_REPORT_DIR
  || path.join(process.cwd(), 'reports', 'marketplace-tx-plan-brochure');
const NEW_TAB_TIMEOUT = frameworkConfig.pageLoadWaitMs || 45000;

// Human-readable state names for the "Select state" step + report metadata.
const STATE_NAMES = { CA: 'California', ID: 'Idaho', NV: 'Nevada', WA: 'Washington', TX: 'Texas', NM: 'New Mexico' };

// Flow 2 — explicit states whose Materials-page brochures are validated.
const FLOW2_STATES = ['NV', 'CA', 'WA', 'ID'];

function materialsUrl(state, lang) {
  const code = String(state).toLowerCase();
  return lang === 'es'
    ? `https://www.molinahealthcare.com/es-us/ifp/${code}/materials`
    : `https://www.molinahealthcare.com/ifp/${code}/materials`;
}

const norm = (value) => String(value == null ? '' : value).trim();

function sanitize(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '-').replace(/[()]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_');
}

function filenameFromUrl(value) {
  try { return (new URL(value).pathname.split('/').pop() || '').trim(); }
  catch { return String(value || '').split('?')[0].split('#')[0].split('/').pop() || ''; }
}

function urlLangMatches(url, lang) {
  const lower = String(url || '').toLowerCase();
  return lang === 'es' ? /\/spanish\//.test(lower) : /\/english\//.test(lower);
}

function loadFlow1ByState() {
  const workbookPath = frameworkConfig.marketplaceBrochureFormulary.excelPath;
  if (!workbookPath || !fs.existsSync(workbookPath)) throw new Error(`Brochure workbook not found: ${workbookPath}`);
  const workbook = XLSX.readFile(workbookPath);
  const sheet = workbook.Sheets.BrochureFormulary || workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const runRows = rows.filter((entry) => norm(entry.Run).toUpperCase() === 'Y');
  if (runRows.length === 0) throw new Error('No Run=Y rows found in MarketplaceBrochureFormularyData.xlsx');
  // Off-exchange rows (e.g. "TX-OX") fold into their base state's item list.
  const byState = new Map();
  for (const row of runRows) {
    const get = (key) => norm(row[key]);
    const rawState = get('State').toUpperCase();
    const baseState = rawState.replace(/-OX$/, '');
    const groups = [
      {
        key: `${rawState} Member Brochure`,
        searchText: get('MemberBrochure_Search'),
        cardName: { en: get('MemberBrochure_EN_Name'), es: get('MemberBrochure_ES_Name') },
        expectedUrl: { en: get('MemberBrochure_EN_URL'), es: get('MemberBrochure_ES_URL') },
      },
      {
        key: `${rawState} Broker Brochure`,
        searchText: get('BrokerBrochure_Search'),
        cardName: { en: get('BrokerBrochure_EN_Name'), es: get('BrokerBrochure_ES_Name') },
        expectedUrl: { en: get('BrokerBrochure_EN_URL'), es: get('BrokerBrochure_ES_URL') },
      },
    ];
    if (!byState.has(baseState)) byState.set(baseState, []);
    const list = byState.get(baseState);
    for (const group of groups) {
      if (!group.expectedUrl.en && !group.expectedUrl.es) continue;
      list.push({
        ...group,
        filename: { en: filenameFromUrl(group.expectedUrl.en), es: filenameFromUrl(group.expectedUrl.es) },
      });
    }
  }
  return Array.from(byState.entries())
    .filter(([, items]) => items.length > 0)
    .map(([state, items]) => ({ state, stateName: STATE_NAMES[state] || state, items }));
}

const FLOW1_BY_STATE = loadFlow1ByState();

function flow2Items(state) {
  const code = String(state).toLowerCase();
  return [
    { linkText: `${state}Brochure27`, filename: `${state}Brochure27.pdf` },
    { linkText: `${state}MBRBrochure27`, filename: `${state}MBRBrochure27.pdf` },
  ].map((item) => ({
    ...item,
    expectedUrl: {
      en: `https://www.molinahealthcare.com/-/media/project/pws/healthcare/pdf/pdf/ifp/${code}/materials/brochure/2027/english/${item.filename}`,
      es: `https://www.molinahealthcare.com/-/media/project/pws/healthcare/pdf/pdf/ifp/${code}/materials/brochure/2027/spanish/${item.filename}`,
    },
  }));
}

async function openAndValidate({ page, context, trigger, card, item, lang, screenshotsDir, label }) {
  const started = Date.now();
  let pdfPage = null;
  let actualUrl = '';
  const clickTimeout = Math.max(frameworkConfig.elementInteractionTimeoutMs, 15000);
  let href = '';
  try { href = (await trigger.getAttribute('href').catch(() => '')) || ''; } catch { /* ignore */ }
  try {
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    // Click to open the PDF in a new tab. A sticky header / cookie overlay can
    // intercept the first pointer event, so retry once with force before giving up.
    for (const force of [false, true]) {
      try {
        const [opened] = await Promise.all([
          context.waitForEvent('page', { timeout: NEW_TAB_TIMEOUT }).catch(() => null),
          trigger.click({ timeout: clickTimeout, force }),
        ]);
        if (opened) { pdfPage = opened; break; }
      } catch (error) {
        if (force) logger.warn('MP-TX-BROCH', `Click failed for ${label}: ${String(error.message || error).substring(0, 120)}`);
      }
    }
    // Fallback: the anchor's href is the brochure URL under test — open it
    // directly so a blocked click never produces a false failure.
    if (!pdfPage && href) {
      const absolute = (() => { try { return new URL(href, page.url()).toString(); } catch { return href; } })();
      pdfPage = await context.newPage();
      await pdfPage.goto(absolute, { waitUntil: 'commit', timeout: NEW_TAB_TIMEOUT }).catch(() => {});
    }
    if (pdfPage) {
      try { await pdfPage.waitForURL(/\.pdf(\?|#|$)/i, { timeout: NEW_TAB_TIMEOUT }); } catch { /* retain settled URL */ }
      // Wait for the PDF page to load before capturing the screenshot. Chrome's
      // built-in PDF viewer does not always fire 'load', so cap these waits so a
      // single card can never hang the whole test — they are best-effort.
      try { await pdfPage.waitForLoadState('domcontentloaded', { timeout: NEW_TAB_TIMEOUT }); } catch {}
      try { await pdfPage.waitForLoadState('load', { timeout: 20000 }); } catch {}
      try { await pdfPage.waitForLoadState('networkidle', { timeout: frameworkConfig.networkIdleWaitMs || 8000 }); } catch {}
      actualUrl = pdfPage.url();
    }
  } catch (error) {
    card.status = 'FAIL';
    card.error = String(error && error.message ? error.message : error).substring(0, 250);
  }

  const shot = path.join(screenshotsDir, `${sanitize(label)}.png`);
  if (pdfPage) {
    // Small settle so the rendered first page is visible in the capture.
    try { await pdfPage.waitForTimeout(frameworkConfig.waitAfterNetworkIdleMs || 1200); } catch {}
    try { await pdfPage.screenshot({ path: shot, fullPage: false }); }
    catch (error) { logger.warn('MP-TX-BROCH', `PDF screenshot failed: ${error.message.substring(0, 120)}`); }
  }

  const filename = filenameFromUrl(actualUrl);
  const newTab = !!pdfPage;
  const expectedFilename = typeof item.filename === 'string' ? item.filename : item.filename[lang];
  const filenameOk = filename.toLowerCase() === expectedFilename.toLowerCase();
  const languageOk = urlLangMatches(actualUrl, lang);
  const passed = newTab && filenameOk && languageOk;
  card.pdfUrl = actualUrl;
  card.status = passed ? 'PASS' : 'FAIL';
  if (!passed && !card.error) card.error = `newTab=${newTab}, expected=${expectedFilename}, actual=${filename || '(empty)'}, langSegment=${languageOk}`;
  pushPlanStep(card, {
    id: 1,
    name: 'Open brochure PDF and validate URL',
    expected: `Open a new tab ending in ${expectedFilename} with /${lang === 'es' ? 'spanish' : 'english'}/ in its path.`,
    actual: newTab
      ? `Opened URL: ${actualUrl}\nFilename: ${filename} (${filenameOk ? 'match' : 'mismatch'})\nLanguage path: ${languageOk ? 'match' : 'mismatch'}`
      : `PDF tab did not open. ${card.error}`,
    status: passed ? 'PASS' : 'FAIL',
    durationMs: Date.now() - started,
    screenshotPath: shot,
    screenshotLabel: label,
  });
  card.validations.push({
    name: 'Expected brochure PDF opened',
    status: passed ? 'PASS' : 'FAIL',
    description: passed ? `${filename} opened in ${lang.toUpperCase()}` : card.error,
  });
  if (pdfPage) await pdfPage.close().catch(() => {});
}

function writePerTestReport({ testId, testName, state, stateName, lang, flow, appUrl, scopeDir, reportFile, setupSteps, planCards, started }) {
  const durationMs = Date.now() - started;
  const overall = !setupSteps.some((step) => step.status === 'FAIL')
    && planCards.length > 0
    && planCards.every((card) => card.status === 'PASS') ? 'PASS' : 'FAIL';
  try {
    writeReport({
      reportDir: scopeDir,
      reportFile,
      testMeta: {
        name: testName,
        id: testId,
        module: 'Marketplace / Plan Brochure',
        description: `${state} · Flow ${flow}, ${lang.toUpperCase()}: validate brochure PDFs via ${flow === 1 ? 'the Forms & Documents UI' : 'the Materials page accordion'}.`,
        author: 'Molina QA Automation',
        environment: 'PROD (www)',
      },
      appUrl,
      year: YEAR,
      accordionLabel: `${state} · ${YEAR} · ${lang.toUpperCase()}`,
      setupSteps,
      planCards,
      responsiveShots: [],
      durationMs,
      timestamp: new Date().toLocaleString(),
    });
    fs.writeFileSync(path.join(scopeDir, 'variant.json'), JSON.stringify({
      schemaVersion: 1, testId, state, stateName, year: YEAR,
      language: lang, flow, status: overall, durationMs, testName,
      planCards: planCards.map(({ id, name, status, expectedUrl, pdfUrl, href, validations }) => ({ id, name, status, expectedUrl, pdfUrl, href, validations })),
      setupSteps: setupSteps.map(({ id, name, status, durationMs: stepDuration }) => ({ id, name, status, durationMs: stepDuration })),
      reportFile: reportFile,
    }, null, 2), 'utf8');
  } catch (error) {
    logger.warn('REPORT', `[${testId}] Report write failed: ${String(error.message || error).substring(0, 200)}`);
  }
  return overall;
}

async function captureSetup({ page, marketplace, setupSteps, screenshotsDir, id, name, expected, action, screenshotName }) {
  const started = Date.now();
  let ok = true;
  let errorMessage = '';
  try { await action(); }
  catch (error) { ok = false; errorMessage = String(error && error.message ? error.message : error).substring(0, 200); }
  const shot = path.join(screenshotsDir, `${sanitize(screenshotName)}.png`);
  await marketplace.saveScreenshot(shot, { preserveScroll: true });
  pushSetupStep(setupSteps, {
    id, name, expected,
    actual: ok ? `Completed.\nURL: ${page.url()}` : `Failed: ${errorMessage}`,
    status: ok ? 'PASS' : 'FAIL', durationMs: Date.now() - started,
    screenshotPath: shot, screenshotLabel: screenshotName,
  });
  if (!ok) throw new Error(`Step ${id} failed: ${errorMessage}`);
}

function registerTest({ flow, state, stateName, lang, items, appUrl }) {
  const langLabel = lang.toUpperCase();
  const testId = `${state}_PBROCH_FLOW${flow}_${langLabel}`;
  const testName = `${state} · Flow ${flow} — brochures · ${YEAR} · ${langLabel}`;
  const scopeDir = path.join(REPORT_ROOT, testId);
  const screenshotsDir = path.join(scopeDir, 'screenshots');
  const reportFile = path.join(scopeDir, `${testId}.html`);

  test(testName, async ({ page, context }) => {
    test.setTimeout(360_000);
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const marketplace = new MarketplacePage(page);
    const setupSteps = [];
    const planCards = [];
    const started = Date.now();
    let stepId = 1;
    let runError = null;

    try {
      if (flow === 1) {
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: 'Open Molina home',
          expected: `Load ${APP_URL}.`,
          action: () => marketplace.open(APP_URL),
          screenshotName: 'Step1_Home',
        });
        if (lang === 'es') {
          await captureSetup({
            page, marketplace, setupSteps, screenshotsDir, id: stepId++,
            name: 'Switch site language to Spanish',
            expected: 'Switch the Molina site to Spanish (URL should contain /es-us/).',
            action: async () => {
              try { await marketplace.switchLanguage('es'); } catch { /* fall back to direct ES home */ }
              if (!/\/es-us\//i.test(page.url())) await marketplace.open('https://www.molinahealthcare.com/es-us/');
            },
            screenshotName: 'Step2_Language_ES',
          });
        }
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: 'Open Member Resources menu',
          expected: 'The Member Resources menu should open.',
          action: () => marketplace.openMemberResources(),
          screenshotName: `Step${stepId}_MemberResources`,
        });
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: 'Open Forms & Documents',
          expected: 'The Forms & Documents page should load.',
          action: () => marketplace.openFormsAndDocuments(),
          screenshotName: `Step${stepId}_FormsAndDocuments`,
        });
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: `Select state ${stateName}`,
          expected: `State "${stateName}" should be selected.`,
          action: async () => {
            const res = await marketplace.selectState(state);
            if (!res || !res.selected) throw new Error(`State select failed: ${res && res.reason ? res.reason : 'unknown'}`);
            await marketplace.scrollToAllFormsAndDocuments();
          },
          screenshotName: `Step${stepId}_State_${state}`,
        });
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: `Toggle Coverage Year to ${YEAR}`,
          expected: `Coverage Year ${YEAR} should be active.`,
          action: async () => {
            await marketplace.selectCoverageYear(YEAR);
            const yearInUrl = marketplace.getYearFromUrl(page.url());
            const activeYear = await marketplace.getActiveYear();
            if (!(yearInUrl === YEAR && (activeYear == null || activeYear === YEAR))) {
              throw new Error(`Coverage Year ${YEAR} not active (urlYear="${yearInUrl}", activeYear="${activeYear}").`);
            }
          },
          screenshotName: `Step${stepId}_Year_${YEAR}`,
        });
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: 'Apply Marketplace / Member Handbooks and Coverage filters',
          expected: `Audience="${FILTER_AUDIENCE}" and Category="${FILTER_CATEGORY}" should be selected.`,
          action: async () => {
            // The Spanish facet panel can render slowly; retry the whole
            // filter application a few times before failing the step.
            let lastErr;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await marketplace.scrollToAllFormsAndDocuments();
                try { await marketplace.searchByPlanName(''); } catch {}
                await marketplace.selectFilterOption('Audience', FILTER_AUDIENCE);
                await marketplace.selectFilterOption('Category', FILTER_CATEGORY);
                return;
              } catch (err) {
                lastErr = err;
                await page.waitForTimeout(1500);
              }
            }
            throw lastErr;
          },
          screenshotName: `Step${stepId}_Filters`,
        });
      } else {
        const materialsEn = materialsUrl(state, 'en');
        const materialsEs = materialsUrl(state, 'es');
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: `Open ${state} Materials page`,
          expected: `Load ${materialsEn}.`,
          action: () => marketplace.open(materialsEn),
          screenshotName: 'Step1_Materials',
        });
        if (lang === 'es') {
          await captureSetup({
            page, marketplace, setupSteps, screenshotsDir, id: stepId++,
            name: 'Switch site language to Spanish',
            expected: 'Switch the Molina site to Spanish materials.',
            action: async () => {
              await marketplace.switchLanguage('es');
              if (!new RegExp(`/ifp/${String(state).toLowerCase()}/materials`, 'i').test(page.url()) || !/\/es-us\//i.test(page.url())) await marketplace.open(materialsEs);
            },
            screenshotName: 'Step2_Language_ES',
          });
        }
        await captureSetup({
          page, marketplace, setupSteps, screenshotsDir, id: stepId++,
          name: 'Expand Plan Brochure accordion',
          expected: 'The Plan Brochure accordion should expand and show the brochure links.',
          action: async () => {
            const header = page.locator('button:has-text("Plan Brochure"), button:has-text("Folleto del plan"), button:has-text("Folleto")').first();
            await header.waitFor({ state: 'visible', timeout: 20000 });
            await header.scrollIntoViewIfNeeded().catch(() => {});
            if ((await header.getAttribute('aria-expanded').catch(() => '')) !== 'true') await header.click();
            await page.waitForTimeout(600);
          },
          screenshotName: `Step${stepId}_Accordion`,
        });
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const expectedUrl = item.expectedUrl[lang];
        const card = {
          id: i + 1,
          name: `[Flow ${flow} · ${langLabel}] ${item.cardName ? item.cardName[lang] : item.linkText}`,
          status: 'PASS',
          expectedUrl,
          pdfUrl: '',
          href: '',
          isDataDriven: true,
          steps: [],
          validations: [],
          error: '',
        };
        planCards.push(card);
        const screenshotLabel = `Flow${flow}_${langLabel}_${sanitize(item.cardName ? item.cardName[lang] : item.linkText)}_PDF`;

        await test.step(`Card ${i + 1} — ${card.name}`, async () => {
          let locator;
          if (flow === 1) {
            await marketplace.searchByPlanName(item.searchText);
            await marketplace.scrollToAllFormsAndDocuments();
            const matched = await marketplace.findCardByNameAndUrl(item.cardName[lang], expectedUrl);
            if (!matched) {
              card.status = 'FAIL';
              card.error = `No ${state} card matched name="${item.cardName[lang]}" and URL="${expectedUrl}".`;
              pushPlanStep(card, { id: 1, name: 'Find and open brochure card', expected: `Find ${item.cardName[lang]}.`, actual: card.error, status: 'FAIL', durationMs: 0 });
              return;
            }
            locator = matched.linkLoc;
            card.href = matched.href || '';
          } else {
            locator = page.locator('a').filter({ hasText: new RegExp(`^\\s*${item.linkText}\\s*$`, 'i') }).first();
            if (!(await locator.count())) {
              card.status = 'FAIL';
              card.error = `Link "${item.linkText}" not found in the Plan Brochure accordion.`;
              pushPlanStep(card, { id: 1, name: 'Find and open brochure link', expected: `Find ${item.linkText}.`, actual: card.error, status: 'FAIL', durationMs: 0 });
              return;
            }
            card.href = await locator.getAttribute('href') || '';
          }
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          await openAndValidate({ page, context, trigger: locator, card, item, lang, screenshotsDir, label: screenshotLabel });
        });
      }
    } catch (error) {
      runError = error;
      logger.warn('MP-TX-BROCH', `${testId} aborted: ${String(error && error.message ? error.message : error).substring(0, 200)}`);
    } finally {
      const status = writePerTestReport({ testId, testName, state, stateName, lang, flow, appUrl, scopeDir, reportFile, setupSteps, planCards, started });
      if (status !== 'PASS') logger.warn('MP-TX-BROCH', `${testId} report status: ${status}`);
      // Collect every per-test HTML into a single shared all-reports folder.
      try {
        const allReportsDir = path.join(REPORT_ROOT, 'all-reports');
        fs.mkdirSync(allReportsDir, { recursive: true });
        if (fs.existsSync(reportFile)) fs.copyFileSync(reportFile, path.join(allReportsDir, `${testId}.html`));
      } catch (error) {
        logger.warn('MP-TX-BROCH', `${testId} all-reports copy failed: ${String(error && error.message ? error.message : error).substring(0, 160)}`);
      }
    }

    if (runError) throw runError;
    const failed = planCards.filter((card) => card.status === 'FAIL');
    expect(failed, `${failed.length} card(s) failed: ${failed.map((card) => card.name).join('; ')}`).toHaveLength(0);
  });
}

for (const lang of ['en', 'es']) {
  for (const { state, stateName, items } of FLOW1_BY_STATE) {
    registerTest({ flow: 1, state, stateName, lang, items, appUrl: APP_URL });
  }
  for (const state of FLOW2_STATES) {
    registerTest({ flow: 2, state, stateName: STATE_NAMES[state] || state, lang, items: flow2Items(state), appUrl: materialsUrl(state, lang) });
  }
}
