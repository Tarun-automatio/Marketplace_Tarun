/**
 * Marketplace Brochure & Formulary — consolidated dashboards.
 *
 * Scans `reports/marketplace-brochure-formulary/` for per-state folders
 * with a `variant.json` companion and produces:
 *   • Consolidated.html            — every state, filterable table
 *   • Consolidated-<STATE>.html    — per-state file (one per state that ran)
 *   • all-reports-<STATE>/         — flat share folder (all HTMLs + a
 *                                    flat-link dashboard) for easy upload
 *
 * The flat folder pattern mirrors the Sitecore Docs suite so QA has a
 * single, familiar workflow across all four marketplace suites.
 */

const fs   = require('fs');
const path = require('path');

// ─── Discovery ─────────────────────────────────────────────────────────────

function discoverScopes(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const scopes = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('all-reports')) continue;
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
    return a.folderName.localeCompare(b.folderName, undefined, { numeric: true, sensitivity: 'base' });
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

/** Group a scope's planCards by docType so the row expander can show the totals. */
function docTypeTallies(scope) {
  const cards = Array.isArray(scope.data.planCards) ? scope.data.planCards : [];
  const buckets = new Map();
  for (const c of cards) {
    const key = String(c.docType || 'Other');
    if (!buckets.has(key)) buckets.set(key, { total: 0, passed: 0, failed: 0 });
    const b = buckets.get(key);
    b.total += 1;
    if (String(c.status).toUpperCase() === 'PASS') b.passed += 1; else b.failed += 1;
  }
  return buckets;
}

// ─── Row + full HTML rendering ─────────────────────────────────────────────

