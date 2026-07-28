/**
 * Screenshot helpers for focused, high-signal evidence capture.
 *
 * Provides:
 *   • readPngDimensions / isProbablyBlank / validateScreenshotImage
 *       — inspect PNG files without any external dependency
 *   • captureElementScreenshot   — element-level (optionally padded)
 *   • captureClippedScreenshot   — union bounding-box clip of multiple elements
 *   • highlightLocator           — apply a temporary CSS highlight to an
 *                                  element and return an async cleanup
 *   • highlightAndCapture        — apply temporary CSS highlight to a target,
 *                                  screenshot the enclosing container, always restore
 *   • captureEvidencePanel       — render an in-memory HTML panel in a fresh
 *                                  page and screenshot just that panel
 *   • ensureValidScreenshot      — take a shot + validate + regenerate via
 *                                  fallback if the file is blank / invalid
 *
 * These utilities intentionally avoid `page.screenshot({ fullPage: true })`
 * so the report contains only focused, business-relevant evidence.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// ─── PNG file inspection (no external deps) ───────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read PNG width / height from the IHDR chunk without loading the whole file.
 * Returns null when the file is not a PNG or cannot be read.
 */
function readPngDimensions(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

/**
 * Heuristic blank/solid-colour detection based on how well the PNG compressed
 * relative to its pixel count. A pure white (or fully transparent) PNG
 * compresses to a very small file (< ~0.002 bytes per pixel for large images).
 *
 * This is fast (no image decoding), zero-dep, and reliable enough for the
 * "did the PDF viewer render anything?" question.
 */
function isProbablyBlank(filePath) {
  try {
    const dim = readPngDimensions(filePath);
    if (!dim) return false; // non-PNG — cannot judge
    const stat = fs.statSync(filePath);
    const pixels = dim.width * dim.height;
    if (pixels < 100) return true;
    const bytesPerPixel = stat.size / pixels;
    return bytesPerPixel < 0.002;
  } catch { return false; }
}

/**
 * Validate an image file for the report. Returns:
 *   { valid, reason, width, height, sizeBytes }
 */
function validateScreenshotImage(filePath) {
  if (!filePath) return { valid: false, reason: 'no path provided' };
  if (!fs.existsSync(filePath)) return { valid: false, reason: 'file does not exist' };
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return { valid: false, reason: 'empty file (0 bytes)' };

  const dim = readPngDimensions(filePath);
  if (!dim) {
    return { valid: true, width: 0, height: 0, sizeBytes: stat.size, reason: 'non-PNG (dimension check skipped)' };
  }
  if (dim.width === 0 || dim.height === 0) return { valid: false, reason: 'zero dimensions', width: dim.width, height: dim.height, sizeBytes: stat.size };
  if (isProbablyBlank(filePath)) return { valid: false, reason: 'appears blank / solid colour', width: dim.width, height: dim.height, sizeBytes: stat.size };
  return { valid: true, width: dim.width, height: dim.height, sizeBytes: stat.size };
}

// ─── Element / container screenshots ──────────────────────────────────────

/**
 * Element-level screenshot with optional pixel padding around the element.
 *
 * When padding > 0 we compute a clipping rectangle from the element's bounding
 * box and use `page.screenshot({ clip })` (which is still bounded by the
 * viewport). When padding = 0 we use the native `locator.screenshot()` which
 * captures the element even if it exceeds the viewport height.
 */
async function captureElementScreenshot(locator, filePath, options = {}) {
  const { padding = 0, timeout = 10000, animations = 'disabled' } = options;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await locator.waitFor({ state: 'visible', timeout });

  if (padding > 0) {
    const box = await locator.boundingBox();
    if (box) {
      const page = locator.page();
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };
      const clip = {
        x: Math.max(0, box.x - padding),
        y: Math.max(0, box.y - padding),
        width: Math.min(viewport.width, box.width + padding * 2),
        height: Math.min(viewport.height, box.height + padding * 2),
      };
      await page.screenshot({ path: filePath, clip, animations });
      return filePath;
    }
  }
  await locator.screenshot({ path: filePath, animations });
  return filePath;
}

