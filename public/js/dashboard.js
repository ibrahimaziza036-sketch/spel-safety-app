import { api, navbar, mountSession, escapeHtml, fmtDate, sevChip } from './common.js';

document.getElementById('nav').innerHTML = navbar('Dashboard');
mountSession();

// ---- palette (validated): single-hue magnitude + ordinal severity ramp ----
const BLUE = '#2563eb';
const TEAL = '#0891b2';
const SEV = { Minor: '#fde047', Serious: '#fb923c', Major: '#ef4444', Fatal: '#7f1d1d' };
const SEV_ORDER = ['Minor', 'Serious', 'Major', 'Fatal'];
const INK = '#0f172a';
const MUTED = '#64748b';
const GRID = 'rgba(15,23,42,.06)';

let RANGE = 'all';
const charts = {};

// ---- WhatsApp-down alarm banner (unchanged behaviour) ----
async function checkChannels() {
  let h; try { h = await api('/api/health/channels'); } catch { return; }
  const wa = h.whatsapp; const box = document.getElementById('channel-alarm');
  if (!box) return;
  if (wa.enabled && wa.state !== 'ready') {
    const mins = Math.round((wa.downMs || 0) / 60000);
    const backup = h.email.enabled && h.email.recipients > 0 ? 'Email backup alerts still going out.' : '⚠️ No email backup configured.';
    box.innerHTML = `<div class="banner err" style="margin-bottom:16px">🔴 <b>WhatsApp alerting DOWN</b> (${escapeHtml(wa.state)}${mins ? `, ~${mins}m` : ''}). Alerts queued & will send on reconnect — nothing lost. ${backup}</div>`;
  } else box.innerHTML = '';
}

// ---- helpers ----
function kpi({ n, label, tip, cls = '', delta }) {
  let d = '';
  if (delta !== null && delta !== undefined) {
    const up = delta > 0, flat = delta === 0;
    // For incidents, DOWN is good (green), UP is bad (red).
    const col = flat ? MUTED : up ? 'var(--major)' : 'var(--ok)';
    const arrow = flat ? '→' : up ? '↑' : '↓';
    d = `<span class="kpi-delta" style="color:${col}">${arrow} ${Math.abs(delta)}% <span class="muted" style="font-weight:500">vs prev</span></span>`;
  }
  return `<div class="stat ${cls}">
    <div class="n">${escapeHtml(String(n))}</div>
    <div class="l">${escapeHtml(label)}${tip ? ` <span class="info" tabindex="0" data-tip="${escapeHtml(tip)}">i</span>` : ''}</div>
    ${d}</div>`;
}

function funnelRow(label, value, total, color) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return `<div class="fu-row" title="${escapeHtml(label)}: ${value} of ${total} (${pct}%)">
    <div class="fu-label">${escapeHtml(label)}</div>
    <div class="fu-bar"><div class="fu-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="fu-val"><b>${value}</b> <span class="muted">${pct}%</span></div>
  </div>`;
}

function renderFollowup(f, bySeverity) {
  const box = document.getElementById('followup');
  if (!f.reported) { box.innerHTML = '<p class="muted">No incidents in this period.</p>'; return; }
  const gap = f.reported - f.investigated;
  const insight = gap > 0
    ? `<div class="fu-insight warn">${gap} incident${gap > 1 ? 's' : ''} <b>not yet investigated</b>.</div>`
    : `<div class="fu-insight ok">Investigation has started on all reported incidents. 👍</div>`;
  const funnel = `
    ${funnelRow('Reported', f.reported, f.reported, '#94a3b8')}
    ${funnelRow('Investigated', f.investigated, f.reported, TEAL)}
    ${funnelRow('Actions defined', f.withActions, f.reported, BLUE)}
    ${funnelRow('Closed', f.closed, f.reported, 'var(--ok)')}`;
  // compact severity strip
  const sevTotal = bySeverity.reduce((s, r) => s + r.n, 0);
  const strip = sevTotal ? '<div class="sev-strip" title="Severity mix">' + SEV_ORDER.map((s) => {
    const n = (bySeverity.find((r) => r.key === s) || {}).n || 0;
    const w = (n / sevTotal) * 100;
    return w ? `<span style="width:${w}%;background:${SEV[s]}" title="${s}: ${n}"></span>` : '';
  }).join('') + '</div><div class="sev-legend">' + SEV_ORDER.map((s) => {
    const n = (bySeverity.find((r) => r.key === s) || {}).n || 0;
    return `<span><i style="background:${SEV[s]}"></i>${s} <b>${n}</b></span>`;
  }).join('') + '</div>' : '';
  box.innerHTML = insight + `<div class="fu-grid">${funnel}</div>` + strip;
}

function renderNeeds(list) {
  const box = document.getElementById('needs');
  if (!list.length) { box.innerHTML = '<p class="muted" style="padding:8px 0">🎉 No neglected incidents — everything is being worked on.</p>'; return; }
  box.innerHTML = list.map((r) => `
    <a class="row-item" href="/incident.html?id=${r.id}">
      <span class="ri-main">${sevChip(r.severity)} <b>${escapeHtml(r.ref_no || '—')}</b> <span class="muted">${escapeHtml(r.unit)}</span></span>
      <span class="ri-reason">${escapeHtml(r.reason)}</span>
    </a>`).join('');
}

function renderOverdue(list) {
  const box = document.getElementById('overdue');
  if (!list.length) { box.innerHTML = '<p class="muted" style="padding:8px 0">✅ No overdue actions.</p>'; return; }
  box.innerHTML = list.map((c) => `
    <a class="row-item" href="/incident.html?id=${c.incident_id}">
      <span class="ri-main"><b>${escapeHtml(truncate(c.action, 48))}</b></span>
      <span class="ri-reason"><span class="chip sev-Major">${c.daysOverdue}d overdue</span>
        <span class="muted">${escapeHtml(c.owner || 'no owner')} · ${escapeHtml(c.ref_no || '')}</span></span>
    </a>`).join('');
}