function renderScopeRow(sc, opts = {}) {
  const { data, folderName } = sc;
  const status    = String(data.status || 'UNKNOWN').toUpperCase();
  const statusCls = status === 'PASS' ? 'ok' : status === 'FAIL' ? 'bad' : 'info';
  const basename  = data.reportFile ? path.posix.basename(data.reportFile) : '';
  const rel       = opts.flatLinks
    ? basename
    : (data.reportFile ? path.posix.join(folderName, basename) : '');

  const tallies = docTypeTallies(sc);
  const summarize = (label) => {
    const b = tallies.get(label);
    if (!b) return `<span class="chip muted">${esc(label)}: \u2013</span>`;
    const cls = b.failed === 0 ? 'ok' : 'bad';
    return `<span class="chip chip-${cls}">${esc(label)}: ${b.passed}/${b.total}</span>`;
  };

  const cards = Array.isArray(data.planCards) ? data.planCards : [];
  const cardRows = cards.map((c) => {
    const cardCls = String(c.status).toUpperCase() === 'PASS' ? 'ok' : 'bad';
    return `<tr class="card-row card-row-${cardCls}">
      <td>${esc(c.docType || '')}</td>
      <td>${esc(c.langLabel || '')}</td>
      <td class="mono">${esc(c.expectedUrl || '')}</td>
      <td class="mono">${esc(c.pdfUrl || '(none)')}</td>
      <td><span class="badge badge-${cardCls}">${esc(c.status)}</span></td>
      <td>${esc(c.error || '')}</td>
    </tr>`;
  }).join('');

  return `
  <tr class="scope-row scope-row-${statusCls}"
      data-status="${esc(status)}"
      data-state="${esc(String(data.state || '').toUpperCase())}"
      data-search="${esc([data.testId, data.stateName, data.state].filter(Boolean).join(' ').toLowerCase())}">
    <td class="c-expand"><button type="button" class="expand-btn" onclick="toggleScope(this)" aria-expanded="false" title="Show doc-type breakdown">\u25B8</button></td>
    <td class="c-testid mono">${esc(data.testId || folderName)}</td>
    <td class="c-state">${esc((data.state || '').toUpperCase())}${data.stateName ? ` <span class="muted">(${esc(data.stateName)})</span>` : ''}</td>
    <td class="c-tallies">${summarize('Formulary')} ${summarize('Member Brochure')} ${summarize('Broker Brochure')}</td>
    <td class="c-status"><span class="badge badge-${statusCls}">${esc(status)}</span></td>
    <td class="c-dur mono">${esc(fmtDuration(data.durationMs))}</td>
    <td class="c-openlink">${rel ? `<a href="${esc(rel)}" target="_blank" rel="noopener">Open&nbsp;&rarr;</a>` : ''}</td>
  </tr>
  <tr class="scope-details" hidden>
    <td colspan="7">
      <div class="scope-details-inner">
        <div class="scope-details-head">
          <strong>${esc(data.testName || data.testId || folderName)}</strong>
          ${data.testDescription ? `<div class="scope-details-desc">${esc(data.testDescription)}</div>` : ''}
          ${data.vanityFormulary ? `<div class="scope-details-desc"><strong>Vanity URL:</strong> ${esc(data.vanityFormulary)}</div>` : ''}
        </div>
        <table class="cards-table">
          <thead>
            <tr><th>Doc-type</th><th>Lang</th><th>Expected URL</th><th>Actual URL</th><th>Status</th><th>Notes / Error</th></tr>
          </thead>
          <tbody>${cardRows || '<tr><td colspan="6" class="muted">No verified cards recorded.</td></tr>'}</tbody>
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

  const statesSet = new Set();
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
  }
  const states = [...statesSet].sort();
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
  <title>Marketplace Brochure &amp; Formulary — Consolidated Dashboard</title>
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
    .chip { display:inline-block; padding:2px 8px; border-radius:8px; font-size:.72rem; font-weight:700; letter-spacing:.3px; margin-right:4px; }
    .chip.muted { background: var(--info-bg); color: var(--muted); }
    .chip-ok    { background: var(--pass-bg); color: var(--pass); }
    .chip-bad   { background: var(--fail-bg); color: var(--fail); }

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

    .scopes-wrap { overflow-x:auto; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .scopes-table { width:100%; border-collapse: separate; border-spacing:0; }
    .scopes-table th, .scopes-table td { padding:12px 14px; text-align:left; border-bottom:1px solid var(--border); font-size:.88rem; vertical-align: middle; }
    .scopes-table thead th { background: var(--bg); font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); border-bottom:2px solid var(--border); }
    .scope-row-ok  td { background: var(--pass-bg); }
    .scope-row-bad td { background: var(--fail-bg); }
    .expand-btn { background: transparent; border:1px solid var(--border); border-radius:6px; width:26px; height:26px; padding:0; cursor:pointer; color: var(--text); font-size:.85rem; transition: transform .12s; }
    .expand-btn.open { transform: rotate(90deg); background: var(--info-bg); color: var(--info); }
    .mono { font-family:'Consolas','Menlo', monospace; font-size:.82rem; word-break: break-all; }
    .c-tallies { min-width:360px; }
    .c-dur     { text-align:right; white-space: nowrap; }
    .c-openlink a { text-decoration:none; color: var(--primary); font-weight:700; }
    .c-openlink a:hover { text-decoration: underline; }

    .scope-details > td { padding: 0; background: var(--surface); }
    .scope-details-inner { padding:18px 24px; background: var(--surface); border-top: 3px solid var(--primary); border-bottom: 1px solid var(--border); }
    .scope-details-head strong { font-size:.95rem; color: var(--primary); }
    .scope-details-desc { margin-top:6px; color: var(--muted); font-size:.82rem; }
    .cards-table { width:100%; border-collapse: collapse; margin-top:10px; background: var(--bg); border-radius:8px; overflow:hidden; }
    .cards-table th, .cards-table td { padding:8px 10px; border-bottom:1px solid var(--border); font-size:.8rem; vertical-align: top; }
    .cards-table th { background: rgba(13,61,128,.08); font-size:.68rem; text-transform:uppercase; letter-spacing:.4px; color: var(--muted); font-weight:700; text-align:left; }
    .card-row-ok  td { color: var(--text); }
    .card-row-bad td { color: var(--fail); }

    .muted { color: var(--muted); font-style: italic; }
    .footer { text-align:center; color: var(--muted); font-size:.75rem; margin-top:32px; }
    @media print { .sticky-summary, .toolbar, .filter-bar, .expand-btn { display:none !important; } .scope-details, .scope-details[hidden] { display:table-row !important; } }
  </style>
</head>
<body>
  <div class="sticky-summary">
    <div class="brand">Molina Automation \u00b7 Marketplace Brochure &amp; Formulary Dashboard</div>
    <div class="tiny-kpis">
      <div class="tiny-kpi ${overall === 'PASS' ? 'ok' : 'bad'}">Overall ${overall}</div>
      <div class="tiny-kpi ${failed ? 'bad' : 'ok'}">${passed}/${total} states</div>
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
        <h2 class="td-title">Marketplace Brochure &amp; Formulary \u2014 Filter + Direct-URL Verification${esc(stateTitle)}</h2>
        <span class="badge badge-${overall === 'PASS' ? 'ok' : 'bad'}">${overall}</span>
      </div>
      <p class="td-desc">Per state on the Forms &amp; Documents page: apply the Marketplace Audience + Formulary/Member Brochure Category filter, search, and verify each PDF. Broker Brochures are verified via direct URL hit (they aren't surfaced on the Marketplace filters). Click any row's arrow to see the per-doc-type breakdown.</p>
    </section>

    <div class="kpi-grid">
      <div class="kpi info"><div class="kpi-label">Total states</div><div class="kpi-value">${total}</div></div>
      <div class="kpi ok"><div class="kpi-label">Passed</div><div class="kpi-value">${passed}</div><div class="kpi-sub">${total ? Math.round((passed / total) * 100) : 0}% pass-rate</div></div>
      <div class="kpi ${failed ? 'bad' : ''}"><div class="kpi-label">Failed</div><div class="kpi-value">${failed}</div></div>
      <div class="kpi"><div class="kpi-label">Total duration</div><div class="kpi-value">${esc(fmtDuration(totalDurationMs))}</div></div>
    </div>

    <div class="filter-bar">
      <input type="search" id="fSearch" class="search-in" placeholder="Search by TestId / state\u2026" autocomplete="off"/>
      <select id="fStatus">
        <option value="">All statuses</option>
        <option value="PASS">Pass only</option>
        <option value="FAIL">Fail only</option>
      </select>
      <select id="fState">
        <option value="">All states</option>
        ${states.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
      <button type="button" class="clear-btn" onclick="clearFilters()">Clear</button>
      <div class="filter-summary" id="filterSummary">${total} of ${total} states</div>
    </div>

    <div class="scopes-wrap">
      <table class="scopes-table" id="scopesTable">
        <thead>
          <tr>
            <th></th>
            <th>TestId</th>
            <th>State</th>
            <th>Doc-type tallies (passed / total)</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px;">No variant.json files found. Run npm run test:marketplace:brochure first.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="footer">Generated ${esc(timestamp)} \u00b7 ${scopes.length} state(s) indexed \u00b7 Molina Automation Framework</div>
  </div>

  <script>
    function toggleScope(btn) {
      var row = btn.closest('tr');
      var detail = row.nextElementSibling;
      if (!detail || !detail.classList.contains('scope-details')) return;
      var isOpen = !detail.hasAttribute('hidden');
      if (isOpen) { detail.setAttribute('hidden', ''); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      else        { detail.removeAttribute('hidden');  btn.classList.add('open');    btn.setAttribute('aria-expanded', 'true');  }
    }
    (function () {
      var search  = document.getElementById('fSearch');
      var status  = document.getElementById('fStatus');
      var state   = document.getElementById('fState');
      var summary = document.getElementById('filterSummary');
      var rows    = Array.prototype.slice.call(document.querySelectorAll('#scopesTable tbody tr.scope-row'));
      var total   = rows.length;

      function apply() {
        var q  = (search.value || '').trim().toLowerCase();
        var st = status.value;
        var s  = state.value;
        var shown = 0;
        rows.forEach(function (r) {
          var okQ  = !q  || r.getAttribute('data-search').indexOf(q) !== -1;
          var okSt = !st || r.getAttribute('data-status') === st;
          var okS  = !s  || r.getAttribute('data-state')  === s;
          var visible = okQ && okSt && okS;
          r.style.display = visible ? '' : 'none';
          var detail = r.nextElementSibling;
          if (detail && detail.classList.contains('scope-details')) {
            detail.style.display = visible && !detail.hasAttribute('hidden') ? '' : 'none';
          }
          if (visible) shown++;
        });
        summary.textContent = shown + ' of ' + total + ' state' + (total === 1 ? '' : 's');
      }
      window.clearFilters = function () {
        search.value = ''; status.value = ''; state.value = '';
        apply();
      };
      ['input','change'].forEach(function (evt) {
        search.addEventListener(evt, apply);
        status.addEventListener(evt, apply);
        state.addEventListener(evt, apply);
      });
    })();
  </script>
</body>
</html>
`;
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Discover all variant.json files and write:
 *   • Consolidated.html            (all states)
 *   • Consolidated-<STATE>.html    (per state)
 *   • all-reports-<STATE>/         (flat share folder)
 * Returns { file, count, perState, flat }.
 */
function generateBrochureFormularyDashboard({ rootDir }) {
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
      console.error(`[TEARDOWN][MP-BF] Flat folder for ${st} failed: ${err && err.message}`);
    }
  }

  return { file: allFile, count: scopes.length, perState, flat };
}

/** Copy each state's self-contained HTML into a flat folder + a flat-link dashboard. */
function copyReportsToFlatFolder({ rootDir, state, scopes }) {
  const safeState = String(state).replace(/[\\/:*?"<>|]/g, '-');
  const flatDir = path.join(rootDir, `all-reports-${safeState}`);
  fs.mkdirSync(flatDir, { recursive: true });

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

  const dashboardFile = path.join(flatDir, `Consolidated-${safeState}.html`);
  fs.writeFileSync(dashboardFile, renderDashboardHtml(scopes, { flatLinks: true }), 'utf8');

  return { flatDir, htmlCount };
}

module.exports = { generateBrochureFormularyDashboard };
