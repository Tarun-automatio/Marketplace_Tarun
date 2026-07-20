/**
 * DrugPage — Page Object for the Molina Medicare "Pharmacy and Prescription
 * Benefits Documents" content on the drugs landing page
 * (e.g. https://.../medicare/<state>/drugs).
 *
 * ─── DOM change (2027 redesign) ────────────────────────────────────────
 *
 * Molina moved the drug documents. What used to be its own top-level
 * section is now a NESTED accordion inside the "Common questions" section.
 *
 * OLD structure (still used by plan-materials page):
 *   <div.container>
 *     <h2>2027 Pharmacy and Prescription Benefits Documents</h2>
 *     <accordion>
 *       <button aria-label="Comprehensive Formulary">   ← accordion toggle
 *       <div.accordionContent>
 *         <a href="…">Plan 1</a>
 *         <a href="…">Plan 2</a>
 *
 * NEW structure (drug page today):
 *   <div.container>
 *     <h2>Common questions</h2>
 *     <accordion>
 *       <button aria-label="How do I check if my prescription is covered?">
 *       <button aria-label="Where can I fill my prescription?">
 *       <button aria-label="2027 Pharmacy and Prescription Benefits Documents">  ← year-accordion
 *       <div.accordionContent>
 *         <p><strong>Comprehensive Formulary</strong></p>   ← document-type heading
 *         <ul>
 *           <li><a>Plan 1</a></li>
 *           <li><a>Plan 2</a></li>
 *         </ul>
 *         <p><strong>Prior Authorization Grid</strong></p>
 *         <ul> … </ul>
 *       …
 *       <button aria-label="2026 Pharmacy and Prescription Benefits Documents">
 *
 * ─── API compatibility ────────────────────────────────────────────────
 *
 * The public contract expected by fixtures + specs is preserved:
 *
 *   materials.expandAccordion(year, accordionLabel) → { section, container, button, panel }
 *
 * Only the internals change to walk the new DOM. `panel` now returns the
 * `<ul>` immediately following the matching `<p><strong>…</strong></p>`
 * heading, so `collectPlanLinks(panel)` / `planLinkByName(panel, name)`
 * from PlanMaterialsPage continue to work unchanged (both just do
 * `panel.locator('a[href]')`).
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { waitForDomStable } = require('../utils/asyncHelpers');
const { PlanMaterialsPage } = require('./planMaterialsPage');

class DrugPage extends PlanMaterialsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options] — same shape as PlanMaterialsPage options
   */
  constructor(page, options = {}) {
    super(page, {
      ...options,
      // Retained on the instance for logging / diagnostics — no longer used
      // for section-heading detection (section is fixed = "Common questions").
      sectionSuffix: options.sectionSuffix || 'Pharmacy and Prescription Benefits Documents',
      logTag:        options.logTag        || 'DRUG',
    });
  }

  // ─── Section location (override) ───────────────────────────────────────

  /**
   * Locate the "Common questions" section wrapper — the new home for the
   * drug documents. Year is unused; the signature is retained for API
   * compatibility with PlanMaterialsPage.
   */
  sectionByYearLocator(/* year */) {
    return this.page
      .locator('div.container', {
        has: this.page.getByRole('heading', { level: 2, name: /^\s*Common\s+questions\s*$/i }),
      })
      .first();
  }

  /**
   * Existence check: the section is present AND it contains an accordion
   * button whose aria-label matches "<year> Pharmacy and Prescription
   * Benefits Documents". Keeps the "does this year have drug documents?"
   * semantics of the plan-materials sectionExists.
   */
  async sectionExists(year) {
    const section = this.sectionByYearLocator();
    const timeout = frameworkConfig.pageLoadWaitMs || 45000;
    try {
      await section.first().waitFor({ state: 'attached', timeout });
    } catch {
      return false;
    }
    const yearBtn = this.yearAccordionButton(section, year);
    return (await yearBtn.count()) > 0;
  }

  // ─── Year-accordion (new) ─────────────────────────────────────────────

  /**
   * The accordion button inside "Common questions" whose aria-label is
   * "<year> Pharmacy and Prescription Benefits Documents". This is the
   * NEW parent that wraps every drug-document sub-section for the year.
   */
  yearAccordionButton(sectionLocator, year) {
    const label = year + ' ' + this.sectionSuffix;
    const escaped = label.replace(/["\\]/g, '\\$&');
    return sectionLocator.locator('button[aria-label="' + escaped + '" i]').first();
  }

  // ─── Accordion handling (override) ─────────────────────────────────────

  /**
   * Expand the year-accordion inside "Common questions", then scope the
   * returned panel to the `<ul>` under the matching `<p><strong>…</strong></p>`
   * heading (accordionLabel — e.g. "Comprehensive Formulary").
   *
   * Return shape matches PlanMaterialsPage.expandAccordion so fixtures /
   * specs need no changes:
   *
   *   section   — the "Common questions" container
   *   container — the year-accordion "card" (used as a scroll anchor)
   *   button    — the year-accordion toggle button
   *   panel     — the `<ul>` immediately following the accordionLabel heading,
   *               scoped so `panel.locator('a[href]')` returns ONLY the
   *               plans for that document sub-section.
   */
  async expandAccordion(year, accordionLabel) {
    const section = await this.scrollToPlanMaterialsSection(year);

    // ── Step 1: locate + expand the year-accordion ─────────────────────
    const yearBtn = this.yearAccordionButton(section, year);
    await yearBtn.waitFor({
      state: 'visible',
      timeout: frameworkConfig.elementInteractionTimeoutMs,
    });
    await yearBtn.scrollIntoViewIfNeeded();

    const initiallyExpanded = (await yearBtn.getAttribute('aria-expanded')) === 'true';
    if (!initiallyExpanded) {
      await yearBtn.click();
      // Poll aria-expanded rather than waitForFunction(elementHandle) so we
      // never operate on a stale handle if the accordion re-renders.
      const pollDeadline = Date.now() + frameworkConfig.elementInteractionTimeoutMs;
      while (Date.now() < pollDeadline) {
        const exp = await yearBtn.getAttribute('aria-expanded').catch(() => null);
        if (exp === 'true') break;
        await this.page.waitForTimeout(100);
      }
    }

    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.animationSettleMs,
      timeoutMs: 4000,
    });

    // ── Step 2: locate the year-accordion's content panel ──────────────
    const panelId = await yearBtn.getAttribute('aria-controls').catch(() => null);
    const yearPanel = panelId
      ? this.page.locator('[id="' + panelId.replace(/"/g, '\\"') + '"]')
      : section.locator('.AccordionHC_accordionContent__8usse').first();
    await yearPanel
      .waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs })
      .catch(() => {});

    // ── Step 3: scope the panel to the document-type sub-section ───────
    // Inside yearPanel each document type is introduced by:
    //   <p><strong>Comprehensive Formulary</strong></p>
    //   <ul> <li><a>…</a></li> … </ul>
    // The <ul> immediately following the matching <p> holds ONLY that
    // sub-section's plan links.
    const target = String(accordionLabel).trim();
    const headingP = yearPanel
      .locator('xpath=.//p[strong[normalize-space(.)=' + JSON.stringify(target) + ']]')
      .first();
    await headingP
      .waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });

    const plansUl = headingP.locator('xpath=./following-sibling::ul[1]');

    // ── Container = the year-accordion "card" wrapper (scroll anchor) ──
    const container = yearBtn.locator(
      'xpath=ancestor::div[contains(@class,"AccordionHC_acc_parent__PozGP")][1]'
    );

    logger.info(this.logTag,
      'Accordion "' + accordionLabel + '" ready under ' + year + ' ' + this.sectionSuffix
      + ' (year-accordion was ' + (initiallyExpanded ? 'already open' : 'just expanded') + ')');

    return { section, container, button: yearBtn, panel: plansUl };
  }
}

module.exports = { DrugPage };

