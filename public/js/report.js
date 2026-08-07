import { api, brandHtml } from './common.js';

// Minimal brand-only header — the report form is public (anonymous workers).
document.getElementById('nav').innerHTML =
  `<div class="topbar"><span class="brand">${brandHtml()}<span class="brand-tag">Incident Report</span></span></div>`;

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
  try {
    const data = await api('/api/incidents', { method: 'POST', body: new FormData(form) });
    document.getElementById('form-view').style.display = 'none';
    document.getElementById('success-view').style.display = 'block';
    document.getElementById('ref-no').textContent = data.ref_no;
    if (data.warnings && data.warnings.length) {
      const w = document.createElement('div');
      w.className = 'banner warn'; w.style.marginTop = '14px';
      w.textContent = data.warnings.join(' ');
      document.getElementById('success-view').appendChild(w);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showBanner('err', 'Could not submit: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.innerHTML = '🚨 Submit &amp; Alert Management';
  }
});

document.getElementById('another').addEventListener('click', () => location.reload());
