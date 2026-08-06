import { api, navbar, mountSession } from './common.js';

document.getElementById('nav').innerHTML = navbar('Dashboard');
mountSession();
const banner = document.getElementById('banner');

// Prominent alarm the moment the WhatsApp alerting channel is down, so nobody
// assumes alerts are flowing when they are not.
async function checkChannels() {
  let h;
  try { h = await api('/api/health/channels'); } catch { return; }
  const wa = h.whatsapp;
  const box = document.getElementById('channel-alarm');
  if (!box) return;
  if (wa.enabled && wa.state !== 'ready') {
    const mins = Math.round((wa.downMs || 0) / 60000);
    const emailBackup = h.email.enabled && h.email.recipients > 0
      ? 'Email backup alerts are still going out.'
      : '⚠️ No email backup is configured — set up SMTP so alerts still reach you.';
    box.innerHTML = `<div class="banner err" style="margin-bottom:16px">
      🔴 <b>WhatsApp alerting is DOWN</b> (state: ${wa.state}${mins ? `, ~${mins} min` : ''}).
      Incident alerts are being <b>queued</b> and will send on reconnect — nothing is lost — but WhatsApp is not delivering right now.
      ${wa.state === 'qr' ? 'It needs a QR re-scan on the Admin page. ' : ''}${emailBackup}</div>`;
  } else {
    box.innerHTML = '';
  }
}
checkChannels();
setInterval(checkChannels, 30000);

const SEV_COLORS = { Minor: '#eab308', Serious: '#f97316', Major: '#dc2626', Fatal: '#111827' };
const PALETTE = ['#1d4ed8', '#0891b2', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#ca8a04', '#0d9488', '#9333ea'];

function kpi(n, label, cls = '') {
  return `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${label}</div></div>`;
}

const charts = {};
function draw(id, config) {
  if (!window.Chart) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new window.Chart(document.getElementById(id), config);
}

async function load() {
  let s;
  try {
    s = await api('/api/dashboard/stats');
  } catch (err) {
    banner.innerHTML = `<div class="banner err">Failed to load dashboard: ${err.message}</div>`;
    return;
  }

  const openCount = (s.byStatus['Open'] || 0) + (s.byStatus['Under Investigation'] || 0);
  document.getElementById('kpis').innerHTML =
    kpi(s.total, 'Total Incidents', 'accent-blue') +
    kpi(openCount, 'Open / Investigating', 'accent-orange') +
    kpi(s.capa.overdue, 'Overdue Actions', 'accent-red') +
    kpi(s.daysSinceLastOverall ?? '—', 'Days Since Last', 'accent-green');

  // by unit (bar)
  draw('unitChart', {
    type: 'bar',
    data: {
      labels: s.byUnit.map((r) => r.key),
      datasets: [{ label: 'Incidents', data: s.byUnit.map((r) => r.n), backgroundColor: '#1d4ed8', borderRadius: 6 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  // trend (line)
  draw('trendChart', {
    type: 'line',
    data: {
      labels: s.monthly.map((r) => r.month),
      datasets: [{ label: 'Incidents', data: s.monthly.map((r) => r.n), borderColor: '#0891b2', backgroundColor: 'rgba(8,145,178,.15)', fill: true, tension: .3, pointRadius: 4 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  // severity (doughnut)
  draw('sevChart', {
    type: 'doughnut',
    data: {
      labels: s.bySeverity.map((r) => r.key),
      datasets: [{ data: s.bySeverity.map((r) => r.n), backgroundColor: s.bySeverity.map((r) => SEV_COLORS[r.key] || '#94a3b8') }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });

  // type (bar horizontal)
  draw('typeChart', {
    type: 'bar',
    data: {
      labels: s.byType.map((r) => r.key),
      datasets: [{ label: 'Incidents', data: s.byType.map((r) => r.n), backgroundColor: s.byType.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 6 }],
    },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  // unit scorecard table
  const tbody = document.querySelector('#unitTable tbody');
  tbody.innerHTML = s.units.map((u) => `
    <tr>
      <td><b>${u.unit}</b></td>
      <td class="right">${u.count}</td>
      <td class="right">${u.daysSinceLast === null ? '<span class="muted">no incidents</span>' : u.daysSinceLast + ' days'}</td>
    </tr>`).join('');
}

load();
setInterval(load, 30000); // auto-refresh every 30s
