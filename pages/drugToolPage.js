/**
 * DrugToolPage — Page Object for the Molina Marketplace "Drug Search Tool"
 * component on the Individual & Family Drug page (`/ifp/{state}/drugs`).
 *
 * Page anatomy (see docs/reference/pageHtml's/MarketPlaceDrugPage.html):
 *   • The live page can host TWO tool sections — "2027 Drug Search Tool"
 *     and "2026 Drug Search Tool" — each a `PageBanner` block containing:
 *       - <h2 class="PageBanner_title…">{year} Drug Search Tool</h2>
 *       - <select class="Dropdown_dropdownSelect…"> with one <option>
 *         per plan. Each option carries:
 *             value    = plan marketing name (e.g. "Silver 70 HMO")
 *             data-url = the CVS Caremark drug-search URL for that plan
 *         plus a placeholder <option value="">Select your plan</option>.
 *       - <a aria-label="Search Drug Coverage"> button.
 *   • Header language toggle:
 *       <span class="LanguageSelector_selectedLang…">EN|ES</span>
 *   • Selecting a plan + clicking "Search Drug Coverage" opens Molina's
 *     ExternalSiteModal ("You are leaving the Molina Healthcare website")
 *     whose Continue link navigates to the plan's CVS URL in a new tab.
 *
 * This class extends MarketplaceDrugPage so it inherits the hardened
 * navigation (`open`), screenshot pipeline, and — crucially — the entire
 * External Site Modal handling (waitForExternalSiteModal, getContinueHref,
 * clickContinueAndCaptureNewTab, dismissModalViaClose, …).
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { MarketplaceDrugPage } = require('./marketplaceDrugPage');
const { waitForDomStable } = require('../utils/asyncHelpers');

const DT = frameworkConfig.drugTool || {};

class DrugToolPage extends MarketplaceDrugPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options]
   */
  constructor(page, options = {}) {
    super(page, { ...options, logTag: options.logTag || 'DRUG-TOOL' });
  }

  // ─── URL building ──────────────────────────────────────────────────────

  /**
   * Build the Drug page URL for a state + language. Spanish inserts the
   * configured `esPrefix` (default `/es-us`) right after the origin.
   *
   * @param {string} state    — 2-letter code (ca, id, nv, …)
   * @param {string} language — 'en' | 'es'
   * @returns {string} absolute URL
   */
  static urlFor(state, language) {
    const s = String(state || '').trim().toLowerCase();
    const template = (DT.urls && DT.urls.template)
      || 'https://uat-pws.molinahealthcare.com/ifp/{state}/drugs';
    const base = template.replace(/\{state\}/gi, s);
    if (String(language || 'en').toLowerCase() !== 'es') return base;

    const prefix = (DT.urls && DT.urls.esPrefix) || '/es-us';
    try {
      const u = new URL(base);
      const clean = String(prefix).replace(/\/+$/, '');
      if (!u.pathname.toLowerCase().startsWith(`${clean.toLowerCase()}/`)) {
        u.pathname = `${clean}${u.pathname}`;
      }
      return u.toString();
    } catch {
      return base;
    }
  }

  /**
   * Navigate to the Drug page for the given state + language and wait for
   * the tool section to render.
   */
  async gotoDrugTool(state, language) {
    const url = DrugToolPage.urlFor(state, language);
    await this.open(url);
    logger.info(this.logTag, `Opened Drug Tool: ${url}`);
    return url;
  }

  // ─── Language selector ─────────────────────────────────────────────────

  /**
   * Read the header language selector's current value ("EN" / "ES").
   * Returns '' when the control isn't present.
   */
  async getSelectedLanguage() {
    const loc = this.page.locator('[class*="LanguageSelector_selectedLang"]').first();
    if (!(await loc.count().catch(() => 0))) return '';
    const txt = await loc.textContent().catch(() => '');
    return String(txt || '').trim().toUpperCase();
  }

  // ─── Tool section resolution ───────────────────────────────────────────

  /**
   * Resolve the Drug Search Tool <select> for the requested plan year and
   * tag it + its "Search Drug Coverage" button in the DOM with stable
   * markers (`data-dt-select` / `data-dt-search`) so subsequent Playwright
   * interactions aren't sensitive to hashed CSS-module class names.
   *
   * Picks the tool section whose nearest heading contains `year`
   * (e.g. "2027"); falls back to the first plan <select> on the page.
   *
   * @param {string} year — e.g. "2027"
   * @returns {Promise<{ found:boolean, heading:string,
   *   options:Array<{value:string,text:string,dataUrl:string}> }>}
   */
  async resolveToolSection(year) {
    const yr = String(year || '').trim();
    const result = await this.page.evaluate((yearStr) => {
      const headingFor = (el) => {
        let node = el;
        for (let i = 0; i < 7 && node; i += 1) {
          node = node.parentElement;
          if (!node) break;
          const h = node.querySelector('h1, h2, h3');
          if (h && h.textContent && h.textContent.trim()) return h.textContent.trim();
        }
        return '';
      };

      // Candidate plan dropdowns: scoped class first, then any <select>
      // that has a plan-bearing option (data-url present).
      let selects = Array.from(document.querySelectorAll('select[class*="Dropdown_dropdownSelect"]'));
      if (!selects.length) {
        selects = Array.from(document.querySelectorAll('select')).filter((s) =>
          Array.from(s.options).some((o) => o.getAttribute('data-url')));
      }
      if (!selects.length) return { found: false, heading: '', options: [] };

      const chosen = selects.find((s) => headingFor(s).includes(yearStr)) || selects[0];
      // Clear any stale markers from a previous plan/section resolution.
      document.querySelectorAll('[data-dt-select]').forEach((n) => n.removeAttribute('data-dt-select'));
      document.querySelectorAll('[data-dt-search]').forEach((n) => n.removeAttribute('data-dt-search'));
      chosen.setAttribute('data-dt-select', '1');

      // The Search CTA lives in a `PageBanner_search_block` a few levels
      // ABOVE the <select> (outside the inner `PageBanner_selectdropdown`
      // wrapper), and its aria-label localizes ("Search Drug Coverage" /
      // "Buscar cobertura de medicamentos"). Climb PageBanner-scoped
      // ancestors and take the search anchor there. Scoping to PageBanner
      // avoids grabbing hidden header-megamenu CTAs that also contain the
      // word "Buscar" (those are display:none → never clickable → timeout).
      // The Search CTA is the single Button anchor inside the
      // `PageBanner_search_block` ancestor of the <select>. Its aria-label
      // localizes — and on some state pages is even mislabeled (CA/ES shows
      // "Seleccione su plan." instead of "Buscar cobertura…") — so we match
      // it STRUCTURALLY (the block's Button-text anchor) rather than by text.
      let btn = null;
      let node = chosen.parentElement;
      for (let i = 0; i < 10 && node && !btn; i += 1) {
        if (/PageBanner_search_block/.test(String(node.className || ''))) {
          btn = Array.from(node.querySelectorAll('a')).find((a) => a.querySelector('[class*="Button_link_text"]'))
             || node.querySelector('a[href="/"]')
             || node.querySelector('a');
        }
        node = node.parentElement;
      }
      // Fallback — first PageBanner ancestor carrying the labelled CTA.
      if (!btn) {
        node = chosen.parentElement;
        for (let i = 0; i < 10 && node && !btn; i += 1) {
          if (/PageBanner/.test(String(node.className || ''))) {
            btn = node.querySelector('a[aria-label*="Search Drug Coverage" i]')
               || node.querySelector('a[aria-label*="Buscar cobertura" i]')
               || Array.from(node.querySelectorAll('a')).find((a) => a.querySelector('[class*="Button_link_text"]'))
               || null;
          }
          node = node.parentElement;
        }
      }
      if (!btn) {
        // Visible-only global fallback — never pick a hidden megamenu anchor.
        const all = Array.from(document.querySelectorAll(
          'a[aria-label*="Search Drug Coverage" i], a[aria-label*="Buscar cobertura" i]'));
        btn = all.find((a) => a.offsetParent !== null) || all[0] || null;
      }
      if (btn) btn.setAttribute('data-dt-search', '1');

      const options = Array.from(chosen.options)
        .filter((o) => String(o.value || '').trim() !== '')
        .map((o) => ({
          value:   o.value,
          text:    (o.textContent || '').trim(),
          dataUrl: o.getAttribute('data-url') || '',
        }));

      return { found: true, heading: headingFor(chosen), options };
    }, yr);

    logger.info(this.logTag,
      `resolveToolSection("${yr}"): found=${result.found} `
      + `heading="${result.heading}" options=${result.options.length}`);
    return result;
  }

  planSelect() {
    return this.page.locator('select[data-dt-select="1"]').first();
  }

  searchButton() {
    return this.page.locator('[data-dt-search="1"]').first();
  }

  /**
   * Scroll the tool section into view (for evidence screenshots) and wait
   * for the DOM to settle.
   */
  async scrollToolIntoView() {
    const sel = this.planSelect();
    await sel.scrollIntoViewIfNeeded().catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: 3000,
    });
  }

  /**
   * Select a plan by its marketing name (option value) then click the
   * "Search Drug Coverage" button. Falls back to matching the option by
   * visible label when the exact value isn't found.
   *
   * @param {string} planName
   */
  async selectPlanAndSearch(planName) {
    const select = this.planSelect();
    await select.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await select.scrollIntoViewIfNeeded().catch(() => {});
    // Explicit timeout — <select>.selectOption() otherwise inherits the
    // global action timeout (0 = wait forever), which would hang the whole
    // run if the plan option isn't present. Callers should pre-check
    // presence; this is a safety net.
    const selTimeout = frameworkConfig.elementInteractionTimeoutMs || 15000;
    try {
      await select.selectOption({ value: planName }, { timeout: selTimeout });
    } catch {
      await select.selectOption({ label: planName }, { timeout: selTimeout });
    }
    logger.info(this.logTag, `Selected plan "${planName}"`);
    await waitForDomStable(this.page, { stableMs: frameworkConfig.domStableMs, timeoutMs: 2000 });

    const btn = this.searchButton();
    await btn.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click();
    logger.info(this.logTag, 'Clicked "Search Drug Coverage"');
  }

  /**
   * Read the `data-url` attribute of a plan's <option> directly from the
   * DOM — the authoritative destination URL the page would open for that
   * plan. Returns '' when the plan isn't present.
   */
  async optionDataUrl(planName) {
    return this.page.evaluate((name) => {
      const sel = document.querySelector('select[data-dt-select="1"]')
        || document.querySelector('select[class*="Dropdown_dropdownSelect"]');
      if (!sel) return '';
      const opt = Array.from(sel.options).find(
        (o) => (o.value || '').trim() === name || (o.textContent || '').trim() === name);
      return opt ? (opt.getAttribute('data-url') || '') : '';
    }, planName);
  }
}

module.exports = { DrugToolPage };
