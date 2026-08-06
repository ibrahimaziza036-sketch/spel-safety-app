// Small dependency-free rate limiter with a BOUNDED store.
//
// Why not a Map that only grows: an attacker rotating IPs would otherwise grow
// the map forever. Entries expire with their window and a periodic sweep plus a
// hard cap keep memory flat.
const SWEEP_MS = 60 * 1000;
const MAX_KEYS = 10000;

export function createLimiter({ windowMs, max, name = 'limiter' }) {
  const hits = new Map(); // key -> { count, resetAt }  (Map keeps insertion order)

  function sweep() {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref?.();

  // Cheap eviction: Map iterates in insertion order, so the first entries are the
  // oldest — delete from the front until under the cap. No per-request sort.
  function evictIfNeeded() {
    if (hits.size < MAX_KEYS) return;
    const target = Math.floor(MAX_KEYS * 0.9);
    for (const k of hits.keys()) {
      if (hits.size <= target) break;
      hits.delete(k);
    }
  }

  function slot(key, now) {
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      evictIfNeeded();
      // delete-then-set so a refreshed key moves to the END (most-recent),
      // making the front-of-Map eviction a true oldest-first order.
      hits.delete(key);
      hits.set(key, e);
    }
    return e;
  }

  /** Consume one token. @returns {{allowed, remaining, retryAfterSec}} */
  function check(key) {
    const now = Date.now();
    const e = slot(key, now);
    e.count += 1;
    return { allowed: e.count <= max, remaining: Math.max(0, max - e.count), retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
  }

  /** Look WITHOUT consuming — used to reject before doing expensive work. */
  function peek(key) {
    const e = hits.get(key);
    const now = Date.now();
    if (!e || e.resetAt <= now) return { allowed: true, remaining: max, retryAfterSec: 0 };
    return { allowed: e.count < max, remaining: Math.max(0, max - e.count), retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
  }

  function reset(key) { hits.delete(key); }
  function size() { return hits.size; }
  function stop() { clearInterval(timer); }

  return { check, peek, reset, size, stop, name };
}

/**
 * Express middleware combining a per-IP limit with a global limit, so a single
 * abuser is blocked early and a distributed flood still can't exhaust the box.
 */
export function limitMiddleware({ perIp, global: globalLimiter, message, onGlobalBlock }) {
  return (req, res, next) => {
    const ip = req.clientIp || req.ip || 'unknown';
    const byIp = perIp.check(ip);
    if (!byIp.allowed) {
      res.setHeader('Retry-After', String(byIp.retryAfterSec));
      return res.status(429).json({ ok: false, error: message || 'Too many requests. Please try again later.' });
    }
    const overall = globalLimiter.check('__global__');
    if (!overall.allowed) {
      // The global cap blocks EVERYONE — surface it loudly (throttled) so an
      // operator notices rather than reports silently disappearing.
      if (onGlobalBlock) onGlobalBlock();
      res.setHeader('Retry-After', String(overall.retryAfterSec));
      return res.status(429).json({ ok: false, error: 'The system is receiving too many reports right now. Please try again shortly.' });
    }
    next();
  };
}