/**
 * Apply a temporary visual highlight (bright yellow background + amber
 * outline + soft glow) to the given locator so it stands out in the
 * screenshot the caller is about to take. Returns an async cleanup
 * function that restores the element's original inline `style` — call it
 * from a `finally` block so a screenshot failure never leaves the DOM
 * decorated.
 *
 * Kept separate from `highlightAndCapture` because most callers want to
 * decide themselves whether the screenshot is element-level, viewport, or
 * full-page (and whether it should be routed through the framework's
 * `saveScreenshot` or a raw `page.screenshot`).
 *
 * @example
 *   const clearHighlight = await highlightLocator(ctaLocator);
 *   try {
 *     await page.screenshot({ path: 'Step2.png' });
 *   } finally {
 *     await clearHighlight();
 *   }
 *
 * @param {import('@playwright/test').Locator} locator   — element to highlight
 * @param {object} [options]
 * @param {string} [options.style]      — CSS applied inline. Defaults to a
 *   bright yellow highlight suitable for evidence screenshots.
 * @param {boolean} [options.scrollIntoView=true] — scroll target into view
 *   before applying the highlight so it's actually visible in the shot.
 * @param {number} [options.settleMs=150] — paint-settle pause after applying
 *   the highlight (browser reflow can lag a frame or two).
 * @returns {Promise<() => Promise<void>>} async cleanup function. Idempotent
 *   and safe to call multiple times.
 */
async function highlightLocator(locator, options = {}) {
  const {
    style = 'outline: 3px solid #f9a825 !important; outline-offset: 2px;'
          + ' background-color: #fff59d !important;'
          + ' box-shadow: 0 0 0 4px rgba(249,168,37,0.35) !important;'
          + ' border-radius: 4px !important;'
          + ' transition: none !important;',
    scrollIntoView = true,
    settleMs = 150,
  } = options;

  const handle = await locator.elementHandle();
  if (!handle) {
    // Nothing to highlight — return a no-op cleanup so callers don't
    // have to null-check.
    return async () => {};
  }

  if (scrollIntoView) {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
  }

  try {
    await handle.evaluate((el, css) => {
      // Save the pre-existing inline style verbatim so we can restore it
      // exactly (including "" for elements that had no style attribute).
      const had  = el.hasAttribute('style');
      const prev = el.getAttribute('style') || '';
      el.setAttribute('data-pw-hl-had', had ? '1' : '0');
      el.setAttribute('data-pw-hl-prev', prev);
      el.setAttribute('style', prev ? `${prev};${css}` : css);
    }, style);
  } catch {
    // If the element vanished mid-decoration, skip cleanup entirely.
    await handle.dispose().catch(() => {});
    return async () => {};
  }

  if (settleMs > 0) {
    await locator.page().waitForTimeout(settleMs);
  }

  let cleared = false;
  return async function clearHighlight() {
    if (cleared) return;
    cleared = true;
    try {
      await handle.evaluate((el) => {
        const had  = el.getAttribute('data-pw-hl-had') === '1';
        const prev = el.getAttribute('data-pw-hl-prev') || '';
        if (had && prev) el.setAttribute('style', prev);
        else             el.removeAttribute('style');
        el.removeAttribute('data-pw-hl-had');
        el.removeAttribute('data-pw-hl-prev');
      });
    } catch { /* ignore — DOM may have changed */ }
    finally { await handle.dispose().catch(() => {}); }
  };
}

/**
 * Highlight the `target` element (border + background), take an element
 * screenshot of the enclosing `container`, then restore the target's original
 * inline styles. Restoration runs in a `finally` block so a screenshot
 * failure never leaves the DOM decorated.
 *
 * @param {import('@playwright/test').Locator} container — element to screenshot
 * @param {import('@playwright/test').Locator} target    — element to highlight
 * @param {string} filePath                              — output PNG path
 * @param {object} [options]
 * @param {string} [options.style]   — CSS applied to the target
 * @param {number} [options.padding] — extra pixels around the container screenshot
 * @param {number} [options.timeout]
 */
