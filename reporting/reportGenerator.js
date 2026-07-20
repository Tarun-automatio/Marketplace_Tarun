/**
 * PlanMaterials report generator — self-contained.
 *
 * Renders a single-file HTML report with:
 *   • Sticky summary bar (KPIs + overall status)
 *   • Test-details header
 *   • KPI grid (plans / validations / setup issues)
 *   • Setup Steps table (steps 1–3)
 *   • Plans Table of Contents
 *   • Per-plan cards with validation chips + step tables
 *   • Lightbox viewer (keyboard nav + zoom)
 *
 * Screenshots are embedded as base64 data URIs so the HTML is portable —
 * blank / invalid images are automatically replaced with a placeholder tile.
 *
 * PUBLIC API
 *   writeReport(ctx)
 *     ctx = {
 *       reportDir,       // string   — folder to create; the HTML lives here
 *       reportFile,      // string   — absolute path of the HTML file to write
 *       testMeta,        // { name, id, module, description, author, environment }
 *       appUrl,          // string
 *       year,            // string
 *       accordionLabel,  // string
 *       setupSteps,      // [{ id, name, status, expected, actual, screenshotPath, screenshotLabel }]
 *       planCards,       // [{ id, name, status, pdfUrl, expectedUrl, ..., steps, validations }]
 *       responsiveShots, // [{ key, label, viewport:{width,height}, filePath }] — optional
 *       durationMs,      // number
 *       timestamp,       // string (already formatted for display)
 *     }
 *
 * The generator is completely decoupled from Playwright — it only needs `fs`,
 * `path`, and the image-validation helper from `utils/screenshotHelpers`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateScreenshotImage } = require('../utils/screenshotHelpers');

// ══════════════════════════════════════════════════════════════════════════
// HTML helpers
// ══════════════════════════════════════════════════════════════════════════

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function reportStatusBadge(status) {
  const up = String(status || '').toUpperCase();
  if (up === 'PASS') return `<span class="badge badge-pass">PASS</span>`;
  if (up === 'FAIL') return `<span class="badge badge-fail">FAIL</span>`;
  return `<span class="badge badge-info">${escapeHtml(up || 'INFO')}</span>`;
}

/**
 * Embed an image as a base64 data URI, but ONLY if it passes the blank/valid
 * check. Returns null if the image is missing or invalid — the caller decides
 * how to render the placeholder.
 */
function embedImageOrNull(filePath) {
  const check = validateScreenshotImage(filePath);
  if (!check.valid) return null;
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, ...check };
  } catch { return null; }
}

/**
 * Render a single thumbnail card (clickable — opens lightbox).
 * `imageIndex` is the 0-based position in the global lightbox image list, used
 * for prev/next navigation.
 */
function renderThumbnail(title, filePath, imageIndex, opts = {}) {
  const img = embedImageOrNull(filePath);
  const safeTitle = escapeHtml(title || '');
  if (!img) {
    return `
      <div class="thumb thumb-empty" title="${safeTitle}">
        <div class="thumb-empty-icon">🚫</div>
        <div class="thumb-title">${safeTitle}</div>
        <div class="thumb-caption">Screenshot unavailable</div>
      </div>`;
  }
  // `opts.simpleCaption` suppresses the trailing resolution — used by
  // writeStepsReport() for the marketplace suite where every screenshot
  // is a uniform 1920×1080 so the resolution string is just visual noise.
  const caption = opts.simpleCaption
    ? 'Click to view'
    : `Click to view · ${img.width || '?'}×${img.height || '?'}`;
  return `
    <div class="thumb" onclick="openLightbox(${imageIndex})" title="${safeTitle}">
      <div class="thumb-img-wrap"><img src="${img.dataUri}" alt="${safeTitle}" loading="lazy"/></div>
      <div class="thumb-title">${safeTitle}</div>
      <div class="thumb-caption">${caption}</div>
    </div>`;
}

/**
 * Render an array of step objects as a table:
 *   Step # | Step | Description (Expected / Actual) | Screenshot
 */
