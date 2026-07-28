/**
 * Marketplace Drug Pharmacy — consolidated dashboard.
 *
 * Scans `reports/marketplace-pharmacy/` for per-scope folders that contain
 * a `variant.json` (emitted by tests/marketplace/marketplaceDrugPharmacy.spec.js)
 * and produces ONE top-level dashboard HTML at:
 *
 *   reports/marketplace-pharmacy/Consolidated.html
 *
 * Design goals (same as marketplacePlansSummary):
 *   • Screenshots NEVER embedded — the file stays small (~1–3 MB even at
 *     50+ scopes) so it's shareable by email / SharePoint / Teams.
 *   • Interactive filters: text search, status, state, link label.
 *   • Expand-per-row shows the initial + final URL details inline.
 *   • Per-state pills at the top for at-a-glance coverage overview.
 *
 * Existing per-scope HTML reports are LEFT UNTOUCHED — this dashboard is
 * purely additive.
 */

const fs   = require('fs');
const path = require('path');

// ─── Discovery ─────────────────────────────────────────────────────────────

function discoverScopes(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const scopes = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(rootDir, entry.name, 'variant.json');
    if (!fs.existsSync(jsonPath)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch { continue; }
    scopes.push({ folderName: entry.name, folder: path.join(rootDir, entry.name), data });
  }
  scopes.sort((a, b) => {
    const ta = String(a.data.testId || '');
    const tb = String(b.data.testId || '');
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
  return parts.slice(-3).join('/') || noQ;
}

// ─── Row + full HTML rendering ─────────────────────────────────────────────

function renderScopeRow(sc) {
  const { data, folderName } = sc;
  const status   = String(data.status || 'UNKNOWN').toUpperCase();
  const statusCls = status === 'PASS' ? 'ok' : status === 'FAIL' ? 'bad' : 'info';
  const rel      = data.reportFile
    ? path.posix.join(folderName, path.posix.basename(data.reportFile))
    : '';

  const initial = data.expectedInitialUrl || '';
  const observed = (data.planCards && data.planCards[0] && data.planCards[0].pdfUrl) || '';
  const initialActual = (data.planCards && data.planCards[0] && data.planCards[0].href) || '';
  const finalExpected = data.expectedFinalUrl || '';

  return `
  <tr class="plan-row plan-row-${statusCls}"
      data-status="${esc(status)}"
      data-state="${esc((data.state || '').toUpperCase())}"
      data-link="${esc(data.linkLabel || '')}"
      data-search="${esc(([data.testId, data.stateName, data.state, data.linkLabel].filter(Boolean).join(' ')).toLowerCase())}">
    <td class="c-expand"><button type="button" class="expand-btn" onclick="toggleScope(this)" aria-expanded="false" title="Show URL detail">\u25B8</button></td>
    <td class="c-testid mono">${esc(data.testId || folderName)}</td>
    <td class="c-state">${esc((data.state || '').toUpperCase())}${data.stateName ? ` <span class="muted">(${esc(data.stateName)})</span>` : ''}</td>
    <td class="c-link">${esc(data.linkLabel || '')}</td>
    <td class="c-status"><span class="badge badge-${statusCls}">${esc(status)}</span></td>
    <td class="c-url mono" title="${esc(observed)}">${esc(urlTail(observed))}</td>
    <td class="c-dur mono">${esc(fmtDuration(data.durationMs))}</td>
    <td class="c-openlink">${rel ? `<a href="${esc(rel)}" target="_blank" rel="noopener">Open&nbsp;&rarr;</a>` : ''}</td>
  </tr>
  <tr class="plan-details" hidden>
    <td colspan="8">
      <div class="plan-details-inner">
        <div class="plan-details-head">
          <strong>${esc(data.testName || data.testId || folderName)}</strong>
          ${data.testDescription ? `<div class="plan-details-desc">${esc(data.testDescription)}</div>` : ''}
        </div>
        <table class="urls-table">
          <thead>
            <tr><th style="width:180px;">Field</th><th>Expected</th><th>Actual</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="field">Drug page URL</td>
              <td class="url mono" title="${esc(data.drugUrl || '')}">${esc(data.drugUrl || '')}</td>
              <td class="url mono">\u2014</td>
            </tr>
            <tr>
              <td class="field">Continue link href (initial)</td>
              <td class="url mono" title="${esc(initial)}">${esc(initial || '(auto — no expected)')}</td>
              <td class="url mono" title="${esc(initialActual)}">${esc(initialActual || '(none)')}</td>
            </tr>
            <tr>
              <td class="field">Final URL after redirects</td>
              <td class="url mono" title="${esc(finalExpected)}">${esc(finalExpected || '(auto — capture-only)')}</td>
              <td class="url mono" title="${esc(observed)}">${esc(observed || '(none)')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </td>
  </tr>`;
}

function renderDashboardHtml(scopes) {
  const total  = scopes.length;
  const passed = scopes.filter((s) => s.data.status === 'PASS').length;
  const failed = total - passed;
  const totalDurationMs = scopes.reduce((sum, s) => sum + (Number(s.data.durationMs) || 0), 0);
  const overall = failed === 0 && total > 0 ? 'PASS' : 'FAIL';

  // Aggregate per-state stats + per-link stats.
  const statesSet = new Set();
  const linksSet  = new Set();
  const stateStats = new Map();
  for (const s of scopes) {
    const st = String(s.data.state || '').toUpperCase();
    if (st) {
      statesSet.add(st);
      const bucket = stateStats.get(st) || { total: 0, passed: 0, failed: 0 };
      bucket.total += 1;
      if (s.data.status === 'PASS') bucket.passed += 1; else bucket.failed += 1;
      stateStats.set(st, bucket);
    }
    if (s.data.linkLabel) linksSet.add(String(s.data.linkLabel));
  }
  const states = [...statesSet].sort();
  const links  = [...linksSet].sort();

  const stateTitle = states.length === 0 ? ''
                   : states.length <= 4 ? ` (${states.join(', ')})`
                   : ` (${states.length} states)`;

  const rowsHtml  = scopes.map(renderScopeRow).join('');
  const timestamp = new Date().toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Marketplace Drug Pharmacy — Consolidated Dashboard</title>
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
    .wrap { max-width:1600px; margin:0 auto; padding:20px 20px 60px; }

    /* Sticky header */
    .sticky-summary {
      position: sticky; top:0; z-index:30; background: var(--surface); border-bottom:1px solid var(--border);
      padding:12px 20px; display:flex; align-items:center; gap:14px;
      box-shadow: 0 4px 18px rgba(15,23,42,.12);
    }
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
    .filter-bar select { padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: var(--surface); color: var(--text); font-family:inherit; font-size:.85rem; cursor:pointer; max-width: 320px; }
    .filter-bar .clear-btn { padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: transparent; color: var(--text); cursor:pointer; font-size:.85rem; }
    .filter-bar .clear-btn:hover { background: var(--bg); }
    .filter-summary { margin-left:auto; font-size:.82rem; color: var(--muted); }

    .plans-wrap { overflow-x:auto; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .plans-table { width:100%; border-collapse: separate; border-spacing:0; }
    .plans-table th, .plans-table td { padding:12px 14px; text-align:left; border-bottom:1px solid var(--border); font-size:.88rem; vertical-align: middle; }
    .plans-table thead th { background: var(--bg); font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); border-bottom:2px solid var(--border); }
    .plans-table tbody tr.plan-row:last-child td { border-bottom:none; }
    .plan-row-ok  td { background: var(--pass-bg); }
    .plan-row-bad td { background: var(--fail-bg); }
    .plan-row td { transition: background .15s; }
    .plan-row:hover td { filter: brightness(.98); }
    .expand-btn { background: transparent; border:1px solid var(--border); border-radius:6px; width:26px; height:26px; padding:0; cursor:pointer; color: var(--text); font-size:.85rem; transition: transform .12s; }
    .expand-btn.open { transform: rotate(90deg); background: var(--info-bg); color: var(--info); }
    .mono { font-family:'Consolas','Menlo', monospace; font-size:.82rem; }
    .c-testid   { white-space: nowrap; }
    .c-state    { white-space: nowrap; }
    .c-url      { max-width: 340px; }
    .c-dur      { text-align:right; white-space: nowrap; }
    .c-openlink a { text-decoration:none; color: var(--primary); font-weight:700; }
    .c-openlink a:hover { text-decoration: underline; }

    .plan-details > td { padding: 0; background: var(--surface); }
    html.dark .plan-details > td { background: var(--surface); }
    .plan-details-inner { padding:18px 24px; background: var(--surface); border-top: 3px solid var(--primary); border-bottom: 1px solid var(--border); }
    .plan-details-head strong { font-size:.95rem; color: var(--primary); }
    .plan-details-desc { margin-top:6px; color: var(--muted); font-size:.82rem; max-width:1000px; }
    .urls-table { width:100%; border-collapse: collapse; margin-top:12px; background: var(--bg); border-radius:8px; overflow:hidden; }
    .urls-table th, .urls-table td { padding:10px 12px; border-bottom:1px solid var(--border); font-size:.82rem; vertical-align: top; text-align:left; }
    .urls-table th { background: rgba(13,61,128,.08); font-size:.68rem; text-transform:uppercase; letter-spacing:.4px; color: var(--muted); font-weight:700; }
    html.dark .urls-table th { background: rgba(96,165,250,.12); }
    .urls-table tbody tr:last-child td { border-bottom:none; }
    .urls-table .field { font-weight:700; color: var(--text); }
    .urls-table .url   { font-family:'Consolas','Menlo', monospace; font-size:.75rem; word-break: break-all; }

    .muted { color: var(--muted); font-style: italic; }
    .footer { text-align:center; color: var(--muted); font-size:.75rem; margin-top:32px; }

    .state-strip { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 14px; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom:14px; }
    .state-strip-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; margin-right:4px; }
    .state-pill { display:inline-flex; align-items:center; gap:6px; padding:5px 12px; border-radius:14px; font-weight:700; font-size:.82rem; cursor:pointer; border:1px solid transparent; transition: transform .12s, box-shadow .12s; }
    .state-pill.ok  { background: var(--pass-bg); color: var(--pass); }
    .state-pill.bad { background: var(--fail-bg); color: var(--fail); }
    .state-pill:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0,0,0,.10); }
    .state-pill .state-count { font-family:'Consolas','Menlo',monospace; font-size:.75rem; opacity:.85; font-weight:700; }

    @media print {
      .sticky-summary, .toolbar, .filter-bar, .expand-btn { display:none !important; }
      .plan-details { display:table-row !important; }
      .plan-details[hidden] { display:table-row !important; }
    }
  </style>
