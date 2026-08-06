// WhatsApp channel via whatsapp-web.js (free, unofficial WhatsApp Web client).
//
// Design goals:
//  - NEVER crash the app. If the library isn't installed or Chromium fails to
//    launch, we log it and keep running (email still works).
//  - Expose connection state + the login QR so an admin can scan it from the
//    browser at /admin.
//  - Persist the session (LocalAuth) so you only scan once.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config.js';
import { activeValues } from './recipients.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '..', 'data', '.wwebjs_auth');

let client = null;
let MessageMedia = null;
let state = 'disabled'; // disabled | starting | qr | authenticated | ready | disconnected | error
let lastQr = null;
let lastError = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let healthTimer = null;
let watchdogTimer = null;
let downSince = Date.now(); // when the client last left the 'ready' state (null while ready)
let readyListeners = [];

// If the client stays not-ready this long, force a hard re-init — a backstop for
// a hung initialize() or a stuck reconnect. Mission-critical: recover fast.
const WATCHDOG_FORCE_MS = 3 * 60 * 1000;
const INIT_TIMEOUT_MS = 90 * 1000;

// Errors that mean the underlying Chromium page/frame is dead. When these
// happen the client often stays stuck reporting state='ready' while every send
// fails — so we must force a full reconnect instead of trusting the flag.
const FATAL_CLIENT_RE = /detached frame|session closed|target closed|protocol error|execution context (?:was )?destroyed|most likely because of a navigation|page has been closed|not opened|browser has disconnected|websocket/i;
function isFatalClientError(msg) {
  return FATAL_CLIENT_RE.test(String(msg || ''));
}

export function whatsAppStatus() {
  return {
    enabled: config.whatsapp.enabled,
    state,
    hasQr: Boolean(lastQr),
    recipients: activeValues('whatsapp'),
    minSeverity: config.whatsapp.minSeverity,
    error: lastError,
    reconnectAttempts,
    // How long the channel has been unavailable (ms); 0 when ready/disabled.
    downMs: (state === 'ready' || state === 'disabled' || downSince === null) ? 0 : Date.now() - downSince,
  };
}

function markDown() { if (downSince === null) downSince = Date.now(); }

/** Register a callback fired whenever the client becomes ready (for retries). */
export function onWhatsAppReady(fn) {
  readyListeners.push(fn);
}

/** Reject if a promise takes too long, so one hung send can't stall the queue. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Schedule a reconnect with bounded exponential backoff (30s → 15m). Without
 * this the alert channel stays dead after a disconnect until someone notices
 * and restarts the whole app.
 */
function stopHealthProbe() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

/**
 * Actively probe the live client instead of trusting the cached 'ready' flag.
 * whatsapp-web.js can leave state='ready' while its Chromium frame is detached
 * (every send then fails), and no 'disconnected' event fires. getState() throws
 * or returns non-CONNECTED in that case, which we treat as a disconnect.
 */
function startHealthProbe() {
  stopHealthProbe();
  healthTimer = setInterval(async () => {
    if (state !== 'ready' || !client) return;
    try {
      const s = await withTimeout(client.getState(), 15000, 'getState');
      if (s !== 'CONNECTED') markUnhealthy('health probe: getState=' + s);
    } catch (err) {
      markUnhealthy('health probe failed: ' + err.message);
    }
  }, 60000);
  healthTimer.unref?.();
}

/**
 * Backstop watchdog: runs regardless of events. If the client has been
 * not-ready longer than WATCHDOG_FORCE_MS and nothing is actively recovering
 * (or recovery is stuck), force a hard re-init. Catches a hung initialize().
 */
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!config.whatsapp.enabled) return;
    if (state === 'ready' || state === 'error') return; // 'error' = auth_failure (needs human)
    if (downSince && Date.now() - downSince > WATCHDOG_FORCE_MS && !reconnectTimer) {
      console.warn('[whatsapp] watchdog: down too long — forcing hard re-init');
      forceReinit('watchdog');
    }
  }, 30000);
  watchdogTimer.unref?.();
}

async function forceReinit(reason) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHealthProbe();
  markDown();
  try {
    if (client) { try { await withTimeout(client.destroy(), 15000, 'destroy'); } catch { /* ignore */ } client = null; }
  } finally {
    initWhatsApp().catch((e) => console.error('[whatsapp] ' + reason + ' re-init failed:', e?.message || e));
  }
}

