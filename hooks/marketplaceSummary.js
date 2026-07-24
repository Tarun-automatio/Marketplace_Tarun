/**
 * Marketplace state-level CONSOLIDATED report generator (Option A).
 *
 * Scans `reports/marketplace-toggleCheck/` for per-variant folders shaped
 * like `<STATE>-<LANG>-<DEVICE>-<Y1>-<Y2>/` and reads the `variant.json`
 * companion emitted by tests/marketplace/marketplace.spec.js. It groups
 * variants by (STATE, Y1, Y2) and writes a single self-contained
 * `<STATE>-Consolidated-<Y1>-<Y2>.html` at the top level of
 * `reports/marketplace-toggleCheck/`.
 *
 * The consolidated HTML is fully self-contained:
 *   • Every step screenshot is embedded as a base64 data URI (no external
 *     files) so the report can be attached to email / SharePoint / Teams
 *     and rendered without the surrounding folder tree.
 *   • Vanilla-JS tab navigation lets a reviewer flip between all 6
 *     variants (EN Desktop / EN iPhoneSE / EN iPadPro / ES Desktop /
 *     ES iPhoneSE / ES iPadPro) without touching separate files.
 *   • Each variant panel shows its own KPI strip + full step table +
 *     evidence screenshots.
 *
 * Existing per-variant HTML reports are LEFT UNTOUCHED — testers who
 * already link to a single variant's report keep their bookmarks.
 *
 * Exposes:
 *   • generateMarketplaceSummaries({ rootDir })   ← public entry
 */

const fs   = require('fs');
const path = require('path');

// ─── Filesystem discovery ──────────────────────────────────────────────────

/** Match `NV-EN-Desktop-2026-2027` (case-insensitive on lang/device). */
const VARIANT_FOLDER_RE = /^([A-Z]{2})-(EN|ES)-(Desktop|iPhoneSE|iPadPro)-(\d{4})-(\d{4})$/i;

function discoverVariants(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const variants = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = VARIANT_FOLDER_RE.exec(entry.name);
    if (!m) continue;
    const folder = path.join(rootDir, entry.name);

    // Prefer the structured JSON emitted by the spec — has the step data
    // and metadata we need. Skip folders without it.
    const jsonPath = path.join(folder, 'variant.json');
    if (!fs.existsSync(jsonPath)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      continue;
    }
    variants.push({
      folderName: entry.name,
      folder,
      data,
      state:  m[1].toUpperCase(),
      lang:   m[2].toUpperCase(),
      device: /iphonese/i.test(m[3]) ? 'iPhoneSE'
            : /ipadpro/i.test(m[3])  ? 'iPadPro'
            : 'Desktop',
      y1:     m[4],
      y2:     m[5],
    });
  }
  return variants;
}

// ─── Image embedding ───────────────────────────────────────────────────────

const IMG_MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

/**
 * Read `filePath` and return a `data:` URI or null when the file is missing
 * / unreadable / not a recognised image extension.
 */
function embedImageOrNull(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const ext  = path.extname(filePath).toLowerCase();
    const mime = IMG_MIME[ext];
    if (!mime) return null;
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ─── HTML utilities ────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000)  return `${Math.round(n)}ms`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}

// ─── Per-variant rendering ─────────────────────────────────────────────────

/**
 * Render the steps table for one variant + collect its images for the
 * lightbox. Every screenshot is embedded as a data URI so the report
 * remains fully self-contained.
 */
function renderVariantSteps(variant) {
  const steps = Array.isArray(variant.data.steps) ? variant.data.steps : [];
  if (!steps.length) {
    return { html: '<div class="empty-msg">No steps recorded for this variant.</div>', images: [] };
  }

  const images = [];
  const rows = steps.map((s) => {
    const dataUri = embedImageOrNull(s.screenshotPath);
    let thumb;
    if (dataUri) {
      const imgIdx = images.length;
      images.push({ title: s.screenshotLabel || s.name || `Step ${s.id}`, dataUri });
      const title = esc(s.screenshotLabel || s.name || `Step ${s.id}`);
      thumb = `
        <div class="thumb" onclick="openLightbox('${esc(variant.folderName)}', ${imgIdx})" title="${title}">
          <div class="thumb-img-wrap"><img src="${dataUri}" alt="${title}" loading="lazy"/></div>
          <div class="thumb-title">${title}</div>
          <div class="thumb-caption">Click to view</div>
        </div>`;
    } else {
      thumb = '<div class="empty-msg" style="padding:8px;">No screenshot</div>';
    }
    const status    = (s.status || 'info').toLowerCase();
    const badgeText = (s.status || 'INFO').toUpperCase();
    const expected  = s.expected || '';
    const actual    = s.actual   || '';
    return `
      <tr class="steps-row steps-row-${status}">
        <td class="steps-num">${esc(s.id)}</td>
        <td class="steps-name">
          <div class="steps-title">${esc(s.name || '')}</div>
          <div class="steps-status"><span class="badge badge-${status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'info'}">${esc(badgeText)}</span></div>
        </td>
        <td class="steps-desc">
          ${expected ? `<div class="er"><span class="er-k">Expected Result:</span> <span class="er-v">${esc(expected)}</span></div>` : ''}
          <div class="ar"><span class="ar-k ar-k-${status}">Actual Result:</span> <span class="ar-v">${esc(actual)}</span></div>
        </td>
        <td class="steps-shot">${thumb}</td>
      </tr>`;
  }).join('');

  return {
    html: `
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
      </div>`,
    images,
  };
}

