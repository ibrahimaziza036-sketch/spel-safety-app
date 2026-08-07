import { api, getMeta, navbar, fmtDate, sevChip, mountSession } from './common.js';

document.getElementById('nav').innerHTML = navbar('Incidents');
let CAN_EDIT = false;
const banner = document.getElementById('banner');
const content = document.getElementById('content');
const id = Number(new URLSearchParams(location.search).get('id'));

function note(type, msg) {
  banner.innerHTML = `<div class="banner ${type}">${msg}</div>`;
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'ok') setTimeout(() => (banner.innerHTML = ''), 3000);
}

let META;
let IS_ADMIN = false;

async function load() {
  META = await getMeta();
  let data;
  try {
    data = await api('/api/incidents/' + id);
  } catch (err) {
    content.innerHTML = `<div class="banner err">${err.message}</div>`;
    return;
  }
  render(data);
}

function render({ incident: inc, investigation: inv, capa, history }) {
  inv = inv || {};
  const hasPhoto = inc.photo_path && inc.photo_path.startsWith('/uploads/');
  const photo = hasPhoto
    ? `<a href="${escapeHtml(inc.photo_path)}" target="_blank"><img src="${escapeHtml(inc.photo_path)}" alt="incident photo" style="max-width:220px;border-radius:10px;border:1px solid var(--line)"/></a>`
    : (inc.pii_restricted
      ? '<span class="muted">Photo hidden (view-only access)</span>'
      : (inc.photo_path ? `<span class="muted">${escapeHtml(inc.photo_path)}</span>` : '<span class="muted">No photo</span>'));

  const statusOpts = META.statuses.map((s) => `<option ${s === inc.status ? 'selected' : ''}>${s}</option>`).join('');

  content.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:16px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;color:var(--muted);font-weight:700">${escapeHtml(inc.ref_no || 'INCIDENT')}</div>
          <h1 class="page-title" style="margin:2px 0">${escapeHtml(inc.unit)} — ${escapeHtml(inc.type)}</h1>
          <div>${sevChip(inc.severity)}</div>
        </div>
        <label class="field" style="margin:0;min-width:200px">
          <span>Status</span>
          <select id="status">${statusOpts}</select>
        </label>
      </div>
      <div class="grid cols-2" style="margin-top:16px">
        <div>
          <table class="data"><tbody>
            <tr><th>When</th><td>${escapeHtml(fmtDate(inc.occurred_at))}</td></tr>
            <tr><th>Reported</th><td>${escapeHtml(fmtDate(inc.created_at))}</td></tr>
            <tr><th>Location</th><td>${escapeHtml(inc.location || '—')}</td></tr>
            <tr><th>Injured</th><td>${escapeHtml(inc.injured_person || '—')}</td></tr>
            <tr><th>Reporter</th><td>${escapeHtml(inc.reporter_name || 'Anonymous')}${inc.reporter_code ? ' — ' + escapeHtml(inc.reporter_code) : ''}${inc.reporter_contact ? ' (' + escapeHtml(inc.reporter_contact) + ')' : ''}</td></tr>
          </tbody></table>
        </div>
        <div>
          <div class="section-title">Description</div>
          <p style="margin:0 0 14px">${escapeHtml(inc.description)}</p>
          ${photo}
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="section-title">🔍 Investigation — Root Cause</div>
      <p class="page-sub" style="margin-top:-6px">What happened, how it happened, and the underlying cause. Fill in after investigating.</p>
      <label class="field"><span>What happened (detailed)</span><textarea id="what_happened">${val(inv.what_happened)}</textarea></label>
      <label class="field"><span>How it happened (sequence of events)</span><textarea id="how_happened">${val(inv.how_happened)}</textarea></label>
      <label class="field"><span>Root cause (5-Why — keep asking "why")</span><textarea id="root_cause" placeholder="Why 1: …\nWhy 2: …\nWhy 3: …\nWhy 4: …\nWhy 5 (root cause): …">${val(inv.root_cause)}</textarea></label>
      <label class="field"><span>Immediate actions taken</span><textarea id="immediate_actions">${val(inv.immediate_actions)}</textarea></label>
      <div class="grid cols-2">
        <label class="field"><span>Investigated by</span>
          <input value="${val(inv.investigated_by || '(set automatically when you save)')}" disabled />
          <div class="hint">Recorded automatically from your login — cannot be typed in.</div>
        </label>
        <label class="field"><span>Investigation date</span>
          <input value="${val(inv.investigated_at ? fmtDate(inv.investigated_at) : '(set automatically when you save)')}" disabled />
        </label>
      </div>
      <button class="btn" id="saveInv">Save Investigation</button>
    </div>

    <div class="card">
      <div class="section-title">✅ Corrective &amp; Preventive Actions (CAPA)</div>
      <p class="page-sub" style="margin-top:-6px">These actions are what prevent the next incident. Assign an owner and a due date to every action.</p>
      <div class="table-wrap">
        <table class="data" id="capaTbl">
          <thead><tr><th>Action</th><th>Type</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:14px">
        <div class="grid cols-2">
          <label class="field"><span>New action <span class="req">*</span></span><input id="c_action" placeholder="e.g. Install machine guard on M-12" /></label>
          <label class="field"><span>Type</span><select id="c_kind"><option>Corrective</option><option>Preventive</option></select></label>
        </div>
        <div class="grid cols-3">
          <label class="field"><span>Owner</span><input id="c_owner" placeholder="Responsible person" /></label>
          <label class="field"><span>Due date</span><input type="date" id="c_due" /></label>
          <div style="display:flex;align-items:end"><button class="btn" id="addCapa" style="width:100%">+ Add Action</button></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="section-title">🧾 Record History (audit trail)</div>
      <p class="page-sub" style="margin-top:-6px">Who changed what — this record is permanent and cannot be erased.</p>
      <div id="history"></div>
    </div>

    ${inc.voided_at ? `
    <div class="card" style="margin-top:16px;border-color:#fca5a5">
      <div class="banner warn" style="margin:0">🗄️ This record is <b>VOIDED</b> — excluded from reports &amp; the dashboard.
        Voided on ${escapeHtml(fmtDate(inc.voided_at))} by ${escapeHtml(inc.voided_by || '—')}${inc.void_reason ? ' — ' + escapeHtml(inc.void_reason) : ''}.</div>
      ${IS_ADMIN ? '<button class="btn ghost" id="restoreBtn" style="margin-top:12px">Restore record</button>' : ''}
    </div>` : (IS_ADMIN ? `
    <div class="card" style="margin-top:16px;border-color:#fca5a5">
      <div class="section-title">🗄️ Void this record (admin)</div>
      <p class="page-sub" style="margin-top:-6px">Void a duplicate or incorrect report. The record is not deleted — the evidence is preserved; it is only removed from reports and the dashboard.</p>
      <label class="field"><span>Reason <span class="req">*</span></span><input id="voidReason" placeholder="e.g. duplicate of INC-2026-0012" /></label>
      <button class="btn danger" id="voidBtn">Void record</button>
    </div>` : '')}
  `;

  renderCapa(capa);
  renderHistory(history || []);

  if (IS_ADMIN && !inc.voided_at) {
    document.getElementById('voidBtn')?.addEventListener('click', async () => {
      const reason = v('voidReason');
      if (!reason) return note('err', 'A reason is required to void this record.');
      if (!confirm('Void this record? It will be removed from reports (it will not be deleted).')) return;
      try { await api(`/api/incidents/${id}/void`, jsonBody({ reason })); note('ok', 'Record voided.'); load(); }
      catch (err) { note('err', err.message); }
    });
  }
  if (IS_ADMIN && inc.voided_at) {
    document.getElementById('restoreBtn')?.addEventListener('click', async () => {
      try { await api(`/api/incidents/${id}/restore`, jsonBody({})); note('ok', 'Record restored.'); load(); }
      catch (err) { note('err', err.message); }
    });
  }

  document.getElementById('status').addEventListener('change', async (e) => {
    try { await api(`/api/incidents/${id}/status`, jsonBody({ status: e.target.value }, 'PATCH')); note('ok', 'Status updated.'); }
    catch (err) { note('err', err.message); }
  });

  document.getElementById('saveInv').addEventListener('click', async () => {
    // investigated_by / investigated_at are set server-side from the session,
    // so they are deliberately not sent from here.
    const body = {
      what_happened: v('what_happened'), how_happened: v('how_happened'),
      root_cause: v('root_cause'), immediate_actions: v('immediate_actions'),
    };
    try { await api(`/api/incidents/${id}/investigation`, jsonBody(body)); note('ok', 'Investigation saved.'); load(); }
    catch (err) { note('err', err.message); }
  });

  document.getElementById('addCapa').addEventListener('click', async () => {
    const action = v('c_action');
    if (!action) return note('err', 'Enter the action text.');
    const body = { action, kind: v('c_kind'), owner: v('c_owner'), due_date: v('c_due') };
    try { await api(`/api/incidents/${id}/capa`, jsonBody(body)); note('ok', 'Action added.'); load(); }
    catch (err) { note('err', err.message); }
  });

  // Viewers get a read-only view: disable the editing controls and drop the
  // action buttons. The history card stays visible (it is read-only anyway).
  if (!CAN_EDIT) {
    content.querySelectorAll('input, textarea, select, button').forEach((eln) => { eln.disabled = true; });
    document.getElementById('saveInv')?.remove();
    document.getElementById('addCapa')?.remove();
    const extra = inc.pii_restricted
      ? ' Personal details and photos are restricted for your role.'
      : '';
    banner.innerHTML = `<div class="banner warn">You have view-only access.${extra} Contact an admin for a safety-officer account to investigate.</div>`;
  }
  if (inc.voided_at && CAN_EDIT) {
    content.querySelectorAll('#saveInv, #addCapa, #status, .capa-status, #investigation textarea, #c_action, #c_kind, #c_owner, #c_due')
      .forEach((eln) => { if (eln) eln.disabled = true; });
  }
}

const ACTION_LABEL = {
  create: '➕ Created', update: '✏️ Edited', status: '🔁 Status changed',
  void: '🗄️ Voided', restore: '♻️ Restored', redact: '🙈 Redacted', export: '📤 Exported',
};

function renderHistory(entries) {
  const box = document.getElementById('history');
  if (!box) return;
  if (!entries.length) { box.innerHTML = '<p class="muted">No history recorded yet.</p>'; return; }
  box.innerHTML = entries.map((e) => {
    let changes = '';
    if (e.changes) {
      try {
        const obj = JSON.parse(e.changes);
        changes = '<ul style="margin:6px 0 0;padding-left:18px;font-size:13px">' +
          Object.entries(obj).map(([field, { from, to }]) =>
            `<li><b>${escapeHtml(field)}</b>: <span class="muted">${escapeHtml(truncate(from))}</span> → ${escapeHtml(truncate(to))}</li>`
          ).join('') + '</ul>';
      } catch { /* ignore malformed */ }
    }
    const label = ACTION_LABEL[e.action] || escapeHtml(e.action);
    return `
      <div style="border-left:3px solid var(--line);padding:8px 0 8px 14px;margin-bottom:4px">
        <div style="font-size:13px">
          <b>${label}</b>
          <span class="muted">· ${escapeHtml(e.entity)}</span>
          <span class="muted"> · by </span><b>${escapeHtml(e.actor_name)}</b>
          <span class="muted"> · ${escapeHtml(fmtDate(e.created_at))}</span>
        </div>
        ${e.detail ? `<div class="muted" style="font-size:13px">${escapeHtml(e.detail)}</div>` : ''}
        ${changes}
      </div>`;
  }).join('');
}

function truncate(val, n = 80) {
  const s = val === null || val === undefined || val === '' ? '(empty)' : String(val);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function renderCapa(capa) {
  const tbody = document.querySelector('#capaTbl tbody');
  if (!capa.length) { tbody.innerHTML = '<tr><td colspan="5" class="muted">No actions yet.</td></tr>'; return; }
  // Overdue is judged on the PKT calendar date, matching the server so the UI
  // and the dashboard never disagree during early-morning hours in Pakistan.
  const today = META?.todayPkt || new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  tbody.innerHTML = capa.map((c) => {
    const overdue = c.status !== 'Done' && c.due_date && c.due_date < today;
    const stSel = ['Open', 'In Progress', 'Done'].map((s) => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('');
    return `<tr style="cursor:default">
      <td style="white-space:normal;max-width:320px">${escapeHtml(c.action)}</td>
      <td>${escapeHtml(c.kind)}</td>
      <td>${escapeHtml(c.owner || '—')}</td>
      <td style="${overdue ? 'color:var(--major);font-weight:700' : ''}">${escapeHtml(c.due_date || '—')}${overdue ? ' ⚠' : ''}</td>
      <td><select data-capa="${c.id}" class="capa-status" style="padding:6px 8px">${stSel}</select></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.capa-status').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try { await api('/api/incidents/capa/' + sel.dataset.capa, jsonBody({ status: sel.value }, 'PATCH')); note('ok', 'Action updated.'); load(); }
      catch (err) { note('err', err.message); }
    });
  });
}

// helpers
const v = (id) => (document.getElementById(id)?.value || '').trim();
const val = (s) => escapeHtml(s || '');
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function jsonBody(obj, method = 'POST') {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Read-only for viewers; safety officers and admins can edit.
mountSession().then((me) => {
  CAN_EDIT = !!me && (me.role === 'safety_officer' || me.role === 'admin');
  IS_ADMIN = me?.role === 'admin';
  load();
});
