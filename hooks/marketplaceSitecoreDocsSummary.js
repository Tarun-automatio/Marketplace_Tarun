/**
 * Marketplace Sitecore Docs — consolidated dashboard.
 *
 * Scans `reports/marketplace-sitecore-docs/` for per-scope folders with a
 * `variant.json` companion (emitted by marketplaceSitecoreDocs.spec.js)
 * and produces ONE dashboard HTML at:
 *
 *   reports/marketplace-sitecore-docs/Consolidated.html
 *
 * Design mirrors marketplacePharmacySummary:
 *   • No embedded screenshots — file stays lightweight for email / SP.
 *   • Interactive filters: search, status, state, doc-type, language.
 *   • Expand-per-row shows requested vs settled vs embed URL inline.
 *   • Per-state pills at the top for at-a-glance state coverage.
 */

const fs   = require('fs');
const path = require('path');

// ─── Discovery ─────────────────────────────────────────────────────────────

function discoverScopes(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const scopes = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const jsonPath = path.join(rootDir, entry.name, 'variant.json');
    if (!fs.existsSync(jsonPath)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch { continue; }
    scopes.push({ folderName: entry.name, folder: path.join(rootDir, entry.name), data });
  }
  scopes.sort((a, b) => {
    const sa = String(a.data.state || '');
    const sb = String(b.data.state || '');
    if (sa !== sb) return sa.localeCompare(sb);
    const ta = String(a.data.testIdBase || a.data.testId || '');
    const tb = String(b.data.testIdBase || b.data.testId || '');
    return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' })
        || a.folderName.localeCompare(b.folderName);
  });
  return scopes;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function urlTail(u) {
  const s = String(u || '');
  if (!s) return '(none)';
  const noQ = s.split('?')[0].split('#')[0];
  const parts = noQ.split('/');
  return parts.slice(-4).join('/') || noQ;
}

// ─── Row + full HTML rendering ─────────────────────────────────────────────

function renderScopeRow(sc, opts = {}) {
  const { data, folderName } = sc;
  const status    = String(data.status || 'UNKNOWN').toUpperCase();
  const statusCls = status === 'PASS' ? 'ok' : status === 'FAIL' ? 'bad' : 'info';
  // In flat mode the individual HTMLs sit next to the dashboard (no subfolder),
  // so the link target is just the report's basename.
  const basename  = data.reportFile ? path.posix.basename(data.reportFile) : '';
  const rel       = opts.flatLinks
    ? basename
    : (data.reportFile ? path.posix.join(folderName, basename) : '');

  const docType  = String(data.docType   || '').toUpperCase();
  const langLbl  = String(data.langLabel || (String(data.language || '').toUpperCase())) || '';

  return `
  <tr class="plan-row plan-row-${statusCls}"
      data-status="${esc(status)}"
      data-state="${esc(String(data.state || '').toUpperCase())}"
      data-doctype="${esc(docType)}"
      data-lang="${esc(langLbl)}"
      data-search="${esc([data.testId, data.testIdBase, data.stateName, data.state,
                          data.planCode, data.planName, docType, langLbl, data.expectedName]
                          .filter(Boolean).join(' ').toLowerCase())}">
    <td class="c-expand"><button type="button" class="expand-btn" onclick="toggleScope(this)" aria-expanded="false" title="Show URL detail">\u25B8</button></td>
    <td class="c-testid mono">${esc(data.testIdBase || folderName)}</td>
    <td class="c-state">${esc((data.state || '').toUpperCase())}${data.stateName ? ` <span class="muted">(${esc(data.stateName)})</span>` : ''}</td>
    <td class="c-plan">${esc(data.planName || '')} <span class="mono muted" style="font-size:.75rem;">${esc(data.planCode || '')}</span></td>
    <td class="c-doctype"><span class="chip chip-${esc(docType.toLowerCase())}">${esc(docType || '\u2014')}</span></td>
    <td class="c-lang"><span class="chip chip-lang chip-lang-${esc(langLbl.toLowerCase())}">${esc(langLbl || '\u2014')}</span></td>
    <td class="c-status"><span class="badge badge-${statusCls}">${esc(status)}</span></td>
    <td class="c-file mono" title="${esc(data.expectedName || '')}">${esc(data.expectedName || '')}</td>
    <td class="c-dur mono">${esc(fmtDuration(data.durationMs))}</td>
    <td class="c-openlink">${rel ? `<a href="${esc(rel)}" target="_blank" rel="noopener">Open&nbsp;&rarr;</a>` : ''}</td>
  </tr>
  <tr class="plan-details" hidden>
    <td colspan="10">
      <div class="plan-details-inner">
        <div class="plan-details-head">
          <strong>${esc(data.testName || data.testId || folderName)}</strong>
          ${data.testDescription ? `<div class="plan-details-desc">${esc(data.testDescription)}</div>` : ''}
        </div>
        <table class="urls-table">
          <thead><tr><th style="width:200px;">Field</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td class="field">Expected filename</td><td class="url mono">${esc(data.expectedName || '')}</td></tr>
            <tr><td class="field">Requested URL (post host-rewrite)</td><td class="url mono">${esc(data.requestedUrl || '')}</td></tr>
            <tr><td class="field">Excel URL (raw)</td><td class="url mono">${esc(data.rawUrl || '')}</td></tr>
            <tr><td class="field">Settled URL (page.url())</td><td class="url mono">${esc(data.settledUrl || '')}</td></tr>
            <tr><td class="field">embed.original-url</td><td class="url mono">${esc(data.embedOriginalUrl || '(not captured)')}</td></tr>
            ${data.probe ? `
            <tr><td class="field">HTTP probe</td><td class="url mono">HTTP ${esc(String(data.probe.status || ''))}  ·  ${esc(data.probe.contentType || '(no content-type)')}  ·  ${esc(String(data.probe.contentLength || 0))} bytes</td></tr>` : ''}
            <tr><td class="field">Doc-type / Language</td><td class="url">${esc(docType)} · ${esc(langLbl)}</td></tr>
            <tr><td class="field">Display column (Excel)</td><td class="url">${esc(data.display || '')}</td></tr>
          </tbody>
        </table>
      </div>
    </td>
  </tr>`;
}

function renderDashboardHtml(scopes, opts = {}) {
  const total  = scopes.length;
  const passed = scopes.filter((s) => s.data.status === 'PASS').length;
  const failed = total - passed;
  const totalDurationMs = scopes.reduce((sum, s) => sum + (Number(s.data.durationMs) || 0), 0);
  const overall = failed === 0 && total > 0 ? 'PASS' : 'FAIL';

  const statesSet   = new Set();
  const doctypesSet = new Set();
  const langsSet    = new Set();
  const stateStats  = new Map();
  for (const s of scopes) {
    const st = String(s.data.state || '').toUpperCase();
    if (st) {
      statesSet.add(st);
      const bucket = stateStats.get(st) || { total: 0, passed: 0, failed: 0 };
      bucket.total += 1;
      if (s.data.status === 'PASS') bucket.passed += 1; else bucket.failed += 1;
      stateStats.set(st, bucket);
    }
    if (s.data.docType) doctypesSet.add(String(s.data.docType).toUpperCase());
    if (s.data.langLabel) langsSet.add(String(s.data.langLabel).toUpperCase());
  }
  const states   = [...statesSet].sort();
  const doctypes = [...doctypesSet].sort();
  const langs    = [...langsSet].sort();

  const stateTitle = states.length === 0 ? ''
                   : states.length <= 4 ? ` (${states.join(', ')})`
                   : ` (${states.length} states)`;

  const rowsHtml  = scopes.map((sc) => renderScopeRow(sc, opts)).join('');
  const timestamp = new Date().toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Marketplace Sitecore Docs — Consolidated Dashboard</title>
  <style>
    :root {
      --bg:#eef2f7; --surface:#ffffff; --border:#dfe3e8; --text:#1a1a2e; --muted:#5c6370;
      --primary:#0d3d80;
      --pass:#0a7d34; --pass-bg:#e6f9ed;
      --fail:#c4320a; --fail-bg:#fff1f0;
      --info:#1e40af; --info-bg:#dbeafe;
      --radius:12px; --shadow: 0 2px 14px rgba(15,23,42,.06);
    }
    html.dark {
      --bg:#0f172a; --surface:#1e293b; --border:#334155; --text:#e2e8f0; --muted:#94a3b8;
      --primary:#3b82f6;
      --pass:#34d058; --pass-bg:#14532d;
      --fail:#ff6b6b; --fail-bg:#7f1d1d;
      --info:#60a5fa; --info-bg:#1e3a8a;
      --shadow: 0 2px 14px rgba(0,0,0,.35);
    }
    * { box-sizing: border-box; }
    body { margin:0; background: var(--bg); color: var(--text); font-family:'Segoe UI',system-ui,-apple-system,sans-serif; line-height:1.5; }
    .wrap { max-width:1720px; margin:0 auto; padding:20px 20px 60px; }

    .sticky-summary { position: sticky; top:0; z-index:30; background: var(--surface); border-bottom:1px solid var(--border);
      padding:12px 20px; display:flex; align-items:center; gap:14px; box-shadow: 0 4px 18px rgba(15,23,42,.12); }
    .sticky-summary .brand { font-weight:700; color: var(--primary); }
    .sticky-summary .status { margin-left:auto; }
    .sticky-summary .tiny-kpis { display:flex; gap:12px; flex-wrap:wrap; }
    .tiny-kpi { padding:4px 10px; border-radius:8px; background: var(--info-bg); color: var(--info); font-size:.78rem; font-weight:600; white-space:nowrap; }
    .tiny-kpi.ok  { background: var(--pass-bg); color: var(--pass); }
    .tiny-kpi.bad { background: var(--fail-bg); color: var(--fail); }
    .toolbar { display:flex; gap:8px; }
    .toolbar button { background: transparent; border:1px solid var(--border); border-radius:6px; padding:5px 12px; cursor:pointer; font-size:.78rem; color: var(--text); }
    .toolbar button:hover { background: var(--border); }
    .badge { display:inline-block; padding:3px 10px; border-radius:12px; font-weight:700; font-size:.72rem; letter-spacing:.4px; }
    .badge-ok   { background: var(--pass-bg); color: var(--pass); }
    .badge-bad  { background: var(--fail-bg); color: var(--fail); }
    .badge-info { background: var(--info-bg); color: var(--info); }
    .badge-pass { background: var(--pass-bg); color: var(--pass); }
    .badge-fail { background: var(--fail-bg); color: var(--fail); }

    .chip { display:inline-block; padding:2px 8px; border-radius:8px; font-size:.72rem; font-weight:700; letter-spacing:.3px; }
    .chip-sbc { background:#e0e7ff; color:#3730a3; }
    .chip-sob { background:#dcfce7; color:#166534; }
    .chip-eoc { background:#fef3c7; color:#92400e; }
    .chip-ooc { background:#fce7f3; color:#9d174d; }
    html.dark .chip-sbc { background:#312e81; color:#c7d2fe; }
    html.dark .chip-sob { background:#166534; color:#dcfce7; }
    html.dark .chip-eoc { background:#78350f; color:#fef3c7; }
    html.dark .chip-ooc { background:#831843; color:#fce7f3; }
    .chip-lang-en { background:#e0f2fe; color:#0c4a6e; }
    .chip-lang-es { background:#fff7ed; color:#7c2d12; }
    html.dark .chip-lang-en { background:#0c4a6e; color:#e0f2fe; }
    html.dark .chip-lang-es { background:#7c2d12; color:#fff7ed; }

    .test-details { background: linear-gradient(135deg,#1a3a6b 0%, #0d6efd 100%); color:#fff; border-radius: var(--radius); padding:24px 28px; margin-top:18px; box-shadow: var(--shadow); }
    .td-eyebrow { font-size:.72rem; letter-spacing:.7px; text-transform:uppercase; opacity:.75; font-weight:700; margin-bottom:4px; }
    .td-title-row { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .td-title { font-size:1.55rem; margin:0; font-weight:700; }
    .td-desc { margin:8px 0 0; opacity:.9; font-size:.92rem; max-width:960px; }

    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:14px; margin:18px 0; }
    .kpi { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:16px; text-align:center; box-shadow: var(--shadow); }
    .kpi-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; }
    .kpi-value { font-size:1.7rem; font-weight:800; margin-top:4px; }
    .kpi-sub { font-size:.72rem; color: var(--muted); margin-top:2px; }
    .kpi.ok  { border-left:4px solid var(--pass); } .kpi.ok  .kpi-value { color: var(--pass); }
    .kpi.bad { border-left:4px solid var(--fail); } .kpi.bad .kpi-value { color: var(--fail); }
    .kpi.info { border-left:4px solid var(--info); } .kpi.info .kpi-value { color: var(--info); }

    .filter-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:12px 14px; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom:14px; }
    .filter-bar .search-in { flex:1; min-width:220px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: var(--bg); color: var(--text); font-family:inherit; font-size:.9rem; }
    .filter-bar select { padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: var(--surface); color: var(--text); font-family:inherit; font-size:.85rem; cursor:pointer; max-width: 260px; }
    .filter-bar .clear-btn { padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: transparent; color: var(--text); cursor:pointer; font-size:.85rem; }
    .filter-bar .clear-btn:hover { background: var(--bg); }
    .filter-summary { margin-left:auto; font-size:.82rem; color: var(--muted); }

    .plans-wrap { overflow-x:auto; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .plans-table { width:100%; border-collapse: separate; border-spacing:0; }
    .plans-table th, .plans-table td { padding:10px 12px; text-align:left; border-bottom:1px solid var(--border); font-size:.85rem; vertical-align: middle; }
    .plans-table thead th { background: var(--bg); font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); border-bottom:2px solid var(--border); }
    .plans-table tbody tr.plan-row:last-child td { border-bottom:none; }
    .plan-row-ok  td { background: var(--pass-bg); }
    .plan-row-bad td { background: var(--fail-bg); }
    .expand-btn { background: transparent; border:1px solid var(--border); border-radius:6px; width:26px; height:26px; padding:0; cursor:pointer; color: var(--text); font-size:.85rem; transition: transform .12s; }
    .expand-btn.open { transform: rotate(90deg); background: var(--info-bg); color: var(--info); }
    .mono { font-family:'Consolas','Menlo', monospace; font-size:.82rem; }
    .c-testid  { white-space: nowrap; }
    .c-state   { white-space: nowrap; }
    .c-doctype, .c-lang, .c-status { white-space: nowrap; }
    .c-file    { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .c-plan    { max-width: 340px; }
    .c-dur     { text-align:right; white-space: nowrap; }
    .c-openlink a { text-decoration:none; color: var(--primary); font-weight:700; }
    .c-openlink a:hover { text-decoration: underline; }

    .plan-details > td { padding: 0; background: var(--surface); }
    .plan-details-inner { padding:18px 24px; background: var(--surface); border-top: 3px solid var(--primary); border-bottom: 1px solid var(--border); }
    .plan-details-head strong { font-size:.95rem; color: var(--primary); }
    .plan-details-desc { margin-top:6px; color: var(--muted); font-size:.82rem; max-width:1200px; }
    .urls-table { width:100%; border-collapse: collapse; margin-top:12px; background: var(--bg); border-radius:8px; overflow:hidden; }
    .urls-table th, .urls-table td { padding:10px 12px; border-bottom:1px solid var(--border); font-size:.82rem; vertical-align: top; text-align:left; }
    .urls-table th { background: rgba(13,61,128,.08); font-size:.68rem; text-transform:uppercase; letter-spacing:.4px; color: var(--muted); font-weight:700; }
    html.dark .urls-table th { background: rgba(96,165,250,.12); }
    .urls-table .field { font-weight:700; color: var(--text); }
    .urls-table .url   { font-family:'Consolas','Menlo', monospace; font-size:.75rem; word-break: break-all; }
    .muted { color: var(--muted); font-style: italic; }

    .state-strip { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 14px; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom:14px; }
    .state-strip-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; margin-right:4px; }
    .state-pill { display:inline-flex; align-items:center; gap:6px; padding:5px 12px; border-radius:14px; font-weight:700; font-size:.82rem; cursor:pointer; }
    .state-pill.ok  { background: var(--pass-bg); color: var(--pass); }
    .state-pill.bad { background: var(--fail-bg); color: var(--fail); }
    .state-pill .state-count { font-family:'Consolas','Menlo',monospace; font-size:.75rem; opacity:.85; font-weight:700; }

    .footer { text-align:center; color: var(--muted); font-size:.75rem; margin-top:32px; }
    @media print { .sticky-summary, .toolbar, .filter-bar, .expand-btn { display:none !important; } .plan-details, .plan-details[hidden] { display:table-row !important; } }
  </style>
</head>
<body>
  <div class="sticky-summary">
    <div class="brand">Molina Automation \u00b7 Marketplace Sitecore Docs Dashboard</div>
    <div class="tiny-kpis">
      <div class="tiny-kpi ${overall === 'PASS' ? 'ok' : 'bad'}">Overall ${overall}</div>
      <div class="tiny-kpi ${failed ? 'bad' : 'ok'}">${passed}/${total} scopes</div>
      <div class="tiny-kpi">${esc(fmtDuration(totalDurationMs))}</div>
    </div>
    <div class="status"><span class="badge badge-${overall === 'PASS' ? 'ok' : 'bad'}">${overall}</span></div>
    <div class="toolbar">
      <button onclick="document.documentElement.classList.toggle('dark')">Theme</button>
      <button onclick="window.print()">Print</button>
    </div>
  </div>

  <div class="wrap">
    <section class="test-details">
      <div class="td-eyebrow">Consolidated Dashboard</div>
      <div class="td-title-row">
        <h2 class="td-title">Marketplace Sitecore Docs \u2014 SBC / EOC / OOC / SOB Verification${esc(stateTitle)}</h2>
        <span class="badge badge-${overall === 'PASS' ? 'ok' : 'bad'}">${overall}</span>
      </div>
      <p class="td-desc">Every Sitecore-hosted plan document PDF (SBC / EOC / OOC / SOB, English &amp; Spanish) is hit directly by URL and verified for viewer mount + filename match. One row = one URL. Use the filters below to narrow by state, doc-type, language or status; click a row's arrow for the requested vs settled URL comparison.</p>
    </section>

    <div class="kpi-grid">
      <div class="kpi info"><div class="kpi-label">Total URLs</div><div class="kpi-value">${total}</div></div>
      <div class="kpi ok"><div class="kpi-label">Passed</div><div class="kpi-value">${passed}</div><div class="kpi-sub">${total ? Math.round((passed / total) * 100) : 0}% pass-rate</div></div>
      <div class="kpi ${failed ? 'bad' : ''}"><div class="kpi-label">Failed</div><div class="kpi-value">${failed}</div></div>
      <div class="kpi info"><div class="kpi-label">States covered</div><div class="kpi-value">${states.length}</div><div class="kpi-sub">${esc(states.join(', ') || '\u2014')}</div></div>
      <div class="kpi info"><div class="kpi-label">Doc-types</div><div class="kpi-value">${doctypes.length}</div><div class="kpi-sub">${esc(doctypes.join(' / ') || '\u2014')}</div></div>
      <div class="kpi"><div class="kpi-label">Total duration</div><div class="kpi-value">${esc(fmtDuration(totalDurationMs))}</div></div>
    </div>

    ${states.length ? `<div class="state-strip">
      <div class="state-strip-label">Per-state breakdown:</div>
      ${states.map((st) => {
        const b = stateStats.get(st);
        const ok = b.failed === 0;
        return `<span class="state-pill ${ok ? 'ok' : 'bad'}" onclick="filterByState('${esc(st)}')" title="Click to filter by ${esc(st)}">${esc(st)} <span class="state-count">${b.passed}/${b.total}</span></span>`;
      }).join('')}
    </div>` : ''}

    <div class="filter-bar">
      <input type="search" id="fSearch" class="search-in" placeholder="Search by TestId, plan, filename\u2026" autocomplete="off"/>
      <select id="fStatus">
        <option value="">All statuses</option>
        <option value="PASS">Pass only</option>
        <option value="FAIL">Fail only</option>
      </select>
      <select id="fState">
        <option value="">All states</option>
        ${states.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
      <select id="fDoctype">
        <option value="">All doc-types</option>
        ${doctypes.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
      </select>
      <select id="fLang">
        <option value="">All languages</option>
        ${langs.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
      </select>
      <button type="button" class="clear-btn" onclick="clearFilters()">Clear</button>
      <div class="filter-summary" id="filterSummary">${total} of ${total} URLs</div>
    </div>

    <div class="plans-wrap">
      <table class="plans-table" id="plansTable">
        <thead>
          <tr>
            <th></th>
            <th>TestId</th>
            <th>State</th>
            <th>Plan</th>
            <th>Doc</th>
            <th>Lang</th>
            <th>Status</th>
            <th>Expected filename</th>
            <th>Duration</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px;">No variant.json files found. Run npm run test:marketplace:docs first.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="footer">Generated ${esc(timestamp)} \u00b7 ${scopes.length} URL(s) indexed \u00b7 Molina Automation Framework</div>
  </div>

  <script>
    function toggleScope(btn) {
      var row = btn.closest('tr');
      var detail = row.nextElementSibling;
      if (!detail || !detail.classList.contains('plan-details')) return;
      var isOpen = !detail.hasAttribute('hidden');
      if (isOpen) { detail.setAttribute('hidden', ''); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      else        { detail.removeAttribute('hidden');  btn.classList.add('open');    btn.setAttribute('aria-expanded', 'true');  }
    }
    (function () {
      var search  = document.getElementById('fSearch');
      var status  = document.getElementById('fStatus');
      var state   = document.getElementById('fState');
      var doctype = document.getElementById('fDoctype');
      var lang    = document.getElementById('fLang');
      var summary = document.getElementById('filterSummary');
      var rows    = Array.prototype.slice.call(document.querySelectorAll('#plansTable tbody tr.plan-row'));
      var total   = rows.length;

      function apply() {
        var q  = (search.value || '').trim().toLowerCase();
        var st = status.value;
        var s  = state.value;
        var d  = doctype.value;
        var l  = lang.value;
        var shown = 0;
        rows.forEach(function (r) {
          var okQ  = !q  || r.getAttribute('data-search').indexOf(q) !== -1;
          var okSt = !st || r.getAttribute('data-status') === st;
          var okS  = !s  || r.getAttribute('data-state')  === s;
          var okD  = !d  || r.getAttribute('data-doctype')=== d;
          var okL  = !l  || r.getAttribute('data-lang')   === l;
          var visible = okQ && okSt && okS && okD && okL;
          r.style.display = visible ? '' : 'none';
          var detail = r.nextElementSibling;
          if (detail && detail.classList.contains('plan-details')) {
            detail.style.display = visible && !detail.hasAttribute('hidden') ? '' : 'none';
          }
          if (visible) shown++;
        });
        summary.textContent = shown + ' of ' + total + ' URL' + (total === 1 ? '' : 's');
      }
      window.clearFilters = function () {
        search.value = ''; status.value = ''; state.value = ''; doctype.value = ''; lang.value = '';
        apply();
      };
      window.filterByState = function (st) {
        state.value = st === state.value ? '' : st;
        apply();
        document.getElementById('plansTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      ['input','change'].forEach(function (evt) {
        search.addEventListener(evt, apply);
        status.addEventListener(evt, apply);
        state.addEventListener(evt, apply);
        doctype.addEventListener(evt, apply);
        lang.addEventListener(evt, apply);
      });
    })();
  </script>
</body>
</html>
`;
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Discover all `variant.json` files under `rootDir` and write:
 *   • ONE `Consolidated.html`               — every URL, all states  (nested-link dashboard)
 *   • ONE `Consolidated-<STATE>.html` per   — that state's URLs      (nested-link dashboard)
 *     state present in the results
 *   • ONE `all-reports-<STATE>/` folder per — copies of every individual
 *     state present in the results             report (self-contained HTMLs) + a
 *                                              flat-link `Consolidated-<STATE>.html`
 *                                              so QA can zip + attach the whole
 *                                              folder to a user story
 *
 * Returns { file, count, perState, flat }.
 */
function generateSitecoreDocsDashboard({ rootDir }) {
  const scopes = discoverScopes(rootDir);
  fs.mkdirSync(rootDir, { recursive: true });

  const allFile = path.join(rootDir, 'Consolidated.html');
  fs.writeFileSync(allFile, renderDashboardHtml(scopes), 'utf8');

  const byState = new Map();
  for (const s of scopes) {
    const st = String(s.data.state || '').toUpperCase();
    if (!st) continue;
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(s);
  }

  const perState = [];
  const flat = [];
  for (const [st, list] of byState) {
    const file = path.join(rootDir, `Consolidated-${st}.html`);
    fs.writeFileSync(file, renderDashboardHtml(list), 'utf8');
    perState.push({ state: st, file, count: list.length });

    try {
      const { flatDir, htmlCount } = copyReportsToFlatFolder({ rootDir, state: st, scopes: list });
      flat.push({ state: st, dir: flatDir, htmlCount });
    } catch (err) {
      console.error(`[TEARDOWN][MP-DOCS] Flat folder for ${st} failed: ${err && err.message}`);
    }
  }

  return { file: allFile, count: scopes.length, perState, flat };
}

/**
 * Copy each per-scope's self-contained HTML report into a single flat
 * folder (`all-reports-<STATE>/`) and write a flat-link dashboard next
 * to them. Screenshots are embedded as base64 data URIs in the source
 * HTMLs already, so nothing else needs to be copied.
 */
function copyReportsToFlatFolder({ rootDir, state, scopes }) {
  const flatDir = path.join(rootDir, `all-reports-${state}`);
  fs.mkdirSync(flatDir, { recursive: true });

  // Wipe previous run's copies so removed test IDs don't linger.
  for (const entry of fs.readdirSync(flatDir)) {
    fs.rmSync(path.join(flatDir, entry), { force: true });
  }

  let htmlCount = 0;
  for (const sc of scopes) {
    const rel = sc.data.reportFile;
    if (!rel) continue;
    const src = path.join(rootDir, rel.split('/').join(path.sep));
    if (!fs.existsSync(src)) continue;
    const dst = path.join(flatDir, path.basename(src));
    fs.copyFileSync(src, dst);
    htmlCount += 1;
  }

  // Flat-link dashboard so the folder is self-navigable.
  const dashboardFile = path.join(flatDir, `Consolidated-${state}.html`);
  fs.writeFileSync(dashboardFile, renderDashboardHtml(scopes, { flatLinks: true }), 'utf8');

  return { flatDir, htmlCount };
}

module.exports = { generateSitecoreDocsDashboard };
