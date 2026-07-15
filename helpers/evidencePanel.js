/**
 * Evidence-panel helpers — HTML builders and step-tracker functions.
 *
 * Extracted from tests/planMaterials/planMaterials.spec.js so the spec can focus on
 * business flow while these presentation-layer helpers are reused across
 * the fixture body (setup steps 1–3) and per-plan validation (steps 5–7).
 *
 * All functions here are pure (no Playwright imports, no filesystem I/O)
 * except pushSetupStep/pushPlanStep which log via utils/logger.
 */

const logger = require('../utils/logger');

// ══════════════════════════════════════════════════════════════════════════
// Step trackers — append a timestamped entry to a step array and log it.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Timestamp a setup step, push it into the given array, and log it.
 * @param {Array} setupSteps — per-scope timeline
 * @param {object} step
 */
function pushSetupStep(setupSteps, step) {
  const enriched = { timestamp: new Date().toISOString(), ...step };
  setupSteps.push(enriched);
  const line = `Step ${step.id} | ${step.status} | ${step.name} — ${step.actual || step.description || ''}`;
  if (step.status === 'FAIL') logger.warn('STEP', line);
  else                        logger.info('STEP', line);
}

/**
 * Timestamp a per-plan step, push it into the plan card, and log it.
 */
function pushPlanStep(card, step) {
  const enriched = { timestamp: new Date().toISOString(), ...step };
  card.steps.push(enriched);
  const line = `[${card.name}] Step ${step.id} | ${step.status} | ${step.name} — ${step.actual || step.description || ''}`;
  if (step.status === 'FAIL') logger.warn('PLAN', line);
  else                        logger.info('PLAN', line);
}

// ══════════════════════════════════════════════════════════════════════════
// HTML builders — evidence panels rendered into report screenshots.
// ══════════════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeHtml(status) {
  const up = String(status || '').toUpperCase();
  if (up === 'PASS') return `<span class="badge badge-pass">PASS</span>`;
  if (up === 'FAIL') return `<span class="badge badge-fail">FAIL</span>`;
  return `<span class="badge badge-info">${esc(up || 'INFO')}</span>`;
}

/**
 * Panel for Step 1 — "Open PDF in New Tab".
 * Renders a browser-like "tab" frame with a URL bar at the top and the
 * captured page-level screenshot of the PDF viewer embedded in the body.
 * If the PDF viewport could not be captured (blank / cross-origin), a
 * friendly placeholder is shown BELOW the URL bar so the URL is still
 * clearly visible in the evidence.
 */
function pdfNewTabPanelHtml(planName, pdfUrl, pageScreenshotDataUri, opened) {
  const tabTitle = pdfUrl ? (pdfUrl.split('/').pop() || 'PDF') : 'PDF';
  const body = pageScreenshotDataUri
    ? `<div class="tab-body"><img src="${pageScreenshotDataUri}" alt="PDF viewer for ${esc(planName)}"/></div>`
    : `<div class="tab-empty" style="padding:40px 24px;text-align:center;color:#334155;">
        <div style="font-size:44px;line-height:1;margin-bottom:12px;">📄</div>
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">PDF opened successfully</div>
        <div style="font-size:13px;opacity:.85;max-width:720px;margin:0 auto;">
          Chrome renders PDFs in its built-in viewer, which is not part of the DOM and
          cannot be captured by automation. The URL bar above shows the PDF that opened,
          and the URL validation step below confirms it matches the expected value.
        </div>
      </div>`;
  return `
    <span class="eyebrow">Step 1 — Open PDF in New Tab</span>
    <div class="header-band">
      <div class="title-block">
        <h1>PDF Opened in New Tab</h1>
        <div class="subtitle">${esc(planName)}</div>
      </div>
      ${badgeHtml(opened ? 'PASS' : 'FAIL')}
    </div>
    <div class="tab-frame">
      <div class="tab-bar">
        <div class="tab-dots"><span></span><span></span><span></span></div>
        <div class="tab-title">${esc(tabTitle)}</div>
        <div class="tab-url-wrap">
          <span class="tab-url-icon">🔒</span>
          <span class="tab-url">${esc(pdfUrl || '(no URL)')}</span>
        </div>
      </div>
      ${body}
    </div>
  `;
}

/**
 * Panel for Step 2 — "Verify PDF URL".
 */
function urlValidationPanelHtml(planName, actualUrl, expectedUrl, checks) {
  const overall = checks.every(c => c.pass);
  const checkRows = checks.map(c => `
    <div class="row"><div class="k">${esc(c.label)}</div><div class="v text">${badgeHtml(c.pass ? 'PASS' : 'FAIL')} <span style="margin-left:8px;">${esc(c.detail || '')}</span></div></div>
  `).join('');
  return `
    <span class="eyebrow">Step 2 — Verify PDF URL</span>
    <div class="header-band">
      <div class="title-block">
        <h1>PDF URL Validation</h1>
        <div class="subtitle">${esc(planName)}</div>
      </div>
      ${badgeHtml(overall ? 'PASS' : 'FAIL')}
    </div>
    <div class="row"><div class="k">Selected Plan</div><div class="v text">${esc(planName)}</div></div>
    ${expectedUrl ? `<div class="row"><div class="k">Expected URL</div><div class="v">${esc(expectedUrl)}</div></div>` : ''}
    <div class="row"><div class="k">Actual PDF URL</div><div class="v">${esc(actualUrl || '(empty)')}</div></div>
    ${checkRows}
  `;
}

/**
 * Generic fallback panel — rendered when a primary screenshot is blank or
 * unreadable, so the report never contains an unusable image.
 */
function fallbackPanelHtml(planName, reason) {
  return `
    <span class="eyebrow">Evidence Panel (fallback)</span>
    <div class="header-band">
      <div class="title-block">
        <h1>Screenshot regenerated</h1>
        <div class="subtitle">${esc(planName || 'Setup step')}</div>
      </div>
      ${badgeHtml('INFO')}
    </div>
    <div class="row"><div class="k">Reason</div><div class="v text">${esc(reason || 'Primary screenshot was blank or unreadable.')}</div></div>
    <div class="row"><div class="k">Action</div><div class="v text">Replaced with generated evidence panel so the report never contains a blank image.</div></div>
  `;
}

module.exports = {
  pushSetupStep,
  pushPlanStep,
  esc,
  badgeHtml,
  pdfNewTabPanelHtml,
  urlValidationPanelHtml,
  fallbackPanelHtml,
};
