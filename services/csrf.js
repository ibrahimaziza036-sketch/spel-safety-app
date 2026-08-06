// CSRF protection for state-changing requests.
//
// Two independent layers:
//  1. Origin/Referer check — the browser sets these and page JS cannot forge
//     them, so a cross-origin (or sibling-subdomain) form POST is rejected.
//  2. Double-submit token — a per-session token echoed in a header, which also
//     blocks a same-origin HTML form submission that has no access to it.
//
// The public incident-intake endpoint is exempt: it is designed to be posted
// from an anonymous QR page and holds no session to attack.
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

/** Fully exempt (no Origin AND no token check): anonymous public posts. */
const EXEMPT = [
  /^\/api\/incidents\/?$/, // public QR report submission
];

/** Origin-checked but token-exempt: worst case is a harmless forced action, and
 *  requiring a token here would let a stale page silently fail to log out. */
const TOKEN_EXEMPT = [
  /^\/api\/auth\/logout\/?$/,
];

function allowedOrigins() {
  const set = new Set();
  if (config.baseUrl) set.add(config.baseUrl.replace(/\/$/, ''));
  return set;
}

/** Attach (and lazily create) the session CSRF token. */
export function csrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(24).toString('base64url');
  return req.session.csrfToken;
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const url = req.originalUrl || req.url || '';
  const pathOnly = url.split('?')[0];
  if (EXEMPT.some((re) => re.test(pathOnly))) return next();

  // ---- layer 1: Origin / Referer must be this app ----
  const origin = req.get('origin');
  const referer = req.get('referer');
  const allowed = allowedOrigins();
  const hostOrigin = `${req.protocol}://${req.get('host')}`;
  allowed.add(hostOrigin);

  if (origin) {
    if (!allowed.has(origin.replace(/\/$/, ''))) {
      return res.status(403).json({ ok: false, error: 'Cross-origin request blocked' });
    }
  } else if (referer) {
    try {
      const r = new URL(referer);
      if (!allowed.has(`${r.protocol}//${r.host}`)) {
        return res.status(403).json({ ok: false, error: 'Cross-origin request blocked' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'Invalid referer' });
    }
  } else {
    // No Origin and no Referer on a state-changing request: not a normal
    // browser flow. Allowed only for unauthenticated requests (curl/scripts
    // against public routes), never for a session-carrying one.
    if (req.session?.user) {
      return res.status(403).json({ ok: false, error: 'Missing Origin/Referer on a state-changing request' });
    }
    return next();
  }

  // ---- layer 2: double-submit token (authenticated requests only) ----
  if (req.session?.user && !TOKEN_EXEMPT.some((re) => re.test(pathOnly))) {
    const expected = req.session.csrfToken;
    const provided = req.get(CSRF_HEADER);
    if (!expected || !provided || provided !== expected) {
      return res.status(403).json({ ok: false, error: 'Invalid or missing CSRF token. Please reload the page.' });
    }
  }
  next();
}
