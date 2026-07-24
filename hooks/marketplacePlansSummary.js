/**
 * Marketplace Plan Search — slim consolidated dashboard.
 *
 * Scans `reports/marketplace-plans/` for per-plan folders that contain a
 * `variant.json` companion (emitted by tests/marketplace/marketplacePlanSearch.spec.js)
 * and produces ONE top-level dashboard HTML at:
 *
 *   reports/marketplace-plans/Consolidated.html
 *
 * Design goals (unlike the marketplace-toggleCheck consolidated report):
 *   • Screenshots are NEVER embedded — the file stays small (~1–3 MB even
 *     with 100 plans) so it can be attached to email / SharePoint / Teams
 *     at any scale. Reviewers click "Open full report →" to see evidence.
 *   • Interactive filters (text search, status, state, doc-type) so a
 *     100-row table stays usable.
 *   • Expand-per-row shows the full per-URL PASS/FAIL breakdown inline as
 *     text (no images) — enough to triage without navigating away.
 *
 * Existing per-plan HTML reports are LEFT UNTOUCHED — this dashboard is
 * purely additive.
 *
 * Exposes:
 *   • generatePlansDashboard({ rootDir })   ← public entry
 */

const fs   = require('fs');
const path = require('path');

// ─── Filesystem discovery ──────────────────────────────────────────────────

function discoverPlans(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const plans = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(rootDir, entry.name);
    const jsonPath = path.join(folder, 'variant.json');
    if (!fs.existsSync(jsonPath)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch { continue; }
    plans.push({ folderName: entry.name, folder, data });
  }
  // Sort by testId (TC001, TC002, …) then by folder name as fallback.
  plans.sort((a, b) => {
    const ta = String(a.data.testId || '');
    const tb = String(b.data.testId || '');
    return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' })
        || a.folderName.localeCompare(b.folderName);
  });
  return plans;
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

/** Derive the doc-type ("SBC" / "SOB" / etc.) from a plan card's [LABEL] prefix. */
function labelFromCardName(name) {
  const m = String(name || '').match(/^\[([^\]]+)\]/);
  return m ? m[1].trim().toUpperCase() : '';
}

/** Compute per-plan aggregate: total PDF URLs, matched, failed, doc-types seen. */
function aggregatePlan(p) {
  const cards = Array.isArray(p.data.planCards) ? p.data.planCards : [];
  const total   = cards.length;
  const passed  = cards.filter(c => c.status === 'PASS').length;
  const failed  = total - passed;
  const labels  = Array.from(new Set(cards.map(c => labelFromCardName(c.name)).filter(Boolean)));
  return { total, passed, failed, labels };
}

// ─── HTML rendering ────────────────────────────────────────────────────────

