/**
 * Browser Helper
 * Shared browser context setup, teardown, and test helper functions
 * extracted from the test spec for reusability and maintainability.
 */
const path = require('path');
const fs = require('fs');
const frameworkConfig = require('../config/framework.config');
const logger = require('./logger');
const { sanitizeFileName } = require('./comparisonCommon');

// ── Derived config values ──

const tolerance = frameworkConfig.comparisonTolerance;
const requireTitleMatch = tolerance.requireTitleMatch === true;
const requireTextDeltaCheck = tolerance.requireTextDeltaCheck === true;
const defaultLanguage = frameworkConfig.languageDefaults || {};
const defaultConsentTexts = frameworkConfig.consentButtonTexts || [];

// ── Browser context defaults ──

const browserContextOptions = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  locale: defaultLanguage.locale || 'en-US',
  timezoneId: 'America/Chicago',
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: {
    'Accept-Language': defaultLanguage.acceptLanguageHeader || 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="134", "Google Chrome";v="134", "Not:A-Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  }
};

// ── Helper functions ──

function buildContextOptionsForRow(row) {
  const locale = row.locale || browserContextOptions.locale;
  const acceptLanguageHeader = row.acceptLanguageHeader || browserContextOptions.extraHTTPHeaders['Accept-Language'];

  return {
    ...browserContextOptions,
    locale,
    extraHTTPHeaders: {
      ...browserContextOptions.extraHTTPHeaders,
      'Accept-Language': acceptLanguageHeader
    }
  };
}

function buildConsentTextsForRow(row) {
  return row.consentTexts && row.consentTexts.length
    ? row.consentTexts
    : defaultConsentTexts;
}

function logStateStart(row, rowContextOptions) {
  logger.section(`Starting: ${row.state}`);
  logger.info('STATE', `QA URL: ${row.qaUrl}`);
  logger.info('STATE', `PROD URL: ${row.prodUrl}`);
  logger.info('LANG', `locale=${rowContextOptions.locale}, Accept-Language=${rowContextOptions.extraHTTPHeaders['Accept-Language']}`);
}

function createScreenshotPaths(state) {
  const stateFolder = sanitizeFileName(state);
  const screenshotsDir = path.join(frameworkConfig.reportOutputDir, 'screenshots', stateFolder);
  fs.mkdirSync(screenshotsDir, { recursive: true });

  return {
    qaScreenshot: path.join(screenshotsDir, 'qa_full.png'),
    prodScreenshot: path.join(screenshotsDir, 'prod_full.png'),
    qaMismatchScreenshot: path.join(screenshotsDir, 'qa_mismatch_highlight.png'),
    prodMismatchScreenshot: path.join(screenshotsDir, 'prod_mismatch_highlight.png')
  };
}

function resolveStatus(environmentBlocked, comparison) {
  if (environmentBlocked) {
    return 'BLOCKED';
  }

  const matchesTitle = !requireTitleMatch || comparison.titleMatch;
  const withinTextTolerance = !requireTextDeltaCheck || comparison.textDeltaPercent <= tolerance.maxTextDeltaPercent;

  return matchesTitle && withinTextTolerance
    ? 'PASS'
    : 'FAIL';
}

function assertStateExpectations(environmentBlocked, comparison) {
  if (environmentBlocked) {
    return;
  }

  const thresholdNotes = [];
  if (requireTitleMatch && !comparison.titleMatch) {
    thresholdNotes.push('title mismatch');
  }
  if (requireTextDeltaCheck && comparison.textDeltaPercent > tolerance.maxTextDeltaPercent) {
    thresholdNotes.push(`text delta ${comparison.textDeltaPercent}% exceeds ${tolerance.maxTextDeltaPercent}%`);
  }

  if (thresholdNotes.length) {
    logger.info('ASSERT', `Mismatches recorded for reporting only: ${thresholdNotes.join(', ')}`);
  }
}

async function clearBrowserData(page, label) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Storage.clearDataForOrigin', {
      origin: '*',
      storageTypes: 'all'
    }).catch(() => {});
    await cdp.detach();
    logger.info('BROWSER', `${label}: browser cache, cookies & storage cleared via CDP`);
  } catch (e) {
    logger.debug('BROWSER', `${label}: CDP cache clear skipped (${e.message.substring(0, 50)})`);
  }
}

/**
 * Bypass Chrome "Your connection is not private" SSL interstitial page.
 * Clicks "Advanced" then "Proceed to <site>" if the error page is detected.
 * @param {import('@playwright/test').Page} page
 * @param {string} [label='']
 * @returns {Promise<boolean>} true if SSL error was bypassed
 */
async function bypassSSLError(page, label = '') {
  try {
    const isSSLError = await page.evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      return body.includes('your connection is not private') ||
             body.includes('net::err_cert') ||
             body.includes('privacy error');
    }).catch(() => false);

    if (!isSSLError) return false;

    logger.warn('SSL', `${label} SSL certificate error detected — attempting bypass`);

    const advancedBtn = page.locator('#details-button, button:has-text("Advanced")');
    if (await advancedBtn.isVisible({ timeout: frameworkConfig.elementProbeTimeoutMs }).catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(500);
    }

    const proceedLink = page.locator('#proceed-link, a:has-text("Proceed"), a:has-text("Continue")');
    if (await proceedLink.isVisible({ timeout: frameworkConfig.elementProbeTimeoutMs }).catch(() => false)) {
      await proceedLink.click();
      await page.waitForLoadState('domcontentloaded', { timeout: frameworkConfig.navigationTimeoutMs }).catch(() => {});
      logger.info('SSL', `${label} SSL error bypassed successfully`);
      return true;
    }

    logger.warn('SSL', `${label} Could not find proceed link after clicking Advanced`);
    return false;
  } catch (err) {
    logger.warn('SSL', `${label} SSL bypass attempt failed: ${err.message.substring(0, 80)}`);
    return false;
  }
}

