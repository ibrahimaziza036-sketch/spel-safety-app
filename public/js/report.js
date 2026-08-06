import { api, getMeta, brandHtml } from './common.js';

// Minimal brand-only header — the report form is public (anonymous workers),
// so we don't show staff navigation here.
document.getElementById('nav').innerHTML =
  `<div class="topbar"><span class="brand">${brandHtml()}<span class="brand-tag">Incident Report</span></span></div>`;

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

async function init() {
  const meta = await getMeta();

  const unitSel = document.getElementById('unit');
  unitSel.innerHTML = '<option value="">Select unit…</option>' +
    meta.units.map((u) => `<option value="${u}">${u}</option>`).join('');
  if (preUnit && meta.units.includes(preUnit)) unitSel.value = preUnit;

  document.getElementById('type').innerHTML = '<option value="">Select type…</option>' +
    meta.types.map((t) => `<option value="${t}">${t}</option>`).join('');

  sevBox.innerHTML = meta.severities.map((s) =>
    `<button type="button" class="${s}" data-sev="${s}" aria-pressed="false">${s}</button>`).join('');
  sevBox.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      sevBox.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      sevInput.value = b.dataset.sev;
    });
  });

  // Default "when" = now (local time, formatted for datetime-local input).
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  document.getElementById('occurred_at').value = d.toISOString().slice(0, 16);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  banner.innerHTML = '';

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
      w.className = 'banner warn';
      w.style.marginTop = '14px';
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

init().catch((err) => showBanner('err', 'Failed to load form: ' + err.message));