/** Force recovery when the client is dead-but-reporting-ready. */
function markUnhealthy(reason) {
  if (reconnectTimer) return; // recovery already scheduled
  console.warn('[whatsapp] client unhealthy — ' + reason);
  state = 'disconnected';
  lastError = reason;
  stopHealthProbe();
  scheduleReconnect('unhealthy: ' + reason);
}

function scheduleReconnect(reason) {
  if (!config.whatsapp.enabled) return;
  markDown();
  if (reconnectTimer) return;
  stopHealthProbe();
  reconnectAttempts += 1;
  // Aggressive backoff for a mission-critical channel: 15s, 30s, 60s, cap 2min.
  const delayMs = Math.min(120000, 15000 * 2 ** Math.min(3, reconnectAttempts - 1));
  console.warn(`[whatsapp] ${reason} — reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      if (client) {
        try { await withTimeout(client.destroy(), 15000, 'destroy'); } catch { /* ignore */ }
        client = null;
      }
    } finally {
      initWhatsApp().catch((e) => console.error('[whatsapp] reconnect failed:', e?.message || e));
    }
  }, delayMs);
  reconnectTimer.unref?.();
}

/** Returns the current login QR as a PNG data URL, or null if none pending. */
export async function getQrDataUrl() {
  if (!lastQr) return null;
  return QRCode.toDataURL(lastQr, { margin: 1, width: 320 });
}

export async function initWhatsApp() {
  if (!config.whatsapp.enabled) {
    state = 'disabled';
    return;
  }
  state = 'starting';
  markDown();
  startWatchdog();

  // Everything below is wrapped so ANY failure (mkdir on a read-only volume,
  // an unexpected module shape, Chromium launch) only sets state='error' and
  // never rejects the promise / crashes the server.
  try {
    fs.mkdirSync(authDir, { recursive: true });

    let wweb;
    try {
      wweb = await import('whatsapp-web.js');
    } catch (err) {
      state = 'error';
      lastError = `whatsapp-web.js not installed (${err.message}). Run: npm install`;
      console.error('[whatsapp] ' + lastError);
      return;
    }

    const mod = wweb.default || wweb;
    const { Client, LocalAuth } = mod;
    MessageMedia = mod.MessageMedia;
    if (typeof Client !== 'function') {
      state = 'error';
      lastError = 'whatsapp-web.js Client export not found (version mismatch?)';
      console.error('[whatsapp] ' + lastError);
      return;
    }

    const puppeteer = {
      headless: config.whatsapp.headless,
      // Stability args reduce the frequency of the "detached frame" renderer
      // crashes on long-running/headless Chromium.
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      ],
    };
    if (config.whatsapp.chromePath) puppeteer.executablePath = config.whatsapp.chromePath;

    client = new Client({
      authStrategy: new LocalAuth({ dataPath: authDir }),
      puppeteer,
      // Keep the library's version cache under data/ instead of the repo root.
      webVersionCache: {
        type: 'local',
        path: path.join(__dirname, '..', 'data', '.wwebjs_cache'),
      },
    });

    client.on('qr', (qr) => {
      lastQr = qr;
      state = 'qr';
      console.log('\n[whatsapp] Scan this QR to link a WhatsApp number (or open ' + config.baseUrl + '/admin):');
      qrcodeTerminal.generate(qr, { small: true });
    });
    client.on('authenticated', () => { state = 'authenticated'; lastQr = null; });
    client.on('ready', () => {
      state = 'ready';
      lastQr = null;
      lastError = null;
      reconnectAttempts = 0;
      downSince = null; // fully recovered
      console.log('[whatsapp] Client is ready.');
      startHealthProbe(); // catch a silently-dead frame going forward
      // Let the notifier flush anything that queued up while we were down.
      for (const fn of readyListeners) {
        try { fn(); } catch (e) { console.error('[whatsapp] ready listener failed:', e.message); }
      }
    });
    client.on('auth_failure', (m) => {
      // Credentials are invalid — a reconnect loop won't help; an admin must
      // re-scan the QR, so surface it instead of retrying forever.
      state = 'error';
      lastError = 'auth_failure: ' + m + ' — re-scan the QR on the Admin page.';
      console.error('[whatsapp] auth failure', m);
    });
    client.on('disconnected', (reason) => {
      state = 'disconnected';
      lastError = 'disconnected: ' + reason;
      stopHealthProbe();
      scheduleReconnect('disconnected (' + reason + ')');
    });

    // Bound initialize() so a hung startup can't leave the channel stuck in
    // 'starting' forever — the watchdog/reconnect will then retry.
    await withTimeout(client.initialize(), INIT_TIMEOUT_MS, 'initialize');
  } catch (err) {
    state = 'error';
    lastError = err.message;
    console.error('[whatsapp] initialize failed:', err.message);
    // Chromium launch failures are often transient (resource pressure, stale
    // lock) — keep trying in the background rather than staying dead.
    if (!/auth_failure/i.test(err.message)) scheduleReconnect('initialize failed');
  }
}

/** Graceful shutdown: close the browser so no Chromium zombie is left behind. */
export async function shutdownWhatsApp() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  stopHealthProbe();
  readyListeners = [];
  if (!client) return;
  try { await withTimeout(client.destroy(), 10000, 'whatsapp destroy'); }
  catch (err) { console.warn('[whatsapp] destroy failed:', err.message); }
  client = null;
}

/**
 * Send the alert to the configured WhatsApp recipients.
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.skip] recipients already delivered — not re-sent.
 * @returns {Promise<Array<{recipient,status,detail?,permanent?}>>}
 *   status: sent | failed | skipped. `permanent:true` marks a failure that will
 *   never succeed on retry (e.g. the number is not on WhatsApp).
 */
export async function sendIncidentWhatsApp({ text, imagePath, skip } = {}) {
  const skipSet = skip instanceof Set ? skip : new Set(skip || []);
  const all = activeValues('whatsapp');
  // Guard empties first so the audit log always gets at least one row.
  if (all.length === 0) {
    return [{ recipient: '(none)', status: 'skipped', detail: 'no WhatsApp recipients added' }];
  }
  if (!config.whatsapp.enabled) {
    return all.map((r) => ({ recipient: r, status: 'skipped', detail: 'whatsapp disabled' }));
  }
  if (state !== 'ready' || !client) {
    return all.map((r) => ({ recipient: r, status: 'failed', detail: 'not connected (state=' + state + ')' }));
  }

  let media = null;
  if (imagePath && MessageMedia) {
    try { media = MessageMedia.fromFilePath(imagePath); } catch { media = null; }
  }

  // Each recipient is bounded by its own timeout so one unreachable number
  // cannot stall the alerts to everyone after it.
  const timeout = config.whatsapp.sendTimeoutMs;
  const results = [];
  let dead = false; // set once the underlying client is detected as dead
  for (const number of all) {
    // Already delivered on a previous attempt — never re-send (anti-spam).
    if (skipSet.has(number)) {
      results.push({ recipient: number, status: 'sent', detail: 'already delivered' });
      continue;
    }
    // Client just died mid-loop — don't hammer a dead frame; retry later.
    if (dead) {
      results.push({ recipient: number, status: 'failed', detail: 'client reconnecting' });
      continue;
    }
    try {
      const numberId = await withTimeout(client.getNumberId(number), timeout, 'getNumberId');
      if (!numberId) {
        // Not on WhatsApp — retrying will never help, so mark it permanent.
        results.push({ recipient: number, status: 'failed', detail: 'number not on WhatsApp', permanent: true });
        continue;
      }
      const send = media
        ? client.sendMessage(numberId._serialized, media, { caption: text })
        : client.sendMessage(numberId._serialized, text);
      await withTimeout(send, timeout, 'sendMessage');
      results.push({ recipient: number, status: 'sent' });
    } catch (err) {
      if (isFatalClientError(err.message)) {
        // The Chromium frame is dead — force a reconnect and stop sending; the
        // queue keeps these as transient failures and retries after recovery.
        dead = true;
        results.push({ recipient: number, status: 'failed', detail: 'client reconnecting: ' + err.message });
        markUnhealthy('send error: ' + err.message);
      } else {
        results.push({ recipient: number, status: 'failed', detail: err.message });
      }
    }
  }
  return results;
}