/**
 * Thorough context cleanup — clear CDP cache/cookies for all pages, then close context.
 * @param {import('@playwright/test').BrowserContext} ctx
 */
async function clearContext(ctx) {
  for (const p of ctx.pages()) {
    try {
      const cdp = await p.context().newCDPSession(p);
      await Promise.all([cdp.send('Network.clearBrowserCache'), cdp.send('Network.clearBrowserCookies')]);
      await cdp.detach();
    } catch { /* ignore */ }
    await p.close().catch(() => {});
  }
  await ctx.clearCookies().catch(() => {});
  await ctx.close().catch(() => {});
}

/**
 * Auto-dismiss JS dialogs on one or more pages.
 * @param  {...import('@playwright/test').Page} pages
 */
function setupDialogHandlers(...pages) {
  for (const page of pages) {
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  }
}

/**
 * Full cleanup between test runs to prevent Access Denied / WAF blocks.
 * Clears CDP cache, cookies, and storage for all open pages in each context,
 * then closes pages, clears context cookies/permissions, closes contexts,
 * closes any standalone browser instances, removes persistent profile directories,
 * and applies a cooldown delay.
 *
 * @param {Object} options
 * @param {import('@playwright/test').BrowserContext[]} [options.contexts] - Contexts to clean up and close
 * @param {import('@playwright/test').Browser[]} [options.browsers] - Browser instances to close completely
 * @param {string[]} [options.profileDirs] - Persistent profile directories to delete
 * @param {number} [options.cooldownMs] - Cooldown in ms (defaults to frameworkConfig.testCooldownMs)
 */
async function cleanupBetweenTests({ contexts = [], browsers = [], profileDirs = [], cooldownMs } = {}) {
  const effectiveCooldown = cooldownMs ?? Number(frameworkConfig.testCooldownMs || 5000);

  // 1. Clear CDP data + close pages + close contexts
  for (const ctx of contexts) {
    if (!ctx) continue;
    try {
      for (const p of ctx.pages()) {
        try {
          const cdp = await p.context().newCDPSession(p);
          await cdp.send('Network.clearBrowserCache');
          await cdp.send('Network.clearBrowserCookies');
          await cdp.send('Storage.clearDataForOrigin', { origin: '*', storageTypes: 'all' }).catch(() => {});
          await cdp.detach();
        } catch { /* ignore */ }
        await p.close().catch(() => {});
      }
      await ctx.clearCookies().catch(() => {});
      await ctx.close().catch(() => {});
    } catch { /* ignore */ }
  }

  // 2. Close standalone browser instances completely (flushes DNS cache, TLS sessions, connection pools)
  for (const br of browsers) {
    if (!br) continue;
    try { await br.close(); } catch { /* ignore */ }
  }

  // 3. Remove persistent profile directories
  for (const dir of profileDirs) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 4. Cooldown to avoid WAF/Akamai rate-limiting
  if (effectiveCooldown > 0) {
    logger.info('ENV', `Cooldown ${effectiveCooldown / 1000}s between tests — browser closed & cache cleared`);
    await new Promise(r => setTimeout(r, effectiveCooldown));
  }
}

/**
 * Launch a fresh isolated Chromium browser for a single test run.
 * This ensures no state leaks (DNS, TLS, connection pools) between URL executions.
 * The caller MUST close this browser in the finally block via cleanupBetweenTests().
 *
 * @param {Object} [extraOptions] - Additional launch options
 * @returns {Promise<import('@playwright/test').Browser>}
 */
async function launchFreshBrowser(extraOptions = {}) {
  const { chromium } = require('@playwright/test');
  // In headed mode, maximise the Chrome window so the page uses the full
  // monitor. Combined with `viewport: null` on the context (see spec), this
  // avoids the "page shifted to the left" problem that happens when
  // Playwright forces a 1920×1080 CSS viewport into a window that's smaller
  // than the monitor can display.
  const headedWindowArgs = frameworkConfig.headless
    ? []
    : ['--start-maximized'];
  const browser = await chromium.launch({
    headless: frameworkConfig.headless,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-keychain',
      ...headedWindowArgs,
    ],
    ...extraOptions,
  });
  logger.info('BROWSER', 'Launched fresh Chrome browser instance for this test run');
  return browser;
}

/**
 * Apply stealth scripts to a browser context to bypass WAF/bot detection.
 * Must be called BEFORE creating any pages on the context.
 * Works with both regular contexts (browser.newContext()) and persistent contexts.
 * @param {import('@playwright/test').BrowserContext} context
 */
async function applyStealthScripts(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

module.exports = {
  browserContextOptions,
  buildContextOptionsForRow,
  buildConsentTextsForRow,
  logStateStart,
  createScreenshotPaths,
  resolveStatus,
  assertStateExpectations,
  clearBrowserData,
  bypassSSLError,
  clearContext,
  setupDialogHandlers,
  cleanupBetweenTests,
  launchFreshBrowser,
  applyStealthScripts,
};
