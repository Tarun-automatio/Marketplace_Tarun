/**
 * PageCapture — Core page interaction class.
 *
 * The class is composed from focused mixin modules:
 *   - cookieMethods     → Cookie consent detection & dismissal
 *   - popupMethods      → Popup/modal detection, validation & cleanup
 *   - accordionMethods  → Accordion expand/collapse/capture
 *   - screenshotMethods → Full-page, responsive & mismatch screenshots
 *   - pageSnapshot      → Content snapshot for QA-vs-PROD comparison
 *
 * Standalone functions used by comparison tests (captureCarouselCards,
 * captureContactContent) live in ./homePageExtras.js and are re-exported
 * here for backward compatibility.
 */

const logger = require('../utils/logger');
const { waitForDomStable } = require('../utils/asyncHelpers');
const frameworkConfig = require('../config/framework.config');

// Mixin modules
const cookieMethods    = require('./cookieMethods');
const popupMethods     = require('./popupMethods');
const accordionMethods = require('./accordionMethods');
const screenshotMethods = require('./screenshotMethods');
const pageSnapshot     = require('./pageSnapshot');

// Standalone helpers
const { captureCarouselCards, captureContactContent } = require('./homePageExtras');

// ═══════════════════════════════════════════════════════════════
// PageCapture Class — Core
// ═══════════════════════════════════════════════════════════════

class PageCapture {
  constructor(page, options = {}) {
    this.page = page;
    this.consentTexts = (options.consentTexts || [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    this.cookieBannerText = '';
    this.skipPassportDismissal = false;
    this.popupText = '';
    this.performanceMetrics = null;
  }

  // ── Shared DOM helpers ──

  /**
   * Try an async operation on the main page first, then on each iframe.
   * Stops and returns the first truthy result.
   */
  async _tryInMainAndFrames(fn) {
    const mainResult = await fn(this.page, 'main page');
    if (mainResult) return mainResult;
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const frameResult = await fn(frame, `frame: ${frame.url() || 'unknown'}`);
      if (frameResult) return frameResult;
    }
    return null;
  }

  /**
   * Click the first visible locator from an array of candidates.
   */
  async _clickFirstVisible(candidates, timeout = frameworkConfig.elementProbeTimeoutMs) {
    for (const candidate of candidates) {
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      await candidate.click({ timeout }).catch(() => null);
      return true;
    }
    return false;
  }

  /**
   * Build an ordered list of button/link/role-button locator candidates.
   */
  _buildButtonCandidates(context, nameRegex, includeLabels = false) {
    const selector = includeLabels
      ? 'button, a, [role="button"], label'
      : 'button, a, [role="button"]';
    return [
      context.getByRole('button', { name: nameRegex }).first(),
      context.getByRole('link', { name: nameRegex }).first(),
      context.locator(selector).filter({ hasText: nameRegex }).first(),
    ];
  }

  // ── Navigation ──

  async open(url, timeout, waitAfterNetworkIdleMs = 1500) {
    const openStart = Date.now();
    const maxRetries = 3;
    const baseRetryDelayMs = 15000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info('NAV', `Opening URL: ${url}${attempt > 1 ? ` (retry ${attempt}/${maxRetries})` : ''}`);

      if (attempt > 1) {
        try {
          const context = this.page.context();
          await context.clearCookies();
        } catch { /* ignore */ }
      }

      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      } catch (err) {
        if (attempt < maxRetries) {
          const delayMs = baseRetryDelayMs * attempt;
          logger.warn('NAV', `page.goto failed on attempt ${attempt} (${err.message.substring(0, 80)}) — waiting ${delayMs / 1000}s before retry`);
          await this.page.waitForTimeout(delayMs).catch(() => {});
          continue;
        }
        logger.error('NAV', `page.goto failed after ${maxRetries} attempts: ${err.message.substring(0, 120)}`);
        throw err;
      }

      const blocked = await this.page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes("you don't have permission") ||
               text.includes('access denied') ||
               text.includes('reference #') ||
               text.includes('errors.edgesuite.net');
      }).catch(() => false);

      if (blocked && attempt < maxRetries) {
        const delayMs = baseRetryDelayMs * attempt;
        logger.warn('NAV', `Access blocked on attempt ${attempt} — waiting ${delayMs / 1000}s before retry`);
        await this.page.waitForTimeout(delayMs);
        continue;
      }

      if (blocked && attempt === maxRetries) {
        logger.warn('NAV', `Access still blocked after ${maxRetries} attempts — proceeding (will be marked BLOCKED)`);
      }

      break;
    }

    await Promise.all([
      this.acceptCookiesIfPresent(),
      this.dismissPassportMemberPromptIfPresent()
    ]);
    logger.debug('NAV', 'Waiting for network to become idle');
    try {
      await this.page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 20000) });
    } catch {
      logger.warn('NAV', 'networkidle timeout detected; continuing with stabilized DOM checks');
    }
    await this.page.waitForFunction(() => document.readyState === 'complete', null, { timeout: Math.min(timeout, 20000) }).catch(() => {});
    await Promise.all([
      this.acceptCookiesIfPresent(),
      this.dismissPassportMemberPromptIfPresent()
    ]);
    // Scroll through the full page to trigger lazy-loaded content
    await this.page.evaluate(async () => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      const scrollHeight = document.body.scrollHeight;
      const step = Math.max(window.innerHeight, 600);
      for (let y = 0; y < scrollHeight; y += step) {
        window.scrollTo(0, y);
        await delay(100);
      }
      window.scrollTo(0, document.body.scrollHeight);
      await delay(200);
      window.scrollTo(0, 0);
    }).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: frameworkConfig.networkIdleWaitMs }).catch(() => {});
    await waitForDomStable(this.page, { stableMs: waitAfterNetworkIdleMs, timeoutMs: Math.max(waitAfterNetworkIdleMs * 3, 5000) });
    await this.capturePerformanceMetrics();
    const loadTime = Date.now() - openStart;
    logger.info('NAV', `Page load stabilized in ${logger.formatDuration(loadTime)}`, { url, loadTime });
  }

  // ── Performance ──

  async capturePerformanceMetrics() {
    try {
      this.performanceMetrics = await this.page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0];
        if (!perf) return null;
        const paint = performance.getEntriesByType('paint');
        const fcp = paint.find(p => p.name === 'first-contentful-paint');
        return {
          dnsMs: Math.round(perf.domainLookupEnd - perf.domainLookupStart),
          connectMs: Math.round(perf.connectEnd - perf.connectStart),
          ttfbMs: Math.round(perf.responseStart - perf.requestStart),
          domContentLoadedMs: Math.round(perf.domContentLoadedEventEnd - perf.navigationStart),
          loadCompleteMs: Math.round(perf.loadEventEnd - perf.navigationStart),
          domInteractiveMs: Math.round(perf.domInteractive - perf.navigationStart),
          fcpMs: fcp ? Math.round(fcp.startTime) : null,
          transferSizeKb: perf.transferSize ? Math.round(perf.transferSize / 1024) : null,
          resourceCount: performance.getEntriesByType('resource').length,
        };
      });
    } catch {
      this.performanceMetrics = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Mix in methods from focused modules
// ═══════════════════════════════════════════════════════════════

Object.assign(
  PageCapture.prototype,
  cookieMethods,
  popupMethods,
  accordionMethods,
  screenshotMethods,
  pageSnapshot,
);

// ═══════════════════════════════════════════════════════════════
// Exports (backward-compatible)
// ═══════════════════════════════════════════════════════════════

const HomePage = PageCapture;
module.exports = { PageCapture, HomePage, captureCarouselCards, captureContactContent };
