import { api, getMeta, navbar, fmtDate, sevChip, statusBadge, escapeHtml, mountSession } from './common.js';

document.getElementById('nav').innerHTML = navbar('Incidents');
mountSession();
const banner = document.getElementById('banner');

function opt(all, label) {
  return `<option value="">${label}</option>` + all.map((x) => `<option value="${x}">${x}</option>`).join('');
}

async function init() {
  const meta = await getMeta();
  document.getElementById('f-unit').innerHTML = opt(meta.units, 'All units');
  document.getElementById('f-severity').innerHTML = opt(meta.severities, 'All severities');
  document.getElementById('f-status').innerHTML = opt(meta.statuses, 'All statuses');
  document.getElementById('f-type').innerHTML = opt(meta.types, 'All types');

  // Changing a filter restarts at page 1 so the view can't land out of range.
  ['f-unit', 'f-severity', 'f-status', 'f-type', 'f-from', 'f-to'].forEach((id) =>
    document.getElementById(id).addEventListener('change', () => load(1)));
  document.getElementById('clear').addEventListener('click', () => {
    ['f-unit', 'f-severity', 'f-status', 'f-type', 'f-from', 'f-to'].forEach((id) => (document.getElementById(id).value = ''));
    load(1);
  });
  load(1);
}

let currentPage = 1;

async function load(page = currentPage) {
  currentPage = Math.max(1, page);
  const q = new URLSearchParams();
  const map = { unit: 'f-unit', severity: 'f-severity', status: 'f-status', type: 'f-type', from: 'f-from', to: 'f-to' };
  for (const [key, id] of Object.entries(map)) {
    const v = document.getElementById(id).value;
    if (v) q.set(key, v);
  }
  q.set('page', String(currentPage));
  let data;
  try {
    data = await api('/api/incidents?' + q.toString());
  } catch (err) {
    banner.innerHTML = `<div class="banner err">${err.message}</div>`;
    return;
  }
  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = data.incidents.map((i) => `
    <tr data-id="${i.id}">
      <td><b>${escapeHtml(i.ref_no || '—')}</b></td>
      <td>${escapeHtml(fmtDate(i.occurred_at || i.created_at))}</td>
      <td>${escapeHtml(i.unit)}</td>
      <td>${escapeHtml(i.type)}</td>
      <td>${sevChip(i.severity)}</td>
      <td>${statusBadge(i.status)}</td>
      <td>${escapeHtml(i.location || '—')}</td>
    </tr>`).join('');
  // Attach row navigation via listeners (no inline handlers — CSP-safe).
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => { location.href = '/incident.html?id=' + tr.dataset.id; });
  });
  document.getElementById('empty').style.display = data.incidents.length ? 'none' : 'block';
  renderPager(data);
}

function renderPager(data) {
  const pager = document.getElementById('pager');
  if (!pager) return;
  const { page = 1, pages = 1, total = 0, limit = 100 } = data;
  if (total === 0) { pager.innerHTML = ''; return; }
  const first = (page - 1) * limit + 1;
  const last = Math.min(total, page * limit);
  pager.innerHTML = `
    <span class="muted" style="font-size:13px">Showing ${first}–${last} of ${total}</span>
    <span style="display:flex;gap:8px;align-items:center">
      <button class="btn sm ghost" id="prev" ${page <= 1 ? 'disabled' : ''}>← Previous</button>
      <span class="muted" style="font-size:13px">Page ${page} of ${pages}</span>
      <button class="btn sm ghost" id="next" ${page >= pages ? 'disabled' : ''}>Next →</button>
    </span>`;
  pager.querySelector('#prev')?.addEventListener('click', () => load(page - 1));
  pager.querySelector('#next')?.addEventListener('click', () => load(page + 1));
}

init().catch((err) => (banner.innerHTML = `<div class="banner err">${err.message}</div>`));
