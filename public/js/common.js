// Shared front-end helpers (no framework, no build step).

// CSRF token for state-changing requests; supplied by /api/meta once logged in.
let csrf = null;
export function setCsrf(token) { csrf = token || null; }

export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  // Ensure a CSRF token is loaded before any state-changing call, so a handler
  // that fires before mountSession() finished still succeeds (no silent 403).
  if (isWrite && !csrf && path !== '/api/meta' && path !== '/api/auth/login' && path !== '/api/auth/logout') {
    try { await getMeta({ refresh: true }); } catch { /* ignore */ }
  }
  if (csrf && isWrite) {
    opts = { ...opts, headers: { ...(opts.headers || {}), 'X-CSRF-Token': csrf } };
  }
  const res = await fetch(path, opts);
  // Session expired / not logged in -> bounce to login (except when probing
  // the session itself, or already on the login page).
  if (res.status === 401 && path !== '/api/auth/me' && location.pathname !== '/login.html') {
    location.href = '/login.html';
    throw new Error('Login required');
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = data?.error || (data?.errors && data.errors.join(' ')) || res.statusText;
    throw new Error(msg);
  }
  return data;
}

let _meta = null;
export async function getMeta({ refresh = false } = {}) {
  if (_meta && !refresh) return _meta;
  _meta = (await api('/api/meta'));
  if (_meta?.csrfToken) setCsrf(_meta.csrfToken);
  return _meta;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Stored timestamps are UTC. The whole app reports on the Pakistan (UTC+5)
// calendar, so shift by +5h for display or every time would read 5h early.
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
export function fmtDate(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t + PKT_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) + ' PKT';
}

// HTML-escape any value before inserting into innerHTML. Use for EVERY
// user-controlled field to prevent stored XSS.
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sevChip(sev) {
  // sev is a fixed-list value; escape defensively anyway.
  return `<span class="chip sev-${escapeHtml(sev)}">${escapeHtml(sev)}</span>`;
}

export function statusBadge(status) {
  return `<span class="status-badge">${escapeHtml(status)}</span>`;
}

// Reusable brand logo: shield mark (safety) + safety-orange check (alerting) +
// two-weight "SPEL Safety" wordmark. Sits on the blue topbar.
export function brandHtml() {
  return `
    <svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="brandShield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="1" stop-color="#dbe6ff"/>
        </linearGradient>
      </defs>
      <path d="M20 3.5 L33.5 8 V18.5 C33.5 27.2 27.7 33.8 20 36.6 C12.3 33.8 6.5 27.2 6.5 18.5 V8 Z" fill="url(#brandShield)"/>
      <path d="M13.4 19.9 l4.7 4.7 l8.7 -10.1" fill="none" stroke="#f97316" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="brand-name"><b>SPEL</b><span class="brand-sub">Safety</span></span>`;
}

export function navbar(active) {
  // Phase-1 menu: Dashboard, Report, and Admin (Admin shows for admins only —
  // mountSession() removes it for other roles). The incidents-list is archived.
  const links = [
    ['/', 'Dashboard'],
    ['/report.html', 'Report Incident'],
    ['/admin.html', 'Admin'],
  ];
  const nav = links.map(([href, label]) =>
    `<a href="${href}" class="${active === label ? 'active' : ''}">${label}</a>`).join('');
  return `
  <div class="topbar">
    <a class="brand" href="/">${brandHtml()}</a>
    <nav>${nav}<span id="user-badge"></span></nav>
  </div>`;
}

// Fetch the current user, render the badge + logout, and hide the Admin link
// for non-admins. Returns the user object (or null). Call after setting the nav.
export async function mountSession() {
  let me = null;
  try { me = (await api('/api/auth/me')).user; } catch { /* ignore */ }
  // Load the CSRF token for this session before any write happens.
  if (me) { try { await getMeta({ refresh: true }); } catch { /* ignore */ } }
  const badge = document.getElementById('user-badge');
  if (me) {
    if (badge) {
      badge.innerHTML = `<span class="user-chip">${escapeHtml(me.username)} · ${escapeHtml(me.role)}</span> <a href="#" id="logout">Logout</a>`;
      document.getElementById('logout').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        location.href = '/login.html';
      });
    }
    if (me.role !== 'admin') {
      document.querySelectorAll('.topbar nav a[href="/admin.html"]').forEach((a) => a.remove());
    }
  }
  return me;
}