/** Render one variant's inner panel (mini KPI ribbon + steps table). */
function renderVariantPanel(variant, isActive) {
  const { data } = variant;
  const total  = (data.steps || []).length;
  const passes = (data.steps || []).filter(s => s.status === 'PASS').length;
  const fails  = (data.steps || []).filter(s => s.status === 'FAIL').length;
  const stepsBlock = renderVariantSteps(variant);

  const meta        = data.testMeta || {};
  const description = meta.description || '';
  const linkTarget  = data.reportFile || '';

  return {
    html: `
    <section class="variant-panel${isActive ? ' active' : ''}" id="panel-${esc(variant.folderName)}" data-variant="${esc(variant.folderName)}">
      <div class="variant-summary">
        <div class="variant-summary-info">
          <div class="variant-summary-title">${esc(meta.name || variant.folderName)}</div>
          ${description ? `<div class="variant-summary-desc">${esc(description)}</div>` : ''}
        </div>
        ${linkTarget ? `<a class="variant-open-link" href="${esc(linkTarget)}" target="_blank" rel="noopener" title="Open the standalone per-variant report in a new tab">Open standalone report &rarr;</a>` : ''}
      </div>
      <div class="mini-kpis">
        <span class="mini-kpi ${data.status === 'PASS' ? 'ok' : 'bad'}">${esc(data.status || '(unknown)')}</span>
        <span class="mini-kpi">${passes}/${total} steps passed</span>
        ${fails ? `<span class="mini-kpi bad">${fails} failed</span>` : ''}
        <span class="mini-kpi">${esc(fmtDuration(data.durationMs))}</span>
        <span class="mini-kpi">Default ${esc(data.defaultYear)} \u2192 ${esc(data.altYear)}</span>
      </div>
      ${stepsBlock.html}
    </section>`,
    images: stepsBlock.images,
  };
}

// ─── Consolidated HTML for one state ───────────────────────────────────────

