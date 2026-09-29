/**
 * Marketplace · Service Area Maps by State (US: MP-SAM-001)
 *
 * Verifies the "View Marketplace Service Area Maps by State" component on the
 * Brokers & Agents → Molina Healthcare page. Each acceptance criterion maps
 * 1:1 to a `test.step(...)` block so it renders as a labelled block in the
 * Playwright HTML report and the framework's custom HTML report.
 *
 *   AC1  Component + approved verbiage (heading / description / placeholder)
 *   AC2  Dropdown populated with all configured Marketplace states
 *   AC3  No map displayed by default (before any selection)
 *   AC4  Selecting a state shows the map inline (no modal / tab / download)
 *   AC5  Selecting a different state replaces the previous map
 *   AC6  Displayed image is the latest approved image for the state
 *
 * Framework reuse (nothing new introduced):
 *   • pages/serviceAreaMapsPage.js — page object (component / dropdown / map)
 *   • pages/HomePage.js            — PageCapture (used via the page object)
 *   • utils/browserHelper.js       — launchFreshBrowser + stealth + cleanup
 *   • utils/logger.js              — structured logging
 *   • reporting/reportGenerator.js — custom per-run HTML report
 *   • config/framework.config.js   — every knob (URL, data path, report dir)
 *   • data/marketplace/serviceAreaMaps.json — states + approved images + verbiage
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { test, expect } = require('@playwright/test');

const frameworkConfig = require('../../config/framework.config');
const logger = require('../../utils/logger');
const { launchFreshBrowser, cleanupBetweenTests, applyStealthScripts } =
  require('../../utils/browserHelper');
const { ServiceAreaMapsPage } = require('../../pages/serviceAreaMapsPage');
const { writeStepsReport } = require('../../reporting/reportGenerator');

const SAM = frameworkConfig.serviceAreaMaps;

/** Normalize a cell to a trimmed string. */
const norm = (v) => String(v == null ? '' : v).trim();

/** Escape a string for safe use inside a RegExp. */
const escapeRe = (s) => String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Data loader ────────────────────────────────────────────────────────────
// Source: data/marketplace/ServiceAreaMapsData.xlsx.
//   • Sheet "ServiceAreaMaps" — one row per state; Run=Y rows are tested.
//   • Sheet "Config" (Key|Value) — AppUrl + approved verbiage (source of truth).
// If the sheet is missing, unreadable, or has zero Run=Y rows, the suite runs
// 0 tests. Regenerate with `npm run data:service-area-maps`.
function openWorkbook() {
  if (!fs.existsSync(SAM.excelPath)) {
    logger.warn('SERVICE_AREA_MAPS', `Excel not found at ${SAM.excelPath} — running 0 tests`);
    return null;
  }
  try {
    return XLSX.readFile(SAM.excelPath);
  } catch (err) {
    logger.warn('SERVICE_AREA_MAPS', `Excel read failed: ${err.message.substring(0, 160)} — running 0 tests`);
    return null;
  }
}

/** Read the Key/Value "Config" sheet; falls back to framework config values. */
function loadConfig(wb) {
  const fb = SAM.verbiage || {};
  const out = {
    appUrl:              SAM.urls.appUrl,
    heading:             fb.heading || '',
    description:         fb.description || '',
    dropdownPlaceholder: fb.dropdownPlaceholder || '',
    noMapMessage:        fb.noMapMessage || '',
  };
  const sheet = wb && wb.Sheets[SAM.configSheet];
  if (!sheet) return out;
  const map = {};
  for (const row of XLSX.utils.sheet_to_json(sheet, { defval: '' })) {
    const key = norm(row.Key).toLowerCase();
    if (key) map[key] = norm(row.Value);
  }
  if (map.appurl)              out.appUrl = map.appurl;
  if (map.heading)             out.heading = map.heading;
  if (map.description)         out.description = map.description;
  if (map.dropdownplaceholder) out.dropdownPlaceholder = map.dropdownplaceholder;
  if (map.nomapmessage)        out.noMapMessage = map.nomapmessage;
  return out;
}

