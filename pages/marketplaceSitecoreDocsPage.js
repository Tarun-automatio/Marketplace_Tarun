/**
 * MarketplaceSitecoreDocsPage — thin Page Object for Requirement 2.
 *
 * Sitecore-hosted plan document PDFs (SBC / EOC / OOC, optionally SOB)
 * live at URLs like:
 *   https://<host>/-/media/project/pws/healthcare/pdf/pdf/ifp/<state>/materials/<DOCTYPE>/<year>/<lang>/<file>.pdf
 *
 * The verification is entirely URL-driven — no navigation, no filters,
 * no cookies to click. We `page.goto(url)` and rely on two DOM signals
 * that Chrome's built-in PDF viewer exposes to the parent frame:
 *   • <embed id="plugin" type="application/x-google-chrome-pdf"
 *            original-url="…"/>  — proves the viewer mounted
 *   • page.url()                 — proves navigation resolved to the
 *                                  requested URL (no 404 / redirect)
 *
 * When Chrome for some reason blocks or downloads the PDF instead of
 * rendering it, `waitForEmbed()` will time out — callers can fall back
 * to a plain HTTP request (see `probeUrl`) to still verify the file
 * exists and has the correct Content-Type.
 *
 * Kept as a subclass of MarketplacePage so future callers get the
 * hardened cookie/consent/screenshot pipeline for free, even though this
 * PO doesn't need the megamenu/state-picker helpers.
 */

const logger = require('../utils/logger');
const frameworkConfig = require('../config/framework.config');
const { MarketplacePage } = require('./marketplacePage');

class MarketplaceSitecoreDocsPage extends MarketplacePage {
  constructor(page, options = {}) {
    super(page, { ...options, logTag: options.logTag || 'MP-DOCS' });
  }

  /**
   * Navigate directly to a Sitecore PDF URL.
   *
   * We DON'T use `MarketplacePage.open()` here because it runs the full
   * marketing-site consent pipeline (cookie banner, popups, DOM stability
   * waits) — none of which applies to a raw PDF URL. A plain `page.goto()`
   * with `domcontentloaded` waitUntil is the right primitive.
   */
  async open(url, timeoutMs) {
    const nav = timeoutMs || frameworkConfig.navigationTimeoutMs;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: nav });
    logger.info(this.logTag, `Opened PDF URL: ${url}`);
  }

  /**
   * Wait for Chrome's built-in PDF viewer to mount its `<embed>` element
   * into the top-level document. Returns `{ ok, originalUrl, error }`.
   *
   * We intentionally do NOT throw on timeout — the caller decides whether
   * to fail the step or fall back to an HTTP probe.
   */
  async waitForEmbed(timeoutMs) {
    const t = timeoutMs || frameworkConfig.marketplaceSitecoreDocs?.pdf?.embedTimeoutMs || 20000;
    try {
      const locator = this.page.locator('embed[type="application/x-google-chrome-pdf"]').first();
      await locator.waitFor({ state: 'attached', timeout: t });
      const originalUrl = await locator.getAttribute('original-url').catch(() => '');
      return { ok: true, originalUrl: originalUrl || '', error: '' };
    } catch (err) {
      return { ok: false, originalUrl: '', error: err && err.message ? err.message.substring(0, 200) : String(err) };
    }
  }

  /**
   * Best-effort HTTP probe used when Chrome refuses to render the PDF
   * inline (e.g. WAF challenge, network hiccup). Returns response
   * metadata via Playwright's request context — never throws.
   */
  async probeUrl(url) {
    const timeout = frameworkConfig.marketplaceSitecoreDocs?.pdf?.requestTimeoutMs || 30000;
    try {
      const resp = await this.page.request.get(url, { timeout, maxRedirects: 5 });
      const headers = resp.headers();
      const contentType = headers['content-type'] || '';
      const disposition = headers['content-disposition'] || '';
      const len = Number(headers['content-length']) || 0;
      let bodySize = 0;
      try {
        const buf = await resp.body();
        bodySize = buf ? buf.length : 0;
      } catch { /* ignore — body may be streamed */ }
      return {
        ok: resp.ok(),
        status: resp.status(),
        contentType,
        contentDisposition: disposition,
        contentLength: len || bodySize,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        contentType: '',
        contentDisposition: '',
        contentLength: 0,
        error: err && err.message ? err.message.substring(0, 200) : String(err),
      };
    }
  }

  /**
   * Take a viewport screenshot of the current tab. Overrides the parent
   * `saveScreenshot` because the framework's screenshot pipeline (cookie
   * dismissal, popup nuking, URL bar overlay, DOM-stable waits) doesn't
   * apply to Chrome's PDF viewer surface and can trigger long timeouts
   * against the extension frame.
   */
  async saveScreenshot(filePath) {
    try {
      await this.page.screenshot({ path: filePath, fullPage: false });
    } catch (err) {
      logger.warn('SCREENSHOT', `PDF viewer screenshot failed (${filePath}): ${err.message.substring(0, 120)}`);
    }
  }
}

module.exports = { MarketplaceSitecoreDocsPage };
