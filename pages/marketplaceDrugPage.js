/**
 * MarketplaceDrugPage — Page Object for the Molina Marketplace
 * Individual & Family Drug page (`/ifp/{state}/drugs`).
 *
 * The page contains several external-site CTAs (Find a pharmacy, Find a
 * provider, mail-order form, formulary, …). Every such link triggers the
 * `ExternalSiteModal` popup with three buttons:
 *   • Continue      → real navigation, opens the URL in a new tab
 *   • Stay on this site → cancels, keeps the user on Molina
 *   • Close (X)     → cancels, keeps the user on Molina
 *
 * This class is intentionally CTA-agnostic — every locator method takes
 * the anchor's `aria-label` so testers can plug in new CTAs from Excel
 * without touching the page-object code. See tests/marketplace/
 * marketplaceDrugPharmacy.spec.js for the driver.
 *
 * Reuses the framework's `MarketplacePage.open()` for the hardened
 * navigation (WAF detection, cookie dismissal, retries, DOM stability).
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { MarketplacePage } = require('./marketplacePage');
const { waitForDomStable } = require('../utils/asyncHelpers');

class MarketplaceDrugPage extends MarketplacePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options]
   * @param {string} [options.logTag] — default "MP-DRUG"
   */
  constructor(page, options = {}) {
    super(page, { ...options, logTag: options.logTag || 'MP-DRUG' });
  }

  // ─── Content-body external CTA link ────────────────────────────────────
  //
  // The Individual & Family drug page has TWO elements with the same
  // aria-label (e.g. "Find a pharmacy"): one in the header mega-menu
  // (`.Megamenu_middle_section__LBaWJ`) and one in the body copy. Testers
  // want the body-copy one — that's the primary member-facing CTA.
  //
  // We scope the locator to elements that are NOT inside the mega-menu
  // container. This works for any current or future CTA on the page.

  /**
   * Locate the body-copy external CTA anchor with the given aria-label.
   * Excludes anchors inside the header mega-menu — those have identical
   * aria-labels but different click semantics (they open the URL directly
   * in a new tab and don't trigger the External Site Modal).
   *
   * @param {string|string[]} ariaLabel — a single label ("Find a pharmacy"),
   *   an array of alternatives, OR a "|"-separated string of alternatives
   *   ("Find a pharmacy|Pharmacy Location"). When multiple labels are
   *   supplied the locator matches an anchor with ANY of them (first hit
   *   in DOM order wins).
   *
   * Matching is CASE-INSENSITIVE and TOLERANT of decorative characters —
   * Molina uses inconsistent aria-label formatting per state:
   *   • NV: aria-label="Find a pharmacy"          (lower-case p)
   *   • NM: aria-label="Find a Pharmacy"          (capital P)
   *   • IL: aria-label="“Find a Pharmacy”"        (wrapped in smart quotes)
   * To handle all of these without needing per-state Excel rows, we lower
   * both sides and use XPath `contains()` instead of `=` so decorative
   * wrapper characters (smart quotes, extra spaces, etc.) don't defeat
   * the match.
   */
  bodyExternalCtaByLabel(ariaLabel) {
    const labels = MarketplaceDrugPage.parseLabels(ariaLabel);
    if (labels.length === 0) {
      throw new Error('bodyExternalCtaByLabel: at least one aria-label is required');
    }
    // XPath 1.0 has no case-insensitive comparator. `translate()` is the
    // portable idiom: map A-Z → a-z on both sides. Then `contains()`
    // absorbs any leading/trailing decorative characters (smart quotes,
    // punctuation) around the human-readable label.
    const ALPHA_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const ALPHA_LOWER = 'abcdefghijklmnopqrstuvwxyz';
    const labelPredicate = labels
      .map(l => {
        const lower = l.toLowerCase();
        return `contains(`
             + `translate(normalize-space(@aria-label),'${ALPHA_UPPER}','${ALPHA_LOWER}'),`
             + `${MarketplaceDrugPage._xpathString(lower)}`
             + `)`;
      })
      .join(' or ');
    return this.page.locator(
      `xpath=//a[${labelPredicate}]`
      + `[not(ancestor::*[contains(@class,"Megamenu")])]`
    ).first();
  }

  /**
   * Normalise a labels argument (string, array, or pipe-separated string)
   * into a de-duplicated array of trimmed non-empty labels.
   * @param {string|string[]} input
   * @returns {string[]}
   */
  static parseLabels(input) {
    if (input === undefined || input === null) return [];
    const raw = Array.isArray(input) ? input : String(input).split('|');
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      const trimmed = String(item).trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
    return out;
  }

  /**
   * Escape an arbitrary string for safe embedding inside an XPath
   * expression. XPath 1.0 has no escape sequence — we must build a
   * concat() call when the value contains both ' and ".
   */
  static _xpathString(str) {
    if (!str.includes("'")) return `'${str}'`;
    if (!str.includes('"')) return `"${str}"`;
    const parts = str.split("'").map(p => `'${p}'`);
    return `concat(${parts.join(",\"'\",")})`;
  }

  /**
   * Scroll a body-copy CTA into view and click it. Returns nothing —
   * caller should immediately wait for the external-site modal to appear.
   *
   * The Marketplace drug page loads a lot of hydration content async; the
   * CTA is typically far below the initial viewport. Uses `waitFor
   * state:'attached'` (not 'visible') with a generous timeout, THEN
   * scrolls into view, then clicks.
   */
  async clickBodyExternalCta(ariaLabel) {
    const link = this.bodyExternalCtaByLabel(ariaLabel);
    // Give the page up to 30s to hydrate and render the CTA anchor into
    // the DOM. Anchors below the initial fold are 'attached' immediately
    // when the SSR content lands but only become 'visible' after scroll.
    await link.waitFor({ state: 'attached', timeout: 30000 });
    await link.scrollIntoViewIfNeeded().catch(() => {});
    // Small stabilisation pause — Molina's page hydrates async and the
    // click interceptor that shows the modal isn't wired until after
    // hydration completes. DOM-stable wait handles this cleanly.
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: 3000,
    });
    await link.click();
    logger.info(this.logTag, `Clicked external CTA "${ariaLabel}"`);
  }

  /**
   * Locate + verify the CTA is present on the page. Returns an object
   * `{ locator, matchedLabel }` once the anchor is attached to the DOM.
   *
   * Many Marketplace state pages (Nevada, Ohio, …) lazy-render body-copy
   * sections using React intersection observers — the "Find a pharmacy"
   * anchor is not in the DOM until its section scrolls into view. To
   * handle this we FIRST scroll through the full page (fast staged
   * scroll), then wait for the anchor to appear.
   *
   * Accepts multi-label input (string, array, or pipe-separated). The
   * returned `matchedLabel` is the exact aria-label the DOM node carries,
   * so evidence steps can record which variant matched (useful when a
   * page has both "Find a pharmacy" and "Pharmacy Location" — same URL,
   * different label).
   *
   * Kept separate from `clickBodyExternalCta` so the test can produce a
   * distinct "CTA located" evidence step before the click.
   */
  async ensureCtaAttached(ariaLabel, { timeoutMs = 30000 } = {}) {
    // Force any lazy sections to hydrate. Cheap (~2s) and fixes the
    // common case where the CTA is in a section rendered only when it
    // enters the viewport.
    await this._primeLazyContent();
    const labels = MarketplaceDrugPage.parseLabels(ariaLabel);
    const link = this.bodyExternalCtaByLabel(labels);
    await link.waitFor({ state: 'attached', timeout: timeoutMs });
    await link.scrollIntoViewIfNeeded().catch(() => {});
    const matchedLabel = (await link.getAttribute('aria-label').catch(() => null))
      || labels[0];
    logger.info(this.logTag,
      `CTA matched aria-label "${matchedLabel}" `
      + `(candidates: ${JSON.stringify(labels)})`);
    return { locator: link, matchedLabel };
  }

  /**
   * Scroll from top to bottom to trigger every intersection-observer-based
   * lazy render. Runs multiple passes and waits for `document.body.scrollHeight`
   * to stabilise between passes — required because Molina's page grows in
   * height as sections hydrate. Returns to the top when done.
   *
   * Private helper — safe to call multiple times.
   */
  async _primeLazyContent() {
    try {
      const anchorsAfter = await this.page.evaluate(async () => {
        const scrollOnce = async () => {
          const step = 500;
          const pause = 150;
          let prevHeight = 0;
          for (let pass = 0; pass < 6; pass += 1) {
            const h = document.documentElement.scrollHeight;
            if (h === prevHeight) return h; // stabilised
            prevHeight = h;
            // eslint-disable-next-line no-await-in-loop
            for (let y = 0; y <= h; y += step) {
              window.scrollTo(0, y);
              // eslint-disable-next-line no-await-in-loop
              await new Promise(r => setTimeout(r, pause));
            }
          }
          return prevHeight;
        };
        await scrollOnce();
        window.scrollTo(0, 0);
        // Diagnostic: count anchors with aria-label containing "pharmacy"
        const matches = [];
        document.querySelectorAll('a[aria-label]').forEach(a => {
          const label = (a.getAttribute('aria-label') || '').trim();
          if (/pharmacy|pharma/i.test(label)) matches.push(label);
        });
        return { totalAnchors: document.querySelectorAll('a').length, pharmacyLabels: matches };
      });
      logger.info(this.logTag,
        `_primeLazyContent: ${anchorsAfter.totalAnchors} anchors on page; `
        + `pharmacy labels: ${JSON.stringify(anchorsAfter.pharmacyLabels)}`);
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: 4000,
      });
    } catch (err) {
      logger.warn(this.logTag, `_primeLazyContent: ${err.message}`);
    }
  }

  // ─── External Site Modal (popup) ───────────────────────────────────────
  //
  // Molina's ExternalSiteModal has these key elements:
  //   .ExternalSiteModal_popup__zWHwO         → container
  //   .ExternalSiteModal_title__oCsjc         → "You are leaving …" heading
  //   .ExternalSiteModal_closeButton__VNZXC   → close (X) button
  //   .ExternalSiteModal_stayButton__RuzPW    → "Stay on this site" button
  //   .ExternalSiteModal_continueButton__94arr → <a> with href, target=_blank
  //
  // The Continue element is an anchor whose href IS the destination URL
  // (it also carries `data-skip-external-modal="true"` so the click
  // interceptor lets the navigation proceed).

  externalSiteModal() {
    return this.page.locator(
      '[class*="ExternalSiteModal_popup"]'
    ).first();
  }

  modalCloseButton() {
    return this.externalSiteModal().locator(
      '[class*="ExternalSiteModal_closeButton"], button[aria-label="close" i]'
    ).first();
  }

  modalStayButton() {
    return this.externalSiteModal().locator(
      '[class*="ExternalSiteModal_stayButton"], button[aria-label*="Stay on this site" i]'
    ).first();
  }

  modalContinueLink() {
    return this.externalSiteModal().locator(
      '[class*="ExternalSiteModal_continueButton"], a[aria-label*="Continue" i]'
    ).first();
  }

  /**
   * Wait for the external-site modal to be fully rendered + interactive.
   * Also validates the Continue link is present so downstream reads/clicks
   * don't race the render, AND scrolls the modal container into view so
   * subsequent screenshots capture it.
   *
   * NOTE on layout: Molina renders `.ExternalSiteModal_popup__…` as a
   * child of <body> (not `position: fixed`). If the caller was scrolled
   * down to click a CTA far below the fold, the modal renders at page-top
   * and is OFF-SCREEN. `scrollIntoViewIfNeeded()` brings it back so
   * evidence screenshots actually show the popup.
   */
  async waitForExternalSiteModal(timeout) {
    const t = Number.isFinite(timeout) ? timeout : frameworkConfig.elementInteractionTimeoutMs;
    const modal = this.externalSiteModal();
    await modal.waitFor({ state: 'visible', timeout: t });
    await this.modalContinueLink().waitFor({ state: 'visible', timeout: t });
    // Bring the modal into the current viewport so screenshots capture it
    // regardless of where the triggering CTA lived on the page. Silently
    // ignored when the modal is already in view.
    await modal.scrollIntoViewIfNeeded().catch(() => {});
    logger.info(this.logTag, 'External site modal is visible');
  }

  /**
   * Read the Continue anchor's `href` attribute. This is the URL that will
   * be opened in a new tab when Continue is clicked — captured BEFORE the
   * click so the test can compare it against the actual new-tab URL after
   * redirects settle.
   *
   * @returns {Promise<string>} absolute or relative URL
   */
  async getContinueHref() {
    const link = this.modalContinueLink();
    const href = await link.getAttribute('href');
    const trimmed = (href || '').trim();
    logger.info(this.logTag, `Continue href = ${trimmed || '(empty)'}`);
    return trimmed;
  }

  /**
   * Click Continue in the modal and capture the new tab that opens.
   * Waits for the new tab's redirect chain to settle so `newPage.url()`
   * returns the FINAL landed URL (not the intermediate 302 URLs).
   *
   * @param {import('@playwright/test').BrowserContext} context
   * @param {object} [opts]
   * @param {number} [opts.newTabTimeoutMs]     — wait for `page` event (default: config.pageLoadWaitMs)
   * @param {number} [opts.redirectSettleMs]    — wait for load+networkidle (default: config.marketplacePharmacy.newTabRedirectWaitMs)
   * @returns {Promise<{ newPage, url, error }>} — url = final URL after redirects, error = string when new tab didn't open
   */
  async clickContinueAndCaptureNewTab(context, opts = {}) {
    const newTabTimeoutMs  = Number.isFinite(opts.newTabTimeoutMs)
      ? opts.newTabTimeoutMs  : frameworkConfig.pageLoadWaitMs;
    const redirectSettleMs = Number.isFinite(opts.redirectSettleMs)
      ? opts.redirectSettleMs : (frameworkConfig.marketplacePharmacy?.newTabRedirectWaitMs || 15000);

    const link = this.modalContinueLink();
    await link.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });

    // Race the click with the `page` event so we catch the new tab even
    // when it opens quickly.
    // `noWaitAfter: true` is critical here — the Continue anchor is
    // `target="_blank"` but Playwright still waits for any post-click
    // network activity on the CURRENT page by default. Some Molina
    // interstitials fire analytics XHRs on click that never resolve,
    // hanging the click promise for the full test timeout. Skipping the
    // post-click wait lets the promise resolve as soon as the click
    // is dispatched.
    const [maybePage] = await Promise.all([
      context.waitForEvent('page', { timeout: newTabTimeoutMs }).catch(() => null),
      link.click({ noWaitAfter: true }),
    ]);

    if (!maybePage) {
      return { newPage: null, url: '', error: `No new tab opened within ${newTabTimeoutMs}ms after clicking Continue.` };
    }

    // Wait for the redirect chain to settle. Caremark's entry URL typically
    // 302s to a session-token URL then to the final search page — both
    // load + networkidle handle this cleanly.
    try { await maybePage.waitForLoadState('load',        { timeout: redirectSettleMs }); } catch { /* ignore */ }
    try { await maybePage.waitForLoadState('networkidle', { timeout: redirectSettleMs }); } catch { /* ignore */ }

    const finalUrl = maybePage.url();
    logger.info(this.logTag, `New tab settled at final URL: ${finalUrl}`);
    return { newPage: maybePage, url: finalUrl, error: '' };
  }

  /**
   * Dismiss the external-site modal via the Close (X) button.
   * No-op when the modal isn't visible. Provided for future tests that
   * want to verify the Close path.
   */
  async dismissModalViaClose() {
    const modal = this.externalSiteModal();
    if (!(await modal.isVisible({ timeout: 1500 }).catch(() => false))) {
      logger.info(this.logTag, 'External site modal not visible — no dismiss needed');
      return;
    }
    await this.modalCloseButton().click({ timeout: frameworkConfig.elementInteractionTimeoutMs });
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    logger.info(this.logTag, 'External site modal dismissed via Close (X)');
  }

  /**
   * Dismiss the external-site modal via the "Stay on this site" button.
   * No-op when the modal isn't visible. Provided for future tests that
   * want to verify the Stay path.
   */
  async dismissModalViaStay() {
    const modal = this.externalSiteModal();
    if (!(await modal.isVisible({ timeout: 1500 }).catch(() => false))) {
      logger.info(this.logTag, 'External site modal not visible — no dismiss needed');
      return;
    }
    await this.modalStayButton().click({ timeout: frameworkConfig.elementInteractionTimeoutMs });
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    logger.info(this.logTag, 'External site modal dismissed via Stay on this site');
  }

  // ─── URL helpers (static — usable without a page instance) ─────────────

  /**
   * Build the full drug-page URL for a state. Uses the config template
   * `marketplacePharmacy.urls.template` with `{state}` substituted (lower-cased).
   *
   * @param {string} state — 2-letter code (nv, oh, ca, …)
   * @returns {string} absolute URL
   */
  static urlForState(state) {
    const s = String(state || '').trim().toLowerCase();
    const template = frameworkConfig.marketplacePharmacy?.urls?.template
      || 'https://pws-q3.molinahealthcare.com/ifp/{state}/drugs';
    return template.replace(/\{state\}/gi, s);
  }
}

module.exports = { MarketplaceDrugPage };
