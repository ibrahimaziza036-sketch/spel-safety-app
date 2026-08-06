// Authentication helpers + Express middleware.
// Password hashing uses Node's built-in scrypt (no native dependency).
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { config, ROLES } from '../config.js';

const scryptAsync = promisify(scrypt);

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password WITHOUT blocking the event loop. scryptSync is deliberately
 * expensive, so doing it synchronously would let concurrent logins (or a login
 * flood) stall every other request, including incident submissions.
 */
export async function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  // Always run a derivation, even for a missing/garbled hash, so the response
  // time does not reveal whether the account exists.
  const safeSalt = salt && /^[0-9a-f]+$/i.test(salt) ? salt : 'ffffffffffffffffffffffffffffffff';
  let actual;
  try {
    actual = await scryptAsync(String(pw), safeSalt, 64);
  } catch {
    return false;
  }
  if (!hash || !/^[0-9a-f]+$/i.test(hash)) return false;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const nowIso = () => new Date().toISOString();

export function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function createUser({ username, password, role }) {
  const r = ROLES.includes(role) ? role : 'viewer';
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, hashPassword(password), r, nowIso());
  return Number(info.lastInsertRowid);
}

// Seed the initial admin on first run (only when the users table is empty).
export function ensureAdminUser() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  let pw = config.auth.adminPassword;
  let generated = false;
  if (!pw) {
    pw = randomBytes(12).toString('base64url'); // ~16 chars, ~96 bits
    generated = true;
  }
  createUser({ username: config.auth.adminUsername, password: pw, role: 'admin' });

  console.log('\n[auth] Created initial admin user:');
  console.log('       username: ' + config.auth.adminUsername);
  if (generated) {
    console.log('       password: ' + pw + '   <-- generated, note it now (set ADMIN_PASSWORD in .env to control it)');
  } else {
    console.log('       password: (from ADMIN_PASSWORD in .env)');
  }
  console.log('       Change it after first login.\n');
}

// ---- middleware ----

// Re-load the logged-in user from the DB on every request so role changes and
// deletions take effect IMMEDIATELY (not only after the cookie expires). If the
// user was deleted, the session is destroyed. Mount globally after session().
// Public static assets (CSS/JS/vendor) don't need a DB round-trip. This is a
// PREFIX allowlist, NOT an extension match: extension-based skipping would also
// skip /uploads/<name>.jpg, where the role check MUST see the fresh role so a
// demoted/deleted user immediately loses photo access.
const STATIC_PREFIX_RE = /^\/(?:css|js|vendor)\//i;
const STATIC_EXT_RE = /\.(?:css|js|mjs|map|ico|woff2?|ttf)$/i;

export function refreshSession(req, res, next) {
  const su = req.session?.user;
  if (!su) return next();
  if (STATIC_PREFIX_RE.test(req.path) && STATIC_EXT_RE.test(req.path)) return next();
  const fresh = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(su.id);
  if (!fresh) {
    return req.session.destroy(() => {
      if ((req.originalUrl || req.url).startsWith('/api/')) {
        return res.status(401).json({ ok: false, error: 'Session revoked' });
      }
      return res.redirect('/login.html');
    });
  }
  req.session.user = { id: fresh.id, username: fresh.username, role: fresh.role };
  next();
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  // Use originalUrl: when this runs as router-mounted middleware, req.path is
  // relative to the mount and would not start with /api/.
  if ((req.originalUrl || req.url).startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Login required' });
  }
  return res.redirect('/login.html');
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session?.user;
    if (!u) return res.status(401).json({ ok: false, error: 'Login required' });
    if (!roles.includes(u.role)) return res.status(403).json({ ok: false, error: 'You do not have permission for this action.' });
    next();
  };
}
