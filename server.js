import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, DEV_SESSION_SECRET, UNITS, INCIDENT_TYPES, SEVERITIES, STATUSES } from './config.js';
import { db } from './db.js';
import incidentsRouter from './routes/incidents.js';
import dashboardRouter from './routes/dashboard.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import { initWhatsApp, shutdownWhatsApp, whatsAppStatus, onWhatsAppReady } from './services/whatsapp.js';
import { verifyEmail, emailStatus } from './services/email.js';
import { ensureAdminUser, requireAuth, requireRole, refreshSession } from './services/auth.js';
import { seedRecipientsFromEnv } from './services/recipients.js';
import { startNotifyWorker, stopNotifyWorker, notifyBusy, flushDeferred } from './services/notify.js';
import { startRetentionWorker, stopRetentionWorker } from './services/retention.js';
import { startReminderWorker, stopReminderWorker } from './services/reminders.js';
import { startMssqlBackupWorker, stopMssqlBackupWorker } from './services/mssql-backup.js';
import { startMonitor, stopMonitor, monitorStatus } from './services/monitor.js';
import { SqliteStore } from './services/session-store.js';
import { csrfProtection, csrfToken } from './services/csrf.js';
import { uploadDir } from './utils/paths.js';
import { pktDate } from './utils/time.js';

// Refuse to boot in production with a missing/default session secret.
if (process.env.NODE_ENV === 'production' &&
    (!process.env.SESSION_SECRET || config.auth.sessionSecret === DEV_SESSION_SECRET)) {
  console.error('FATAL: SESSION_SECRET must be set to a strong random value in production.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// Security headers (defense-in-depth; primary XSS defense is output escaping).
// script-src 'self' blocks inline scripts/handlers; nosniff stops MIME sniffing
// of uploaded files. style 'unsafe-inline' is required for inline style attrs.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.auth.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// Trust exactly as many proxy hops as are actually deployed. Trusting blindly
// would let a client spoof X-Forwarded-For and defeat per-IP rate limiting.
if (config.auth.trustProxyHops > 0) app.set('trust proxy', config.auth.trustProxyHops);

// Resolve the client IP once, so limiters and the audit trail agree.
app.use((req, res, next) => {
  req.clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
  next();
});

const sessionStore = new SqliteStore();
app.use(session({
  name: 'spel.sid',
  store: sessionStore,
  secret: config.auth.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax', // 'lax' so alert-email links (top-level nav) still carry the session
    secure: config.auth.cookieSecure, // set true when served over HTTPS
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
}));

// Keep session role/identity in sync with the DB (immediate revoke on delete).
app.use(refreshSession);

// CSRF must run before any body parser consumes a forged form post.
app.use(csrfProtection);

// ---- public endpoints ----
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Readiness: actually probe the dependencies, so monitoring can tell the
// difference between "process alive" and "able to do its job".
app.get('/readyz', (req, res) => {
  const checks = { db: false, whatsapp: null, email: null };
  try {
    db.prepare('SELECT 1 AS ok').get();
    // Also confirm the DB is WRITABLE, not just readable (catches a full/RO disk).
    db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    checks.db = true;
  } catch (err) {
    // Do NOT leak the driver message (it can include the DB file path) to an
    // anonymous caller; log it server-side instead.
    console.error('[readyz] db check failed:', err.message);
  }
  const wa = whatsAppStatus();
  checks.whatsapp = wa.enabled ? wa.state : 'disabled';
  const em = emailStatus();
  checks.email = em.enabled ? (em.configured ? 'configured' : 'not-configured') : 'disabled';
  // Alerting degrades gracefully, so only the DB is required for readiness.
  const ready = checks.db;
  res.status(ready ? 200 : 503).json({ ok: ready, checks });
});

// Reference data for the front-end (dropdowns etc.) — needed by the public
// report form, so left public.
app.get('/api/meta', (req, res) => {
  res.json({
    ok: true,
    units: UNITS,
    types: INCIDENT_TYPES,
    severities: SEVERITIES,
    statuses: STATUSES,
    baseUrl: config.baseUrl,
    maxDescription: config.intake.maxDescription,
    maxShortField: config.intake.maxShortField,
    // PKT calendar date, so client-side "overdue" matches the server exactly.
    todayPkt: pktDate(),
    // Session CSRF token for authenticated front-end calls (null when anonymous).
    csrfToken: req.session?.user ? csrfToken(req) : null,
  });
});

app.use('/api/auth', authRouter);

// Lightweight channel health for ANY logged-in user, so the dashboard can show
// a prominent banner the moment WhatsApp alerting is down.
app.get('/api/health/channels', requireAuth, (req, res) => {
  const wa = whatsAppStatus();
  const em = emailStatus();
  res.json({
    ok: true,
    whatsapp: { enabled: wa.enabled, state: wa.state, downMs: wa.downMs, hasQr: wa.hasQr },
    email: { enabled: em.enabled, configured: em.configured, recipients: em.recipients.length },
    monitor: monitorStatus(),
  });
});

// ---- API routes ----
// Incident create (POST /) is public (QR reporting); the router enforces auth
// on all read/edit routes itself.
app.use('/api/incidents', incidentsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/admin', requireRole('admin'), adminRouter);

// Serve Chart.js locally (no CDN needed — works offline / behind firewall).
app.get('/js/chart.umd.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), (err) => {
    if (err) res.status(404).send('// chart.js not installed');
  });
});

