/**
 * Cookie Consent Methods (mixin for PageCapture.prototype)
 *
 * Handles detection, text capture, and dismissal of cookie consent banners.
 * Methods access `this.page`, `this.consentTexts`, `this.cookieBannerText`
 * via the PageCapture instance.
 */

const { COOKIE_BANNER_SELECTORS } = require('./selectors');
const frameworkConfig = require('../config/framework.config');
const logger = require('../utils/logger');

module.exports = {
  buildConsentRegex() {
    if (!this.consentTexts.length) {
      return null;
    }

    const escapedParts = this.consentTexts.map((value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );

    // Use partial matching so labels like "Accept all cookies" match "accept all".
    return new RegExp(`(?:${escapedParts.join('|')})`, 'i');
  },

  buildConsentLocator(context, consentRegex) {
    const elementCandidates = context.locator('button, a, [role="button"]');
    return elementCandidates.filter({ hasText: consentRegex }).first();
  },

  async tryClickConsentInContext(context, contextLabel, consentRegex) {
    const consentLocator = this.buildConsentLocator(context, consentRegex);

    const isVisible = await consentLocator.isVisible().catch(() => false);
    if (!isVisible) {
      return false;
    }

    await consentLocator.click({ timeout: frameworkConfig.elementProbeTimeoutMs }).catch(() => null);
    logger.info('COOKIE', `Clicked consent button on ${contextLabel}`);
    return true;
  },

  async captureCookieBannerText() {
    if (this.cookieBannerText) return;

    const extractBannerText = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t.length > 10) return t;
        }
      }
      return '';
    };

    await this._tryInMainAndFrames(async (context, label) => {
      try {
        const text = await context.evaluate(extractBannerText, COOKIE_BANNER_SELECTORS);
        if (text) {
          this.cookieBannerText = text;
          logger.debug('COOKIE', `Captured cookie banner text from ${label} (${text.length} chars)`);
          return true;
        }
      } catch { /* context may be detached */ }
      return false;
    });
  },

  async acceptCookiesIfPresent() {
    const consentRegex = this.buildConsentRegex();
    if (!consentRegex) {
      return;
    }

    // Capture banner text BEFORE clicking (clicking removes the banner from DOM)
    await this.captureCookieBannerText();

    // Helper: capture cookie text from the consent button's ancestor container
    const captureFromButton = async (context) => {
      if (this.cookieBannerText) return;
      try {
        const consentTexts = (this.consentTexts || []).map(t => t.toLowerCase());
        const text = await context.evaluate((ctexts) => {
          const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
          const cookieKeywords = /cookie|privacy|consent|analytic|tracking|data collection/i;
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          for (const btn of btns) {
            if (btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;
            const btnText = normalize(btn.innerText).toLowerCase();
            if (!ctexts.some(ct => btnText.includes(ct))) continue;
            let container = btn.parentElement;
            for (let i = 0; i < 6 && container && container !== document.body; i++) {
              const ct = normalize(container.innerText);
              if (ct.length > 20 && ct.length < 3000 && cookieKeywords.test(ct)) return ct;
              container = container.parentElement;
            }
            // If no cookie-keyword container found, just use the button's direct parent text
            const parentText = btn.parentElement ? normalize(btn.parentElement.innerText) : '';
            if (parentText.length > 20 && parentText.length < 3000) return parentText;
          }
          return '';
        }, consentTexts);
        if (text) {
          this.cookieBannerText = text;
          logger.debug('COOKIE', `Captured cookie banner text via button context (${text.length} chars)`);
        }
      } catch { /* ignore */ }
    };

    await this._tryInMainAndFrames(async (context, label) => {
      const locator = this.buildConsentLocator(context, consentRegex);
      const isVisible = await locator.isVisible().catch(() => false);
      if (!isVisible) return false;
      await captureFromButton(context);
      await locator.click({ timeout: frameworkConfig.elementProbeTimeoutMs }).catch(() => null);
      logger.info('COOKIE', `Clicked consent button on ${label}`);
      return true;
    });
  },
};
