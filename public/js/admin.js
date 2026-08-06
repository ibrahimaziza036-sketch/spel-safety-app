import { api, getMeta, navbar, fmtDate, escapeHtml, mountSession } from './common.js';

document.getElementById('nav').innerHTML = navbar('Admin');

const WA_STATE_LABEL = {
  disabled: ['WhatsApp is disabled', 'warn', 'Set WHATSAPP_ENABLED=true in .env to enable.'],
  starting: ['Starting…', 'warn', 'Launching WhatsApp client.'],
  qr: ['Waiting for QR scan', 'warn', 'Scan the QR below with the SPEL WhatsApp number.'],
  authenticated: ['Authenticated', 'ok', 'Finishing sync…'],
  ready: ['Connected ✓', 'ok', 'WhatsApp alerts are active.'],
  disconnected: ['Disconnected', 'err', 'The linked device was logged out. Restart to re-link.'],
  error: ['Error', 'err', ''],
};

async function loadWa() {
  try {
    const s = await api('/api/admin/whatsapp/status');
    const [label, cls, help] = WA_STATE_LABEL[s.state] || ['Unknown', 'warn', ''];
    document.getElementById('wa-status').innerHTML =
      `<div class="banner ${cls}">${label}</div>
       <div class="hint">${help}${s.error ? ' — ' + s.error : ''}</div>
       <div class="hint">Recipients: ${(s.recipients || []).join(', ') || '(none set)'} · Alert threshold: ${s.minSeverity}</div>`;

    const qrBox = document.getElementById('wa-qr');
    if (s.state === 'qr' && s.hasQr) {
      const { dataUrl } = await api('/api/admin/whatsapp/qr');
      qrBox.innerHTML = dataUrl ? `<img src="${dataUrl}" alt="WhatsApp QR" style="width:280px;height:280px" />` : '';
    } else {
      qrBox.innerHTML = '';
    }
  } catch (err) {
    document.getElementById('wa-status').innerHTML = `<div class="banner err">${err.message}</div>`;
  }
}

async function loadEmail() {
  try {
    const s = await api('/api/admin/email/status');
    const cls = s.configured ? (s.enabled ? 'ok' : 'warn') : 'err';
    const txt = !s.configured ? 'SMTP not configured' : s.enabled ? 'Email enabled' : 'Email disabled';
    document.getElementById('email-status').innerHTML =
      `<div class="banner ${cls}">${txt}</div>
       <div class="hint">From: ${s.from || '—'}</div>
       <div class="hint">Recipients: ${(s.recipients || []).join(', ') || '(none set)'}</div>
       <button class="btn ghost sm" id="verify">Test SMTP connection</button>
       <span id="verify-result" class="hint"></span>`;
    document.getElementById('verify').addEventListener('click', async () => {
      const r = document.getElementById('verify-result');
      r.textContent = ' testing…';
      try { const res = await api('/api/admin/email/verify'); r.textContent = res.ok ? ' ✓ SMTP OK' : ' ✗ ' + res.reason; }
      catch (err) { r.textContent = ' ✗ ' + err.message; }
    });
  } catch (err) {
    document.getElementById('email-status').innerHTML = `<div class="banner err">${err.message}</div>`;
  }
}

async function loadQrLinks() {
  const meta = await getMeta();
  document.getElementById('qr-links').innerHTML =
    '<div class="hint" style="margin-bottom:6px">Report links per unit:</div>' +
    meta.units.map((u) => `<div><a href="/report.html?unit=${u}" target="_blank">${meta.baseUrl}/report.html?unit=${u}</a></div>`).join('');
}

async function loadLog() {
  try {
    const { notifications } = await api('/api/admin/notifications');
    const tbody = document.querySelector('#log tbody');
    if (!notifications.length) { tbody.innerHTML = '<tr><td colspan="6" class="muted">No notifications yet.</td></tr>'; return; }
    const dot = { sent: '🟢', failed: '🔴', skipped: '⚪' };
    tbody.innerHTML = notifications.map((n) => `
      <tr style="cursor:default">
        <td>${escapeHtml(n.ref_no || '—')}</td><td>${escapeHtml(n.channel)}</td><td>${escapeHtml(n.recipient || '—')}</td>
        <td>${dot[n.status] || ''} ${escapeHtml(n.status)}</td><td style="white-space:normal;max-width:260px">${escapeHtml(n.detail || '')}</td>
        <td>${escapeHtml(fmtDate(n.created_at))}</td>
      </tr>`).join('');
  } catch (err) {
    document.querySelector('#log tbody').innerHTML = `<tr><td colspan="6" class="banner err">${err.message}</td></tr>`;
  }
}