function renderConsolidatedHtml(group) {
  const { state, y1, y2, variants } = group;

  const totalStatus = variants.every(v => v.data.status === 'PASS') && variants.length ? 'PASS' : 'FAIL';
  const passVariants = variants.filter(v => v.data.status === 'PASS').length;
  const failVariants = variants.length - passVariants;
  const totalDurationMs = variants.reduce((s, v) => s + (Number(v.data.durationMs) || 0), 0);

  const allImages = []; // { title, dataUri, variant }
  const tabsHtml  = variants.map((v, idx) => {
    const status = v.data.status === 'PASS' ? 'ok' : 'bad';
    const langLabel = v.data.langLabel || (v.lang === 'EN' ? 'English' : 'Spanish');
    return `
      <button type="button" class="variant-tab${idx === 0 ? ' active' : ''}"
              data-target="panel-${esc(v.folderName)}"
              title="${esc(v.folderName)}">
        <span class="variant-tab-lang lang-${v.lang.toLowerCase()}">${esc(langLabel)}</span>
        <span class="variant-tab-device">${esc(v.device)}</span>
        <span class="variant-tab-status variant-tab-status-${status}">${esc(v.data.status || '?')}</span>
        <span class="variant-tab-duration">${esc(fmtDuration(v.data.durationMs))}</span>
      </button>`;
  }).join('');

  const panelsHtml = variants.map((v, idx) => {
    const p = renderVariantPanel(v, idx === 0);
    p.images.forEach(img => allImages.push({ ...img, variant: v.folderName }));
    return p.html;
  }).join('');

  const timestamp    = new Date().toLocaleString();
  const lightboxJson = JSON.stringify(allImages);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Marketplace Consolidated Report \u2014 ${esc(state)} \u00b7 ${esc(y1)} \u2192 ${esc(y2)}</title>
  <style>
    :root {
      --bg:#eef2f7; --surface:#ffffff; --border:#dfe3e8; --text:#1a1a2e; --muted:#5c6370;
      --primary:#0d3d80; --primary-2:#0d6efd;
      --pass:#0a7d34; --pass-bg:#e6f9ed;
      --fail:#c4320a; --fail-bg:#fff1f0;
      --info:#1e40af; --info-bg:#dbeafe;
      --radius:12px; --shadow: 0 2px 14px rgba(15,23,42,.06);
    }
    html.dark {
      --bg:#0f172a; --surface:#1e293b; --border:#334155; --text:#e2e8f0; --muted:#94a3b8;
      --primary:#3b82f6; --primary-2:#60a5fa;
      --pass:#34d058; --pass-bg:#14532d;
      --fail:#ff6b6b; --fail-bg:#7f1d1d;
      --info:#60a5fa; --info-bg:#1e3a8a;
      --shadow: 0 2px 14px rgba(0,0,0,.35);
    }
    * { box-sizing: border-box; }
    body { margin:0; background: var(--bg); color: var(--text); font-family:'Segoe UI',system-ui,-apple-system,sans-serif; line-height:1.5; }
    .wrap { max-width:1440px; margin:0 auto; padding:20px 20px 60px; }

    /* Sticky header */
    .sticky-summary {
      position: sticky; top:0; z-index:20; background: var(--surface); border-bottom:1px solid var(--border);
      padding:14px 20px; display:flex; align-items:center; gap:14px; box-shadow: var(--shadow);
      backdrop-filter: blur(6px);
    }
    .sticky-summary .brand { font-weight:700; color: var(--primary); }
    .sticky-summary .status { margin-left:auto; }
    .sticky-summary .tiny-kpis { display:flex; gap:12px; }
    .tiny-kpi { padding:4px 10px; border-radius:8px; background: var(--info-bg); color: var(--info); font-size:.78rem; font-weight:600; }
    .tiny-kpi.ok  { background: var(--pass-bg); color: var(--pass); }
    .tiny-kpi.bad { background: var(--fail-bg); color: var(--fail); }
    .toolbar { display:flex; gap:8px; }
    .toolbar button { background: transparent; border:1px solid var(--border); border-radius:6px; padding:5px 12px; cursor:pointer; font-size:.78rem; color: var(--text); }
    .toolbar button:hover { background: var(--border); }
    .badge { display:inline-block; padding:3px 12px; border-radius:14px; font-weight:700; font-size:.78rem; letter-spacing:.4px; }
    .badge-pass { background: var(--pass-bg); color: var(--pass); }
    .badge-fail { background: var(--fail-bg); color: var(--fail); }
    .badge-info { background: var(--info-bg); color: var(--info); }

    /* Test Details header card */
    .test-details { background: linear-gradient(135deg,#1a3a6b 0%, #0d6efd 100%); color:#fff; border-radius: var(--radius); padding:24px 28px; margin-top:18px; box-shadow: var(--shadow); }
    .test-details .td-eyebrow { font-size:.72rem; letter-spacing:.7px; text-transform:uppercase; opacity:.75; font-weight:700; margin-bottom:4px; }
    .test-details .td-title-row { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .test-details .td-title { font-size:1.55rem; margin:0; font-weight:700; }
    .test-details .td-desc { margin:8px 0 0; opacity:.9; font-size:.92rem; max-width:960px; }

    /* Top-level KPIs */
    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:14px; margin:18px 0; }
    .kpi { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:16px; text-align:center; box-shadow: var(--shadow); }
    .kpi-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; }
    .kpi-value { font-size:1.7rem; font-weight:800; margin-top:4px; }
    .kpi-sub { font-size:.72rem; color: var(--muted); margin-top:2px; }
    .kpi.ok  { border-left:4px solid var(--pass); } .kpi.ok  .kpi-value { color: var(--pass); }
    .kpi.bad { border-left:4px solid var(--fail); } .kpi.bad .kpi-value { color: var(--fail); }
    .kpi.info { border-left:4px solid var(--info); } .kpi.info .kpi-value { color: var(--info); }

    .section { margin-top:28px; }
    .section-title { font-size:1.15rem; margin:0 0 12px; font-weight:700; color: var(--primary); }
    .empty-msg { color: var(--muted); font-style:italic; padding:14px; text-align:center; }

    /* Variant tabs */
    .variant-tabs {
      display:flex; flex-wrap:wrap; gap:8px;
      background: var(--surface); border:1px solid var(--border); border-radius: var(--radius);
      padding:10px; box-shadow: var(--shadow); margin-bottom:16px;
    }
    .variant-tab {
      display:inline-flex; align-items:center; gap:8px;
      background: transparent; border:1px solid var(--border); border-radius:10px;
      padding:8px 12px; cursor:pointer; text-align:left; color: var(--text);
      font-family:inherit; font-size:.85rem;
      transition: background .12s, border-color .12s, box-shadow .12s;
    }
    .variant-tab:hover { background: var(--bg); }
    .variant-tab.active { border-color: var(--primary); background: var(--info-bg); box-shadow: 0 2px 8px rgba(13,61,128,.15); }
    .variant-tab-lang { padding:2px 8px; border-radius:8px; font-weight:700; font-size:.7rem; letter-spacing:.4px; }
    .lang-en { background:#fef3c7; color:#92400e; } html.dark .lang-en { background:#78350f; color:#fcd34d; }
    .lang-es { background:#ede9fe; color:#5b21b6; } html.dark .lang-es { background:#4c1d95; color:#c4b5fd; }
    .variant-tab-device { font-weight:700; color: var(--primary); }
    .variant-tab-status { padding:2px 8px; border-radius:8px; font-weight:800; font-size:.68rem; letter-spacing:.5px; }
    .variant-tab-status-ok  { background: var(--pass-bg); color: var(--pass); }
    .variant-tab-status-bad { background: var(--fail-bg); color: var(--fail); }
    .variant-tab-duration { font-family:'Consolas','Menlo',monospace; font-size:.75rem; color: var(--muted); }

    /* Variant panel (only one visible at a time) */
    .variant-panel { display:none; }
    .variant-panel.active { display:block; }
    .variant-summary {
      display:flex; align-items:flex-start; justify-content:space-between; gap:14px;
      background: var(--surface); border:1px solid var(--border); border-radius: var(--radius);
      padding:14px 18px; box-shadow: var(--shadow); margin-bottom:10px;
    }
    .variant-summary-title { font-weight:700; color: var(--primary); font-size:1rem; }
    .variant-summary-desc  { color: var(--muted); font-size:.85rem; margin-top:4px; }
    .variant-open-link {
      align-self:flex-start; white-space:nowrap;
      text-decoration:none; color:#fff; background: var(--primary);
      padding:6px 12px; border-radius:8px; font-size:.78rem; font-weight:700;
    }
    .variant-open-link:hover { filter: brightness(1.1); }
    .mini-kpis { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 16px; }
    .mini-kpi { padding:4px 10px; border-radius:8px; background: var(--info-bg); color: var(--info); font-size:.78rem; font-weight:600; }
    .mini-kpi.ok  { background: var(--pass-bg); color: var(--pass); }
    .mini-kpi.bad { background: var(--fail-bg); color: var(--fail); }

    /* Steps table (mirrors the per-variant reports) */
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
    .steps-desc { color: var(--text); }
    .steps-desc .er { margin-bottom:6px; }
    .steps-desc .er-k, .steps-desc .ar-k { display:inline-block; font-weight:700; font-size:.78rem; letter-spacing:.3px; padding:1px 8px; border-radius:8px; margin-right:6px; }
    .steps-desc .er-k { background: var(--info-bg); color: var(--info); }
    .steps-desc .ar-k-pass { background: var(--pass-bg); color: var(--pass); }
    .steps-desc .ar-k-fail { background: var(--fail-bg); color: var(--fail); }
    .steps-desc .ar-k-info { background: var(--info-bg); color: var(--info); }
    .steps-desc .er-v, .steps-desc .ar-v { font-size:.88rem; white-space: pre-line; word-break: break-word; }
    .steps-shot { max-width:280px; }
    .thumb { background: var(--bg); border:1px solid var(--border); border-radius:10px; padding:6px; text-align:center; cursor: zoom-in; transition: transform .12s, box-shadow .12s; }
    .thumb:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
    .thumb-img-wrap { background:#fff; border-radius:8px; overflow:hidden; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; }
    .thumb-img-wrap img { width:100%; height:100%; object-fit:contain; display:block; }
    .thumb-title { font-size:.78rem; font-weight:600; margin-top:6px; color: var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .thumb-caption { font-size:.68rem; color: var(--muted); margin-top:2px; }

    /* Lightbox */
    .lb { display:none; position:fixed; inset:0; background: rgba(15,23,42,.92); z-index:9999; padding:40px; }
    .lb.active { display:flex; flex-direction:column; }
    .lb-header { display:flex; align-items:center; gap:14px; color:#fff; font-size:.9rem; padding-bottom:12px; }
    .lb-header .lb-title { font-weight:600; flex:1; }
    .lb-header .lb-index { opacity:.7; font-size:.8rem; }
    .lb-header button { background: rgba(255,255,255,.15); color:#fff; border:1px solid rgba(255,255,255,.25); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:.82rem; }
    .lb-header button:hover { background: rgba(255,255,255,.25); }
    .lb-viewport { flex:1; display:flex; align-items:center; justify-content:center; overflow:auto; }
    .lb-viewport img { max-width:100%; max-height:100%; box-shadow: 0 8px 40px rgba(0,0,0,.5); border-radius:6px; transition: transform .2s; }
    .lb-hint { color:#fff; opacity:.5; font-size:.72rem; text-align:center; margin-top:10px; }

    .footer { text-align:center; color: var(--muted); font-size:.75rem; margin-top:32px; }

    @media print {
      .sticky-summary, .toolbar, .lb, .variant-tabs { display:none !important; }
      .variant-panel { display:block !important; break-inside:auto; }
      .variant-panel + .variant-panel { margin-top:32px; page-break-before: always; }
    }
  </style>
</head>
<body>
  <div class="sticky-summary">
    <div class="brand">Molina Automation \u00b7 Marketplace Consolidated Report</div>
    <div class="tiny-kpis">
      <div class="tiny-kpi ${totalStatus === 'PASS' ? 'ok' : 'bad'}">Overall ${totalStatus}</div>
      <div class="tiny-kpi ${failVariants ? 'bad' : 'ok'}">${passVariants}/${variants.length} variants</div>
      <div class="tiny-kpi">${esc(fmtDuration(totalDurationMs))}</div>
    </div>
    <div class="status"><span class="badge badge-${totalStatus === 'PASS' ? 'pass' : 'fail'}">${totalStatus}</span></div>
    <div class="toolbar">
      <button onclick="document.documentElement.classList.toggle('dark')">Theme</button>
      <button onclick="window.print()">Print</button>
    </div>
  </div>

  <div class="wrap">
    <section class="test-details">
      <div class="td-eyebrow">Consolidated State Report</div>
      <div class="td-title-row">
        <h2 class="td-title">Marketplace \u00b7 Forms &amp; Documents \u00b7 Coverage Year Toggle (${esc(state)} \u00b7 ${esc(y1)} \u2192 ${esc(y2)})</h2>
        <span class="badge badge-${totalStatus === 'PASS' ? 'pass' : 'fail'}">${totalStatus}</span>
      </div>
      <p class="td-desc">Combined view of all ${variants.length} variant run(s) for state ${esc(state)} \u2014 both languages (English / Spanish) across all three device profiles (Desktop, iPhone SE, iPad Pro). Click a tab to switch between variants. Every screenshot is embedded so this file can be shared as-is by email or SharePoint.</p>
    </section>

    <div class="kpi-grid">
      <div class="kpi info"><div class="kpi-label">Total variants</div><div class="kpi-value">${variants.length}</div><div class="kpi-sub">EN+ES \u00d7 Desktop+iPhoneSE+iPadPro</div></div>
      <div class="kpi ok"><div class="kpi-label">Passed</div><div class="kpi-value">${passVariants}</div><div class="kpi-sub">${variants.length ? Math.round((passVariants / variants.length) * 100) : 0}% pass-rate</div></div>
      <div class="kpi ${failVariants ? 'bad' : ''}"><div class="kpi-label">Failed</div><div class="kpi-value">${failVariants}</div></div>
      <div class="kpi"><div class="kpi-label">Total duration</div><div class="kpi-value">${esc(fmtDuration(totalDurationMs))}</div><div class="kpi-sub">sum across all variants</div></div>
    </div>

    <div class="section">
      <h2 class="section-title">Variants</h2>
      <div class="variant-tabs" role="tablist">${tabsHtml}</div>
      ${panelsHtml}
    </div>

    <div class="footer">Generated ${esc(timestamp)} \u00b7 Molina Automation Framework</div>
  </div>

  <div id="lb" class="lb" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
    <div class="lb-header">
      <div class="lb-title" id="lbTitle"></div>
      <div class="lb-index" id="lbIndex"></div>
      <button id="lbPrev" title="Previous (\u2190)">&larr; Prev</button>
      <button id="lbNext" title="Next (\u2192)">Next &rarr;</button>
      <button id="lbClose" title="Close (Esc)">Close \u2715</button>
    </div>
    <div class="lb-viewport" id="lbViewport"><img id="lbImg" alt=""/></div>
    <div class="lb-hint">Keyboard: \u2190 \u2192 prev/next \u00b7 Esc close</div>
  </div>

  <script>
    // ── Tab switching ─────────────────────────────────────────────────
    (function () {
      var tabs   = document.querySelectorAll('.variant-tab');
      var panels = document.querySelectorAll('.variant-panel');
      tabs.forEach(function (t) {
        t.addEventListener('click', function () {
          var targetId = t.getAttribute('data-target');
          tabs.forEach(function (x) { x.classList.toggle('active', x === t); });
          panels.forEach(function (p) { p.classList.toggle('active', p.id === targetId); });
        });
      });
    })();

    // ── Lightbox (per-variant scoped image list) ──────────────────────
    (function () {
      var IMAGES = ${lightboxJson};
      var idx = 0;
      var lb      = document.getElementById('lb');
      var lbImg   = document.getElementById('lbImg');
      var lbTitle = document.getElementById('lbTitle');
      var lbIndex = document.getElementById('lbIndex');
      var scopedImages = [];

      function render() {
        if (!scopedImages.length) return;
        var it = scopedImages[idx];
        lbImg.src = it.dataUri;
        lbImg.alt = it.title;
        lbTitle.textContent = it.title;
        lbIndex.textContent = (idx + 1) + ' / ' + scopedImages.length;
      }
      window.openLightbox = function (variantFolder, imageIdx) {
        scopedImages = IMAGES.filter(function (i) { return i.variant === variantFolder; });
        idx = Math.max(0, Math.min(imageIdx, scopedImages.length - 1));
        render();
        lb.classList.add('active');
        document.body.style.overflow = 'hidden';
      };
      function close() { lb.classList.remove('active'); document.body.style.overflow = ''; }
      function next()  { if (!scopedImages.length) return; idx = (idx + 1) % scopedImages.length; render(); }
      function prev()  { if (!scopedImages.length) return; idx = (idx - 1 + scopedImages.length) % scopedImages.length; render(); }

      document.getElementById('lbClose').onclick = close;
      document.getElementById('lbNext').onclick  = next;
      document.getElementById('lbPrev').onclick  = prev;
      lb.addEventListener('click', function (e) {
        if (e.target === lb || e.target.id === 'lbViewport') close();
      });
      document.addEventListener('keydown', function (e) {
        if (!lb.classList.contains('active')) return;
        if (e.key === 'Escape')          close();
        else if (e.key === 'ArrowRight') next();
        else if (e.key === 'ArrowLeft')  prev();
      });
    })();
  </script>
</body>
</html>
`;
}

// ─── Public entry point ────────────────────────────────────────────────────

function generateMarketplaceSummaries({ rootDir }) {
  const variants = discoverVariants(rootDir);
  if (variants.length === 0) return [];

  // Group by "STATE|Y1|Y2".
  const groups = new Map();
  for (const v of variants) {
    const key = `${v.state}|${v.y1}|${v.y2}`;
    if (!groups.has(key)) {
      groups.set(key, { state: v.state, y1: v.y1, y2: v.y2, variants: [] });
    }
    groups.get(key).variants.push(v);
  }

  // Predictable variant order — EN before ES, then Desktop → iPhoneSE → iPadPro.
  const deviceOrder = { Desktop: 0, iPhoneSE: 1, iPadPro: 2 };
  const langOrder   = { EN: 0, ES: 1 };
  for (const g of groups.values()) {
    g.variants.sort((a, b) =>
      (langOrder[a.lang] - langOrder[b.lang]) ||
      (deviceOrder[a.device] - deviceOrder[b.device])
    );
  }

  const written = [];
  for (const g of groups.values()) {
    const html = renderConsolidatedHtml(g);
    const file = path.join(rootDir, `${g.state}-Consolidated-${g.y1}-${g.y2}.html`);
    fs.writeFileSync(file, html, 'utf8');
    written.push(file);
  }
  return written;
}

module.exports = { generateMarketplaceSummaries };
