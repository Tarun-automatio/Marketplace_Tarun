/**
 * MarketplacePage — Page Object for the Molina Marketplace flow.
 *
 * Covers the "Member Resources → Forms & Documents → Coverage Year"
 * navigation and validation flow used by Requirement 3.
 *
 * Design notes (framework reuse — no new patterns introduced):
 *   • Delegates cookie / pop-up dismissal, hardened `page.goto`, and
 *     framework-style `saveScreenshot` to the existing `PageCapture`
 *     helper (pages/HomePage.js) — exactly like PlanMaterialsPage /
 *     DrugPage.
 *   • All locators use aria-label + role first, falling back to CSS
 *     hooks that are stable in the current DOM.
 *   • All waits use `waitForDomStable` / framework timeouts from
 *     `config/framework.config.js` — no arbitrary sleeps.
 *   • All logging goes through the shared `logger` with a MARKETPLACE tag.
 *
 * Public methods are intentionally small and composable so the spec can
 * express the business flow at a high level (open → openMemberResources →
 * openFormsAndDocuments → selectState → selectCoverageYear → getActiveYear).
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { PageCapture } = require('./HomePage');
const { waitForDomStable } = require('../utils/asyncHelpers');

class MarketplacePage {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {object} [options]
   * @param {string[]} [options.consentTexts] — override cookie-consent button texts
   * @param {string}   [options.logTag] — log category tag (default: "MARKETPLACE")
   */
  constructor(page, options = {}) {
    this.page = page;
    this.logTag = options.logTag || 'MARKETPLACE';
    // Reuse PageCapture for cookie / pop-up dismissal + framework screenshot util
    this.capture = new PageCapture(page, {
      consentTexts: options.consentTexts || frameworkConfig.consentButtonTexts || [],
    });
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  /**
   * Open the marketplace URL using the framework's hardened navigation
   * (retries, WAF detection, cookie dismissal, network-idle wait, DOM stability).
   *
   * On mobile viewports we skip the framework's aggressive consent-click flow
   * because its generic-text matches ("Continue", "OK", "Accept") can trigger
   * unrelated CTAs on Molina's mobile marketplace home (observed to redirect
   * to /brokers-agents on iPhone SE / iPad Pro emulation). Instead we do a
   * plain `page.goto()` + a targeted Accept click on the CookiesBanner
   * component only.
   */
  async open(url, timeoutMs) {
    const nav = timeoutMs || frameworkConfig.navigationTimeoutMs;

    // Detect mobile up-front by userAgent hint (viewport isn't set until
    // after navigation on some emulation profiles, so UA is more reliable).
    // Playwright's iPhone SE / iPad Pro profiles both include "Mobile" in
    // the UA string.
    const isMobileEmulation = await this.page.evaluate(
      () => /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent)
    ).catch(() => false);

    if (isMobileEmulation) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: nav });
      // Best-effort wait for network idle so the mobile bundle finishes hydrating.
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      // Targeted cookie banner Accept — scoped to the CookiesBanner
      // component only, so we don't accidentally click a CTA elsewhere.
      const cookieAccept = this.page.locator(
        '[class*="CookiesBanner"] button:has-text("Accept"), '
        + '[id*="cookie" i] button:has-text("Accept"), '
        + '[class*="cookie" i] button:has-text("Accept")'
      ).first();
      if (await cookieAccept.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cookieAccept.click({ timeout: 3000 }).catch(() => {});
      }
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });
      logger.info(this.logTag, `Opened URL (mobile flow): ${url}`);
      return;
    }

    // Desktop: full framework flow (retries, WAF detection, popup dismissal, etc.)
    await this.capture.open(url, nav, frameworkConfig.waitAfterNetworkIdleMs);
    logger.info(this.logTag, `Opened URL: ${url}`);
  }

  /**
   * Explicitly attempt to dismiss the cookie banner. `open()` already tries
   * this via PageCapture, but exposing a dedicated method lets the spec
   * record it as its own reportable step.
   */
  async acceptCookies() {
    try {
      await this.capture.acceptCookiesIfPresent();
      logger.info(this.logTag, 'Cookie banner dismissed (if present)');
    } catch (err) {
      logger.warn(this.logTag, `Cookie dismissal failed: ${err.message.substring(0, 120)}`);
    }
  }

  /**
   * Framework-level screenshot: stabilises the DOM, hides fixed elements,
   * dismisses pop-ups and injects a URL bar overlay before saving.
   *
   * Marketplace evidence is always **viewport-only** (not full-page) — each
   * step is a single-viewport action and full-page shots produce very tall
   * images (5000+ px) that don't render nicely in the report. Combined with
   * the CDP viewport override in the spec, every shot is exactly 1920×1080.
   *
   * @param {string} filePath
   * @param {object} [options]
   * @param {boolean} [options.preserveScroll] — pass true when the caller
   *   has scrolled a specific section (e.g. "All Forms & Documents") into
   *   view and wants the screenshot to preserve that scroll position
   *   rather than reset to the top of the page.
   */
  async saveScreenshot(filePath, options = {}) {
    // On mobile, skip the framework's full save path (which calls
    // dismissAllPopups + acceptCookiesIfPresent — those are aggressive
    // enough to click random CTAs on Molina's mobile home, redirecting
    // the page). Instead, do a targeted mobile cookie hide + plain
    // Playwright screenshot.
    const isMobileEmulation = await this.page.evaluate(
      () => /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent)
    ).catch(() => false);

    if (isMobileEmulation) {
      try {
        // Let any in-flight fetch (state selection / year toggle triggers
        // an XHR that renders the results list + a spinner) settle before
        // we snap the screenshot — otherwise the shot captures the
        // "Loading..." state instead of the final results.
        await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        // Best-effort: wait for the visible "Loading..." indicator to
        // disappear. Molina's results list shows a spinner with the text
        // "Loading..." while the fetch is in flight.
        const loadingIndicator = this.page.locator('text=/^\\s*Loading\\.?\\.?\\.?\\s*$/i').first();
        await loadingIndicator.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        // DOM stability catches any post-render reflows (skeleton → cards).
        await waitForDomStable(this.page, {
          stableMs: frameworkConfig.domStableMs,
          timeoutMs: frameworkConfig.domStableTimeoutMs,
        });

        // Hide the cookie banner + any Molina ExternalSiteModal via CSS so
        // the screenshot is clean, without clicking any CTAs.
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
        await this.page.screenshot({
          path: filePath,
          fullPage: false,
        });
      } catch (err) {
        logger.warn('SCREENSHOT', `Mobile screenshot failed (${filePath}): ${err.message.substring(0, 120)}`);
      }
      return;
    }

    // Desktop: full framework save flow (URL bar overlay, popup dismissal,
    // hide fixed elements, video freezing, etc.)
    const shotOpts = {
      fullPage: false,
      preserveScroll: options.preserveScroll === true,
    };
    try {
      await this.capture.saveScreenshot(filePath, shotOpts);
    } catch (err) {
      logger.warn('SCREENSHOT', `Screenshot failed (${filePath}): ${err.message.substring(0, 120)}`);
      // Fallback to raw Playwright screenshot so the report still has evidence
      try { await this.page.screenshot({ path: filePath, fullPage: false }); } catch { /* ignore */ }
    }
  }

  // ─── Top-nav mega menu (Member Resources) ──────────────────────────────

  /**
   * The "Member Resources" trigger in the top navigation. It is a `<button>`
   * with aria-label="Member resources" that opens the megamenu on click/hover.
   */
  memberResourcesButton() {
    return this.page.locator(
      'button[aria-label="Member resources" i], [role="button"][aria-label="Member resources" i]'
    ).first();
  }

  // ─── Mobile navigation helpers ─────────────────────────────────────────
  //
  // On viewports narrower than Molina's desktop breakpoint the marketplace
  // header collapses into a hamburger menu (☰). The path to "Forms &
  // Documents" is different from desktop:
  //
  //   Desktop:  [Member Resources] → [Forms & documents]
  //   Mobile:   ☰ → Individual & Family → Member resources → Use your plan
  //             → Forms & documents
  //
  // We detect the mode by checking if the hamburger button is visible —
  // more reliable than guessing the width breakpoint (Molina's exact
  // breakpoint may differ from Playwright's device profiles).

  /**
   * The ☰ button in the mobile header. Selected by class (language-agnostic)
   * because the aria-label localizes — English uses "Menu", Spanish uses
   * "Menú" (with an accent) — but the CSS class `HeaderHC_hamburger_section`
   * is the same in both languages.
   */
  hamburgerButton() {
    return this.page.locator(
      'button[class*="HeaderHC_hamburger_section"], '
      + 'button[aria-label="Menu" i], '
      + 'button[aria-label="Menú" i]'
    ).first();
  }

  /** True when the hamburger is visible → mobile layout is active. */
  async isMobileLayout() {
    return await this.hamburgerButton().isVisible({ timeout: 1000 }).catch(() => false);
  }

  /** "Individual & Family" button in the top-level mobile menu. */
  mobileIndividualAndFamilyButton() {
    return this.page.locator(
      'button[class*="PrimaryNavigationMenu_menuitembtn"][aria-label="Individual & Family" i], '
      + 'button[aria-label="Individual & Family" i]'
    ).first();
  }

  /**
   * "Member resources" button on the 2nd-level mobile panel (after
   * Individual & Family is opened). The aria-label reads "Member
   * resources, submenu available" so we match with a starts-with.
   */
  mobileMemberResourcesButton() {
    return this.page.locator(
      'button[class*="Megamenu_menuItemContent"][aria-label^="Member resources" i], '
      + 'button[aria-label^="Member resources" i]'
    ).first();
  }

  /** "Use your plan" collapsible row inside the mobile Member resources panel. */
  mobileUseYourPlanButton() {
    return this.page.locator(
      'button[class*="Megamenu_menuItem"][aria-label="Use your plan" i], '
      + 'button[aria-label="Use your plan" i]'
    ).first();
  }

  /**
   * "Forms & documents" link inside the expanded mobile Use-your-plan section.
   * Uses ends-with on the href so it matches both:
   *   English: /member-resources/forms-documents
   *   Spanish: /es-us/member-resources/forms-documents
   */
  mobileFormsAndDocumentsLink() {
    return this.page.locator(
      'ul[class*="Megamenu_lastLevelMenu"] a[href$="/member-resources/forms-documents"], '
      + 'a[aria-label="Forms & documents" i][href$="/member-resources/forms-documents"]'
    ).first();
  }

  async openMemberResources() {
    // ── Mobile path: hamburger → Member resources ──
    // The top-level mobile menu (opened by hamburger) has a "Member resources"
    // button (aria-label starts with "Member resources"). Clicking it opens
    // the Find care / Use your plan sub-panel directly — no need to drill
    // through "Individual & Family" first. This path is identical in both
    // English and Spanish (menu labels don't localize on Molina's mobile).
    if (await this.isMobileLayout()) {
      const hamburger = this.hamburgerButton();
      await hamburger.click();
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });

      const mr = this.mobileMemberResourcesButton();
      await mr.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
      await mr.scrollIntoViewIfNeeded().catch(() => {});
      await mr.click();
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });
      logger.info(this.logTag, 'Opened "Member Resources" via mobile hamburger flow');
      return;
    }

    // ── Desktop path (existing) ──
    const btn = this.memberResourcesButton();
    await btn.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    // The megamenu implementation is hover-triggered on desktop but also
    // opens on click. Doing both makes the flow resilient across layouts.
    await btn.hover().catch(() => {});
    await btn.click().catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, 'Opened "Member Resources" navigation');
  }

  // ─── Forms & Documents link (inside the megamenu) ──────────────────────

  /**
   * The "Forms & Documents" anchor inside the Member Resources megamenu.
   * The DOM uses the HTML entity `&amp;` in aria-label so we match on both
   * the aria-label and the href (which is the more stable anchor).
   */
  formsAndDocumentsLink() {
    return this.page.locator(
      'a[href$="/member-resources/forms-documents"], a[aria-label="Forms & documents" i]'
    ).first();
  }

  async openFormsAndDocuments() {
    // ── Mobile path: expand "Use your plan" → click "Forms & documents" ──
    // (Prerequisite: openMemberResources() has already navigated the mobile
    // menu to the Member resources sub-panel.)
    if (await this.isMobileLayout()) {
      const useYourPlan = this.mobileUseYourPlanButton();
      await useYourPlan.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
      await useYourPlan.scrollIntoViewIfNeeded().catch(() => {});
      await useYourPlan.click();
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });

      const link = this.mobileFormsAndDocumentsLink();
      await link.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await Promise.all([
        this.page.waitForLoadState('domcontentloaded').catch(() => {}),
        link.click(),
      ]);
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: frameworkConfig.domStableTimeoutMs,
      });
      // After navigation the mobile menu stays visible on top of the
      // Forms & Documents page (SPA behavior). Toggle the hamburger to
      // close it so downstream steps can interact with the state dropdown
      // and coverage-year buttons underneath.
      const closeBtn = this.hamburgerButton();
      if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await closeBtn.click().catch(() => {});
        await waitForDomStable(this.page, {
          stableMs: frameworkConfig.domStableMs,
          timeoutMs: frameworkConfig.domStableTimeoutMs,
        });
      }
      logger.info(this.logTag, 'Navigated to "Forms & Documents" via mobile flow');
      return;
    }

    // ── Desktop path (existing) ──
    const link = this.formsAndDocumentsLink();
    await link.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await Promise.all([
      this.page.waitForLoadState('domcontentloaded').catch(() => {}),
      link.click(),
    ]);
    // Small extra stability wait — the page performs a client-side hydration
    // that adds the state dropdown after DOMContentLoaded.
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, 'Navigated to "Forms & Documents"');
  }

  // ─── State dropdown ────────────────────────────────────────────────────

  stateDropdown() {
    // Prefer the id (very stable) then fall back to the aria-label.
    return this.page.locator(
      '#statedropdown, select[aria-label="Select a State" i]'
    ).first();
  }

  /**
   * The "All Forms & Documents" section heading on the Forms & Documents
   * page. Used as an anchor to scroll the reviewable content (state
   * dropdown, coverage-year toggle, filter panel, result list) into view
   * before capturing evidence for Steps 4–6.
   */
  allFormsAndDocumentsHeading() {
    // Match the heading by role first (very stable across React re-renders),
    // then by any h2 containing the text as a fallback.
    return this.page
      .getByRole('heading', { name: /All\s*Forms\s*&\s*Documents/i })
      .or(this.page.locator('h2').filter({ hasText: /All\s*Forms\s*&\s*Documents/i }))
      .first();
  }

  /**
   * Scroll the "All Forms & Documents" section into view so the state
   * dropdown + coverage-year toggle + top of the result list are all
   * visible in the viewport. Best-effort — if the heading isn't found we
   * fall back to scrolling to the state dropdown.
   *
   * @returns {Promise<boolean>} true if a scroll target was found
   */
  async scrollToAllFormsAndDocuments() {
    // On mobile, the layout stacks vertically:
    //   [hero] → [popular results / no-results panel] → [All Forms &
    //   Documents heading] → [state dropdown] → [search] → [coverage
    //   year buttons] → [footer]
    // Scrolling to the heading puts the popular-results panel in view
    // and pushes the state dropdown + year buttons off the bottom.
    // Scroll to the "2026" coverage-year button CENTERED in the viewport
    // instead — that guarantees both the state dropdown (just above it)
    // and the year toggle (the button itself) appear in the shot.
    const isMobile = await this.page.evaluate(
      () => /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent)
    ).catch(() => false);

    if (isMobile) {
      try {
        const yearBtn = this.yearButton('2026');
        if (await yearBtn.count()) {
          await yearBtn.evaluate(
            (el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })
          ).catch(() => {});
          await waitForDomStable(this.page, {
            stableMs: frameworkConfig.domStableMs,
            timeoutMs: frameworkConfig.domStableTimeoutMs,
          });
          return true;
        }
      } catch (err) {
        logger.warn(this.logTag,
          `scrollToAllFormsAndDocuments (mobile): year-button scroll failed (${err.message.substring(0, 80)})`);
      }
      // Mobile fallback → state dropdown
      try {
        const dd = this.stateDropdown();
        if (await dd.count()) {
          await dd.evaluate(
            (el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })
          ).catch(() => {});
          return true;
        }
      } catch { /* ignore */ }
      return false;
    }

    // ── Desktop path (existing) ──
    const heading = this.allFormsAndDocumentsHeading();
    try {
      if (await heading.count()) {
        await heading.scrollIntoViewIfNeeded();
        // Nudge up a little so the heading sits near the top of the
        // viewport rather than right at the edge (avoids the sticky page
        // banner covering it).
        await this.page.evaluate(() => window.scrollBy(0, -80)).catch(() => {});
        await waitForDomStable(this.page, {
          stableMs: frameworkConfig.domStableMs,
          timeoutMs: frameworkConfig.domStableTimeoutMs,
        });
        return true;
      }
    } catch (err) {
      logger.warn(this.logTag,
        `scrollToAllFormsAndDocuments: heading scroll failed (${err.message.substring(0, 80)}) — falling back to state dropdown`);
    }
    // Fallback — the state dropdown lives inside the same section.
    try {
      const dd = this.stateDropdown();
      if (await dd.count()) {
        await dd.scrollIntoViewIfNeeded();
        await this.page.evaluate(() => window.scrollBy(0, -160)).catch(() => {});
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Select a state option by its 2-letter code (matches the <option value>
   * attribute — e.g. "tx", "ca", "az") or by its visible label.
   *
   * Returns a structured result so callers (the spec) can decide how to
   * react — throw / skip / log / fail — instead of the page object baking
   * in a specific policy. Never throws for "state not available"; only
   * throws for genuinely unexpected errors (dropdown not visible, DOM
   * evaluation failure, etc.).
   *
   * @param {string} stateCode
   * @returns {Promise<{
   *   selected: boolean,
   *   availableStates: string[],   // uppercase 2-letter codes, sorted
   *   reason?: 'not-in-dropdown' | 'select-error',
   *   errorMessage?: string,
   * }>}
   */
  async selectState(stateCode) {
    const dd = this.stateDropdown();
    await dd.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await dd.scrollIntoViewIfNeeded().catch(() => {});

    // Enumerate all <option> values + labels so the caller can decide what
    // to do when the requested state isn't in the list.
    const options = await dd.evaluate((select) => {
      return Array.from(select.querySelectorAll('option')).map((o) => ({
        value: (o.getAttribute('value') || '').trim().toLowerCase(),
        label: (o.textContent || '').trim(),
      })).filter((o) => o.value && o.value !== ''); // skip placeholder "" option
    }).catch(() => []);

    const availableStates = options.map((o) => o.value.toUpperCase()).sort();
    const value = String(stateCode).toLowerCase().trim();
    const matchByValue = options.find((o) => o.value === value);
    const matchByLabel = options.find(
      (o) => o.label.toLowerCase() === String(stateCode).toLowerCase()
    );

    if (!matchByValue && !matchByLabel) {
      return { selected: false, availableStates, reason: 'not-in-dropdown' };
    }

    try {
      await dd.selectOption(matchByValue ? matchByValue.value : { label: matchByLabel.label });
    } catch (err) {
      return {
        selected: false,
        availableStates,
        reason: 'select-error',
        errorMessage: err.message,
      };
    }

    // The page navigates / re-renders after selection.
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Selected state: ${stateCode}`);
    return { selected: true, availableStates };
  }

  // ─── Coverage Year buttons ─────────────────────────────────────────────

  /** Wrapper `.year-selection` block (label + button group). */
  yearSection() {
    return this.page.locator('.year-selection').first();
  }

  /** A specific year button. e.g. yearButton('2026') → <button aria-label="2026">. */
  yearButton(year) {
    const y = String(year);
    return this.page
      .locator(`button[aria-label="${y}"]`)
      .filter({ hasText: y })
      .first();
  }

  /**
   * Click a coverage-year button and wait for the URL to reflect the
   * selection (`?year=<year>`) or for DOM to settle if the URL doesn't
   * change.
   *
   * @param {string|number} year — e.g. "2026" or 2027
   * @returns {Promise<{clicked: boolean, reason?: string}>}
   */
  async selectCoverageYear(year) {
    const y = String(year);
    const btn = this.yearButton(y);
    await btn.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await btn.scrollIntoViewIfNeeded().catch(() => {});

    const [isDisabled, alreadyActive] = await Promise.all([
      btn.isDisabled().catch(() => false),
      btn.evaluate((el) => el.classList.contains('active')).catch(() => false),
    ]);

    if (isDisabled && alreadyActive) {
      logger.info(this.logTag, `Year ${y} is already active (button disabled) — no click needed`);
      return { clicked: false, reason: 'already-active' };
    }
    if (isDisabled && !alreadyActive) {
      logger.warn(this.logTag, `Year ${y} button is disabled and not active — coverage may not be available`);
      return { clicked: false, reason: 'disabled' };
    }

    await Promise.all([
      // Some year toggles do a full navigation; others just update the query
      // string via history.replaceState. Wait for whichever happens first.
      this.page.waitForURL(new RegExp(`[?&]year=${y}(&|$)`, 'i'), {
        timeout: frameworkConfig.pageLoadWaitMs,
      }).catch(() => null),
      btn.click(),
    ]);
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Selected coverage year: ${y}`);
    return { clicked: true };
  }

  /**
   * Read the currently-active year from the button group (the `<button>`
   * that has both `class="active"` and an aria-label matching a 4-digit year).
   * Returns the year string (e.g. "2026") or null if not found.
   */
  async getActiveYear() {
    try {
      const active = this.page
        .locator('.years-container button.active[aria-label]')
        .first();
      const label = await active.getAttribute('aria-label');
      return label && /^\d{4}$/.test(label.trim()) ? label.trim() : null;
    } catch {
      return null;
    }
  }

  // ─── URL helpers ───────────────────────────────────────────────────────

  /** Extract the year query-string parameter from a URL (or current page URL). */
  getYearFromUrl(url) {
    const target = url || this.page.url();
    const m = /[?&]year=(\d{4})/i.exec(target);
    return m ? m[1] : null;
  }

  currentUrl() {
    return this.page.url();
  }
}

module.exports = { MarketplacePage };