function renderPlanRow(p) {
  const { data, folderName } = p;
  const status   = String(data.status || 'UNKNOWN').toUpperCase();
  const statusCls = status === 'PASS' ? 'ok' : status === 'FAIL' ? 'bad' : 'info';
  const agg      = aggregatePlan(p);
  const labels   = agg.labels.join(' + ') || '—';
  const rel      = data.reportFile
    ? path.posix.join(folderName, path.posix.basename(data.reportFile))
    : '';

  // Per-URL detail rows for the expandable panel. Each card = one expected URL
  // resolution (PASS = match, FAIL = mismatch/missing). Trims long URLs to the
  // filename tail for readability with the full URL kept in the title attr.
  const cardRows = (data.planCards || []).map((c, idx) => {
    const cs   = String(c.status || 'INFO').toUpperCase();
    const csCls = cs === 'PASS' ? 'ok' : cs === 'FAIL' ? 'bad' : 'info';
    const lbl  = labelFromCardName(c.name);
    const langMatch = /\/english\//i.test(c.expectedUrl || c.pdfUrl || '') ? 'EN'
                    : /\/spanish\//i.test(c.expectedUrl || c.pdfUrl || '') ? 'ES' : '';
    const pdfTail = (u) => {
      const s = String(u || '');
      if (!s) return '(none)';
      const noQ = s.split('?')[0].split('#')[0];
      const parts = noQ.split('/');
      return parts.slice(-3).join('/');
    };
    const err = c.error ? esc(c.error) : '';
    return `
      <tr class="card-row card-row-${csCls}">
        <td class="card-num">#${idx + 1}</td>
        <td class="card-chips">
          ${lbl ? `<span class="doc-chip doc-${lbl.toLowerCase()}">${esc(lbl)}</span>` : ''}
          ${langMatch ? `<span class="lang-chip lang-${langMatch.toLowerCase()}">${esc(langMatch)}</span>` : ''}
        </td>
        <td class="card-status"><span class="badge badge-${csCls}">${esc(cs)}</span></td>
        <td class="card-url" title="${esc(c.expectedUrl || '')}">${esc(pdfTail(c.expectedUrl))}</td>
        <td class="card-url" title="${esc(c.pdfUrl || '')}">${esc(pdfTail(c.pdfUrl))}</td>
        <td class="card-err">${err}</td>
      </tr>`;
  }).join('');

  return `
  <tr class="plan-row plan-row-${statusCls}"
      data-status="${esc(status)}"
      data-state="${esc(data.state || '')}"
      data-labels="${esc(agg.labels.join('|'))}"
      data-search="${esc(([data.testId, data.planName, data.state, agg.labels.join(' ')].filter(Boolean).join(' ')).toLowerCase())}">
    <td class="c-expand"><button type="button" class="expand-btn" onclick="togglePlan(this)" aria-expanded="false" title="Show per-URL details">\u25B8</button></td>
    <td class="c-testid mono">${esc(data.testId || folderName)}</td>
    <td class="c-plan">${esc(data.planName || '')}</td>
    <td class="c-state">${esc(data.state || '')}</td>
    <td class="c-labels">${esc(labels)}</td>
    <td class="c-status"><span class="badge badge-${statusCls}">${esc(status)}</span></td>
    <td class="c-count">${agg.passed}/${agg.total}</td>
    <td class="c-dur mono">${esc(fmtDuration(data.durationMs))}</td>
    <td class="c-link">${rel ? `<a href="${esc(rel)}" target="_blank" rel="noopener">Open&nbsp;&rarr;</a>` : ''}</td>
  </tr>
  <tr class="plan-details" hidden>
    <td colspan="9">
      <div class="plan-details-inner">
        <div class="plan-details-head">
          <strong>${esc(data.testName || data.testId || folderName)}</strong>
          ${data.testDescription ? `<div class="plan-details-desc">${esc(data.testDescription)}</div>` : ''}
        </div>
        <table class="cards-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Status</th>
              <th>Expected PDF</th>
              <th>Actual PDF</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>${cardRows || '<tr><td colspan="6" class="muted">No plan cards recorded.</td></tr>'}</tbody>
        </table>
      </div>
    </td>
  </tr>`;
}

