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

  // ─── Language switcher (top-right header) ──────────────────────────────
  //
  // Molina exposes a Language dropdown in the top-right of the site header:
  //   <button aria-label="Language">Language <span>ES/EN</span> ▼</button>
  //   <ul role="menu">
  //     <li><button>English</button></li>
  //     <li><button>Spanish</button></li>
  //   </ul>
  //
  // Selecting Spanish navigates to `/es-us/…` (path prefix), English removes
  // the prefix. Both trigger a full re-render, so we wait for the URL and
  // DOM to stabilise before returning.
  //
  // Idempotent: if the site is already in the requested language this is a
  // no-op that logs and returns immediately.

  languageToggleButton() {
    return this.page.locator(
      'button[aria-label="Language" i], '
      + 'button[aria-label*="Language" i], '
      + 'button:has-text("Language")'
    ).first();
  }

  /** Read the current UI language from the URL — 'es' when `/es-us` path prefix is present, 'en' otherwise. */
  currentLanguage() {
    return /\/es-us\//i.test(this.page.url()) ? 'es' : 'en';
  }

  /**
   * Switch the site UI language via the header dropdown. Accepts:
   *   'en' | 'english'  → English
   *   'es' | 'spanish'  → Spanish
   *
   * Idempotent (no-op when already in the target language).
   * Waits for the URL prefix to reflect the change AND for the DOM to settle.
   */
  async switchLanguage(target) {
    const wantEs = /^(es|spanish)$/i.test(String(target || ''));
    const current = this.currentLanguage();
    if ((wantEs && current === 'es') || (!wantEs && current === 'en')) {
      logger.info(this.logTag, `Language already set to ${wantEs ? 'Spanish' : 'English'} — no switch needed`);
      return;
    }

    const btn = this.languageToggleButton();
    await btn.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click();

    // Dropdown option — "English" or "Spanish".
    const optionText = wantEs ? 'Spanish' : 'English';
    const option = this.page.locator(
      `button:has-text("${optionText}"), `
      + `a:has-text("${optionText}"), `
      + `[role="menuitem"]:has-text("${optionText}"), `
      + `li:has-text("${optionText}")`
    ).first();
    await option.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await option.click();

    // Wait for the URL to reflect the language change. Spanish adds
    // `/es-us`, English removes it.
    const targetRe = wantEs ? /\/es-us\//i : /^(?!.*\/es-us\/)/;
    await this.page.waitForURL(targetRe, { timeout: frameworkConfig.pageLoadWaitMs }).catch(() => {});
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Switched language to ${wantEs ? 'Spanish' : 'English'} — URL: ${this.page.url()}`);
  }

  // ─── Filter accordion (Audience / Category) ────────────────────────────
  //
  // The Forms & Documents page renders each filter as an accordion panel:
  //   <button class="filterTitle" aria-expanded="…"
  //           aria-controls="filter-panel-<Facet>Facet">Audience</button>
  //   <ul id="filter-panel-<Facet>Facet">
  //     <li><label>Member (165)<input type="checkbox" value="Member"
  //                                    name="AudienceFacet"></label></li>
  //     …
  //
  // We locate the toggle button by its visible text, expand if collapsed,
  // then click the checkbox by its `value` attribute (exact) — the visible
  // label text carries a count in parens (e.g. "Member (165)") which would
  // change day-to-day and shouldn't be part of the selector.

  filterToggleByName(name) {
    return this.page
      .locator('button.filterTitle')
      .filter({ hasText: new RegExp('^\\s*' + String(name).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\s*$', 'i') })
      .first();
  }

  /** Panel id resolver — 'Audience' → 'filter-panel-AudienceFacet'. */
  filterPanelIdFor(name) {
    const key = String(name).trim();
    if (/audience/i.test(key)) return 'filter-panel-AudienceFacet';
    if (/category/i.test(key)) return 'filter-panel-CategoryFacet';
    return null;
  }

  /**
   * Expand a filter accordion by name (idempotent — no-op when already open).
   * Waits for aria-expanded="true" or the panel element to become visible.
   */
  async openFilterSection(name) {
    const btn = this.filterToggleByName(name);
    // The filter panel is populated asynchronously by the site after the
    // Forms & Documents list resolves (which itself lags year/state changes
    // by up to ~10s). Wait generously here so we don't fail on the first
    // filter open of the run.
    await btn.waitFor({ state: 'visible', timeout: 30000 });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    const expanded = (await btn.getAttribute('aria-expanded').catch(() => '')) === 'true';
    if (!expanded) {
      await btn.click();
      // Poll aria-expanded rather than rely on a fixed timeout — the panel
      // uses a CSS class toggle that flips synchronously with the state.
      const deadline = Date.now() + frameworkConfig.elementInteractionTimeoutMs;
      while (Date.now() < deadline) {
        const now = await btn.getAttribute('aria-expanded').catch(() => null);
        if (now === 'true') break;
        await this.page.waitForTimeout(80);
      }
      await waitForDomStable(this.page, {
        stableMs: frameworkConfig.domStableMs,
        timeoutMs: 2000,
      });
    }
    logger.info(this.logTag, `Filter section "${name}" is open`);
  }

  /**
   * Check a filter option's checkbox inside the named accordion. `optionValue`
   * matches the `value` attribute exactly (not the visible label — which has
   * "(N)" counts that change over time).
   *
   * Idempotent: no-op when the checkbox is already checked. Waits for the
   * result list to settle after the filter fires its XHR.
   */
  async selectFilterOption(sectionName, optionValue) {
    await this.openFilterSection(sectionName);
    const panelId = this.filterPanelIdFor(sectionName);
    const scope = panelId
      ? this.page.locator(`ul[id="${panelId}"]`)
      : this.page;

    const value = String(optionValue).trim();
    // Escape double-quotes in the CSS attribute selector.
    const cssValue = value.replace(/"/g, '\\"');
    const checkbox = scope.locator(`input[type="checkbox"][value="${cssValue}"]`).first();
    await checkbox.waitFor({ state: 'attached', timeout: frameworkConfig.elementInteractionTimeoutMs });

    const already = await checkbox.isChecked().catch(() => false);
    if (already) {
      logger.info(this.logTag, `Filter "${sectionName}=${value}" already selected`);
      return;
    }

    // The native checkbox is visually hidden (styled via .checkmark span),
    // so click the wrapping <label> — that toggles the underlying input
    // reliably across desktop + mobile.
    const label = scope.locator(`label:has(input[type="checkbox"][value="${cssValue}"])`).first();
    if (await label.count()) {
      await label.click();
    } else {
      await checkbox.check({ force: true });
    }

    // Filter selection triggers an XHR + full result re-render.
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Filter selected: ${sectionName}="${value}"`);
  }

  /**
   * Uncheck a filter option's checkbox inside the named accordion (the
   * opposite of `selectFilterOption`). Idempotent: no-op when already
   * unchecked. Waits for the result list to settle after the filter fires
   * its XHR.
   */
  async unselectFilterOption(sectionName, optionValue) {
    await this.openFilterSection(sectionName);
    const panelId = this.filterPanelIdFor(sectionName);
    const scope = panelId
      ? this.page.locator(`ul[id="${panelId}"]`)
      : this.page;

    const value = String(optionValue).trim();
    const cssValue = value.replace(/"/g, '\\"');
    const checkbox = scope.locator(`input[type="checkbox"][value="${cssValue}"]`).first();
    await checkbox.waitFor({ state: 'attached', timeout: frameworkConfig.elementInteractionTimeoutMs });

    const already = await checkbox.isChecked().catch(() => false);
    if (!already) {
      logger.info(this.logTag, `Filter "${sectionName}=${value}" already unselected`);
      return;
    }

    const label = scope.locator(`label:has(input[type="checkbox"][value="${cssValue}"])`).first();
    if (await label.count()) {
      await label.click();
    } else {
      await checkbox.uncheck({ force: true });
    }

    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Filter unselected: ${sectionName}="${value}"`);
  }

  // ─── Search box ────────────────────────────────────────────────────────

  searchInput() {
    return this.page.locator('#searchInputBox, input[aria-label="Search" i]').first();
  }

  searchButton() {
    // The button carries just an SVG icon + "Search" label; scope by parent
    // form so we don't accidentally target header search components.
    return this.page.locator(
      'form.searchbox-section button.search_btn, '
      + 'form.searchbox-section button[type="button"]:has(span:has-text("Search"))'
    ).first();
  }

  /**
   * Type `planName` into the search box and click the Search button.
   * Waits for the URL to reflect `queue=<text>` (Molina drives search via
   * URL query param) AND for a `.resultCard` (or a "no results" message)
   * to appear before returning — protects downstream calls that query the
   * result list.
   */
  async searchByPlanName(planName) {
    const text = String(planName || '').trim();
    const input = this.searchInput();
    await input.waitFor({ state: 'visible', timeout: frameworkConfig.elementInteractionTimeoutMs });
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.fill('');
    if (text) await input.fill(text);

    await this.searchButton().click();

    // Molina drives search via URL query param `queue=` — wait for it to
    // appear (client-side history.push) before probing the DOM.
    if (text) {
      await this.page.waitForURL(/[?&]queue=/i, { timeout: 15000 }).catch(() => {});
    }
    // Wait for either a rendered result card OR a "no results" message so
    // we don't query DOM mid-refresh.
    await Promise.race([
      this.page.locator('.resultCard').first()
        .waitFor({ state: 'attached', timeout: 20000 }).catch(() => null),
      this.page.locator('text=/no\\s+results?/i').first()
        .waitFor({ state: 'attached', timeout: 20000 }).catch(() => null),
    ]);
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await waitForDomStable(this.page, {
      stableMs: frameworkConfig.domStableMs,
      timeoutMs: frameworkConfig.domStableTimeoutMs,
    });
    logger.info(this.logTag, `Searched for plan: "${text}"`);
  }

  // ─── Result cards ──────────────────────────────────────────────────────

  /**
   * Collect every `.resultCard` currently rendered — each result's title,
   * PDF href (relative), and clickable link locator.
   *
   * @returns {Promise<Array<{
   *   index:   number,       // 0-based position in the DOM
   *   title:   string,       // visible card heading
   *   href:    string,       // href attribute (may be relative)
   *   linkLoc: import('@playwright/test').Locator,
   * }>>}
   */
  async collectResultCards() {
    const cards = this.page.locator('.resultCard');
    const count = await cards.count();
    const out = [];
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const linkLoc  = card.locator('a.title-link').first();
      const titleLoc = linkLoc.locator('.card-heading').first();
      const title = ((await titleLoc.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const href  = ((await linkLoc.getAttribute('href').catch(() => '')) || '').trim();
      if (!title && !href) continue;
      out.push({ index: i, title, href, linkLoc });
    }
    return out;
  }

  /**
   * Same as `collectResultCards` but filtered to cards whose visible title
   * matches `needle` with a **word-boundary substring** match (case + whitespace
   * insensitive). This prevents "Molina Gold Core 1500" from also matching
   * "Molina Gold Core 1500 LCS" — the needle must appear as a full word/phrase,
   * not as a prefix of a longer name.
   *
   * When multiple cards match (e.g. one English SBC and one Spanish SBC for
   * the same plan), ALL are returned in DOM order — the caller decides which
   * one to click first.
   */
  async findResultCardsByName(needle) {
    const raw = String(needle || '').replace(/\s+/g, ' ').trim();
    if (!raw) return this.collectResultCards();
    // Escape regex metacharacters in the needle so plan names with e.g.
    // parentheses or plus signs work as literal text, then require a word
    // boundary (start-of-string / whitespace / punctuation) on both sides.
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const wordBoundaryRe = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i');
    const all = await this.collectResultCards();
    // Prefer word-boundary matches; if none found, fall back to a loose
    // substring match so testers get *some* signal instead of an empty list.
    const strict = all.filter(c => wordBoundaryRe.test(c.title));
    if (strict.length) return strict;
    const loose = all.filter(c => c.title.toLowerCase().includes(raw.toLowerCase()));
    return loose;
  }

  /**
   * Find the SINGLE result card whose title matches `needleName` exactly
   * (whitespace + case insensitive) AND whose href pathname matches the
   * pathname of `expectedUrl`.
   *
   * Rationale: when several plans share a similar prefix (e.g. "Molina Gold
   * Core 1500" and "Molina Gold Core 1500 LCS Plus with Adult Vision"),
   * and the SAME title text may appear TWICE — once for the English PDF and
   * once for the Spanish PDF — the ONLY way to pick the right card is to
   * match by (a) exact title and (b) the PDF href language/path. This is
   * order-independent and doesn't rely on positional guessing.
   *
   * @returns {Promise<{ index, title, href, linkLoc } | null>}
   */
  async findCardByNameAndUrl(needleName, expectedUrl) {
    const nameKey = String(needleName || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const expectedPath = expectedUrlToPath(expectedUrl);
    if (!nameKey || !expectedPath) return null;
    const all = await this.collectResultCards();

    const nameMatches = all.filter(c =>
      c.title.replace(/\s+/g, ' ').trim().toLowerCase() === nameKey
    );
    if (nameMatches.length === 0) return null;

    const urlMatches = nameMatches.filter(c => hrefToPath(c.href) === expectedPath);
    if (urlMatches.length === 1) return urlMatches[0];
    if (urlMatches.length > 1) {
      logger.warn(this.logTag, `Multiple cards match name="${needleName}" AND href-path "${expectedPath}" — returning first`);
      return urlMatches[0];
    }
    return null;
  }
}

// ─── Module-scoped URL helpers used by findCardByNameAndUrl ─────────────────
// Kept outside the class so they can be called without a MarketplacePage
// instance (they're pure functions).

function hrefToPath(href) {
  const s = String(href || '').trim();
  if (!s) return '';
  // Absolute URL — parse and take pathname.
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).pathname.replace(/\/+$/, '').toLowerCase(); }
    catch { /* fall through */ }
  }
  // Relative path — strip query/fragment + trailing slash, lowercase.
  return s.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

function expectedUrlToPath(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try { return new URL(s).pathname.replace(/\/+$/, '').toLowerCase(); }
  catch {
    return s.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

module.exports = { MarketplacePage };