</head>
<body>
  <div class="sticky-summary">
    <div class="brand">Molina Automation \u00b7 Marketplace Drug Pharmacy Dashboard</div>
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
        <h2 class="td-title">Marketplace Drug Pharmacy \u2014 All External-CTA Tests${esc(stateTitle)}</h2>
        <span class="badge badge-${overall === 'PASS' ? 'ok' : 'bad'}">${overall}</span>
      </div>
      <p class="td-desc">Overview of every (state, external-CTA-link) test on the Individual &amp; Family Drug page. Each row = one Excel row. Use the filters to narrow by state, link or status; click a row's arrow to see the initial + final URL comparison. Screenshots and step-by-step evidence stay in each scope's standalone report \u2014 click "Open \u2192" on any row to open it.</p>
    </section>

    <div class="kpi-grid">
      <div class="kpi info"><div class="kpi-label">Total scopes</div><div class="kpi-value">${total}</div></div>
      <div class="kpi ok"><div class="kpi-label">Passed</div><div class="kpi-value">${passed}</div><div class="kpi-sub">${total ? Math.round((passed / total) * 100) : 0}% pass-rate</div></div>
      <div class="kpi ${failed ? 'bad' : ''}"><div class="kpi-label">Failed</div><div class="kpi-value">${failed}</div></div>
      <div class="kpi info"><div class="kpi-label">States covered</div><div class="kpi-value">${states.length}</div><div class="kpi-sub">${esc(states.join(', ') || '\u2014')}</div></div>
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
      <input type="search" id="fSearch" class="search-in" placeholder="Search by TestId, state, link\u2026" autocomplete="off"/>
      <select id="fStatus">
        <option value="">All statuses</option>
        <option value="PASS">Pass only</option>
        <option value="FAIL">Fail only</option>
      </select>
      <select id="fState">
        <option value="">All states</option>
        ${states.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
      <select id="fLink">
        <option value="">All links</option>
        ${links.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
      </select>
      <button type="button" class="clear-btn" onclick="clearFilters()">Clear</button>
      <div class="filter-summary" id="filterSummary">${total} of ${total} scopes</div>
    </div>

    <div class="plans-wrap">
      <table class="plans-table" id="plansTable">
        <thead>
          <tr>
            <th></th>
            <th>TestId</th>
            <th>State</th>
            <th>Link Label</th>
            <th>Status</th>
            <th>Final URL (observed)</th>
            <th>Duration</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px;">No variant.json files found in reports/marketplace-pharmacy/. Run npm run test:marketplace:pharmacy first.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="footer">Generated ${esc(timestamp)} \u00b7 ${scopes.length} scope(s) indexed \u00b7 Molina Automation Framework</div>
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
      var link    = document.getElementById('fLink');
      var summary = document.getElementById('filterSummary');
      var rows    = Array.prototype.slice.call(document.querySelectorAll('#plansTable tbody tr.plan-row'));
      var total   = rows.length;

      function apply() {
        var q  = (search.value || '').trim().toLowerCase();
        var st = status.value;
        var s  = state.value;
        var l  = link.value;
        var shown = 0;
        rows.forEach(function (r) {
          var okQ  = !q  || r.getAttribute('data-search').indexOf(q) !== -1;
          var okSt = !st || r.getAttribute('data-status') === st;
          var okS  = !s  || r.getAttribute('data-state')  === s;
          var okL  = !l  || r.getAttribute('data-link')   === l;
          var visible = okQ && okSt && okS && okL;
          r.style.display = visible ? '' : 'none';
          var detail = r.nextElementSibling;
          if (detail && detail.classList.contains('plan-details')) {
            detail.style.display = visible && !detail.hasAttribute('hidden') ? '' : 'none';
          }
          if (visible) shown++;
        });
        summary.textContent = shown + ' of ' + total + ' scope' + (total === 1 ? '' : 's');
      }
      window.clearFilters = function () {
        search.value = ''; status.value = ''; state.value = ''; link.value = '';
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
        link.addEventListener(evt, apply);
      });
    })();
  </script>
</body>
</html>
`;
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Discover all `variant.json` files under `rootDir` and write ONE
 * `Consolidated.html` (all states combined). Returns { file, count }.
 */
function generatePharmacyDashboard({ rootDir }) {
  const scopes = discoverScopes(rootDir);
  fs.mkdirSync(rootDir, { recursive: true });
  const html = renderDashboardHtml(scopes);
  const file = path.join(rootDir, 'Consolidated.html');
  fs.writeFileSync(file, html, 'utf8');
  return { file, count: scopes.length };
}

module.exports = { generatePharmacyDashboard };