async function highlightAndCapture(container, target, filePath, options = {}) {
  const {
    style = 'outline: 3px solid #d13d3d !important; outline-offset: 3px; background-color: #fff8c4 !important; box-shadow: 0 0 0 3px rgba(209,61,61,0.25) !important; border-radius: 4px !important;',
    padding = 8,
    timeout = 10000,
  } = options;

  const page = container.page();
  await target.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await container.waitFor({ state: 'visible', timeout });

  const handle = await target.elementHandle();
  try {
    if (handle) {
      await handle.evaluate((el, css) => {
        const prev = el.getAttribute('style') || '';
        el.setAttribute('data-pw-prev-style', prev);
        el.setAttribute('style', `${prev};${css}`);
      }, style);
    }
    await page.waitForTimeout(120); // allow paint before capturing
    await captureElementScreenshot(container, filePath, { padding, timeout });
  } finally {
    if (handle) {
      await handle.evaluate((el) => {
        const prev = el.getAttribute('data-pw-prev-style');
        if (prev === null || prev === '') el.removeAttribute('style');
        else el.setAttribute('style', prev);
        el.removeAttribute('data-pw-prev-style');
      }).catch(() => {});
      await handle.dispose().catch(() => {});
    }
  }
  return filePath;
}

// ─── Evidence panel screenshots ───────────────────────────────────────────

/**
 * Shared CSS for every evidence panel — kept as a template literal so the
 * generated panel is a self-contained document (no external CSS references).
 */
