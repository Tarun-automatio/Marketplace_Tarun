/**
 * Drug Lookup Tool — per-language consolidated dashboard.
 *
 * Scans a report root (reports/drug-tool-EN or reports/drug-tool-ES) for
 * per-scope folders containing a `variant.json` (emitted by
 * tests/drugTool/drugTool.spec.js) and produces ONE dashboard HTML:
 *
 *   <rootDir>/Consolidated.html
 *
 * Design: screenshots are NEVER embedded (file stays small + shareable).
 * Each state row expands to show its setup steps + per-plan Continue/URL
 * results. Per-scope standalone HTML reports are left untouched.
 */

const fs   = require('fs');
const path = require('path');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000)  return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}

function discoverScopes(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const scopes = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(rootDir, entry.name, 'variant.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      scopes.push({ folderName: entry.name, data: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) });
    } catch { /* skip malformed */ }
  }
  scopes.sort((a, b) => String(a.data.state || '').localeCompare(String(b.data.state || '')));
  return scopes;
}

function badge(status) {
  const up = String(status || '').toUpperCase();
  const cls = up === 'PASS' ? 'ok' : up === 'FAIL' ? 'bad' : 'info';
  return `<span class="badge ${cls}">${esc(up || 'INFO')}</span>`;
}

function renderPlanRows(planCards) {
  return (planCards || []).map((c) => {
    const vals = (c.validations || []).map((v) =>
      `<div class="val"><span class="vb ${String(v.status).toLowerCase() === 'pass' ? 'ok' : 'bad'}">${esc(v.status)}</span> ${esc(v.name)}${v.description ? ` — <span class="muted">${esc(v.description)}</span>` : ''}</div>`
    ).join('');
    return `
      <tr class="plan ${String(c.status).toUpperCase() === 'FAIL' ? 'row-bad' : ''}">
        <td>${esc(c.name)}</td>
        <td>${badge(c.status)}</td>
        <td class="url">${esc(c.expectedUrl || '')}</td>
        <td class="url">${esc(c.actualUrl || c.href || '')}</td>
      </tr>
      <tr class="plan-detail"><td colspan="4">${vals || '<span class="muted">No validations recorded.</span>'}</td></tr>`;
  }).join('');
}

function renderScope(sc) {
  const d = sc.data;
  const status = String(d.status || 'UNKNOWN').toUpperCase();
  const rel = d.reportFile ? esc(d.reportFile.split(path.sep).join('/')) : '';
  const steps = (d.setupSteps || []).map((s) =>
    `<div class="step"><span class="vb ${String(s.status).toLowerCase() === 'pass' ? 'ok' : 'bad'}">${esc(s.status)}</span> <b>${esc(s.name)}</b>${s.actual ? `<div class="muted pre">${esc(s.actual)}</div>` : ''}</div>`
  ).join('');

  return `
    <div class="scope" data-status="${status}" data-state="${esc(d.state)}">
      <div class="scope-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="chev">▶</span>
        <b>${esc(d.stateName || d.state)}</b>
        <span class="chip">${esc(d.state)}</span>
        <span class="chip">${esc(d.language)}</span>
        <span class="chip">${esc(d.device || '')}</span>
        ${badge(status)}
        <span class="spacer"></span>
        <span class="muted">${d.passPlans || 0}/${d.planCount || 0} plans OK</span>
        <span class="muted">${esc(fmtDuration(d.durationMs))}</span>
        ${rel ? `<a class="link" href="${rel}" onclick="event.stopPropagation()">open report ↗</a>` : ''}
      </div>
      <div class="scope-body">
        <div class="section-label">Setup steps</div>
        ${steps || '<span class="muted">No setup steps.</span>'}
        <div class="section-label">Plans (${(d.planCards || []).length})</div>
        <table class="plans"><thead><tr><th>Plan</th><th>Status</th><th>Expected URL</th><th>Observed URL</th></tr></thead>
          <tbody>${renderPlanRows(d.planCards)}</tbody></table>
      </div>
    </div>`;
}