// ---- alert outbox ----
async function loadAlerts() {
  const box = document.getElementById('alerts');
  try {
    const { counts, problems, rateCappedChannels } = await api('/api/admin/alerts');
    const pill = (label, n, cls) => `<span class="stat" style="display:inline-block;padding:8px 12px;margin:0 8px 8px 0"><b class="${cls || ''}">${n || 0}</b> <span class="muted" style="font-size:12px">${label}</span></span>`;
    let html = pill('sent', counts.sent) + pill('pending', counts.pending) +
      pill('failed', counts.failed) + pill('skipped', counts.skipped);
    if (rateCappedChannels && rateCappedChannels.length) {
      html += `<div class="banner warn">Send rate cap reached for: ${escapeHtml(rateCappedChannels.join(', '))} — dispatch paused until the window resets (protects the WhatsApp number from a spam ban).</div>`;
    }
    if (problems.length) {
      html += `<div class="table-wrap"><table class="data"><thead><tr><th>Ref</th><th>Unit</th><th>Sev</th><th>Channel</th><th>Status</th><th>Tries</th><th>Error</th><th></th></tr></thead><tbody>` +
        problems.map((p) => `<tr style="cursor:default">
          <td><b>${escapeHtml(p.ref_no || '—')}</b></td><td>${escapeHtml(p.unit)}</td>
          <td>${escapeHtml(p.severity)}</td><td>${escapeHtml(p.channel)}</td>
          <td>${p.status === 'failed' ? '🔴' : '🟡'} ${escapeHtml(p.status)}</td><td>${p.attempts}</td>
          <td style="white-space:normal;max-width:240px">${escapeHtml(p.last_error || '')}</td>
          <td><button class="btn sm ghost retry-alert" data-id="${p.id}">Retry</button></td>
        </tr>`).join('') + '</tbody></table></div>';
    } else {
      html += '<p class="muted" style="margin:6px 0 0">All alerts delivered. ✓</p>';
    }
    box.innerHTML = html;
    box.querySelectorAll('.retry-alert').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api(`/api/admin/alerts/${b.dataset.id}/retry`, { method: 'POST' }); loadAlerts(); }
      catch (err) { box.insertAdjacentHTML('afterbegin', `<div class="banner err">${escapeHtml(err.message)}</div>`); }
    }));
  } catch (err) {
    box.innerHTML = `<div class="banner err">${escapeHtml(err.message)}</div>`;
  }
}

// ---- system health ----
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + units[i];
}

async function loadSystem() {
  const box = document.getElementById('system');
  try {
    const { storage, database, intake, counts, node, uptimeSec } = await api('/api/admin/system');
    const barColor = storage.usedPct > 90 ? 'var(--major)' : storage.usedPct > 70 ? 'var(--serious)' : 'var(--ok)';
    box.innerHTML = `
      <div class="hint">Photo storage: <b>${fmtBytes(storage.usedBytes)}</b> of ${fmtBytes(storage.capBytes)} (${storage.usedPct}%)</div>
      <div style="background:#e2e8f0;border-radius:999px;height:10px;margin:6px 0 12px;overflow:hidden">
        <div style="width:${Math.min(100, storage.usedPct)}%;height:100%;background:${barColor}"></div>
      </div>
      ${storage.full ? '<div class="banner err">Photo storage is FULL — new reports are accepted but without photos. Free space or raise MAX_UPLOAD_DIR_BYTES.</div>' : ''}
      ${intake?.globalCapReached ? '<div class="banner err">⚠️ Report intake rate cap reached — NEW REPORTS ARE BEING REFUSED right now. Investigate a possible flood or raise INTAKE_GLOBAL_PER_HOUR.</div>' : ''}
      <div class="hint">Database: <b>${fmtBytes(database?.bytes || 0)}</b></div>
      <div class="hint">Incidents: <b>${counts.incidents}</b> (${counts.voided} voided) · CAPA: <b>${counts.capa}</b> ·
        Audit entries: <b>${counts.auditEntries}</b> · Notification log: <b>${counts.notifications}</b> · Users: <b>${counts.users}</b></div>
      <div class="hint">Node ${escapeHtml(node)} · uptime ${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m</div>`;
  } catch (err) {
    box.innerHTML = `<div class="banner err">${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById('runRetention').addEventListener('click', async (e) => {
  const out = document.getElementById('retention-result');
  e.target.disabled = true;
  out.textContent = ' running…';
  try {
    const { result } = await api('/api/admin/retention/run', { method: 'POST' });
    out.textContent = ` cleaned: ${result.notifications} log rows, ${result.orphanPhotos} orphan photos`;
    loadSystem();
  } catch (err) {
    out.textContent = ' ' + err.message;
  } finally {
    e.target.disabled = false;
  }
});

// ---- audit trail ----
async function loadAudit() {
  const tbody = document.querySelector('#audit tbody');
  try {
    const { entries } = await api('/api/admin/audit?limit=100');
    if (!entries.length) { tbody.innerHTML = '<tr><td colspan="5" class="muted">No entries yet.</td></tr>'; return; }
    tbody.innerHTML = entries.map((e) => `
      <tr style="cursor:default">
        <td>${escapeHtml(fmtDate(e.created_at))}</td>
        <td><b>${escapeHtml(e.actor_name)}</b></td>
        <td>${escapeHtml(e.action)}</td>
        <td>${escapeHtml(e.ref_no || e.entity)}</td>
        <td style="white-space:normal;max-width:280px">${escapeHtml(e.detail || '')}</td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="banner err">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ---- recipients ----
async function loadRecipients() {
  const rb = document.getElementById('recip-banner');
  try {
    const { recipients } = await api('/api/admin/recipients');
    const tbody = document.querySelector('#recips tbody');
    if (!recipients.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">No recipients yet — add one below.</td></tr>';
    } else {
      tbody.innerHTML = recipients.map((r) => `
        <tr style="cursor:default">
          <td>${r.channel === 'whatsapp' ? '📱 WhatsApp' : '✉️ Email'}</td>
          <td><b>${escapeHtml(r.value)}</b></td>
          <td>${escapeHtml(r.label || '—')}</td>
          <td class="right"><button class="btn sm danger del-recip" data-id="${r.id}" data-v="${escapeHtml(r.value)}">Delete</button></td>
        </tr>`).join('');
      tbody.querySelectorAll('.del-recip').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm(`Remove recipient "${b.dataset.v}"?`)) return;
        try { await api('/api/admin/recipients/' + b.dataset.id, { method: 'DELETE' }); loadRecipients(); loadWa(); }
        catch (err) { rb.innerHTML = `<div class="banner err">${err.message}</div>`; }
      }));
    }
  } catch (err) {
    document.querySelector('#recips tbody').innerHTML = `<tr><td colspan="4" class="banner err">${err.message}</td></tr>`;
  }
}

