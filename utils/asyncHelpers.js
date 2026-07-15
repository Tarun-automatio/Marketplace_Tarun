/**
 * Utility helpers for async operations: timing and retries.
 */

const logger = require('./logger');

/**
 * Wrap an async function with timing — logs how long it took.
 * @param {string} label — descriptive label for the log
 * @param {() => Promise<T>} fn — async function to run
 * @returns {Promise<T>}
 */
async function timed(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    logger.info('TIMER', `${label} completed in ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    logger.warn('TIMER', `${label} failed after ${Date.now() - start}ms: ${err.message}`);
    throw err;
  }
}

/**
 * Retry an async function up to `maxRetries` times with a delay between attempts.
 * @param {() => Promise<T>} fn — async function to run
 * @param {number} [maxRetries=2] — number of retries (total attempts = maxRetries + 1)
 * @param {number} [delayMs=1000] — delay between retries in ms
 * @returns {Promise<T>}
 */
async function retry(fn, maxRetries = 2, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        logger.debug('RETRY', `Attempt ${attempt + 1} failed, retrying in ${delayMs}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// Note: module.exports is at the end of the file after all functions are defined.

/**
 * Wait until the DOM has stabilized (no mutations for `stableMs`).
 * Falls back to a maximum wait of `timeoutMs` to avoid hanging.
 *
 * Use this instead of hard `waitForTimeout` calls to adapt to actual
 * page rendering speed rather than guessing a fixed delay.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {number} [options.stableMs=300] — how long DOM must be quiet to consider stable
 * @param {number} [options.timeoutMs=5000] — max time to wait before giving up
 * @returns {Promise<void>}
 */
async function waitForDomStable(page, { stableMs = 300, timeoutMs = 5000 } = {}) {
  await page.evaluate(({ stableMs: s, timeoutMs: t }) => {
    return new Promise((resolve) => {
      let timer = null;
      const deadline = Date.now() + t;

      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        if (Date.now() >= deadline) {
          observer.disconnect();
          resolve();
          return;
        }
        timer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, s);
      });

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Start the initial stability timer
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, s);

      // Hard deadline fallback
      setTimeout(() => {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }, t);
    });
  }, { stableMs, timeoutMs }).catch(() => {});
}

module.exports = { timed, retry, waitForDomStable };
