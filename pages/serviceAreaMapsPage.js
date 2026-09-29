/**
 * ServiceAreaMapsPage — Page Object for the
 * "View Marketplace Service Area Maps by State" component (US: MP-SAM-001).
 *
 * Lives on the Brokers & Agents → Molina Healthcare page. The component
 * shows an approved heading + description, a state dropdown (placeholder
 * "Select a State"), and — only after a state is chosen — an inline
 * Service Area Map image directly below the component (no modal / popup /
 * new tab / download).
 *
 * Design notes (framework reuse — no new patterns introduced):
 *   • Delegates cookie / pop-up dismissal, hardened navigation and the
 *     framework-style `saveScreenshot` to the existing `PageCapture`
 *     helper (pages/HomePage.js) — same as MarketplacePage / DrugPage.
 *   • Locators use accessible role / name / text first (the approved
 *     verbiage is stable business copy), with CSS fallbacks that are safe
 *     to tighten once the real DOM is confirmed.
 *   • All waits use `waitForDomStable` / framework timeouts from
 *     `config/framework.config.js` — no arbitrary sleeps.
 *   • All logging goes through the shared `logger` with a SERVICE_AREA_MAPS tag.
 *
 * NOTE (selectors): confirmed against the live pws-d1 DOM. The component is
 * the `MapPageBanner` block; the dropdown is a native <select> with option
 * values = 2-letter state codes; the map is an <img> inside
 * `MapPageBanner_stateImageContainer` whose `alt` is the state code and
 * whose `src` is the approved image. Class hashes (e.g. `__K5iD`) may change
 * on a front-end rebuild, so locators match on the stable class prefix.
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { PageCapture } = require('./HomePage');
const { waitForDomStable } = require('../utils/asyncHelpers');

class ServiceAreaMapsPage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options]
   * @param {string[]} [options.consentTexts] — override cookie-consent button texts
   * @param {string}   [options.logTag] — log category tag (default: "SERVICE_AREA_MAPS")
   */
  constructor(page, options = {}) {
    this.page = page;
    this.logTag = options.logTag || 'SERVICE_AREA_MAPS';
    this.capture = new PageCapture(page, {
      consentTexts: options.consentTexts || frameworkConfig.consentButtonTexts || [],
    });
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  /**
   * Open the Brokers & Agents page that hosts the Service Area Maps
   * component, using the framework's hardened navigation (retries, WAF
   * detection, cookie dismissal, network-idle wait, DOM stability).
   */
  async open(url, timeoutMs) {
    const nav = timeoutMs || frameworkConfig.navigationTimeoutMs;
    await this.capture.open(url, nav, frameworkConfig.waitAfterNetworkIdleMs);
    logger.info(this.logTag, `Opened URL: ${url}`);
  }

  /**
   * Lightweight framework-style screenshot. The generic
   * `PageCapture.saveScreenshot` flow (aggressive popup dismissal + video
   * freeze + URL-bar overlay) stalls on this page once the large state map
   * renders, so we hide the cookie/modal banners via CSS and take a plain
   * viewport screenshot instead.
   *
   * @param {string} filePath
   * @param {object} [options]
   * @param {'component'|'map'} [options.focus] — element to scroll into view
   *   (centered) immediately before capture so the screenshot frames it.
   */
  async saveScreenshot(filePath, options = {}) {
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await this.page.evaluate(() => {
        const hide = (el) => {
          try {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
          } catch { /* ignore */ }
        };
        document.querySelectorAll(
          '[class*="CookiesBanner"], [class^="ExternalSiteModal_"], '
          + '[class*="ExternalSiteModal_popup"]'
        ).forEach(hide);
      }).catch(() => {});
      // Scroll the target into view LAST so the viewport screenshot frames it.
      if (options.focus === 'map') {
        await this.mapImage()
          .evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
          .catch(() => {});
      } else if (options.focus === 'component') {
        await this.component()
          .evaluate(el => el.scrollIntoView({ block: 'start', inline: 'nearest' }))
          .catch(() => {});
      }
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });
      await this.page.screenshot({ path: filePath, fullPage: false });
    } catch (err) {
      logger.warn('SCREENSHOT', `Screenshot failed (${filePath}): ${err.message.substring(0, 120)}`);
    }
  }

  // ─── Component locators ──────────────────────────────────────────────────

  /**
   * The Service Area Maps component root (the `MapPageBanner` block).
   * Matched on the stable class prefix so it survives hash changes.
   */
  component() {
    return this.page.locator('[class*="MapPageBanner_midPageBanner_Wrapper"]').first();
  }

  /** The component heading (role=heading with the approved name). */
  heading() {
    return this.page.getByRole('heading', {
      name: /View Marketplace Service Area Maps by State/i,
    }).first();
  }

  /** The approved description paragraph, matched by its leading copy. */
  description() {
    return this.page.locator('[class*="MapPageBanner_lower"]').first();
  }

  /**
   * The state dropdown — a native <select> (option values are 2-letter
   * state codes; the placeholder option value is empty).
   */
  dropdown() {
    return this.page.locator(
      'select[class*="Dropdown_dropdownSelect"], select[aria-label="Select state" i]'
    ).first();
  }

  /**
   * The inline Service Area Map image rendered below the component after a
   * selection (inside `MapPageBanner_stateImageContainer`).
   */
  mapImage() {
    return this.page.locator('[class*="MapPageBanner_stateImageContainer"] img').first();
  }

  /**
   * The "map unavailable" message shown when a selected state has no map
   * (rendered in place of the image container, e.g. Illinois).
   */
  noMapMessage() {
    return this.page.locator(
      'text=/Service Area Map is currently unavailable for the selected state/i'
    ).first();
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  async getHeadingText() {
    return (await this.heading().textContent() || '').trim();
  }

  async getDescriptionText() {
    return (await this.description().textContent() || '').trim();
  }

  /** True when the component heading is visible on the page. */
  async isComponentVisible() {
    return await this.heading().isVisible({ timeout: frameworkConfig.elementInteractionTimeoutMs })
      .catch(() => false);
  }

  /**
   * The dropdown's placeholder / initial label. For a native <select> this
   * is the text of the selected (placeholder) option; for a custom control
   * it is the trigger's visible/aria text.
   */
  async getDropdownPlaceholder() {
    const dd = this.dropdown();
    const tag = await dd.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      const opt = dd.locator('option').first();
      return (await opt.textContent().catch(() => '') || '').trim();
    }
    const aria = (await dd.getAttribute('aria-label').catch(() => '')) || '';
    const text = (await dd.textContent().catch(() => '')) || '';
    return (aria.trim() || text.trim());
  }

  // ─── Actions ─────────────────────────────────────────────────────────────

  /** Scroll the component into view (used before evidence screenshots). */
  async scrollToComponent() {
    await this.component()
      .evaluate(el => el.scrollIntoView({ block: 'start', inline: 'nearest' }))
      .catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
  }

  /** Scroll the displayed Service Area Map into view (centered). */
  async scrollToMap() {
    await this.mapImage()
      .evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
      .catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
  }

  /** Open a custom dropdown (no-op for a native <select>). */
  async openDropdown() {
    const dd = this.dropdown();
    const tag = await dd.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tag !== 'select') {
      await dd.click({ timeout: frameworkConfig.elementInteractionTimeoutMs });
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });
    }
    logger.info(this.logTag, 'Opened state dropdown');
  }

  /**
   * Return the selectable state option labels (excludes the placeholder).
   * The control is a native <select>; a custom-listbox fallback is kept in
   * case the component is re-implemented.
   */
  async getStateOptions() {
    const dd = this.dropdown();
    const tag = await dd.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    let labels = [];
    if (tag === 'select') {
      labels = await dd.locator('option').allTextContents();
    } else {
      await this.openDropdown();
      labels = await this.page.getByRole('option').allTextContents();
    }
    return labels
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !/^select a state$/i.test(s));
  }

  /**
   * Select a state by its 2-letter code and/or full name. Works for a
   * native <select> (via selectOption) and a custom combobox (open → click
   * option by accessible name).
   *
   * @param {{ state?: string, name?: string }} target
   * @returns {Promise<{ selected: boolean, label: string }>}
   */
  async selectState(target) {
    const code = (target.state || '').trim();
    const name = (target.name || '').trim();
    const dd = this.dropdown();
    const tag = await dd.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

    if (tag === 'select') {
      // Read the real option values first, then select the exact match once.
      // (Guessing values via selectOption would hang: with no action timeout
      // configured, a non-matching value makes Playwright wait indefinitely.)
      const options = await dd.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, label: (o.textContent || '').trim() }))
      );
      const want = options.find(o =>
        (code && o.value.toLowerCase() === code.toLowerCase())
        || (name && o.label.toLowerCase() === name.toLowerCase())
        || (code && o.label.toLowerCase() === code.toLowerCase())
      );
      if (!want) return { selected: false, label: name || code };
      await dd.selectOption(want.value);
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });
      logger.info(this.logTag, `Selected state via <select>: ${want.label || want.value}`);
      return { selected: true, label: want.label || want.value };
    }

    // Custom combobox: open then click the option by accessible name.
    await this.openDropdown();
    const optionName = new RegExp(`^\\s*(${[name, code].filter(Boolean).join('|')})\\s*$`, 'i');
    const option = this.page.getByRole('option', { name: optionName }).first();
    const visible = await option.isVisible({ timeout: frameworkConfig.elementInteractionTimeoutMs })
      .catch(() => false);
    if (!visible) return { selected: false, label: name || code };
    await option.click();
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Selected state via combobox: ${name || code}`);
    return { selected: true, label: name || code };
  }

  /** True when an inline Service Area Map image is visible. */
  async isMapVisible() {
    return await this.mapImage().isVisible({ timeout: frameworkConfig.elementInteractionTimeoutMs })
      .catch(() => false);
  }

  /** The `src` of the currently displayed map image ('' when none). */
  async getMapSrc() {
    if (!(await this.isMapVisible())) return '';
    return (await this.mapImage().getAttribute('src').catch(() => '')) || '';
  }

  /** True when the "map unavailable" message is shown for a no-map state. */
  async isNoMapMessageVisible() {
    return await this.noMapMessage()
      .isVisible({ timeout: frameworkConfig.elementInteractionTimeoutMs })
      .catch(() => false);
  }

  /** The text of the "map unavailable" message ('' when not shown). */
  async getNoMapMessageText() {
    if (!(await this.isNoMapMessageVisible())) return '';
    return (await this.noMapMessage().textContent().catch(() => '') || '').trim();
  }

  /** Number of open browser pages/tabs in the current context. */
  pageCount() {
    return this.page.context().pages().length;
  }
}

module.exports = { ServiceAreaMapsPage };
