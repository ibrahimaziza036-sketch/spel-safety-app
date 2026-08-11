import { brandHtml } from './common.js';

// Minimal brand-only header — the report form is public (anonymous workers).
document.getElementById('nav').innerHTML =
  `<div class="topbar"><span class="brand">${brandHtml()}<span class="brand-tag">Incident Report</span></span></div>`;

// Register the service worker so the form works OFFLINE (opens from cache, and
// reports queue on the phone until the internet is back). Best-effort — a
// failure here never blocks reporting.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
}

// The form is FULLY usable the instant this runs — unit/type options and the
// severity buttons are hardcoded in the HTML, so a QR scan needs ZERO API calls
// before the worker can start filling it in (fastest possible).
const params = new URLSearchParams(location.search);
const preUnit = params.get('unit'); // set by the per-unit QR code

const form = document.getElementById('form');
const banner = document.getElementById('banner');
const submitBtn = document.getElementById('submit');
const sevBox = document.getElementById('sev');
const sevInput = document.getElementById('severity');

function showBanner(type, msg) {
  banner.innerHTML = `<div class="banner ${type}">${msg}</div>`;
  banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Preselect the unit from the QR (no network needed).
if (preUnit) {
  const opt = [...form.unit.options].find((o) => o.value === preUnit);
  if (opt) form.unit.value = preUnit;
}

// Severity buttons.
sevBox.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    sevBox.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    sevInput.value = b.dataset.sev;
  });
});

// Type tiles (pictorial picker) → hidden #type input (same value the server reads).
const typeGrid = document.getElementById('typeGrid');
const typeInput = document.getElementById('type');
typeGrid.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    typeGrid.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    typeInput.value = b.dataset.type;
  });
});

// Separate date + time inputs → combined into the hidden occurred_at the server
// reads (as "YYYY-MM-DDTHH:MM", interpreted as PKT wall-clock).
const dateEl = document.getElementById('occurred_date');
const timeEl = document.getElementById('occurred_time');
const occEl = document.getElementById('occurred_at');
function combineWhen() {
  occEl.value = dateEl.value ? (dateEl.value + (timeEl.value ? 'T' + timeEl.value : '')) : '';
}
// Default = now (local wall-clock).
const now = new Date();
now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
const iso = now.toISOString();
dateEl.value = iso.slice(0, 10);
timeEl.value = iso.slice(11, 16);
dateEl.addEventListener('change', combineWhen);
timeEl.addEventListener('change', combineWhen);
combineWhen();

// ---------------------------------------------------------------------------
// Offline queue (IndexedDB): if a submit can't reach the server, the report is
// saved on the phone and sent automatically when the connection returns.
// ---------------------------------------------------------------------------
const DB_NAME = 'spel-offline';
const STORE = 'pending';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbAdd(record) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbAll() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(id) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// A unique idempotency token per report, so a retry/queue-flush never creates a
// duplicate on the server. (randomUUID needs a secure context; fall back for LAN http.)
function newToken() {
  try { if (self.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch { /* ignore */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// Snapshot the form into a plain, storable object (photo kept as a Blob). The
// token is generated ONCE here and reused on every retry of this same report.
function snapshotForm() {
  const data = { client_token: newToken() };
  for (const k of ['unit', 'description', 'type', 'severity', 'location', 'occurred_at', 'injured_person', 'reporter_name', 'reporter_code', 'reporter_contact']) {
    data[k] = form[k] ? form[k].value : '';
  }
  const photo = form.photo && form.photo.files && form.photo.files[0] ? form.photo.files[0] : null;
  return { data, photo, savedAt: Date.now() };
}
function recordToFormData(rec) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(rec.data)) { if (v) fd.append(k, v); }
  if (rec.photo) fd.append('photo', rec.photo, rec.photo.name || 'photo.jpg');
  return fd;
}

// POST to the server. Distinguishes a SERVER rejection (validation → show error)
// from a NETWORK failure (offline → queue).
async function postIncident(fd) {
  let res;
  try {
    res = await fetch('/api/incidents', { method: 'POST', body: fd });
  } catch (err) {
    const e = new Error('network'); e.network = true; throw e; // offline / unreachable
  }
  let out = null; try { out = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error(out?.error || (out?.errors && out.errors.join(' ')) || res.statusText);
    e.serverStatus = res.status;
    throw e;
  }
  return out;
}

let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine) return; // guard: never run two flushes at once
  flushing = true;
  try {
    let items;
    try { items = await idbAll(); } catch { return; }
    for (const item of items) {
      try {
        await postIncident(recordToFormData(item));
        await idbDelete(item.id); // delivered (or de-duped server-side) — remove from the phone
      } catch (err) {
        if (err.network) break;                 // still offline — stop, retry later
        if (err.serverStatus >= 400 && err.serverStatus < 500) {
          await idbDelete(item.id);              // permanently rejected — drop to avoid a stuck loop
        } else {
          break;                                 // server 5xx — keep and retry later
        }
      }
    }
  } finally {
    flushing = false;
    updatePendingNote();
  }
}