function evidencePanelCss() {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef2f7; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #1a1a2e; padding: 20px; }
    .panel { background: #ffffff; border-radius: 14px; box-shadow: 0 8px 32px rgba(15,23,42,0.08); border: 1px solid #dfe3e8; padding: 22px 26px; }
    .panel .eyebrow { display: inline-block; background: #dbeafe; color: #1e40af; padding: 3px 12px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 10px; }
    .panel h1 { margin: 0 0 4px; font-size: 1.15rem; color: #0d3d80; }
    .panel .subtitle { color: #5c6370; font-size: 0.82rem; margin-bottom: 14px; }
    .row { display: flex; padding: 8px 0; border-bottom: 1px dashed #e6ebf1; gap: 12px; }
    .row:last-child { border-bottom: none; }
    .row .k { flex: 0 0 190px; color: #5c6370; font-weight: 600; font-size: 0.82rem; letter-spacing: 0.2px; }
    .row .v { flex: 1; color: #1a1a2e; font-size: 0.92rem; word-break: break-word; font-family: 'Consolas','Menlo', monospace; }
    .row .v.text { font-family: 'Segoe UI', system-ui, sans-serif; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-weight: 700; font-size: 0.82rem; letter-spacing: 0.3px; }
    .badge-pass { background: #e6f9ed; color: #0a7d34; border: 1px solid #b7e4c7; }
    .badge-fail { background: #fff1f0; color: #c4320a; border: 1px solid #f0b7ac; }
    .badge-info { background: #dbeafe; color: #1e40af; border: 1px solid #b0cbf4; }
    .score-wrap { margin-top: 4px; }
    .score-bar { height: 12px; background: #eef2f7; border-radius: 999px; overflow: hidden; margin-top: 6px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.05); }
    .score-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #ef4444 0%, #f59e0b 45%, #10b981 80%); }
    .score-num { font-size: 1.5rem; font-weight: 800; color: #0d3d80; }
    .reasons { margin-top: 12px; padding: 10px 14px; background: #f8fafc; border-left: 3px solid #60a5fa; border-radius: 6px; font-size: 0.82rem; color: #334155; }
    .reasons ul { margin: 0; padding-left: 18px; }
    .reasons li { margin: 2px 0; }
    .header-band { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .header-band .title-block { flex: 1; }

    /* ── "PDF opened in new tab" composite (URL bar + embedded viewport screenshot) ── */
    .tab-frame { border: 1px solid #dfe3e8; border-radius: 10px; overflow: hidden; background: #ffffff; box-shadow: 0 4px 14px rgba(15,23,42,0.05); margin-top: 8px; }
    .tab-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: linear-gradient(180deg, #f1f5fb 0%, #e5edf7 100%); border-bottom: 1px solid #dfe3e8; }
    .tab-dots { display: flex; gap: 5px; margin-right: 6px; }
    .tab-dots span { width: 10px; height: 10px; border-radius: 50%; background: #cbd5e1; }
    .tab-dots span:nth-child(1) { background: #ef4444; }
    .tab-dots span:nth-child(2) { background: #f59e0b; }
    .tab-dots span:nth-child(3) { background: #10b981; }
    .tab-title { color: #475569; font-size: 0.78rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .tab-url-wrap { flex: 1; background: #ffffff; border: 1px solid #dbe0e6; border-radius: 999px; padding: 5px 12px; display: flex; align-items: center; gap: 8px; min-width: 0; }
    .tab-url-icon { color: #16a34a; font-weight: 700; font-size: 0.78rem; }
    .tab-url { color: #0d3d80; font-family: 'Consolas','Menlo', monospace; font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .tab-body { background: #ffffff; }
    .tab-body img { display: block; width: 100%; height: auto; max-height: 620px; object-fit: cover; object-position: top; }
    .tab-empty { padding: 40px 20px; text-align: center; color: #64748b; font-size: 0.88rem; background: #f8fafc; }
    .tab-empty strong { color: #0d3d80; }
  `;
}

/**
 * Render a self-contained HTML "evidence panel" in a fresh in-memory page and
 * capture just the .panel element. This gives professional, readable evidence
 * for validations where a page screenshot would be uninformative (e.g. Chrome
 * PDF viewer which cannot be captured reliably).
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} bodyHtml — HTML that goes inside <div class="panel">
 * @param {string} filePath — output PNG path
 * @param {object} [opts]
 * @param {number} [opts.width=1920]
 * @param {number} [opts.height=1080]
 */
async function captureEvidencePanel(context, bodyHtml, filePath, opts = {}) {
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const html = `<!doctype html><html><head><meta charset="utf-8"/><style>${evidencePanelCss()}</style></head>
<body><div class="panel">${bodyHtml}</div></body></html>`;

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width, height });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const panel = page.locator('.panel');
    await panel.waitFor({ state: 'visible' });
    // Give the browser a moment to lay out fonts/borders cleanly.
    await page.waitForTimeout(80);
    // Screenshot the whole viewport (not just the .panel element) so every
    // report image is exactly `width × height` — keeps the report uniform.
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Take a screenshot via `takeShotFn`, validate it, and if it is invalid /
 * blank fall back to a generated evidence panel so we NEVER attach a bad
 * screenshot to the report.
 *
 * @param {() => Promise<string>} takeShotFn — must resolve to the written file path
 * @param {() => Promise<string>} fallbackPanelFn — must resolve to the fallback file path
 * @returns {Promise<{filePath: string, valid: boolean, fallbackUsed: boolean, reason?: string}>}
 */
async function ensureValidScreenshot(takeShotFn, fallbackPanelFn) {
  let filePath = null;
  let reason = null;
  try {
    filePath = await takeShotFn();
    const check = validateScreenshotImage(filePath);
    if (check.valid) return { filePath, valid: true, fallbackUsed: false };
    reason = check.reason || 'validation failed';
    logger.warn('SCREENSHOT', `Primary screenshot invalid (${reason}) — switching to evidence-panel fallback`);
  } catch (err) {
    reason = err.message ? err.message.substring(0, 140) : String(err);
    logger.warn('SCREENSHOT', `Primary screenshot threw (${reason}) — switching to evidence-panel fallback`);
  }
  try {
    const fallback = await fallbackPanelFn();
    return { filePath: fallback, valid: true, fallbackUsed: true, reason };
  } catch (fbErr) {
    logger.warn('SCREENSHOT', `Fallback panel also failed: ${fbErr.message.substring(0, 140)}`);
    return { filePath: filePath || null, valid: false, fallbackUsed: false, reason };
  }
}

// ─── Real PDF preview via pdfjs-dist ──────────────────────────────────────
//
// Chrome's built-in PDF viewer is not part of the DOM and cannot be
// captured by page.screenshot / CDP Page.captureScreenshot (both return a
// blank/uniform image). This helper renders page 1 of the PDF ourselves
// using pdfjs-dist inside a fresh Playwright page, then returns a data URI
// of the canvas — visually identical to what a user sees when they open
// the PDF in a new Chrome tab.
//
// Design notes:
//   • Fetches PDF bytes through `context.request` so any session cookies /
//     bearer headers set on the browser context are honoured.
//   • Uses pdfjs-dist v3 UMD build (`legacy/build/pdf.min.js`) — the newer
//     v4 ships ESM only which `page.addScriptTag` cannot load as a plain
//     <script>.
//   • The worker file is read once and injected into the page as a Blob
//     URL, so pdfjs can spawn its Web Worker without any HTTP server.
//   • Safe by construction: any thrown error is caught in the caller
//     (`ensureValidScreenshot` / a try/catch) so failure falls back to the
//     existing placeholder panel.

let _pdfjsLibSource = null;
let _pdfjsWorkerSource = null;

function loadPdfjsSources() {
  if (_pdfjsLibSource && _pdfjsWorkerSource) return;
  const libPath    = require.resolve('pdfjs-dist/legacy/build/pdf.min.js');
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.js');
  _pdfjsLibSource    = fs.readFileSync(libPath, 'utf8');
  _pdfjsWorkerSource = fs.readFileSync(workerPath, 'utf8');
}

/**
 * Render page 1 of a PDF to a PNG data URI using pdfjs-dist inside a fresh
 * Playwright page. Returns null on failure so callers can fall back cleanly.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} pdfUrl        — absolute URL of the PDF
 * @param {object} [opts]
 * @param {number} [opts.scale=1.5]  — pdfjs render scale (higher = sharper)
 * @param {number} [opts.timeout=30000]  — overall timeout in ms
 * @returns {Promise<string|null>}   — `data:image/png;base64,...` or null
 */
async function renderPdfFirstPageAsDataUri(context, pdfUrl, opts = {}) {
  const scale   = opts.scale   || 1.5;
  const timeout = opts.timeout || 30000;

  if (!pdfUrl) return null;

  try {
    loadPdfjsSources();
  } catch (err) {
    logger.warn('PDF', `pdfjs-dist not available: ${err.message.substring(0, 120)}`);
    return null;
  }

  // 1) Fetch PDF bytes through Playwright's request context so cookies /
  //    auth headers from the browser context are reused.
  let pdfBytes;
  try {
    const response = await context.request.get(pdfUrl, { timeout });
    if (!response.ok()) {
      logger.warn('PDF', `PDF fetch returned HTTP ${response.status()} — ${pdfUrl}`);
      return null;
    }
    pdfBytes = await response.body();
  } catch (err) {
    logger.warn('PDF', `PDF fetch failed: ${err.message.substring(0, 140)}`);
    return null;
  }
  if (!pdfBytes || pdfBytes.length < 100) return null;

  const base64 = pdfBytes.toString('base64');

  // 2) Open a fresh page and render page 1 to a canvas via pdfjs-dist.
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1200, height: 1600 });
    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:#ffffff;"></body></html>',
      { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: _pdfjsLibSource });

    const dataUri = await page.evaluate(async ({ workerSrc, base64, scale }) => {
      // Set up the pdfjs worker as a Blob URL (no HTTP server needed).
      const blob = new Blob([workerSrc], { type: 'application/javascript' });
      const workerBlobUrl = URL.createObjectURL(blob);
      // eslint-disable-next-line no-undef
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;

      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      // eslint-disable-next-line no-undef
      const pdf = await pdfjsLib.getDocument({ data: bytes, disableFontFace: false }).promise;
      const pg = await pdf.getPage(1);
      const viewport = pg.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width  = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      document.body.appendChild(canvas);

      const ctx2d = canvas.getContext('2d');
      // Paint a white background so transparent PDFs still look right.
      ctx2d.fillStyle = '#ffffff';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);

      await pg.render({ canvasContext: ctx2d, viewport }).promise;
      return canvas.toDataURL('image/png');
    }, { workerSrc: _pdfjsWorkerSource, base64, scale });

    if (!dataUri || !dataUri.startsWith('data:image/png;base64,')) return null;
    return dataUri;
  } catch (err) {
    logger.warn('PDF', `pdfjs render failed: ${err.message.substring(0, 160)}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  readPngDimensions,
  isProbablyBlank,
  validateScreenshotImage,
  captureElementScreenshot,
  highlightLocator,
  highlightAndCapture,
  captureEvidencePanel,
  ensureValidScreenshot,
  renderPdfFirstPageAsDataUri,
};
