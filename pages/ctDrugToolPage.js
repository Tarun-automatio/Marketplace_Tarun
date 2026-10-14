/**
 * CtDrugToolPage — Page Object for the ConnectiCare (CT) Drug Lookup Tool.
 *
 * Flow (QA: https://pws-d1.bnd.molinahealthcare.com/):
 *   1. Home loads (ConnectiCare members site).
 *   2. Top-nav "Member Resources" button → opens the mega-menu.
 *   3. Under Pharmacy, the "Search Drugs" dropdown button opens an inline
 *      popup titled "Select your plan to look up covered drugs" containing
 *      two native <select>s:
 *         • Year  — options: Year / 2026 / 2027
 *         • Plan  — populated AFTER a year is chosen; each <option>'s
 *                   value AND data-href is the CVS Caremark drug-search URL.
 *
 * Selecting a plan routes the member to the external Caremark drug-search
 * site. For deterministic evidence we capture the selected option's URL and
 * open it in a new tab (the destination is identical to the member flow).
 *
 * Extends MarketplacePage for hardened navigation (`open`), cookie dismissal
 * (`acceptCookies`) and the framework screenshot pipeline (`saveScreenshot`).
 * All ConnectiCare-specific locators live here (the base class's
 * `memberResourcesButton` targets Molina's DOM, not ConnectiCare's).
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { MarketplacePage } = require('./marketplacePage');
const { waitForDomStable } = require('../utils/asyncHelpers');

const CT = frameworkConfig.ctDrugTool || {};

class CtDrugToolPage extends MarketplacePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options]
   * @param {string} [options.language] 'en' | 'es'
   */
  constructor(page, options = {}) {
    super(page, { ...options, logTag: options.logTag || 'CT-DRUG' });
    this.language = String(options.language || 'en').toLowerCase();
  }

  /** Absolute home URL for a language (ES served under `esPath`, e.g. /es-US). */
  static urlForLanguage(language) {
    const base = String(CT.url || '').replace(/\/+$/, '');
    return String(language || 'en').toLowerCase() === 'es'
      ? `${base}${CT.esPath || '/es-US'}`
      : (CT.url || `${base}/`);
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  /** Open the ConnectiCare home page with a plain, non-aggressive navigation.
   *  The framework's `open()`/screenshot pipeline is tuned for Molina and its
   *  generic popup/CTA dismissal clicks the "Brokers" link here (redirecting
   *  to /brokers), so we deliberately avoid it. */
  async gotoHome(url) {
    const target = url || CtDrugToolPage.urlForLanguage(this.language);
    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: frameworkConfig.navigationTimeoutMs });
    await this.page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await this.dismissCookieBanner().catch(() => {});
    logger.info(this.logTag, `Opened ConnectiCare home (${this.language}): ${target}`);
    return target;
  }

  /** Targeted cookie-banner accept (does NOT click page CTAs). */
  async dismissCookieBanner() {
    const btn = this.page.locator(
      '#onetrust-accept-btn-handler, '
      + '[id*="onetrust" i] button:has-text("Accept"), '
      + '[class*="cookie" i] button:has-text("Accept"), '
      + 'button:has-text("Accept All Cookies"), '
      + 'button:has-text("Accept Cookies")',
    ).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      logger.info(this.logTag, 'Cookie banner accepted (targeted)');
    }
  }

  /** Poll until the Member Resources nav button hydrates + becomes visible. */
  async waitForMemberResources(timeout = 25000) {
    await this.openMobileNavIfNeeded().catch(() => {});
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.isMemberResourcesVisible()) return true;
      await this.openMobileNavIfNeeded().catch(() => {});
      await this.page.waitForTimeout(500);
    }
    return false;
  }

  /** On mobile the top nav collapses into a hamburger; open it so the Member
   *  Resources item is reachable. No-op on desktop (hamburger not visible). */
  async openMobileNavIfNeeded() {
    if (await this.isMemberResourcesVisible()) return;
    const ham = this.page.locator('[class*="hamburger_section"] button, button[class*="hamburger"]').first();
    if (await ham.isVisible({ timeout: 1200 }).catch(() => false)) {
      await ham.click({ timeout: 4000 }).catch(() => {});
      await this.page.waitForTimeout(800);
      logger.info(this.logTag, 'Opened mobile hamburger nav');
    }
  }

  // ─── Member Resources mega-menu ────────────────────────────────────────

  /** The top-nav Member Resources trigger (EN "Member Resources" /
   *  ES "Recursos para miembros"). */
  ctMemberResourcesButton() {
    return this.page.getByRole('button', { name: /member resources|recursos para miembros/i });
  }

  /** True when the Member Resources trigger is present/visible. */
  async isMemberResourcesVisible() {
    const loc = this.ctMemberResourcesButton();
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
  }

  /** Click the Member Resources trigger to open the mega-menu. */
  async openMemberResources() {
    await this.openMobileNavIfNeeded().catch(() => {});
    const loc = this.ctMemberResourcesButton();
    const count = await loc.count().catch(() => 0);
    let btn = loc.first();
    for (let i = 0; i < count; i += 1) {
      if (await loc.nth(i).isVisible().catch(() => false)) { btn = loc.nth(i); break; }
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: frameworkConfig.elementInteractionTimeoutMs });
    await this.page.waitForTimeout(600);
    logger.info(this.logTag, 'Opened Member Resources mega-menu');
  }

  // ─── Search Drugs popup (Year + Plan selects) ──────────────────────────

  /** The wrapper that holds the Search Drugs toggle + Year/Plan selects
   *  (EN "Search Drugs" / ES "Busqueda de Medicinas"). */
  searchDrugsWrapper() {
    return this.page
      .locator('div[class*="dropdownMenuWrapper"]')
      .filter({ hasText: /search drugs|b[uú]squeda de medicinas/i })
      .first();
  }

  /** The "Search Drugs" dropdown toggle button. */
  searchDrugsToggle() {
    return this.searchDrugsWrapper()
      .locator('button[class*="dropdownMenuButton"]')
      .first();
  }

  /** Popup title element ("Select your plan to look up covered drugs"). */
  popupTitle() {
    return this.searchDrugsWrapper().locator('[class*="dropdownMenuTitle"]').first();
  }

  /** Expand the Search Drugs popup (no-op if already expanded). */
  async openSearchDrugs() {
    const toggle = this.searchDrugsToggle();
    await toggle.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await toggle.scrollIntoViewIfNeeded().catch(() => {});
    const expanded = await toggle.getAttribute('aria-expanded').catch(() => null);
    if (expanded !== 'true') {
      await toggle.click();
    }
    await this.yearSelect()
      .waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs })
      .catch(() => {});
    logger.info(this.logTag, 'Opened Search Drugs popup');
  }

  /** Both native selects inside the Search Drugs popup (0=Year, 1=Plan). */
  dropdownSelects() {
    return this.searchDrugsWrapper().locator('select[class*="dropdownSelect"]');
  }

  yearSelect() { return this.dropdownSelects().nth(0); }
  planSelect() { return this.dropdownSelects().nth(1); }

  /** True when the Year/Plan selects are visible (popup open). */
  async isPopupOpen() {
    return this.yearSelect().isVisible({ timeout: 2500 }).catch(() => false);
  }

  /** Re-open Member Resources → Search Drugs if the popup has collapsed. */
  async ensureSearchDrugsOpen() {
    if (await this.isPopupOpen()) return;
    await this.openMemberResources();
    await this.openSearchDrugs();
  }

  /**
   * Raw viewport screenshot that does NOT run the framework's popup-dismissal
   * pipeline — used for the Search Drugs popup steps so the open dropdown is
   * preserved in the evidence instead of being auto-dismissed.
   */
  async rawShot(filePath) {
    try {
      await this.page.screenshot({ path: filePath, fullPage: false });
    } catch (err) {
      logger.warn(this.logTag, `rawShot failed (${filePath}): ${err.message.substring(0, 120)}`);
    }
  }

  /** Select a plan year (e.g. "2027") and wait for the plan list to populate. */
  async selectYear(year) {
    const sel = this.yearSelect();
    await sel.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await sel.selectOption(String(year), { timeout: frameworkConfig.elementInteractionTimeoutMs });
    await waitForDomStable(this.page, { stableMs: frameworkConfig.domStableMs, timeoutMs: 3000 });
    logger.info(this.logTag, `Selected year ${year}`);
  }

  /** The year currently selected ("" when none). */
  async getSelectedYear() {
    return this.yearSelect()
      .evaluate((s) => ((s.options[s.selectedIndex] || {}).value || '').trim())
      .catch(() => '');
  }

  /**
   * Read the real plan options (placeholder/disabled excluded).
   * @returns {Promise<Array<{text:string,url:string,dataHref:string}>>}
   */
  async getPlanOptions() {
    const sel = this.planSelect();
    await sel.waitFor({ state: 'attached', timeout: frameworkConfig.elementInteractionTimeoutMs });
    return sel.evaluate((s) => [...s.options]
      .filter((o) => !o.disabled && (o.textContent || '').trim() && (o.textContent || '').trim().toLowerCase() !== 'plan')
      .map((o) => ({
        text: (o.textContent || '').trim(),
        url: (o.value || '').trim(),
        dataHref: (o.getAttribute('data-href') || '').trim(),
      })));
  }

  /**
   * Select a plan by its visible name; returns the selected option's URL info.
   * @param {string} planName
   * @returns {Promise<{text:string,url:string,dataHref:string}>}
   */
  async selectPlan(planName) {
    const sel = this.planSelect();
    await sel.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await sel.scrollIntoViewIfNeeded().catch(() => {});
    await sel.selectOption({ label: planName }, { timeout: frameworkConfig.elementInteractionTimeoutMs });
    await this.page.waitForTimeout(300);
    const info = await sel.evaluate((s) => {
      const o = s.options[s.selectedIndex];
      return o
        ? { text: (o.textContent || '').trim(), url: (o.value || '').trim(), dataHref: (o.getAttribute('data-href') || '').trim() }
        : null;
    });
    logger.info(this.logTag, `Selected plan "${planName}" → ${info && info.url ? info.url : '(no url)'}`);
    return info || { text: planName, url: '', dataHref: '' };
  }

  /**
   * Open a captured plan (Caremark) URL in a NEW tab and let redirects settle.
   * @param {import('@playwright/test').BrowserContext} context
   * @param {string} url
   * @param {object} [opts]
   * @returns {Promise<{ newPage, url, error }>}
   */
  async openPlanUrlInNewTab(context, url, opts = {}) {
    const redirectSettleMs = Number.isFinite(opts.redirectSettleMs)
      ? opts.redirectSettleMs : (CT.newTabRedirectWaitMs || 15000);
    if (!url) return { newPage: null, url: '', error: 'No plan URL to open' };
    let newPage = null;
    try {
      newPage = await context.newPage();
      await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: frameworkConfig.pageLoadWaitMs });
      try { await newPage.waitForLoadState('load', { timeout: redirectSettleMs }); } catch { /* ignore */ }
      try { await newPage.waitForLoadState('networkidle', { timeout: redirectSettleMs }); } catch { /* ignore */ }
      return { newPage, url: newPage.url(), error: '' };
    } catch (err) {
      return {
        newPage,
        url: newPage ? newPage.url() : '',
        error: (err && err.message ? err.message : String(err)).substring(0, 200),
      };
    }
  }

  /**
   * Best-effort: type a drug term into the external Caremark search box and
   * submit. The Caremark tool is member-login gated, so this never throws —
   * it returns whether a search input was found + used (informational).
   * @param {import('@playwright/test').Page} extPage
   * @param {string} term
   */
  async tryDrugSearch(extPage, term) {
    if (!extPage || !term) return { attempted: false, searched: false, note: 'no page/term' };
    try {
      const input = extPage.locator(
        'input[type="search"], input[name*="drug" i], input[placeholder*="drug" i], input[aria-label*="drug" i], input[placeholder*="search" i]'
      ).first();
      if (!(await input.isVisible({ timeout: 4000 }).catch(() => false))) {
        return { attempted: true, searched: false, note: 'No drug search input on external site (likely requires member login)' };
      }
      await input.fill(term, { timeout: 4000 });
      await input.press('Enter').catch(() => {});
      await extPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      return { attempted: true, searched: true, note: `Entered "${term}" into external drug search` };
    } catch (err) {
      return { attempted: true, searched: false, note: (err && err.message ? err.message : String(err)).substring(0, 150) };
    }
  }
}

module.exports = { CtDrugToolPage };
