import { api } from './common.js';

const form = document.getElementById('form');
const banner = document.getElementById('banner');
const submit = document.getElementById('submit');

// If already logged in, go straight to the dashboard.
api('/api/auth/me').then((r) => { if (r.user) location.href = '/'; }).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  banner.innerHTML = '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) { banner.innerHTML = '<div class="banner err">Enter username and password.</div>'; return; }

  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    // Login itself needs no CSRF token (there is no session to attack yet); the
    // Origin check still applies, and a token is issued for later requests.
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    location.href = '/';
  } catch (err) {
    banner.innerHTML = `<div class="banner err">${err.message}</div>`;
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});