function renderDashboardHtml(plans) {
  const total  = plans.length;
  const passed = plans.filter(p => p.data.status === 'PASS').length;
  const failed = total - passed;
  const totalDurationMs = plans.reduce((s, p) => s + (Number(p.data.durationMs) || 0), 0);
  const overall = failed === 0 && total > 0 ? 'PASS' : 'FAIL';

  // Aggregate PDF stats + per-state breakdown across all plans.
  let totalCards = 0, passedCards = 0;
  const statesSet = new Set();
  const labelsSet = new Set();
  const stateStats = new Map();   // state -> { total, passed, failed }
  for (const p of plans) {
    const cards = p.data.planCards || [];
    totalCards  += cards.length;
    passedCards += cards.filter(c => c.status === 'PASS').length;
    const st = p.data.state ? String(p.data.state).toUpperCase() : '';
    if (st) {
      statesSet.add(st);
      const bucket = stateStats.get(st) || { total: 0, passed: 0, failed: 0 };
      bucket.total += 1;
      if (p.data.status === 'PASS') bucket.passed += 1; else bucket.failed += 1;
      stateStats.set(st, bucket);
    }
    (cards || []).forEach(c => {
      const l = labelFromCardName(c.name);
      if (l) labelsSet.add(l);
    });
  }
  const states = [...statesSet].sort();
  const labels = [...labelsSet].sort();

  // Human-readable state summary for the title.
  const stateTitle = states.length === 0 ? ''
                   : states.length <= 4 ? ` (${states.join(', ')})`
                   : ` (${states.length} states)`;

  const rowsHtml = plans.map(renderPlanRow).join('');
  const timestamp = new Date().toLocaleString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Marketplace Plan Search — Consolidated Dashboard</title>
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

    /* Test Details header card */
    .test-details { background: linear-gradient(135deg,#1a3a6b 0%, #0d6efd 100%); color:#fff; border-radius: var(--radius); padding:24px 28px; margin-top:18px; box-shadow: var(--shadow); }
    .td-eyebrow { font-size:.72rem; letter-spacing:.7px; text-transform:uppercase; opacity:.75; font-weight:700; margin-bottom:4px; }
    .td-title-row { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .td-title { font-size:1.55rem; margin:0; font-weight:700; }
    .td-desc { margin:8px 0 0; opacity:.9; font-size:.92rem; max-width:960px; }

    /* KPIs */
    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:14px; margin:18px 0; }
    .kpi { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); padding:16px; text-align:center; box-shadow: var(--shadow); }
    .kpi-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); font-weight:700; }
    .kpi-value { font-size:1.7rem; font-weight:800; margin-top:4px; }
    .kpi-sub { font-size:.72rem; color: var(--muted); margin-top:2px; }
    .kpi.ok  { border-left:4px solid var(--pass); } .kpi.ok  .kpi-value { color: var(--pass); }
    .kpi.bad { border-left:4px solid var(--fail); } .kpi.bad .kpi-value { color: var(--fail); }
    .kpi.info { border-left:4px solid var(--info); } .kpi.info .kpi-value { color: var(--info); }

    /* Filter bar */
    .filter-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:12px 14px; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom:14px; }
    .filter-bar .search-in { flex:1; min-width:220px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: var(--bg); color: var(--text); font-family:inherit; font-size:.9rem; }
    .filter-bar select { padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: var(--surface); color: var(--text); font-family:inherit; font-size:.85rem; cursor:pointer; }
    .filter-bar .clear-btn { padding:8px 12px; border:1px solid var(--border); border-radius:8px; background: transparent; color: var(--text); cursor:pointer; font-size:.85rem; }
    .filter-bar .clear-btn:hover { background: var(--bg); }
    .filter-summary { margin-left:auto; font-size:.82rem; color: var(--muted); }

    /* Plans table */
    .plans-wrap { overflow-x:auto; background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .plans-table { width:100%; border-collapse: separate; border-spacing:0; }
    .plans-table th, .plans-table td { padding:12px 14px; text-align:left; border-bottom:1px solid var(--border); font-size:.88rem; vertical-align: middle; }
    .plans-table thead th { background: var(--bg); font-size:.72rem; text-transform:uppercase; letter-spacing:.5px; color: var(--muted); border-bottom:2px solid var(--border); }
    .plans-table tbody tr.plan-row:last-child td { border-bottom:none; }
    .plan-row-ok  td { background: var(--pass-bg); }
    .plan-row-bad td { background: var(--fail-bg); }
    .plan-row-info { }
    .plan-row td { transition: background .15s; }
    .plan-row:hover td { filter: brightness(.98); }
    .expand-btn { background: transparent; border:1px solid var(--border); border-radius:6px; width:26px; height:26px; padding:0; cursor:pointer; color: var(--text); font-size:.85rem; transition: transform .12s; }
    .expand-btn.open { transform: rotate(90deg); background: var(--info-bg); color: var(--info); }
    .mono { font-family:'Consolas','Menlo', monospace; font-size:.82rem; }
    .c-testid { white-space: nowrap; }
    .c-count  { text-align:center; font-weight:700; font-family:'Consolas','Menlo', monospace; }
    .c-dur    { text-align:right; }
    .c-link a { text-decoration:none; color: var(--primary); font-weight:700; }
    .c-link a:hover { text-decoration: underline; }

    /* Expanded detail row */
    .plan-details > td { padding: 0; background: var(--surface); }
    html.dark .plan-details > td { background: var(--surface); }
    .plan-details-inner { padding:18px 24px; background: var(--surface); border-top: 3px solid var(--primary); border-bottom: 1px solid var(--border); }
    html.dark .plan-details-inner { background: var(--surface); }
    .plan-details-head strong { font-size:.95rem; color: var(--primary); }
    .plan-details-desc { margin-top:6px; color: var(--muted); font-size:.82rem; max-width:1000px; }
    .cards-table { width:100%; border-collapse: collapse; margin-top:12px; background: var(--bg); border-radius:8px; overflow:hidden; }
    .cards-table th, .cards-table td { padding:10px 12px; border-bottom:1px solid var(--border); font-size:.82rem; vertical-align: top; text-align:left; }
    .cards-table th { background: rgba(13,61,128,.08); font-size:.68rem; text-transform:uppercase; letter-spacing:.4px; color: var(--muted); font-weight:700; }
    html.dark .cards-table th { background: rgba(96,165,250,.12); }
    .cards-table tbody tr:last-child td { border-bottom:none; }
    .card-row-ok  td { background: rgba(10,125,52,.10); }
    .card-row-bad td { background: rgba(196,50,10,.10); }
    html.dark .card-row-ok  td { background: rgba(52,208,88,.10); }
    html.dark .card-row-bad td { background: rgba(255,107,107,.10); }
    .card-num { font-weight:700; color: var(--primary); width: 42px; text-align:center; }
    .card-chips { white-space: nowrap; }
    .card-url { font-family:'Consolas','Menlo', monospace; font-size:.74rem; color: var(--text); word-break: break-all; max-width: 360px; }
    .card-err { color: var(--fail); font-size:.78rem; max-width: 320px; }

    /* Chips */
    .doc-chip { display:inline-block; padding:2px 8px; border-radius:8px; font-weight:700; font-size:.68rem; letter-spacing:.4px; margin-right:4px; }
    .doc-sbc { background:#dbeafe; color:#1e40af; } html.dark .doc-sbc { background:#1e3a8a; color:#93c5fd; }
    .doc-sob { background:#ccfbf1; color:#0f766e; } html.dark .doc-sob { background:#134e4a; color:#5eead4; }
    .lang-chip { display:inline-block; padding:2px 8px; border-radius:8px; font-weight:700; font-size:.68rem; letter-spacing:.4px; }
    .lang-en { background:#fef3c7; color:#92400e; } html.dark .lang-en { background:#78350f; color:#fcd34d; }
    .lang-es { background:#ede9fe; color:#5b21b6; } html.dark .lang-es { background:#4c1d95; color:#c4b5fd; }

    .muted { color: var(--muted); font-style: italic; }
    .footer { text-align:center; color: var(--muted); font-size:.75rem; margin-top:32px; }

    /* Per-state summary strip */
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
    <div class="brand">Molina Automation \u00b7 Marketplace Plan Search Dashboard</div>
    <div class="tiny-kpis">
      <div class="tiny-kpi ${overall === 'PASS' ? 'ok' : 'bad'}">Overall ${overall}</div>
      <div class="tiny-kpi ${failed ? 'bad' : 'ok'}">${passed}/${total} plans</div>
      <div class="tiny-kpi ${passedCards === totalCards && totalCards > 0 ? 'ok' : 'bad'}">${passedCards}/${totalCards} PDFs matched</div>
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
        <h2 class="td-title">Marketplace Plan Search — All Plans${esc(stateTitle)}</h2>
        <span class="badge badge-${overall === 'PASS' ? 'ok' : 'bad'}">${overall}</span>
      </div>
      <p class="td-desc">Overview of every plan-search test run. Use the filters below to narrow by status, state or document type; click a row's arrow to see the per-URL PASS/FAIL breakdown inline. Screenshots and step-level evidence stay in each plan's standalone report \u2014 click "Open \u2192" on any row to open it.</p>
    </section>

    <div class="kpi-grid">
      <div class="kpi info"><div class="kpi-label">Total plans</div><div class="kpi-value">${total}</div></div>
      <div class="kpi ok"><div class="kpi-label">Passed</div><div class="kpi-value">${passed}</div><div class="kpi-sub">${total ? Math.round((passed / total) * 100) : 0}% pass-rate</div></div>
      <div class="kpi ${failed ? 'bad' : ''}"><div class="kpi-label">Failed</div><div class="kpi-value">${failed}</div></div>
      <div class="kpi ${(passedCards === totalCards && totalCards > 0) ? 'ok' : 'bad'}"><div class="kpi-label">PDF URLs</div><div class="kpi-value">${passedCards} / ${totalCards}</div><div class="kpi-sub">matched / total</div></div>
      <div class="kpi info"><div class="kpi-label">States covered</div><div class="kpi-value">${states.length}</div><div class="kpi-sub">${esc(states.join(', ') || '—')}</div></div>
      <div class="kpi"><div class="kpi-label">Total duration</div><div class="kpi-value">${esc(fmtDuration(totalDurationMs))}</div></div>
    </div>

    ${states.length ? `<div class="state-strip">
      <div class="state-strip-label">Per-state breakdown:</div>
      ${states.map(st => {
        const b = stateStats.get(st);
        const ok = b.failed === 0;
        return `<span class="state-pill ${ok ? 'ok' : 'bad'}" onclick="filterByState('${esc(st)}')" title="Click to filter by ${esc(st)}">${esc(st)} <span class="state-count">${b.passed}/${b.total}</span></span>`;
      }).join('')}
    </div>` : ''}

    <div class="filter-bar">
      <input type="search" id="fSearch" class="search-in" placeholder="Search by TestId, plan, state, doc-type\u2026" autocomplete="off"/>
      <select id="fStatus">
        <option value="">All statuses</option>
        <option value="PASS">Pass only</option>
        <option value="FAIL">Fail only</option>
      </select>
      <select id="fState">
        <option value="">All states</option>
        ${states.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
      <select id="fLabel">
        <option value="">All doc types</option>
        ${labels.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
      </select>
      <button type="button" class="clear-btn" onclick="clearFilters()">Clear</button>
      <div class="filter-summary" id="filterSummary">${total} of ${total} plans</div>
    </div>

    <div class="plans-wrap">
      <table class="plans-table" id="plansTable">
        <thead>
          <tr>
            <th></th>
            <th>TestId</th>
            <th>Plan</th>
            <th>State</th>
            <th>Doc types</th>
            <th>Status</th>
            <th>PDFs</th>
            <th>Duration</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px;">No variant.json files found in reports/marketplace-plans/.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="footer">Generated ${esc(timestamp)} \u00b7 ${plans.length} plans indexed \u00b7 Molina Automation Framework</div>
  </div>

  <script>
    // Expand / collapse per-plan details row.
    function togglePlan(btn) {
      var row = btn.closest('tr');
      var detail = row.nextElementSibling;
      if (!detail || !detail.classList.contains('plan-details')) return;
      var isOpen = !detail.hasAttribute('hidden');
      if (isOpen) {
        detail.setAttribute('hidden', '');
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      } else {
        detail.removeAttribute('hidden');
        btn.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    }

    // Filter/search over the plan rows.
    (function () {
      var search  = document.getElementById('fSearch');
      var status  = document.getElementById('fStatus');
      var state   = document.getElementById('fState');
      var label   = document.getElementById('fLabel');
      var summary = document.getElementById('filterSummary');
      var rows    = Array.prototype.slice.call(document.querySelectorAll('#plansTable tbody tr.plan-row'));
      var total   = rows.length;

      function apply() {
        var q  = (search.value || '').trim().toLowerCase();
        var st = status.value;
        var s  = state.value;
        var l  = label.value;
        var shown = 0;
        rows.forEach(function (r) {
          var okQ  = !q  || r.getAttribute('data-search').indexOf(q) !== -1;
          var okSt = !st || r.getAttribute('data-status')  === st;
          var okS  = !s  || r.getAttribute('data-state')   === s;
          var okL  = !l  || ('|' + r.getAttribute('data-labels') + '|').indexOf('|' + l + '|') !== -1;
          var visible = okQ && okSt && okS && okL;
          r.style.display = visible ? '' : 'none';
          var detail = r.nextElementSibling;
          if (detail && detail.classList.contains('plan-details')) {
            detail.style.display = visible && !detail.hasAttribute('hidden') ? '' : 'none';
          }
          if (visible) shown++;
        });
        summary.textContent = shown + ' of ' + total + ' plans';
      }
      window.clearFilters = function () {
        search.value = ''; status.value = ''; state.value = ''; label.value = '';
        apply();
      };
      // Called by the per-state summary pills at the top of the page.
      window.filterByState = function (st) {
        state.value = st === state.value ? '' : st;   // toggle if already selected
        apply();
        document.getElementById('plansTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      ['input','change'].forEach(function (evt) {
        search.addEventListener(evt, apply);
        status.addEventListener(evt, apply);
        state.addEventListener(evt, apply);
        label.addEventListener(evt, apply);
      });
    })();
  </script>
</body>
</html>
`;
}

// ─── Public entry ──────────────────────────────────────────────────────────

function generatePlansDashboard({ rootDir }) {
  const plans = discoverPlans(rootDir);
  fs.mkdirSync(rootDir, { recursive: true });

  // Group plans by their `state` field. Plans without a state fall into a
  // synthetic '_UNKNOWN' bucket that becomes `Consolidated.html`.
  const groups = new Map();  // state -> plans[]
  for (const p of plans) {
    const st = String(p.data.state || '').trim().toUpperCase() || '_UNKNOWN';
    if (!groups.has(st)) groups.set(st, []);
    groups.get(st).push(p);
  }

  // Clean any stale Consolidated*.html from previous runs that isn't part
  // of the current state set (avoids orphaned files when the state set
  // shrinks between runs).
  const currentFiles = new Set(
    [...groups.keys()].map(st => st === '_UNKNOWN' ? 'Consolidated.html' : `Consolidated-${st}.html`)
  );
  try {
    for (const f of fs.readdirSync(rootDir)) {
      if (/^Consolidated.*\.html$/i.test(f) && !currentFiles.has(f)) {
        try { fs.unlinkSync(path.join(rootDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* rootDir might not be readable — non-fatal */ }

  const written = [];
  for (const [state, statePlans] of groups) {
    const html = renderDashboardHtml(statePlans);
    const filename = state === '_UNKNOWN' ? 'Consolidated.html' : `Consolidated-${state}.html`;
    const file = path.join(rootDir, filename);
    fs.writeFileSync(file, html, 'utf8');
    written.push({ file, state: state === '_UNKNOWN' ? '' : state, count: statePlans.length });
  }

  return { written, count: plans.length };
}

module.exports = { generatePlansDashboard };