async function pendingCount() { try { return (await idbAll()).length; } catch { return 0; } }
async function updatePendingNote() {
  const n = await pendingCount();
  const el = document.getElementById('pending-note');
  if (!el) return;
  el.innerHTML = n > 0
    ? `<div class="banner warn">📥 ${n} report(s) saved on this phone, waiting for internet. They will send automatically.</div>`
    : '';
}

function showSuccess({ queued, ref } = {}) {
  document.getElementById('form-view').style.display = 'none';
  const view = document.getElementById('success-view');
  view.style.display = 'block';
  const refBox = document.getElementById('ref-no');
  if (queued) {
    view.querySelector('h2').textContent = 'Report saved on your phone';
    view.querySelector('.muted').textContent = 'No internet right now — it will be sent automatically the moment you are back online. You can close this page.';
    refBox.textContent = '⏳ Queued';
  } else {
    view.querySelector('h2').textContent = 'Report submitted';
    view.querySelector('.muted').textContent = 'Management has been alerted. Thank you for keeping SPEL safe.';
    refBox.textContent = ref || '';
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  banner.innerHTML = '';
  combineWhen();
  if (!form.unit.value) return showBanner('err', 'Please select a unit.');
  if (!form.description.value.trim()) return showBanner('err', 'Please describe what happened.');
  if (!form.type.value) return showBanner('err', 'Please select the incident type.');
  if (!sevInput.value) return showBanner('err', 'Please select a severity.');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  const snapshot = snapshotForm();
  try {
    const data = await postIncident(recordToFormData(snapshot));
    showSuccess({ ref: data.ref_no });
    if (data.warnings && data.warnings.length) {
      const w = document.createElement('div');
      w.className = 'banner warn'; w.style.marginTop = '14px';
      w.textContent = data.warnings.join(' ');
      document.getElementById('success-view').appendChild(w);
    }
    flushQueue(); // opportunistically send anything else that was waiting
  } catch (err) {
    if (err.network) {
      // Offline / server unreachable → save on the phone and confirm.
      try { await idbAdd(snapshot); showSuccess({ queued: true }); }
      catch { showBanner('err', 'Could not save the report on this device. Please note the details and tell the safety officer.'); resetBtn(); }
    } else {
      showBanner('err', 'Could not submit: ' + err.message);
      resetBtn();
    }
  }
});
function resetBtn() {
  submitBtn.disabled = false;
  submitBtn.innerHTML = '🚨 Submit &amp; Alert Management';
}

document.getElementById('another').addEventListener('click', () => location.reload());

// Try to flush the queue on load, whenever the connection returns, and
// periodically while the page is open.
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 30000);
updatePendingNote();
flushQueue();