// Incident photos: served ONLY through this authenticated route (the files live
// outside the static web root), resolved by basename to block traversal.
// Personal details are restricted for viewers, so photos are too.
app.get('/uploads/:file', requireRole('safety_officer', 'admin'), (req, res) => {
  res.sendFile(path.join(uploadDir, path.basename(req.params.file)), (err) => {
    if (err && !res.headersSent) res.status(404).json({ ok: false, error: 'Not found' });
  });
});

// ---- page guard ----
// The report form and login page are public; every other page + the root
// require a session. Decode + lowercase the path first and fail CLOSED so
// %2e / case tricks (e.g. /dashboard%2ehtml, /ADMIN.HTML) cannot slip past.
// CSS/JS/image assets stay public (needed by the login page itself).
const PUBLIC_PAGES = new Set(['/login.html', '/report.html']);
app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path).toLowerCase(); }
  catch { return res.status(400).json({ ok: false, error: 'Bad request path' }); }
  const isPage = p === '/' || p.endsWith('.html');
  if (!isPage || PUBLIC_PAGES.has(p)) return next();
  if (req.session?.user) return next();
  return res.redirect('/login.html');
});

// Static front-end. "/" -> dashboard.
// Code (JS/CSS/SVG/HTML) is 'no-cache' — the browser still caches it but MUST
// revalidate (a cheap ETag 304 when unchanged), so a deploy never serves a stale
// dashboard.js against a changed backend. Only truly-stable binary assets get a
// long max-age. (Revalidation keeps the QR report page effectively instant.)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(?:png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // stable binaries: 1 day
    } else if (/\.(?:css|js|mjs|svg|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache'); // revalidate — never serve stale code
    }
  },
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Errors -> JSON. Client faults keep their message; server faults are generic so
// internal details (paths, schema, driver text) never leak.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE')) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const messages = {
      LIMIT_FILE_SIZE: 'Photo is too large (max 10 MB). Please retake at a smaller size.',
      LIMIT_FILE_COUNT: 'Only one photo can be attached.',
      LIMIT_FIELD_VALUE: 'One of the fields is too long.',
      LIMIT_FIELD_COUNT: 'Too many form fields.',
      LIMIT_PART_COUNT: 'Too many form parts.',
    };
    return res.status(status).json({ ok: false, error: messages[err.code] || err.message });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Request body is too large.' });
  }
  if (err?.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error('[error]', err?.stack || err?.message || err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// Seed the initial admin + any .env recipients before accepting traffic.
ensureAdminUser();
seedRecipientsFromEnv();

const server = app.listen(config.port, () => {
  console.log('\n==================================================');
  console.log('  SPEL Safety App running');
  console.log('  Local:     http://localhost:' + config.port);
  console.log('  Public:    ' + config.baseUrl);
  console.log('  Login:     ' + config.baseUrl + '/login.html');
  console.log('  Report:    ' + config.baseUrl + '/report.html?unit=UNIT1');
  console.log('  Dashboard: ' + config.baseUrl + '/');
  console.log('  Admin:     ' + config.baseUrl + '/admin.html');
  console.log('==================================================\n');

  // Kick off background services (never block the server).
  if (config.email.enabled) {
    verifyEmail().then((r) => console.log('[email] ' + (r.ok ? 'SMTP OK' : 'SMTP not ready: ' + r.reason)));
  }
  // Flush any queued/deferred alerts as soon as WhatsApp becomes available.
  onWhatsAppReady(() => flushDeferred());
  // Guard the fire-and-forget init so a WhatsApp/Chromium startup failure can
  // never take down the safety-alerting server.
  initWhatsApp().catch((e) => console.error('[whatsapp] init error:', e?.message || e));

  startNotifyWorker();
  startRetentionWorker();
  startReminderWorker();
  startMssqlBackupWorker();
  startMonitor();
});

// ---- graceful shutdown ----
// Close connections, checkpoint the WAL, and destroy the Chromium instance so a
// restart never leaves a zombie browser or an unmerged write-ahead log.
let shuttingDown = false;
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — closing down…`);
  const force = setTimeout(() => {
    console.error('[shutdown] timed out — forcing exit');
    process.exit(code || 1);
  }, 20000);
  force.unref?.();

  try {
    // Stop accepting work, stop the background timers, then let any in-flight
    // alert send finish (up to a few seconds) so we don't cut it mid-flight and
    // resend on restart.
    const closed = new Promise((resolve) => server.close(resolve));
    // Don't let idle keep-alive sockets hold the close open past the force timer,
    // which would skip the WAL checkpoint below.
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 5000).unref?.();
    await closed;
    stopNotifyWorker();
    stopRetentionWorker();
    stopReminderWorker();
    stopMssqlBackupWorker();
    stopMonitor();
    const drainUntil = Date.now() + 8000;
    while (notifyBusy() && Date.now() < drainUntil) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await shutdownWhatsApp();
    try { sessionStore.stop(); } catch { /* ignore */ }
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
    } catch (err) {
      console.warn('[shutdown] db close warning:', err.message);
    }
    console.log('[shutdown] done.');
    clearTimeout(force);
    process.exit(code);
  } catch (err) {
    console.error('[shutdown] error:', err.message);
    process.exit(code || 1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

// An unhandled rejection is logged (background work must not kill the server),
// but an uncaught exception leaves the process in an unknown state — log it and
// exit NON-ZERO so the supervisor (PM2) restarts a clean one instead of a zombie
// that answers /healthz while unable to alert anyone.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  shutdown('uncaughtException', 1);
});