const PROGRESS = (r) => {
  if (r.status === 'Closed') return '<span class="chip prog-done">✓ Closed</span>';
  const steps = [];
  steps.push(r.investigated ? '<span class="chip prog-ok">Investigated</span>' : '<span class="chip prog-todo">No investigation</span>');
  if (r.capaCount > 0) steps.push(`<span class="chip prog-ok">${r.capaCount} action${r.capaCount > 1 ? 's' : ''}</span>`);
  return steps.join(' ');
};

function renderRecent(list) {
  const tb = document.querySelector('#recentTbl tbody');
  document.getElementById('recent-empty').style.display = list.length ? 'none' : 'block';
  tb.innerHTML = list.map((r) => `
    <tr data-id="${r.id}">
      <td><b>${escapeHtml(r.ref_no || '—')}</b></td>
      <td>${escapeHtml(fmtDate(r.at))}</td>
      <td>${escapeHtml(r.unit)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${sevChip(r.severity)}</td>
      <td>${PROGRESS(r)}</td>
    </tr>`).join('');
  tb.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.href = '/incident.html?id=' + tr.dataset.id; }));
}

function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

// ---- Chart.js shared options (recessive grid, proper tooltips) ----
function baseOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0f172a', padding: 10, cornerRadius: 8, titleFont: { weight: '700' },
        displayColors: false, ...(extra.tooltip || {}),
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: MUTED, font: { size: 11 } } },
      y: { beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { color: MUTED, precision: 0, font: { size: 11 } } },
    },
    ...(extra.root || {}),
  };
}
function draw(id, config) {
  if (!window.Chart) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new window.Chart(document.getElementById(id), config);
}

function renderCharts(s) {
  draw('trendChart', {
    type: 'line',
    data: { labels: s.monthly.map((m) => m.month.slice(2)), datasets: [{ data: s.monthly.map((m) => m.n), borderColor: TEAL, backgroundColor: 'rgba(8,145,178,.12)', fill: true, tension: .35, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: TEAL, borderWidth: 2 }] },
    options: baseOpts({ tooltip: { callbacks: { title: (t) => 'Month ' + t[0].label, label: (c) => `${c.parsed.y} incident${c.parsed.y === 1 ? '' : 's'}` } } }),
  });
  draw('unitChart', {
    type: 'bar',
    data: { labels: s.byUnit.map((r) => r.key), datasets: [{ data: s.byUnit.map((r) => r.n), backgroundColor: BLUE, borderRadius: 5, maxBarThickness: 46 }] },
    options: baseOpts({ tooltip: { callbacks: { label: (c) => `${c.parsed.y} incident${c.parsed.y === 1 ? '' : 's'}` } } }),
  });
}

function renderScorecard(units) {
  document.querySelector('#unitTable tbody').innerHTML = units.map((u) => `
    <tr style="cursor:default">
      <td><b>${escapeHtml(u.unit)}</b></td>
      <td class="right">${u.count}</td>
      <td class="right">${u.open ? `<span class="chip st-Open">${u.open}</span>` : '0'}</td>
      <td class="right">${u.daysSinceLast === null ? '<span class="muted">—</span>' : u.daysSinceLast + ' d'}</td>
    </tr>`).join('');
}

let loadedOnce = false;
async function load() {
  const banner = document.getElementById('banner');
  let s;
  try {
    s = await api('/api/dashboard/stats?range=' + RANGE);
  } catch (err) {
    // Only alarm on the FIRST load. A transient failure during the 30s
    // auto-refresh (server restart, brief blip) must NOT clobber the good
    // dashboard with a scary red banner — keep the last data, quietly retry.
    if (!loadedOnce) {
      banner.innerHTML = `<div class="banner err">Dashboard could not load: ${escapeHtml(err.message)}. Retrying…</div>`;
    } else {
      console.warn('[dashboard] refresh failed (will retry):', err.message);
    }
    return;
  }
  loadedOnce = true;
  banner.innerHTML = ''; // clear any stale error on a good refresh

  const p = s.period;
  document.getElementById('kpis').innerHTML =
    kpi({ n: p.total, label: `Incidents (${s.range.label})`, tip: 'Incidents reported in this period. The arrow compares with the previous equal period — down (green) is better.', cls: 'accent-blue', delta: p.deltaPct }) +
    kpi({ n: s.openNow, label: 'Open right now', tip: 'Not yet Closed (Open + Under Investigation).', cls: 'accent-orange' }) +
    kpi({ n: s.capa.overdue, label: 'Overdue actions', tip: 'CAPA whose due date has passed and are not Done.', cls: 'accent-red' }) +
    kpi({ n: s.daysSinceLastOverall ?? '—', label: 'Days since last', tip: 'Days since the last incident (across the whole group). More = better.', cls: 'accent-green' });

  document.getElementById('fu-range').textContent = '· ' + s.range.label;
  document.getElementById('unit-range').textContent = '· ' + s.range.label;
  renderFollowup(s.followup, s.bySeverity);
  renderNeeds(s.needsAttention);
  renderOverdue(s.overdueCapa);
  renderRecent(s.recent);
  renderCharts(s);
  renderScorecard(s.units);
}

// range filter
document.getElementById('range').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]'); if (!b) return;
  RANGE = b.dataset.range;
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('active', x === b));
  load();
});

checkChannels();
load();
setInterval(() => { checkChannels(); load(); }, 30000);