document.getElementById('addRecip').addEventListener('click', async () => {
  const rb = document.getElementById('recip-banner');
  const body = {
    channel: document.getElementById('r_channel').value,
    value: document.getElementById('r_value').value,
    label: document.getElementById('r_label').value,
  };
  try {
    await api('/api/admin/recipients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('r_value').value = '';
    document.getElementById('r_label').value = '';
    rb.innerHTML = '<div class="banner ok">Recipient added.</div>';
    loadRecipients();
    loadWa();
  } catch (err) {
    rb.innerHTML = `<div class="banner err">${err.message}</div>`;
  }
});

// ---- users ----
async function loadUsers() {
  const ub = document.getElementById('user-banner');
  try {
    const { users } = await api('/api/admin/users');
    const tbody = document.querySelector('#users tbody');
    tbody.innerHTML = users.map((u) => `
      <tr style="cursor:default">
        <td><b>${escapeHtml(u.username)}</b></td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(fmtDate(u.created_at))}</td>
        <td class="right"><button class="btn sm danger del-user" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Delete</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('.del-user').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Delete user "${b.dataset.name}"?`)) return;
      try { await api('/api/admin/users/' + b.dataset.id, { method: 'DELETE' }); loadUsers(); }
      catch (err) { ub.innerHTML = `<div class="banner err">${err.message}</div>`; }
    }));
  } catch (err) {
    document.querySelector('#users tbody').innerHTML = `<tr><td colspan="4" class="banner err">${err.message}</td></tr>`;
  }
}

document.getElementById('addUser').addEventListener('click', async () => {
  const ub = document.getElementById('user-banner');
  const body = {
    username: document.getElementById('u_name').value.trim(),
    password: document.getElementById('u_pass').value,
    role: document.getElementById('u_role').value,
  };
  try {
    await api('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('u_name').value = '';
    document.getElementById('u_pass').value = '';
    ub.innerHTML = '<div class="banner ok">User added.</div>';
    loadUsers();
  } catch (err) {
    ub.innerHTML = `<div class="banner err">${err.message}</div>`;
  }
});

function refresh() { loadWa(); loadLog(); loadAlerts(); }

// mountSession loads the CSRF token, so wait for it before any write can happen.
mountSession().then(() => {
  loadEmail();
  loadQrLinks();
  loadRecipients();
  loadUsers();
  loadSystem();
  loadAudit();
  refresh();
  setInterval(refresh, 5000);
  setInterval(() => { loadSystem(); loadAudit(); }, 30000);
});
