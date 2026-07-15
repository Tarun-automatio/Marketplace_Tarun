/**
 * Plan Materials worker-scoped fixture factory.
 *
 * The Plan Materials test is matrix-driven: one describe() per (state, year,
 * accordion) scope, each with its OWN worker fixture that opens the correct
 * page + accordion. This factory encapsulates the setup logic (steps 1–3)
 * and yields a context object consumed by per-plan test() bodies.
 *
 * Usage in the spec:
 *
 *   const scopedTest = base.extend({
 *     planMaterialsCtx: [
 *       createPlanMaterialsFixture({ scope, screenshotsDir, setupSteps, planCards, scopeLabel }),
 *       { scope: 'worker' },
 *     ],
 *   });
 *
 * The `setupSteps` and `planCards` arrays are passed by REFERENCE — the
 * fixture body appends to them; the afterAll() hook in the spec reads them
 * to render the HTML report.
 */

const fs   = require('fs');
const path = require('path');

const { devices } = require('@playwright/test');
const frameworkConfig = require('../config/framework.config');
const logger          = require('../utils/logger');
const {
  launchFreshBrowser,
  applyStealthScripts,
  cleanupBetweenTests,
} = require('../utils/browserHelper');
const { PlanMaterialsPage } = require('../pages/planMaterialsPage');
const {
  captureElementScreenshot,
  captureEvidencePanel,
  ensureValidScreenshot,
} = require('../utils/screenshotHelpers');
const {
  pushSetupStep,
  fallbackPanelHtml,
} = require('../helpers/evidencePanel');
// Device profiles used for the "Responsive Previews" report section.
// Each entry captures a full-page screenshot of scope.appUrl once per scope.
const RESPONSIVE_DEVICES = [
  { key: 'iphone-se', label: 'iPhone SE',    device: devices['iPhone SE']   },
  { key: 'ipad-pro',  label: 'iPad Pro 11',  device: devices['iPad Pro 11'] },
];

/**
 * Create the worker-scoped fixture body for a single Plan Materials scope.
 *
 * The fixture is section-agnostic: pass a different `PageClass` and
 * `sectionLabel` and it works against any page that uses the same accordion
 * DOM (e.g. drug/formulary page).
 *
 * @param {object}   opts
 * @param {object}   opts.scope          — { state, year, accordion, appUrl, plans[] }
 * @param {string}   opts.screenshotsDir — where step-1..3 screenshots are saved
 * @param {Array}    opts.setupSteps     — appended to during setup (steps 1–3)
 * @param {Array}    opts.planCards      — passed through to per-plan validation
 * @param {Array}    [opts.responsiveShots] — appended with { key, label, viewport, filePath }
 *                                            entries for each responsive full-page capture
 * @param {string}   opts.scopeLabel     — pretty label for error messages
 * @param {Function} [opts.PageClass]    — page-object class to instantiate
 *                                         (default: PlanMaterialsPage). Pass
 *                                         `DrugPage` for the drug/formulary flow.
 * @param {string}   [opts.sectionLabel] — human-readable section label used in
 *                                         step names / errors (default:
 *                                         "Plan Materials"). e.g. for drugs:
 *                                         "Pharmacy and Prescription Benefits Documents".
 * @returns {Function} an async fixture body suitable for base.extend()
 */