/** Read the "ServiceAreaMaps" sheet — Run=Y rows become states under test. */
function loadStates(wb) {
  const sheet = wb && (wb.Sheets[SAM.excelSheet] || wb.Sheets[wb.SheetNames[0]]);
  if (!sheet) {
    logger.warn('SERVICE_AREA_MAPS', `Sheet "${SAM.excelSheet}" not found — running 0 tests`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const filter = norm(SAM.stateFilter).toLowerCase();
  const states = rows
    .filter(r => norm(r.Run).toLowerCase() === 'y')
    .map(r => ({
      testId:   norm(r.TestId),
      state:    norm(r.State).toUpperCase(),
      name:     norm(r.Name),
      mapImage: norm(r.MapImage),
    }))
    .filter(s => s.state && (!filter || s.state.toLowerCase() === filter));
  logger.info('SERVICE_AREA_MAPS',
    `Loaded ${states.length} state(s) from ${path.basename(SAM.excelPath)}`
    + (filter ? ` (filtered by state=${filter})` : ''));
  return states;
}

const WORKBOOK = openWorkbook();
const verbiage = loadConfig(WORKBOOK);
const STATES = WORKBOOK ? loadStates(WORKBOOK) : [];
const APP_URL = verbiage.appUrl;
const REPORT_DIR = SAM.report.dir;

/** Auto-detect environment label from an app URL. */
function envLabelFromUrl(url) {
  const u = String(url || '');
  if (u.includes('pws-d1')) return 'QA (pws-d1)';
  if (u.includes('pws-q3')) return 'Q3 (pws-q3)';
  if (u.includes('pws-q2')) return 'Q2 (pws-q2)';
  if (u.includes('pws-q1')) return 'Q1 (pws-q1)';
  return 'PROD';
}

/**
 * Take a framework-style screenshot, save it under `screenshotsDir`, and
 * attach it to the current test's HTML report entry.
 *
 * @param {'component'|'map'} [focus] — element to frame in the screenshot.
 */
async function captureStepEvidence(pageObj, testInfo, screenshotsDir, stepNumber, name, focus) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const safeName = String(name).replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
  const file = path.join(screenshotsDir, `Step${stepNumber}_${safeName}.png`);
  try {
    await pageObj.saveScreenshot(file, { focus });
  } catch (err) {
    logger.warn('SCREENSHOT', `Step ${stepNumber} screenshot failed: ${err.message.substring(0, 120)}`);
  }
  try {
    if (fs.existsSync(file)) {
      await testInfo.attach(`Step ${stepNumber} — ${name}`, { path: file, contentType: 'image/png' });
    }
  } catch { /* attach is best-effort */ }
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
// Tests — one test (and one report) per Run=Y state row
// ══════════════════════════════════════════════════════════════════════════

test.describe('Marketplace · Service Area Maps by State', () => {
  if (STATES.length < 1) {
    test('No states configured', () => {
      test.skip(true, 'No Run=Y rows in ServiceAreaMapsData.xlsx — nothing to verify.');
    });
  }

  STATES.forEach((STATE, idx) => {
    // A state with a (non-placeholder) mapImage shows a map; an empty
    // mapImage marks a "no map" state (selecting it shows the unavailable
    // message instead of an image, e.g. Illinois).
    const hasMap = (s) => !!(s && s.mapImage && !/^TODO/i.test(s.mapImage));
    const IS_NO_MAP = !hasMap(STATE);

    // Sibling used to prove the map is replaced on state change — must itself
    // be a map-bearing state. Pick the nearest one after this row, cyclically.
    let COMPARE = null;
    for (let k = 1; k < STATES.length && !COMPARE; k++) {
      const s = STATES[(idx + k) % STATES.length];
      if (s !== STATE && hasMap(s)) COMPARE = s;
    }

    const RUN_SLUG     = STATE.state;
    const RUN_DIR      = path.join(REPORT_DIR, RUN_SLUG);
    const SCREENSHOTS  = path.join(RUN_DIR, 'screenshots');
    const REPORT_ID    = STATE.testId || `${SAM.test.id}-${STATE.state}`;
    const REPORT_FILE  = path.join(RUN_DIR, `${REPORT_ID}.html`);

    const TEST_META = {
      name:        `Marketplace · Service Area Maps · ${STATE.name}`,
      description: IS_NO_MAP
        ? `Verify the "View Marketplace Service Area Maps by State" component on the `
          + `Brokers & Agents → Molina Healthcare page for ${STATE.name} (${STATE.state}): `
          + `approved verbiage, no default map, and that selecting ${STATE.name} shows the `
          + `"map unavailable" message with no map image.`
        : `Verify the "View Marketplace Service Area Maps by State" component on the `
          + `Brokers & Agents → Molina Healthcare page for ${STATE.name} (${STATE.state}): `
          + `approved verbiage, no default map, inline map on selection, the approved image, `
          + `and map replacement when a different state is selected.`,
      id:          REPORT_ID,
      module:      SAM.test.module,
      environment: SAM.test.environment || envLabelFromUrl(APP_URL),
    };

  test(`${STATE.state} · ${STATE.name} · Service Area Map`, async ({}, testInfo) => {
    const reportSteps = [];
    const recordStep = (id, name, status, expected, actual, screenshotPath, screenshotLabel) => {
      reportSteps.push({ id, name, status, expected, actual, screenshotPath, screenshotLabel });
    };
    const runStart = Date.now();

    logger.info('SERVICE_AREA_MAPS', '═══════════════════════════════════════════════════════');
    logger.info('SERVICE_AREA_MAPS', `Run: ${STATE.state} (${STATE.name}) · compare=${COMPARE ? COMPARE.state : '(none)'}`);
    logger.info('SERVICE_AREA_MAPS', `App URL: ${APP_URL}`);
    logger.info('SERVICE_AREA_MAPS', '═══════════════════════════════════════════════════════');

    const browser = await launchFreshBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: frameworkConfig.headless
        ? { width: frameworkConfig.viewport.width, height: frameworkConfig.viewport.height }
        : null,
    });
    await applyStealthScripts(context);
    const page = await context.newPage();
    const sam = new ServiceAreaMapsPage(page);

    try {
      // ── Step 1 — Component + approved verbiage ──────────────────────────
      await test.step('Display the Service Area Maps component with approved content', async () => {
        await sam.open(APP_URL, frameworkConfig.navigationTimeoutMs);
        await sam.scrollToComponent();

        expect(await sam.isComponentVisible(), 'Service Area Maps component should be visible').toBe(true);
        await expect(sam.heading()).toHaveText(new RegExp(`^\\s*${escapeRe(verbiage.heading)}\\s*$`, 'i'));
        await expect(sam.description()).toContainText(verbiage.description);
        const placeholder = await sam.getDropdownPlaceholder();
        expect(placeholder, 'Dropdown placeholder').toMatch(new RegExp(escapeRe(verbiage.dropdownPlaceholder), 'i'));

        const shot = await captureStepEvidence(sam, testInfo, SCREENSHOTS, 1, 'Component_Verbiage', 'component');
        recordStep(1, 'Service Area Maps component is displayed with approved content', 'PASS',
          'The component "View Marketplace Service Area Maps by State" is displayed with the approved '
          + 'heading, description, and the "Select a State" dropdown placeholder.',
          `Heading, description and placeholder ("${placeholder}") match the approved business verbiage.`,
          shot, 'Service Area Maps component');
      });

      // ── Step 2 — No map displayed by default ────────────────────────────
      await test.step('No Service Area Map is shown on initial load', async () => {
        const visible = await sam.isMapVisible();
        expect(visible, 'No map should be shown before a state is selected').toBe(false);
        const shot = await captureStepEvidence(sam, testInfo, SCREENSHOTS, 2, 'No_Default_Map', 'component');
        recordStep(2, 'No Service Area Map is shown on initial load', visible ? 'FAIL' : 'PASS',
          'On first load, with no state selected, no Service Area Map is displayed.',
          visible ? 'A map image was unexpectedly visible before selection.'
                  : 'No Service Area Map image is displayed before a state is selected.',
          shot, 'No map on load');
      });

      // ── Steps 3+ — map-bearing vs no-map states diverge here ────────────
      if (IS_NO_MAP) {
        // ── Step 3 — Select this state → NO map, "unavailable" message ────
        await test.step(`Selecting "${STATE.name}" shows the "map unavailable" message`, async () => {
          const tabsBefore = sam.pageCount();
          const res = await sam.selectState(STATE);
          expect(res.selected, `State "${STATE.name}" should be selectable`).toBe(true);
          await sam.scrollToComponent();

          const mapShown = await sam.isMapVisible();
          expect(mapShown, `No map image should be shown for "${STATE.name}"`).toBe(false);
          const messageShown = await sam.isNoMapMessageVisible();
          expect(messageShown, 'The "map unavailable" message should be shown').toBe(true);
          if (verbiage.noMapMessage) {
            await expect(sam.noMapMessage()).toContainText(verbiage.noMapMessage);
          }
          expect(sam.pageCount(), 'No new browser tab should open').toBe(tabsBefore);

          const msg = await sam.getNoMapMessageText();
          const shot = await captureStepEvidence(sam, testInfo, SCREENSHOTS, 3, `NoMap_${STATE.state}`, 'component');
          recordStep(3, `Selecting "${STATE.name}" shows the "map unavailable" message`, 'PASS',
            `Selecting "${STATE.name}" (a state with no Service Area Map) should display the `
            + `"map unavailable" message and no map image, with no new tab/modal/download.`,
            `No map image was displayed for "${STATE.name}"; the message "${msg}" is shown. `
            + `Browser tab count unchanged (${tabsBefore}).`,
            shot, `No map — ${STATE.name}`);
        });
      } else {
        // ── Step 3 — Select this state → map shown inline, no modal/tab ──
        await test.step(`Selecting "${STATE.name}" displays its Service Area Map inline`, async () => {
          const tabsBefore = sam.pageCount();
          const res = await sam.selectState(STATE);
          expect(res.selected, `State "${STATE.name}" should be selectable`).toBe(true);
          await sam.scrollToMap();

          expect(await sam.isMapVisible(), 'Map should be displayed inline after selection').toBe(true);
          expect(sam.pageCount(), 'No new browser tab should open').toBe(tabsBefore);

          const src = await sam.getMapSrc();
          const shot = await captureStepEvidence(sam, testInfo, SCREENSHOTS, 3, `Map_${STATE.state}`, 'map');
          recordStep(3, `Selecting "${STATE.name}" displays its Service Area Map inline`, 'PASS',
            'Selecting a state displays its Service Area Map inline below the component, with no modal, '
            + 'popup, new tab, or file download.',
            `Map is displayed inline for "${STATE.name}" (src="${src}"). Browser tab count unchanged `
            + `(${tabsBefore}).`,
            shot, `Service Area Map — ${STATE.name}`);
        });

        // ── Step 4 — Displayed image is the approved image for this state ──
        await test.step(`Displayed map matches the approved image for "${STATE.name}"`, async () => {
          const src = await sam.getMapSrc();
          const expected = String(STATE.mapImage || '');

          expect(src, `Displayed image should match the approved image for "${STATE.name}"`)
            .toContain(expected);
          const shot = await captureStepEvidence(sam, testInfo, SCREENSHOTS, 4, `Approved_${STATE.state}`, 'map');
          recordStep(4, `Displayed map matches the approved image for "${STATE.name}"`, 'PASS',
            `The displayed image is the latest approved image for "${STATE.name}".`,
            `Displayed image src ("${src}") contains the approved reference ("${expected}").`,
            shot, `Approved image — ${STATE.name}`);
        });

        // ── Step 5 — Change state → previous map replaced ─────────────────
        if (COMPARE) {
          await test.step(`Selecting "${COMPARE.name}" replaces the displayed map`, async () => {
            const prevSrc = await sam.getMapSrc();
            const res = await sam.selectState(COMPARE);
            expect(res.selected, `State "${COMPARE.name}" should be selectable`).toBe(true);
            await sam.scrollToMap();

            expect(await sam.isMapVisible(), 'A map should still be displayed after change').toBe(true);
            const newSrc = await sam.getMapSrc();
            expect(newSrc, 'Map src should change when a different state is selected').not.toBe(prevSrc);

            const shot = await captureStepEvidence(sam, testInfo, SCREENSHOTS, 5, `Map_${COMPARE.state}`, 'map');
            recordStep(5, `Selecting "${COMPARE.name}" replaces the displayed map`, 'PASS',
              'Selecting a different state replaces the previously displayed Service Area Map.',
              `Map replaced: "${STATE.name}" (src="${prevSrc}") → "${COMPARE.name}" (src="${newSrc}").`,
              shot, `Service Area Map — ${COMPARE.name}`);
          });
        } else {
          recordStep(5, 'Selecting a different state replaces the displayed map', 'SKIP',
            'Selecting a different state replaces the previously displayed map.',
            'No other map-bearing state configured — add one to verify replacement.',
            null, null);
        }
      }

      logger.info('SERVICE_AREA_MAPS', `All verification steps completed for ${STATE.state}`);
    } finally {
      try {
        const reportPath = writeStepsReport({
          reportDir:  RUN_DIR,
          reportFile: REPORT_FILE,
          testMeta:   TEST_META,
          appUrl:     APP_URL,
          steps:      reportSteps,
          durationMs: Date.now() - runStart,
        });
        logger.info('SERVICE_AREA_MAPS', `Report written: ${reportPath}`);
      } catch (reportErr) {
        logger.warn('SERVICE_AREA_MAPS', `Report generation failed: ${reportErr.message.substring(0, 200)}`);
      }
      try {
        await cleanupBetweenTests({ contexts: [context], browsers: [browser] });
      } catch { /* ignore */ }
    }
  });
  });
});