function generateDashboard(rootDir, { language } = {}) {
  const scopes = discoverScopes(rootDir);
  if (!scopes.length) return { file: null, count: 0 };

  const total = scopes.length;
  const pass  = scopes.filter((s) => String(s.data.status).toUpperCase() === 'PASS').length;
  const fail  = total - pass;
  const planTotal = scopes.reduce((n, s) => n + (s.data.planCount || 0), 0);
  const planPass  = scopes.reduce((n, s) => n + (s.data.passPlans || 0), 0);
  const langLabel = language || (scopes[0] && scopes[0].data.language) || '';
  const generated = new Date().toLocaleString();

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drug Lookup Tool Dashboard — ${esc(langLabel)}</title>
<style>
  :root{--bg:#0f172a;--card:#fff;--muted:#64748b;--ok:#16a34a;--bad:#dc2626;--info:#2563eb;--line:#e2e8f0}
  *{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f1f5f9;color:#0f172a}
  header{background:linear-gradient(135deg,#0d9488,#0f766e);color:#fff;padding:20px 28px}
  header h1{margin:0 0 4px;font-size:22px}header .sub{opacity:.9;font-size:13px}
  .kpis{display:flex;gap:14px;flex-wrap:wrap;padding:18px 28px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;min-width:120px}
  .kpi .n{font-size:24px;font-weight:700}.kpi .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .kpi.ok .n{color:var(--ok)}.kpi.bad .n{color:var(--bad)}
  .toolbar{padding:0 28px 10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .toolbar input,.toolbar select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px}
  main{padding:8px 28px 40px}
  .scope{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden}
  .scope-head{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none}
  .scope-head:hover{background:#f8fafc}.scope .chev{transition:transform .15s;color:var(--muted)}
  .scope.open .chev{transform:rotate(90deg)}
  .scope-body{display:none;padding:4px 16px 16px;border-top:1px solid var(--line)}
  .scope.open .scope-body{display:block}
  .spacer{flex:1}
  .chip{background:#f1f5f9;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11px;color:#334155}
  .badge{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}
  .badge.ok{background:var(--ok)}.badge.bad{background:var(--bad)}.badge.info{background:var(--info)}
  .muted{color:var(--muted);font-size:12px}.pre{white-space:pre-wrap;margin-top:3px}
  .link{color:#0d9488;font-size:12px;text-decoration:none;font-weight:600}.link:hover{text-decoration:underline}
  .section-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px;font-weight:700}
  .step{padding:6px 0;border-bottom:1px dashed var(--line);font-size:13px}
  table.plans{width:100%;border-collapse:collapse;font-size:12.5px}
  table.plans th{text-align:left;color:var(--muted);font-weight:600;padding:6px 8px;border-bottom:2px solid var(--line)}
  table.plans td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  tr.plan-detail td{padding-top:0;border-bottom:1px solid var(--line)}
  tr.row-bad td{background:#fef2f2}
  td.url{font-family:Consolas,monospace;font-size:11px;word-break:break-all;max-width:360px}
  .vb{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;color:#fff}.vb.ok{background:var(--ok)}.vb.bad{background:var(--bad)}
  .val{padding:3px 0;font-size:12.5px}
</style></head><body>
<header>
  <h1>Drug Lookup Tool — ${esc(langLabel)} Dashboard</h1>
  <div class="sub">2027 Drug Search Tool · plan dropdown + CVS navigation validation · generated ${esc(generated)}</div>
</header>
<div class="kpis">
  <div class="kpi"><div class="n">${total}</div><div class="l">States</div></div>
  <div class="kpi ok"><div class="n">${pass}</div><div class="l">Pass</div></div>
  <div class="kpi bad"><div class="n">${fail}</div><div class="l">Fail</div></div>
  <div class="kpi"><div class="n">${planPass}/${planTotal}</div><div class="l">Plans OK</div></div>
</div>
<div class="toolbar">
  <input id="q" placeholder="Filter by state…" oninput="flt()">
  <select id="st" onchange="flt()"><option value="">All statuses</option><option value="PASS">Pass</option><option value="FAIL">Fail</option></select>
  <button class="link" onclick="document.querySelectorAll('.scope').forEach(s=>s.classList.add('open'))">Expand all</button>
  <button class="link" onclick="document.querySelectorAll('.scope').forEach(s=>s.classList.remove('open'))">Collapse all</button>
</div>
<main id="list">
  ${scopes.map(renderScope).join('\n')}
</main>
<script>
  function flt(){
    const q=document.getElementById('q').value.toLowerCase();
    const st=document.getElementById('st').value;
    document.querySelectorAll('.scope').forEach(function(s){
      const okText=!q||(s.dataset.state||'').toLowerCase().includes(q)||s.textContent.toLowerCase().includes(q);
      const okSt=!st||s.dataset.status===st;
      s.style.display=(okText&&okSt)?'':'none';
    });
  }
</script>
</body></html>`;

  const file = path.join(rootDir, 'Consolidated.html');
  fs.writeFileSync(file, html, 'utf8');
  return { file, count: total, pass, fail };
}

/**
 * Generate BOTH language dashboards from the configured report roots.
 * @param {object} opts
 * @param {string} opts.dirEn
 * @param {string} opts.dirEs
 * @returns {Array<{language:string,file:string,count:number}>}
 */
function generateDrugToolDashboards({ dirEn, dirEs } = {}) {
  const out = [];
  if (dirEn) {
    const r = generateDashboard(dirEn, { language: 'EN' });
    if (r.count > 0) out.push({ language: 'EN', ...r });
  }
  if (dirEs) {
    const r = generateDashboard(dirEs, { language: 'ES' });
    if (r.count > 0) out.push({ language: 'ES', ...r });
  }
  return out;
}

module.exports = { generateDrugToolDashboards, generateDashboard };
