import express from 'express';
import { findUser, verifyPassword } from '../services/auth.js';
import { createLimiter } from '../services/ratelimit.js';
import { audit } from '../services/audit.js';

const router = express.Router();

// ---- brute-force throttle (per client IP, bounded store) ----
// Per-IP attempts are gated BEFORE the (deliberately expensive) scrypt hash, so
// a hammering IP cannot burn CPU/threadpool. A global FAILURE ceiling bounds a
// distributed guessing attack without penalising legitimate shift-change logins.
const perIp = createLimiter({ windowMs: 15 * 60 * 1000, max: 10, name: 'login-ip' });
const globalFailures = createLimiter({ windowMs: 15 * 60 * 1000, max: 100, name: 'login-fails-global' });

// Throttle the DB audit for blocked attempts so a flood of blocked POSTs cannot
// turn cheap 429s into unbounded synchronous audit_log writes. One row per IP
// per minute is enough to prove the trail can't be silenced.
const blockAuditedAt = new Map();
function auditBlockedThrottled(req, ip) {
  const now = Date.now();
  const last = blockAuditedAt.get(ip) || 0;
  if (now - last < 60000) return;
  if (blockAuditedAt.size > 5000) blockAuditedAt.clear(); // bound the map
  blockAuditedAt.set(ip, now);
  audit(req, { entity: 'user', action: 'login_blocked', actorName: 'anonymous', detail: 'ip rate-limited' });
}

// Public: log in.
router.post('/login', express.json({ limit: '4kb' }), async (req, res, next) => {
  const ip = req.clientIp || req.ip || 'unknown';

  // Gate BEFORE hashing. check() consumes a per-IP token per attempt; the global
  // ceiling is only PEEKed here (it is consumed on failure below) so successful
  // logins never count toward it.
  const ipGate = perIp.check(ip);
  const globalGate = globalFailures.peek('__global__');
  if (!ipGate.allowed || !globalGate.allowed) {
    const retry = Math.max(ipGate.retryAfterSec, globalGate.retryAfterSec);
    res.setHeader('Retry-After', String(retry));
    // Always log to console (cheap); persist to the audit trail at most once per
    // minute per IP so the trail can't be silenced yet a flood can't bloat it.
    console.warn(`[auth] login blocked for ${ip} (rate limit)`);
    auditBlockedThrottled(req, ip);
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  }

  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }

  try {
    const user = findUser(username.trim());
    // verifyPassword always runs a derivation, so a missing user costs the same
    // as a wrong password (no user enumeration by timing).
    const ok = await verifyPassword(password, user ? user.password_hash : '');

    if (!user || !ok) {
      globalFailures.check('__global__'); // count this failure toward the global ceiling
      audit(req, { entity: 'user', action: 'login_failed', actorName: 'anonymous', detail: `username=${username.trim().slice(0, 60)}` });
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }

    perIp.reset(ip); // clear throttle on success
    const sessionUser = { id: user.id, username: user.username, role: user.role };
    // Regenerate the session ID on privilege change to prevent session fixation.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = sessionUser;
      req.session.save((e) => {
        if (e) return next(e);
        audit(req, { entity: 'user', entityId: user.id, action: 'login' });
        res.json({ ok: true, user: sessionUser });
      });
    });
  } catch (err) {
    next(err);
  }
});

// Log out.
router.post('/logout', (req, res) => {
  const user = req.session?.user;
  if (user) audit(req, { entity: 'user', entityId: user.id, action: 'logout' });
  req.session?.destroy(() => {
    res.clearCookie('spel.sid');
    res.json({ ok: true });
  });
});

// Current user — always 200 so the login page can call it without a redirect loop.
router.get('/me', (req, res) => {
  res.json({ ok: true, user: req.session?.user || null });
});

export default router;