function createPlanMaterialsFixture({
  scope,
  screenshotsDir,
  setupSteps,
  planCards,
  responsiveShots,
  scopeLabel,
  PageClass    = PlanMaterialsPage,
  sectionLabel = 'Plan Materials',
}) {
  return async ({}, use) => {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const browser = await launchFreshBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      viewport: frameworkConfig.headless
        ? { width: frameworkConfig.viewport.width, height: frameworkConfig.viewport.height }
        : null,
    });
    await applyStealthScripts(context);
    const page = await context.newPage();
    const materials = new PageClass(page);

    // Step 1 — Launch Materials Page
    await materials.open(scope.appUrl, frameworkConfig.navigationTimeoutMs);
    const mainLocator = page.locator('main, [role="main"], #mainContent').first();
    const launchShot = path.join(screenshotsDir, 'Step1_Materials_Page_Loaded.png');
    const launchResult = await ensureValidScreenshot(
      async () => {
        if (await mainLocator.count()) {
          return captureElementScreenshot(mainLocator, launchShot, { padding: 0, timeout: 8000 });
        }
        await page.screenshot({ path: launchShot, fullPage: false });
        return launchShot;
      },
      () => captureEvidencePanel(context,
        fallbackPanelHtml('Launch', `Application launched: ${scope.appUrl}`),
        launchShot),
    );
    pushSetupStep(setupSteps, {
      id: 1,
      name: 'Launch Materials Page',
      expected: 'Materials page should launch successfully and be ready for interaction.',
      actual: `Materials page launched successfully — ${scope.appUrl}`,
      status: 'PASS',
      screenshotPath: launchResult.filePath,
      screenshotLabel: 'Materials page launched successfully',
    });

    // Step 2 — Navigate to <YEAR> <sectionLabel>
    const sectionOk = await materials.sectionExists(scope.year);
    if (!sectionOk) {
      const failShot = path.join(screenshotsDir, `Step2_Section_${scope.year}_Missing.png`);
      const failRes = await ensureValidScreenshot(
        async () => captureElementScreenshot(page.locator('body'), failShot, { padding: 0 }),
        () => captureEvidencePanel(context,
          fallbackPanelHtml('Section missing', `The "${scope.year} ${sectionLabel}" section was not found on the page.`),
          failShot),
      );
      pushSetupStep(setupSteps, {
        id: 2,
        name: `Navigate to ${scope.year} ${sectionLabel}`,
        expected: `The "${scope.year} ${sectionLabel}" section should be present on the page.`,
        actual: `The "${scope.year} ${sectionLabel}" section was NOT found on the page.`,
        status: 'FAIL',
        screenshotPath: failRes.filePath,
        screenshotLabel: `${scope.year} ${sectionLabel} section missing`,
      });
      throw new Error(`Section "${scope.year} ${sectionLabel}" not present on page`);
    }

    const section = await materials.scrollToPlanMaterialsSection(scope.year);
    // Bring the TARGET accordion into view (still collapsed) so the Step 2
    // evidence screenshot clearly shows the accordion that Step 3 will
    // expand — e.g. "Comprehensive Formulary" for the drug page.
    // Falls back gracefully to the section header if the accordion can't be
    // located (should never happen, but we don't want to break the flow).
    try {
      const targetAccordionBtn = materials.accordionButton(section, scope.accordion);
      if (await targetAccordionBtn.count()) {
        await targetAccordionBtn.scrollIntoViewIfNeeded().catch(() => {});
      }
    } catch { /* ignore — fall back to section scroll below */ }

    const sectionShot = path.join(screenshotsDir, `Step2_Section_${scope.year}_Plan_Materials.png`);
    const sectionRes = await ensureValidScreenshot(
      async () => {
        // If the accordion scroll above worked, this is a no-op. If it
        // didn't, we at least scroll the section back into view.
        await section.scrollIntoViewIfNeeded().catch(() => {});
        await page.screenshot({ path: sectionShot, fullPage: false });
        return sectionShot;
      },
      () => captureEvidencePanel(context,
        fallbackPanelHtml('Section captured', `${scope.year} ${sectionLabel} section was located.`),
        sectionShot),
    );
    pushSetupStep(setupSteps, {
      id: 2,
      name: `Navigate to ${scope.year} ${sectionLabel}`,
      expected: `The "${scope.year} ${sectionLabel}" section should be located and the "${scope.accordion}" accordion should be visible in the viewport.`,
      actual: `The "${scope.year} ${sectionLabel}" section was located and the "${scope.accordion}" accordion was scrolled into view.`,
      status: 'PASS',
      screenshotPath: sectionRes.filePath,
      screenshotLabel: `${scope.accordion} accordion visible under ${scope.year} ${sectionLabel}`,
    });

    // Step 3 — Expand accordion
    let accordion;
    try {
      accordion = await materials.expandAccordion(scope.year, scope.accordion);
    } catch (err) {
      const failShot = path.join(screenshotsDir, 'Step3_Accordion_Expand_Failed.png');
      const failRes = await ensureValidScreenshot(
        () => captureElementScreenshot(section, failShot, { padding: 6 }),
        () => captureEvidencePanel(context,
          fallbackPanelHtml('Accordion expand failed', err.message),
          failShot),
      );
      pushSetupStep(setupSteps, {
        id: 3,
        name: `Expand ${scope.accordion} Accordion`,
        expected: `The "${scope.accordion}" accordion should expand and reveal its plan links.`,
        actual: `Failed to expand "${scope.accordion}": ${err.message}`,
        status: 'FAIL',
        screenshotPath: failRes.filePath,
        screenshotLabel: `${scope.accordion} accordion expansion failed`,
      });
      throw err;
    }
    const anocShot = path.join(screenshotsDir, 'Step3_Accordion_Expanded.png');
    const anocRes = await ensureValidScreenshot(
      async () => {
        await accordion.container.scrollIntoViewIfNeeded().catch(() => {});
        await page.screenshot({ path: anocShot, fullPage: false });
        return anocShot;
      },
      () => captureEvidencePanel(context,
        fallbackPanelHtml(`${scope.accordion} accordion expanded`, 'Accordion was expanded successfully.'),
        anocShot),
    );
    pushSetupStep(setupSteps, {
      id: 3,
      name: `Expand ${scope.accordion} Accordion`,
      expected: `The "${scope.accordion}" accordion should expand and reveal its plan links.`,
      actual: `The "${scope.accordion}" accordion was expanded successfully and its plan links became visible.`,
      status: 'PASS',
      screenshotPath: anocRes.filePath,
      screenshotLabel: `${scope.accordion} accordion expanded`,
    });

    // Discover plans + match against the scope's expected list.
    const { plans: discovered } = await materials.collectPlanLinks(accordion.panel);
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const targets = scope.plans.map((ep) => {
      const key = norm(ep.name);
      const hit = discovered.find(d => norm(d.name) === key);
      return { name: ep.name, expectedUrl: ep.url, discovered: hit || null, missing: !hit };
    });

    logger.info(materials.logTag || 'PLAN-MATERIALS',
      `Scope [${scope.state}/${scope.year}/${scope.accordion}] — ${scope.plans.length} expected plan(s), ${discovered.length} discovered on page`);

    if (!targets.length) {
      throw new Error(`No plans defined for scope "${scopeLabel}"`);
    }

    // ── Responsive previews (iPhone SE + iPad Pro) ──────────────────────
    // Captured once per scope on a fresh emulated context so it doesn't
    // interfere with the primary test flow. After landing on the page we
    // scroll to the scope's year section, expand the accordion, then take
    // a VIEWPORT screenshot (not full-page) so the report shows what the
    // user actually sees on that device with the plan link revealed.
    // Failures here are non-fatal — we log and skip the missing device.
    if (Array.isArray(responsiveShots)) {
      for (const { key, label, device } of RESPONSIVE_DEVICES) {
        if (!device) {
          logger.warn('RESPONSIVE', `Playwright device profile missing for ${label} — skipping`);
          continue;
        }
        let rCtx;
        try {
          rCtx = await browser.newContext({
            ...device,
            ignoreHTTPSErrors: true,
            acceptDownloads: false,
          });
          await applyStealthScripts(rCtx);
          const rPage = await rCtx.newPage();
          const rMaterials = new PageClass(rPage);
          await rMaterials.open(scope.appUrl, frameworkConfig.navigationTimeoutMs);

          // Scroll to the year section (best-effort — swallow errors so a
          // layout tweak on mobile never breaks the responsive capture).
          try {
            const rSection = await rMaterials.scrollToPlanMaterialsSection(scope.year);
            await rSection.scrollIntoViewIfNeeded().catch(() => {});
          } catch (navErr) {
            logger.warn('RESPONSIVE', `${label}: could not scroll to "${scope.year} ${sectionLabel}" — ${navErr.message.substring(0, 80)}`);
          }

          // Expand the target accordion so the plan links are visible in
          // the viewport screenshot.
          try {
            const rAccordion = await rMaterials.expandAccordion(scope.year, scope.accordion);
            await rAccordion.container.scrollIntoViewIfNeeded().catch(() => {});
          } catch (accErr) {
            logger.warn('RESPONSIVE', `${label}: could not expand "${scope.accordion}" — ${accErr.message.substring(0, 80)}`);
          }

          const shotPath = path.join(screenshotsDir, `Responsive_${key}.png`);
          // Viewport screenshot (not full-page) — matches what the user sees
          // on the device and keeps the report image compact.
          await rPage.screenshot({ path: shotPath, fullPage: false });
          responsiveShots.push({
            key,
            label,
            viewport: device.viewport || null,
            filePath: shotPath,
          });
          logger.info('RESPONSIVE', `Captured ${label} accordion-expanded screenshot`);
        } catch (err) {
          logger.warn('RESPONSIVE', `Failed to capture ${label}: ${err.message.substring(0, 120)}`);
        } finally {
          if (rCtx) { await rCtx.close().catch(() => {}); }
        }
      }
    }

    await use({ context, materials, accordion, targets, scope, screenshotsDir, planCards });

    // Teardown
    await cleanupBetweenTests({
      contexts: [context],
      browsers: [browser],
      cooldownMs: 0,
    }).catch(() => {});
  };
}

module.exports = { createPlanMaterialsFixture };