function renderStepsTable(steps, opts = {}) {
  const emptyMsg = opts.emptyMsg || 'No steps recorded.';
  const thumbOpts = opts.thumbOpts || {};
  if (!steps.length) return `<div class="empty-msg">${escapeHtml(emptyMsg)}</div>`;
  const rows = steps.map((s) => {
    const thumb = s.screenshotPath
      ? renderThumbnail(s.screenshotLabel || s.name, s.screenshotPath, s.__imgIdx, thumbOpts)
      : '<div class="empty-msg" style="padding:8px;">No screenshot</div>';
    const expected = s.expected || '';
    const actual   = s.actual   || s.description || '';
    return `
      <tr class="steps-row steps-row-${(s.status || 'info').toLowerCase()}">
        <td class="steps-num">${s.id}</td>
        <td class="steps-name">
          <div class="steps-title">${escapeHtml(s.name || '')}</div>
          <div class="steps-status">${reportStatusBadge(s.status)}</div>
        </td>
        <td class="steps-desc">
          ${expected ? `<div class="er"><span class="er-k">Expected Result:</span> <span class="er-v">${escapeHtml(expected)}</span></div>` : ''}
          <div class="ar"><span class="ar-k ar-k-${(s.status || 'info').toLowerCase()}">Actual Result:</span> <span class="ar-v">${escapeHtml(actual)}</span></div>
        </td>
        <td class="steps-shot">${thumb}</td>
      </tr>`;
  }).join('');
  return `
    <div class="steps-table-wrap">
      <table class="steps-table">
        <thead>
          <tr>
            <th style="width:60px;">Step #</th>
            <th style="width:230px;">Step</th>
            <th>Description</th>
            <th style="width:260px;">Screenshot</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

const renderSetupStepsTable = (steps) =>
  renderStepsTable(steps, { emptyMsg: 'No setup steps recorded.' });

function renderPlanCard(card) {
  const stepsHtml = renderStepsTable(card.steps || [], { emptyMsg: 'No plan steps recorded.' });

  const expectedItem = card.expectedUrl
    ? `<li class="plan-fact-item"><span class="plan-fact-k">Expected URL:</span> <span class="plan-fact-v mono">${escapeHtml(card.expectedUrl)}</span></li>`
    : '';
  const actualHref  = card.pdfUrl || card.href || '#';
  const actualLabel = card.pdfUrl || card.href || '(none)';
  const actualItem  = `<li class="plan-fact-item"><span class="plan-fact-k">Actual PDF URL:</span> <span class="plan-fact-v mono"><a href="${escapeHtml(actualHref)}" target="_blank" rel="noopener">${escapeHtml(actualLabel)}</a></span></li>`;
  const errorItem   = card.error
    ? `<li class="plan-fact-item plan-fact-error"><span class="plan-fact-k">Error:</span> <span class="plan-fact-v">${escapeHtml(card.error)}</span></li>`
    : '';

  return `
  <article class="plan-card plan-${card.status.toLowerCase()}" id="plan-${card.id}">
    <header class="plan-header">
      <div class="plan-header-main">
        <div class="plan-badge">Plan #${card.id}${card.isDataDriven ? ' · Data-driven' : ''}</div>
        <h3 class="plan-name">${escapeHtml(card.name)}</h3>
      </div>
      <div class="plan-header-status">${reportStatusBadge(card.status)}</div>
    </header>

    <ul class="plan-facts-list">
      ${expectedItem}
      ${actualItem}
      ${errorItem}
    </ul>

    <div class="plan-steps">
      <h4 class="col-title">Plan Steps</h4>
      ${stepsHtml}
    </div>
  </article>`;
}

/**
 * Compute a flat list of images across setup steps + plan step tables +
 * responsive previews, and stamp each source object with a `__imgIdx` so
 * the lightbox can navigate them in reading order.
 */
function indexImages(setupSteps, planCards, responsiveShots) {
  const list = [];
  const push = (title, filePath, ownerRef) => {
    const img = embedImageOrNull(filePath);
    if (!img) return;
    ownerRef.__imgIdx = list.length;
    list.push({ title, dataUri: img.dataUri });
  };
  setupSteps.forEach(s => { if (s.screenshotPath) push(s.screenshotLabel || s.name, s.screenshotPath, s); });
  planCards.forEach(card => {
    (card.steps || []).forEach(step => {
      if (step.screenshotPath) push(step.screenshotLabel || step.name, step.screenshotPath, step);
    });
  });
  (responsiveShots || []).forEach(shot => {
    if (shot.filePath) push(`Responsive preview — ${shot.label}`, shot.filePath, shot);
  });
  return list;
}

/**
 * Render the "Responsive Previews" section (iPhone SE + iPad Pro full-page
 * screenshots). Returns '' when no shots were captured so the section is
 * omitted entirely.
 */
function renderResponsivePreviews(shots) {
  if (!Array.isArray(shots) || shots.length === 0) return '';
  const cards = shots.map((shot) => {
    const img = embedImageOrNull(shot.filePath);
    const safeLabel = escapeHtml(shot.label || shot.key || 'Responsive');
    const vpText = shot.viewport
      ? `${shot.viewport.width}\u00d7${shot.viewport.height}`
      : (img ? `${img.width || '?'}\u00d7${img.height || '?'}` : '');
    if (!img) {
      return `
        <div class="rp-card">
          <div class="rp-head"><span class="rp-label">${safeLabel}</span><span class="rp-vp">${escapeHtml(vpText)}</span></div>
          <div class="rp-empty">Screenshot unavailable</div>
        </div>`;
    }
    return `
      <div class="rp-card">
        <div class="rp-head"><span class="rp-label">${safeLabel}</span><span class="rp-vp">${escapeHtml(vpText)}</span></div>
        <div class="rp-frame rp-frame-${escapeHtml(shot.key || '')}"
             onclick="openLightbox(${shot.__imgIdx})" title="Click to zoom \u2014 ${safeLabel}">
          <img src="${img.dataUri}" alt="${safeLabel}" loading="lazy"/>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="section">
      <h2 class="section-title">Responsive Previews</h2>
      <div class="rp-grid">${cards}</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// CSS + client-side script (kept as separate template helpers so the
// writeReport() function stays readable)
// ══════════════════════════════════════════════════════════════════════════

function reportCss() {
  return `
    :root {
      --bg:#eef2f7; --surface:#ffffff; --border:#dfe3e8; --text:#1a1a2e; --muted:#5c6370;
      --primary:#0d3d80; --primary-2:#0d6efd;
      --pass:#0a7d34; --pass-bg:#e6f9ed;
      --fail:#c4320a; --fail-bg:#fff1f0;
      --warn:#b54708; --warn-bg:#fffaeb;
      --info:#1e40af; --info-bg:#dbeafe;
      --radius:12px; --shadow: 0 2px 14px rgba(15,23,42,.06);
    }
    html.dark {
      --bg:#0f172a; --surface:#1e293b; --border:#334155; --text:#e2e8f0; --muted:#94a3b8;
      --primary:#3b82f6; --primary-2:#60a5fa;
      --pass:#34d058; --pass-bg:#14532d;
      --fail:#ff6b6b; --fail-bg:#7f1d1d;
      --warn:#fbbf24; --warn-bg:#78350f;
      --info:#60a5fa; --info-bg:#1e3a8a;
      --shadow: 0 2px 14px rgba(0,0,0,.35);
    }
    * { box-sizing: border-box; }
    body { margin:0; background: var(--bg); color: var(--text); font-family:'Segoe UI',system-ui,-apple-system,sans-serif; line-height:1.5; }
    .wrap { max-width:1440px; margin:0 auto; padding:20px 20px 60px; }

    /* Sticky summary */
    .sticky-summary {
      position: sticky; top:0; z-index:20; background: var(--surface); border-bottom:1px solid var(--border);
      padding:14px 20px; display:flex; align-items:center; gap:14px; box-shadow: var(--shadow);
      backdrop-filter: blur(6px);
    }
    .sticky-summary .brand { font-weight:700; color: var(--primary); }
    .sticky-summary .status { margin-left:auto; }
    .sticky-summary .tiny-kpis { display:flex; gap:12px; }
    .tiny-kpi { padding:4px 10px; border-radius:8px; background: var(--info-bg); color: var(--info); font-size:.78rem; font-weight:600; }
    .tiny-kpi.ok { background: var(--pass-bg); color: var(--pass); }
    .tiny-kpi.bad { background: var(--fail-bg); color: var(--fail); }
    .toolbar { display:flex; gap:8px; }
    .toolbar button { background: transparent; border:1px solid var(--border); border-radius:6px; padding:5px 12px; cursor:pointer; font-size:.78rem; color: var(--text); }
    .toolbar button:hover { background: var(--border); }

    /* Test Details header card */
    .test-details { background: linear-gradient(135deg,#1a3a6b 0%, #0d6efd 100%); color:#fff; border-radius: var(--radius); padding:24px 28px; margin-top:18px; box-shadow: var(--shadow); }
    .test-details .td-eyebrow { font-size:.72rem; letter-spacing:.7px; text-transform:uppercase; opacity:.75; font-weight:700; margin-bottom:4px; }
    .test-details .td-title-row { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .test-details .td-title { font-size:1.55rem; margin:0; font-weight:700; }
    .test-details .td-desc { margin:8px 0 16px; opacity:.9; font-size:.92rem; max-width:960px; }
    .test-details .td-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:8px 16px; background: rgba(255,255,255,.10); border-radius:10px; padding:14px 16px; }
    .test-details .td-row { display:flex; gap:10px; padding:6px 0; border-bottom:1px dashed rgba(255,255,255,.15); }
    .test-details .td-row:last-child { border-bottom:none; }
    .test-details .td-k { flex:0 0 130px; font-size:.75rem; text-transform:uppercase; letter-spacing:.4px; font-weight:700; opacity:.8; }
    .test-details .td-v { flex:1; font-size:.88rem; word-break:break-word; }
    .test-details .td-v.mono { font-family:'Consolas','Menlo', monospace; font-size:.82rem; }
    .test-details .td-v a { color:#fff; text-decoration: underline; }

    /* Badges */
    .badge { display:inline-block; padding:3px 12px; border-radius:14px; font-weight:700; font-size:.78rem; letter-spacing:.4px; }
    .badge-pass { background: var(--pass-bg); color: var(--pass); }
    .badge-fail { background: var(--fail-bg); color: var(--fail); }
    .badge-info { background: var(--info-bg); color: var(--info); }
    .badge-warn { background: var(--warn-bg); color: var(--warn); }

    /* KPI grid */
    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:14px; margin:18px 0; }
    .kpi { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:16px; text-align:center; box-shadow: var(--shadow); }
    .kpi-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; }
    .kpi-value { font-size:1.7rem; font-weight:800; margin-top:4px; }
    .kpi-sub { font-size:.72rem; color: var(--muted); margin-top:2px; }
    .kpi.ok { border-left:4px solid var(--pass); } .kpi.ok .kpi-value { color: var(--pass); }
    .kpi.bad { border-left:4px solid var(--fail); } .kpi.bad .kpi-value { color: var(--fail); }
    .kpi.info { border-left:4px solid var(--info); } .kpi.info .kpi-value { color: var(--info); }

    /* Sections */
    .section { margin-top:28px; }
    .section-title { font-size:1.15rem; margin:0 0 12px; font-weight:700; color: var(--primary); }
    .empty-msg { color: var(--muted); font-style:italic; padding:14px; text-align:center; }

    /* Setup steps TABLE */
    .steps-table-wrap { overflow-x:auto; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .steps-table { width:100%; border-collapse: separate; border-spacing:0; }
    .steps-table th, .steps-table td { padding:12px 14px; vertical-align:top; text-align:left; border-bottom:1px solid var(--border); font-size:.9rem; }
    .steps-table thead th { background: var(--bg); font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); }
    .steps-table tbody tr:last-child td { border-bottom:none; }
    .steps-row-pass { background: var(--pass-bg); }
    .steps-row-fail { background: var(--fail-bg); }
    .steps-num { font-weight:800; color: var(--primary); font-size:1.05rem; text-align:center; }
    .steps-name { min-width:180px; }
    .steps-title { font-weight:700; margin-bottom:6px; }
    .steps-status { }
    .steps-desc { color: var(--text); }
    .steps-desc .er { margin-bottom:6px; }
    .steps-desc .er-k, .steps-desc .ar-k { display:inline-block; font-weight:700; font-size:.78rem; letter-spacing:.3px; padding:1px 8px; border-radius:8px; margin-right:6px; }
    .steps-desc .er-k { background: var(--info-bg); color: var(--info); }
    .steps-desc .ar-k-pass { background: var(--pass-bg); color: var(--pass); }
    .steps-desc .ar-k-fail { background: var(--fail-bg); color: var(--fail); }
    .steps-desc .ar-k-info { background: var(--info-bg); color: var(--info); }
    .steps-desc .er-v, .steps-desc .ar-v { font-size:.88rem; white-space: pre-line; word-break: break-word; }
    .steps-shot { max-width:280px; }
    .steps-shot .thumb { padding:6px; }
    .steps-shot .thumb-img-wrap { aspect-ratio: 16/9; }

    /* Table of contents */
    .toc { display:flex; flex-wrap:wrap; gap:8px; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:12px 16px; box-shadow: var(--shadow); }
    .toc-link { text-decoration:none; color: var(--text); background: var(--info-bg); padding:4px 10px; border-radius:8px; font-size:.82rem; font-weight:600; }
    .toc-link.toc-pass { background: var(--pass-bg); color: var(--pass); }
    .toc-link.toc-fail { background: var(--fail-bg); color: var(--fail); }
    .toc-link:hover { filter: brightness(.95); }

    /* Plan cards */
    .plan-grid { display:grid; grid-template-columns: 1fr; gap:18px; }
    .plan-card { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:18px 20px; box-shadow: var(--shadow); }
    .plan-card.plan-pass { border-left:5px solid var(--pass); }
    .plan-card.plan-fail { border-left:5px solid var(--fail); }
    .plan-header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .plan-badge { display:inline-block; background: var(--info-bg); color: var(--info); padding:3px 10px; border-radius:10px; font-weight:700; font-size:.72rem; letter-spacing:.4px; margin-right:10px; }
    .plan-name { margin:0; font-size:1.05rem; color: var(--primary); display:inline; }
    .plan-facts-list { list-style: disc outside; margin:12px 0; padding:12px 0 12px 22px; border-top:1px dashed var(--border); border-bottom:1px dashed var(--border); display:flex; flex-direction:column; gap:8px; }
    .plan-fact-item { line-height:1.5; }
    .plan-fact-item::marker { color: var(--primary); }
    .plan-fact-k { color: var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.4px; font-weight:700; margin-right:6px; }
    .plan-fact-v { font-size:.9rem; word-break:break-word; }
    .plan-fact-item.plan-fact-error .plan-fact-v { color: var(--fail); }
    .mono { font-family:'Consolas','Menlo', monospace; font-size:.82rem; }
    .sim-num { font-weight:800; font-size:1.05rem; }
    .sim-num.sim-high { color: var(--pass); }
    .sim-num.sim-med  { color: var(--warn); }
    .sim-num.sim-low  { color: var(--fail); }
    .sim-bar { height:8px; background: var(--bg); border-radius:99px; overflow:hidden; margin-top:4px; }
    .sim-bar-fill { height:100%; border-radius:99px; }
    .sim-bar-fill.sim-high { background: linear-gradient(90deg,#10b981,#34d058); }
    .sim-bar-fill.sim-med  { background: linear-gradient(90deg,#f59e0b,#fbbf24); }
    .sim-bar-fill.sim-low  { background: linear-gradient(90deg,#ef4444,#f87171); }

    .plan-cols { display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:14px; }
    .col-title { margin:0 0 8px; font-size:.86rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; }
    .v-list, .ps-list { display:flex; flex-direction:column; gap:8px; }
    .v-item { display:grid; grid-template-columns: 1fr auto; gap:2px 12px; padding:10px 12px; border-radius:10px; background: var(--bg); }
    .v-item.v-fail { background: var(--fail-bg); }
    .v-item.v-pass { background: var(--pass-bg); }
    .v-name { font-weight:700; font-size:.86rem; }
    .v-desc { grid-column: 1 / -1; color: var(--muted); font-size:.78rem; margin-top:2px; word-break:break-word; }

    /* Validation chip row */
    .v-chip-row { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .v-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:12px; font-size:.75rem; font-weight:700; cursor: help; }
    .v-chip-pass { background: var(--pass-bg); color: var(--pass); }
    .v-chip-fail { background: var(--fail-bg); color: var(--fail); }

    /* Per-plan steps block */
    .plan-steps { margin-top:14px; }
    .plan-steps .steps-table-wrap { border-radius:10px; }

    .ps-item { display:flex; gap:10px; padding:10px 12px; border-radius:10px; background: var(--bg); }
    .ps-item.ps-fail { background: var(--fail-bg); }
    .ps-item.ps-pass { background: var(--pass-bg); }
    .ps-marker { flex:0 0 28px; height:28px; border-radius:50%; background: var(--primary); color:#fff; display:flex; align-items:center; justify-content:center; font-size:.82rem; font-weight:800; }
    .ps-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .ps-title { margin:0; font-size:.86rem; font-weight:700; }
    .ps-desc { font-size:.78rem; color: var(--text); margin-top:2px; }

    .plan-gallery { margin-top:14px; }

    /* Thumbnail gallery */
    .thumb-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap:12px; }
    .thumb { background: var(--bg); border:1px solid var(--border); border-radius:10px; padding:8px; text-align:center; cursor: zoom-in; transition: transform .12s, box-shadow .12s; }
    .thumb:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
    .thumb.thumb-empty { cursor:default; opacity:.7; }
    .thumb-img-wrap { background: #fff; border-radius:8px; overflow:hidden; aspect-ratio: 16/10; display:flex; align-items:center; justify-content:center; }
    .thumb-img-wrap img { width:100%; height:100%; object-fit: contain; display:block; }
    .thumb-empty-icon { font-size:1.6rem; padding:14px 0; }
    .thumb-title { font-size:.8rem; font-weight:600; margin-top:6px; color: var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .thumb-caption { font-size:.7rem; color: var(--muted); margin-top:2px; }

    /* Lightbox */
    .lb { display:none; position:fixed; inset:0; background: rgba(15,23,42,.92); z-index:9999; padding:40px; }
    .lb.active { display:flex; flex-direction:column; }
    .lb-header { display:flex; align-items:center; gap:14px; color:#fff; font-size:.9rem; padding-bottom:12px; }
    .lb-header .lb-title { font-weight:600; flex:1; }
    .lb-header .lb-index { opacity:.7; font-size:.8rem; }
    .lb-header button { background: rgba(255,255,255,.15); color:#fff; border:1px solid rgba(255,255,255,.25); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:.82rem; }
    .lb-header button:hover { background: rgba(255,255,255,.25); }
    .lb-viewport { flex:1; display:flex; align-items:center; justify-content:center; overflow:auto; }
    .lb-viewport img { max-width:100%; max-height:100%; box-shadow: 0 8px 40px rgba(0,0,0,.5); border-radius:6px; transform-origin: center center; transition: transform .2s; }
    .lb-hint { color:#fff; opacity:.5; font-size:.72rem; text-align:center; margin-top:10px; }

    /* Responsive Previews (iPhone SE / iPad Pro) */
    .rp-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:20px; align-items:start; }
    .rp-card { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:16px; box-shadow: var(--shadow); display:flex; flex-direction:column; align-items:center; gap:12px; }
    .rp-head { width:100%; display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
    .rp-label { font-weight:700; color: var(--primary); font-size:.95rem; }
    .rp-vp { font-family:'Consolas','Menlo', monospace; font-size:.75rem; color: var(--muted); }
    .rp-frame { border:1px solid var(--border); border-radius:14px; padding:6px; background:#f8fafc; max-height:640px; overflow:auto; cursor: zoom-in; transition: transform .12s, box-shadow .12s; }
    .rp-frame:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.10); }
    .rp-frame img { display:block; border-radius:8px; }
    .rp-frame-iphone-se { max-width: 280px; }
    .rp-frame-iphone-se img { width: 260px; }
    .rp-frame-ipad-pro { max-width: 520px; }
    .rp-frame-ipad-pro img { width: 500px; }
    .rp-empty { color: var(--muted); font-style:italic; padding:32px; text-align:center; }

    /* Responsive */
    @media (max-width:900px) {
      .plan-cols { grid-template-columns: 1fr; }
      .test-details .td-grid { grid-template-columns: 1fr; }
      .rp-frame-iphone-se, .rp-frame-ipad-pro { max-width: 100%; }
      .rp-frame-iphone-se img, .rp-frame-ipad-pro img { width: 100%; height:auto; }
    }
    @media print {
      .sticky-summary, .lb, .toolbar { display:none !important; }
      .plan-card { break-inside: avoid; }
    }`;
}

function lightboxScript(lightboxJson) {
  return `
    // ── Lightbox with keyboard nav + zoom ─────────────────────────────
    const LB_IMAGES = ${lightboxJson};
    let lbIdx = 0;
    let lbZoom = 1;
    const lb = document.getElementById('lb');
    const lbImg = document.getElementById('lbImg');
    const lbTitle = document.getElementById('lbTitle');
    const lbIndex = document.getElementById('lbIndex');

    function renderLb() {
      if (!LB_IMAGES.length) return;
      const it = LB_IMAGES[lbIdx];
      lbImg.src = it.dataUri;
      lbImg.alt = it.title;
      lbImg.style.transform = 'scale(' + lbZoom + ')';
      lbTitle.textContent = it.title;
      lbIndex.textContent = (lbIdx + 1) + ' / ' + LB_IMAGES.length;
    }
    function openLightbox(i) {
      if (typeof i === 'number') lbIdx = Math.max(0, Math.min(LB_IMAGES.length - 1, i));
      lbZoom = 1;
      renderLb();
      lb.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    function closeLightbox() { lb.classList.remove('active'); document.body.style.overflow = ''; }
    function nextLb() { if (!LB_IMAGES.length) return; lbIdx = (lbIdx + 1) % LB_IMAGES.length; lbZoom = 1; renderLb(); }
    function prevLb() { if (!LB_IMAGES.length) return; lbIdx = (lbIdx - 1 + LB_IMAGES.length) % LB_IMAGES.length; lbZoom = 1; renderLb(); }
    function zoomIn()  { lbZoom = Math.min(4, lbZoom + 0.25); renderLb(); }
    function zoomOut() { lbZoom = Math.max(0.5, lbZoom - 0.25); renderLb(); }
    function zoomReset() { lbZoom = 1; renderLb(); }

    document.getElementById('lbClose').onclick = closeLightbox;
    document.getElementById('lbNext').onclick = nextLb;
    document.getElementById('lbPrev').onclick = prevLb;
    document.getElementById('lbZoomIn').onclick = zoomIn;
    document.getElementById('lbZoomOut').onclick = zoomOut;
    document.getElementById('lbReset').onclick = zoomReset;
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.id === 'lbViewport') closeLightbox(); });
    document.addEventListener('keydown', (e) => {
      if (!lb.classList.contains('active')) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') nextLb();
      else if (e.key === 'ArrowLeft') prevLb();
      else if (e.key === '+' || e.key === '=') zoomIn();
      else if (e.key === '-' || e.key === '_') zoomOut();
      else if (e.key === '0') zoomReset();
    });
    window.openLightbox = openLightbox;`;
}

// ══════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Render the full HTML report and write it to `ctx.reportFile`.
 * Creates `ctx.reportDir` if it does not exist.
 */
function writeReport(ctx) {
  const {
    reportDir,
    reportFile,
    testMeta = {},
    appUrl,
    setupSteps = [],
    planCards = [],
    responsiveShots = [],
    durationMs = 0,
    timestamp = new Date().toLocaleString(),
  } = ctx;

  if (!reportDir || !reportFile) {
    throw new Error('writeReport: reportDir and reportFile are required in ctx');
  }
  fs.mkdirSync(reportDir, { recursive: true });

  // Index images once so the lightbox can navigate them by numeric index.
  const lightboxImages = indexImages(setupSteps, planCards, responsiveShots);

  const totalPlans = planCards.length;
  const passedPlans = planCards.filter(p => p.status === 'PASS').length;
  const failedPlans = totalPlans - passedPlans;
  const passRate = totalPlans ? Math.round((passedPlans / totalPlans) * 100) : 0;
  const totalValidations = planCards.reduce((s, p) => s + p.validations.length, 0);
  const passedValidations = planCards.reduce((s, p) => s + p.validations.filter(v => v.status === 'PASS').length, 0);
  const setupFailures = setupSteps.filter(s => s.status === 'FAIL').length;

  const durationStr = durationMs >= 60000
    ? `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`
    : `${Math.round(durationMs / 1000)}s`;

  const overall = (setupFailures === 0 && failedPlans === 0 && totalPlans > 0) ? 'PASS' : 'FAIL';

  const kpi = (label, value, sub, cls) => `
    <div class="kpi ${cls || ''}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${escapeHtml(String(value))}</div>
      ${sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;

  const stepsHtml = renderSetupStepsTable(setupSteps);
  const planCardsHtml = planCards.map(renderPlanCard).join('');
  const tocHtml = planCards.map(c => `<a href="#plan-${c.id}" class="toc-link toc-${c.status.toLowerCase()}">#${c.id} — ${escapeHtml(c.name)} ${reportStatusBadge(c.status)}</a>`).join('');
  const lightboxJson = JSON.stringify(lightboxImages);

  // ── Header / Test Details block ──────────────────────────────────────
  const testName        = testMeta.name        || 'Test';
  const testDescription = testMeta.description || '';
  const testId          = testMeta.id          || '';
  const testModule      = testMeta.module      || '';
  const testEnvironment = testMeta.environment || '';

  const detailRow = (k, v, opts = {}) => v
    ? `<div class="td-row"><div class="td-k">${escapeHtml(k)}</div><div class="td-v${opts.mono ? ' mono' : ''}">${opts.raw ? v : escapeHtml(v)}</div></div>`
    : '';
  const testDetailsHtml = `
    <section class="test-details">
      <header class="td-header">
        <div class="td-eyebrow">Test Details</div>
        <div class="td-title-row">
          <h2 class="td-title">${escapeHtml(testName)}</h2>
          ${reportStatusBadge(overall)}
        </div>
        ${testDescription ? `<p class="td-desc">${escapeHtml(testDescription)}</p>` : ''}
      </header>
      <div class="td-grid">
        ${detailRow('Test ID',        testId)}
        ${detailRow('Environment',    testEnvironment)}
        ${detailRow('Executed On',    timestamp)}
        ${detailRow('Duration',       durationStr)}
      </div>
    </section>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(testName)} — Report</title>
  <style>${reportCss()}</style>
</head>
<body>
  <div class="sticky-summary">
    <div class="brand">Molina Automation · ${escapeHtml(testModule || 'Automation')}</div>
    <div class="tiny-kpis">
      <div class="tiny-kpi ${overall === 'PASS' ? 'ok' : 'bad'}">Overall ${overall}</div>
      <div class="tiny-kpi ${failedPlans ? 'bad' : 'ok'}">${passedPlans}/${totalPlans} plans</div>
      <div class="tiny-kpi ${totalValidations === passedValidations && totalValidations > 0 ? 'ok' : 'bad'}">${passedValidations}/${totalValidations} validations</div>
      <div class="tiny-kpi">${escapeHtml(durationStr)}</div>
    </div>
    <div class="status">${reportStatusBadge(overall)}</div>
    <div class="toolbar">
      <button onclick="document.documentElement.classList.toggle('dark')">Theme</button>
      <button onclick="window.print()">Print</button>
    </div>
  </div>

  <div class="wrap">
    ${testDetailsHtml}

    <div class="kpi-grid">
      ${kpi('Total plans', totalPlans, '', 'info')}
      ${kpi('Passed plans', passedPlans, `${passRate}% pass-rate`, 'ok')}
      ${kpi('Failed plans', failedPlans, '', failedPlans ? 'bad' : '')}
      ${kpi('Validations', `${passedValidations} / ${totalValidations}`, 'passed / total', (totalValidations && totalValidations === passedValidations) ? 'ok' : 'bad')}
      ${kpi('Setup issues', setupFailures, '', setupFailures ? 'bad' : 'ok')}
    </div>

    <div class="section">
      <h2 class="section-title">Setup Steps (1 – 3)</h2>
      ${stepsHtml}
    </div>

    ${totalPlans ? `
    <div class="section">
      <h2 class="section-title">Plans</h2>
      <nav class="toc">${tocHtml}</nav>
    </div>
    <div class="section">
      <div class="plan-grid">${planCardsHtml}</div>
    </div>` : ''}

    ${renderResponsivePreviews(responsiveShots)}
  </div>

  <div id="lb" class="lb" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
    <div class="lb-header">
      <div class="lb-title" id="lbTitle"></div>
      <div class="lb-index" id="lbIndex"></div>
      <button id="lbPrev" title="Previous (←)">&larr; Prev</button>
      <button id="lbNext" title="Next (→)">Next &rarr;</button>
      <button id="lbZoomOut" title="Zoom out (-)">−</button>
      <button id="lbZoomIn" title="Zoom in (+)">+</button>
      <button id="lbReset" title="Reset zoom (0)">1×</button>
      <button id="lbClose" title="Close (Esc)">Close ✕</button>
    </div>
    <div class="lb-viewport" id="lbViewport"><img id="lbImg" alt=""/></div>
    <div class="lb-hint">Keyboard: ← → prev/next · +/− zoom · 0 reset · Esc close</div>
  </div>

  <script>${lightboxScript(lightboxJson)}</script>
</body>
</html>`;

  fs.writeFileSync(reportFile, html, 'utf8');
  return reportFile;
}

// ══════════════════════════════════════════════════════════════════════════
// writeStepsReport() — step-only variant for linear flows (marketplace, etc.)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Write a self-contained HTML report for flows that are a simple sequence
 * of steps with no per-plan validation matrix (e.g. the Marketplace
 * coverage-year toggle flow). Reuses the same CSS, header style, status
 * badges, lightbox and thumbnails as `writeReport()` for visual consistency
 * across the framework.
 *
 * @param {object} ctx
 * @param {string} ctx.reportDir       — absolute folder to write into (created if missing)
 * @param {string} ctx.reportFile      — absolute HTML file path to write
 * @param {object} [ctx.testMeta]      — { name, description, id, module, environment }
 * @param {string} [ctx.appUrl]        — target URL (shown in test details)
 * @param {Array}  ctx.steps           — [{ id, name, status, expected, actual, screenshotPath, screenshotLabel? }]
 * @param {number} [ctx.durationMs]    — total run duration
 * @param {string} [ctx.timestamp]     — pre-formatted timestamp (defaults to now)
 * @returns {string} the report file path that was written
 */
function writeStepsReport(ctx) {
  const {
    reportDir,
    reportFile,
    testMeta = {},
    appUrl,
    steps = [],
    durationMs = 0,
    timestamp = new Date().toLocaleString(),
  } = ctx;

  if (!reportDir || !reportFile) {
    throw new Error('writeStepsReport: reportDir and reportFile are required in ctx');
  }
  fs.mkdirSync(reportDir, { recursive: true });

  // Reuse the same image indexing helper — passing empty plan/responsive
  // arrays gives us the numeric __imgIdx on each step for the lightbox.
  const lightboxImages = indexImages(steps, [], []);

  const totalSteps  = steps.length;
  const passedSteps = steps.filter(s => s.status === 'PASS').length;
  const failedSteps = steps.filter(s => s.status === 'FAIL').length;
  const passRate    = totalSteps ? Math.round((passedSteps / totalSteps) * 100) : 0;

  const durationStr = durationMs >= 60000
    ? `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`
    : `${Math.round(durationMs / 1000)}s`;

  const overall = (totalSteps > 0 && failedSteps === 0) ? 'PASS' : 'FAIL';

  const kpi = (label, value, sub, cls) => `
    <div class="kpi ${cls || ''}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${escapeHtml(String(value))}</div>
      ${sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;

  const stepsHtml = renderStepsTable(steps, {
    emptyMsg: 'No steps recorded.',
    thumbOpts: { simpleCaption: true },  // marketplace: suppress "· WxH" caption
  });

  // ── Header / Test Details block ──────────────────────────────────────
  const testName        = testMeta.name        || 'Test';
  const testDescription = testMeta.description || '';
  const testId          = testMeta.id          || '';
  const testModule      = testMeta.module      || '';
  const testEnvironment = testMeta.environment || '';

  const detailRow = (k, v, opts = {}) => v
    ? `<div class="td-row"><div class="td-k">${escapeHtml(k)}</div><div class="td-v${opts.mono ? ' mono' : ''}">${opts.raw ? v : escapeHtml(v)}</div></div>`
    : '';
  const testDetailsHtml = `
    <section class="test-details">
      <header class="td-header">
        <div class="td-eyebrow">Test Details</div>
        <div class="td-title-row">
          <h2 class="td-title">${escapeHtml(testName)}</h2>
          ${reportStatusBadge(overall)}
        </div>
        ${testDescription ? `<p class="td-desc">${escapeHtml(testDescription)}</p>` : ''}
      </header>
      <div class="td-grid">
        ${detailRow('Test ID',        testId)}
        ${detailRow('Module',         testModule)}
        ${detailRow('Environment',    testEnvironment)}
        ${detailRow('Application URL', appUrl, { mono: true })}
        ${detailRow('Executed On',    timestamp)}
        ${detailRow('Duration',       durationStr)}
      </div>
    </section>`;

  const lightboxJson = JSON.stringify(lightboxImages);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(testName)} — Report</title>
  <style>${reportCss()}</style>
</head>
<body>
  <div class="sticky-summary">
    <div class="brand">Molina Automation · ${escapeHtml(testModule || 'Automation')}</div>
    <div class="tiny-kpis">
      <div class="tiny-kpi ${overall === 'PASS' ? 'ok' : 'bad'}">Overall ${overall}</div>
      <div class="tiny-kpi ${failedSteps ? 'bad' : 'ok'}">${passedSteps}/${totalSteps} steps</div>
      <div class="tiny-kpi">${escapeHtml(durationStr)}</div>
    </div>
    <div class="status">${reportStatusBadge(overall)}</div>
    <div class="toolbar">
      <button onclick="document.documentElement.classList.toggle('dark')">Theme</button>
      <button onclick="window.print()">Print</button>
    </div>
  </div>

  <div class="wrap">
    ${testDetailsHtml}

    <div class="kpi-grid">
      ${kpi('Total steps', totalSteps, '', 'info')}
      ${kpi('Passed', passedSteps, `${passRate}% pass-rate`, 'ok')}
      ${kpi('Failed', failedSteps, '', failedSteps ? 'bad' : '')}
      ${kpi('Duration', durationStr, '', '')}
    </div>

    <div class="section">
      <h2 class="section-title">Test Steps</h2>
      ${stepsHtml}
    </div>
  </div>

  <div id="lb" class="lb" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
    <div class="lb-header">
      <div class="lb-title" id="lbTitle"></div>
      <div class="lb-index" id="lbIndex"></div>
      <button id="lbPrev" title="Previous (←)">&larr; Prev</button>
      <button id="lbNext" title="Next (→)">Next &rarr;</button>
      <button id="lbZoomOut" title="Zoom out (-)">−</button>
      <button id="lbZoomIn" title="Zoom in (+)">+</button>
      <button id="lbReset" title="Reset zoom (0)">1×</button>
      <button id="lbClose" title="Close (Esc)">Close ✕</button>
    </div>
    <div class="lb-viewport" id="lbViewport"><img id="lbImg" alt=""/></div>
    <div class="lb-hint">Keyboard: ← → prev/next · +/− zoom · 0 reset · Esc close</div>
  </div>

  <script>${lightboxScript(lightboxJson)}</script>
</body>
</html>`;

  fs.writeFileSync(reportFile, html, 'utf8');
  return reportFile;
}

// ══════════════════════════════════════════════════════════════════════════
// Evidence packaging — zip the whole report folder for easy attachment
// ══════════════════════════════════════════════════════════════════════════

/**
 * Package an entire report folder (HTML + screenshots) into a single .zip
 * suitable for emailing / attaching to a bug ticket.
 *
 * Uses PowerShell's built-in `Compress-Archive` on Windows (zero npm deps).
 * On non-Windows platforms this returns `null` and logs nothing — callers
 * should treat zip packaging as best-effort.
 *
 * @param {string} reportDir — folder to zip (typically the scope's report dir)
 * @param {string} [zipPath] — output .zip path. Defaults to `<reportDir>.zip`
 * @returns {string|null} absolute path of the created zip, or null on skip/failure
 */
function packageReport(reportDir, zipPath) {
  if (!reportDir || !fs.existsSync(reportDir)) return null;
  const outPath = path.resolve(zipPath || `${reportDir}.zip`);

  if (process.platform !== 'win32') {
    // Best-effort fallback: on macOS/Linux try `zip -r`. If it isn't installed
    // we just return null — the HTML is still self-contained on disk.
    try {
      const parent = path.dirname(outPath);
      const folder = path.basename(reportDir);
      execFileSync('zip', ['-rq', outPath, folder], { cwd: path.dirname(reportDir), stdio: 'pipe' });
      return outPath;
    } catch { return null; }
  }

  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    // Write a tiny PowerShell script to a temp file and invoke it via -File.
    // This bypasses PowerShell's -Command argument parsing, which mangles
    // paths containing spaces / parentheses / special characters.
    const psScript = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $src = $args[0]
      $dst = $args[1]
      [System.IO.Compression.ZipFile]::CreateFromDirectory($src, $dst, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    `;
    const scriptPath = path.join(os.tmpdir(), `pkgReport_${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, psScript, 'utf8');
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, reportDir, outPath],
        { stdio: 'pipe' },
      );
    } finally {
      fs.unlinkSync(scriptPath);
    }
    return fs.existsSync(outPath) ? outPath : null;
  } catch (err) {
    // Surface the reason so the caller can log it, but don't throw — reporting
    // failures should never fail the test run.
    err.message = `packageReport failed: ${err.message}`;
    throw err;
  }
}

module.exports = {
  writeReport,
  writeStepsReport,
  packageReport,
  // Exported for future testing / customisation, but not required by callers.
  escapeHtml,
  reportStatusBadge,
};
