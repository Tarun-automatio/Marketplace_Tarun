/**
 * PlanMaterialsPage — Page Object for the Molina Medicare "Plan Materials" page.
 *
 * Encapsulates section location, ANOC (or any) accordion expand/collapse
 * behaviour, and dynamic plan-link collection so tests can be written at a
 * business-flow level.
 *
 * Screenshot capture and cookie/pop-up dismissal are delegated to the
 * framework's existing PageCapture utility (pages/HomePage.js) to keep
 * report screenshots consistent across the suite.
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { PageCapture } = require('./HomePage');
const { waitForDomStable } = require('../utils/asyncHelpers');

class PlanMaterialsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options]
   * @param {string[]} [options.consentTexts] — override cookie-consent button texts
   * @param {string}   [options.sectionSuffix] — heading text that follows the
   *   year (default: "Plan Materials"). Override for pages that use a
   *   different section title, e.g. the drug/formulary page which uses
   *   "Pharmacy and Prescription Benefits Documents".
   * @param {string}   [options.logTag] — log category tag (default: "PLAN-MATERIALS")
   */
  constructor(page, options = {}) {
    this.page = page;
    // Section-heading pattern is section-specific; every accordion in the
    // framework so far lives under a "<YEAR> <suffix>" heading.
    this.sectionSuffix = options.sectionSuffix || 'Plan Materials';
    this.logTag        = options.logTag        || 'PLAN-MATERIALS';
    // Reuse PageCapture for cookie / pop-up dismissal + framework screenshot util
    this.capture = new PageCapture(page, {
      consentTexts: options.consentTexts || frameworkConfig.consentButtonTexts || [],
    });
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  /**
   * Open the plan materials URL using the framework's hardened navigation
   * (retries, WAF detection, cookie dismissal, network-idle wait, DOM stability).
   */
  async open(url, timeoutMs) {
    const nav = timeoutMs || frameworkConfig.navigationTimeoutMs;
    await this.capture.open(url, nav, frameworkConfig.waitAfterNetworkIdleMs);
    logger.info(this.logTag, `Opened URL: ${url}`);
  }

  /**
   * Framework-level screenshot: stabilises the DOM, hides fixed elements,
   * dismisses pop-ups and injects a URL bar overlay before saving.
   */
  async saveScreenshot(filePath) {
    try {
      await this.capture.saveScreenshot(filePath);
    } catch (err) {
      logger.warn('SCREENSHOT', `Screenshot failed (${filePath}): ${err.message.substring(0, 120)}`);
      // Fallback to raw Playwright screenshot so the report still has evidence
      try { await this.page.screenshot({ path: filePath, fullPage: true }); } catch { /* ignore */ }
    }
  }

  // ─── Section location ──────────────────────────────────────────────────

  /**
   * Locate the wrapper container for a `<year> <sectionSuffix>` section
   * (e.g. "2027 Plan Materials" or "2027 Pharmacy and Prescription Benefits Documents").
   * Uses the section heading as the anchor and returns the enclosing `.container`.
   */
  sectionByYearLocator(year) {
    const escaped = this.sectionSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow flexible whitespace between year and suffix and inside the suffix itself.
    const suffixPattern = escaped.replace(/\s+/g, '\\s+');
    const label = new RegExp(`^\\s*${year}\\s+${suffixPattern}\\s*$`, 'i');
    return this.page
      .locator('div.container', {
        has: this.page.getByRole('heading', { level: 2, name: label }),
      })
      .first();
  }

  async sectionExists(year) {
    const section = this.sectionByYearLocator(year);
    // Use pageLoadWaitMs (default 45 s) so a slow SSR / hydration doesn't
    // cause spurious "section not present" failures. Kept independent of
    // `elementInteractionTimeoutMs` (which is aimed at click/type actions).
    const timeout = frameworkConfig.pageLoadWaitMs || 45000;
    try {
      await section.first().waitFor({ state: 'attached', timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scroll a `<year> Plan Materials` section into view and wait for DOM stability.
   * @returns the section locator
   */
  async scrollToPlanMaterialsSection(year) {
    const section = this.sectionByYearLocator(year);
    await section.waitFor({ state: 'visible', timeout: frameworkConfig.navigationTimeoutMs });
    await section.scrollIntoViewIfNeeded();
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    return section;
  }

  // ─── Accordion handling ────────────────────────────────────────────────

  /**
   * Find an accordion toggle button *within* a section using either its aria-label
   * or its visible text (case-insensitive substring).
   */
  accordionButton(sectionLocator, accordionLabel) {
    const escaped = accordionLabel.replace(/["\\]/g, '\\$&');
    // Prefer aria-label; fall back to hasText for pages that omit aria-label.
    const byAria = sectionLocator.locator(`button[aria-label*="${escaped}" i]`).first();
    const byText = sectionLocator
      .locator('button.AccordionHC_accordionToggle__Kdd_D, button[aria-controls*="accordion-panel"]')
      .filter({ hasText: new RegExp(escaped.replace(/\s+/g, '\\s+'), 'i') })
      .first();
    // `or` returns the first that resolves — Playwright evaluates lazily
    return byAria.or(byText);
  }

  /**
   * Ensure an accordion is expanded. If already expanded (aria-expanded="true")
   * the click is skipped.
   *
   * @param {string} year — e.g. "2027"
   * @param {string} accordionLabel — e.g. "Annual Notice of Change (ANOC)"
   * @returns {Promise<{
   *   section: import('@playwright/test').Locator,
   *   container: import('@playwright/test').Locator,
   *   button: import('@playwright/test').Locator,
   *   panel: import('@playwright/test').Locator,
   * }>}
   *   • section   — the enclosing `<year> Plan Materials` container
   *   • container — the accordion "card" that wraps the button and panel
   *                 (best target for element-level screenshots)
   *   • button    — the accordion toggle button
   *   • panel     — the expanded content panel (contains the plan links)
   */
  async expandAccordion(year, accordionLabel) {
    const section = await this.scrollToPlanMaterialsSection(year);
    const btn = this.accordionButton(section, accordionLabel);
    await btn.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await btn.scrollIntoViewIfNeeded();

    const initiallyExpanded = (await btn.getAttribute('aria-expanded')) === 'true';
    if (!initiallyExpanded) {
      await btn.click();
      // Poll aria-expanded rather than waitForFunction(elementHandle) so we
      // never operate on a stale handle if the accordion re-renders.
      const pollDeadline = Date.now() + frameworkConfig.elementInteractionTimeoutMs;
      while (Date.now() < pollDeadline) {
        const exp = await btn.getAttribute('aria-expanded').catch(() => null);
        if (exp === 'true') break;
        await this.page.waitForTimeout(100);
      }
    }

    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.animationSettleMs,
      timeoutMs: 4000,
    });

    // Locate the associated content panel via aria-controls, fall back to sibling.
    // Use [id="..."] attribute selector (safe for any id characters — no need for CSS.escape,
    // which is a browser-only API and not available in Node).
    const panelId = await btn.getAttribute('aria-controls').catch(() => null);
    const panel = panelId
      ? this.page.locator(`[id="${panelId.replace(/"/g, '\\"')}"]`)
      : section.locator('.AccordionHC_accordionContent__8usse').first();

    // Locate the enclosing accordion "card" (button + panel) for element-level screenshots.
    // Falls back to the panel itself if the ancestor pattern does not match.
    const container = btn.locator('xpath=ancestor::div[contains(@class,"AccordionHC_acc_parent__PozGP")][1]');

    // Verify the panel is visible & has content
    await panel.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs }).catch(() => {});
    logger.info(this.logTag, `Accordion "${accordionLabel}" expanded${initiallyExpanded ? ' (was already open)' : ''}`);
    return { section, container, button: btn, panel };
  }

  // ─── Plan-link collection ──────────────────────────────────────────────

  /**
   * Dynamically discover every plan link under an expanded accordion panel.
   *
   * Returns:
   *   {
   *     links: Locator,   // full anchor collection (useful for count / re-fetch)
   *     plans: [
   *       {
   *         index,        // 0-based position in the collection
   *         name,         // plan display text (aria-label preferred, then text)
   *         href,         // href attribute value (may be relative)
   *         absoluteUrl,  // fully-resolved URL against the page origin
   *       },
   *     ]
   *   }
   */
  async collectPlanLinks(panelLocator) {
    const links = panelLocator.locator('a[href]');
    const count = await links.count();
    const pageOrigin = this.page.url();
    const plans = [];

    for (let i = 0; i < count; i++) {
      const a = links.nth(i);

      // Read robustly — every getter is guarded so a single stale element
      // never breaks the whole discovery pass.
      const aria = (await a.getAttribute('aria-label').catch(() => '') || '').trim();
      const textRaw = await a.innerText().catch(() => '');
      const text = (textRaw || '').replace(/\s+/g, ' ').trim();
      const href = (await a.getAttribute('href').catch(() => '') || '').trim();
      if (!href) continue;

      const name = aria || text;
      if (!name) continue;

      let absoluteUrl = href;
      try { absoluteUrl = new URL(href, pageOrigin).toString(); } catch { /* keep raw */ }

      plans.push({ index: i, name, href, absoluteUrl });
    }
    logger.info(this.logTag, `Discovered ${plans.length} plan link(s) under accordion`);
    return { links, plans };
  }

  /**
   * Re-fetch a plan link locator by its index. Used before clicking so that
   * we always operate on the freshest handle (defensive against re-render).
   */
  planLinkByIndex(panelLocator, index) {
    return panelLocator.locator('a[href]').nth(index);
  }

  /**
   * Locate a plan link inside the panel by matching its display name.
   * Matching is performed against BOTH the anchor's `aria-label` and its
   * visible text — whichever is provided by the page. Whitespace is
   * collapsed and the comparison is case-insensitive.
   *
   * Prefer this over `planLinkByIndex` when the test is data-driven from an
   * expected-plan list — indexes are fragile if the site ever reorders links.
   *
   * @returns {import('@playwright/test').Locator} locator resolving to the
   *   first matching anchor (call `.count()` first to check for existence).
   */
  planLinkByName(panelLocator, name) {
    const target = String(name || '').replace(/\s+/g, ' ').trim();
    // Prefer aria-label because the DOM stores the full label there;
    // fall back to visible-text matching using Playwright's `hasText` with
    // a case-insensitive regex.
    const escapedForCss = target.replace(/["\\]/g, '\\$&');
    const byAria = panelLocator.locator(`a[href][aria-label="${escapedForCss}" i]`).first();
    const escapedForRegex = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byText = panelLocator
      .locator('a[href]')
      .filter({ hasText: new RegExp(`^\\s*${escapedForRegex}\\s*$`, 'i') })
      .first();
    return byAria.or(byText);
  }
}

module.exports = { PlanMaterialsPage };
