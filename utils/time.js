// Shared time helpers. The app stores every timestamp as a UTC ISO string and
// reports on the Pakistan (PKT = UTC+5, no DST) calendar, so all local-calendar
// logic lives here instead of being duplicated per module.

export const PKT_OFFSET_MINUTES = 5 * 60;
export const PKT_OFFSET_MS = PKT_OFFSET_MINUTES * 60 * 1000;
/** SQLite modifier for shifting a stored UTC value onto the PKT calendar. */
export const PKT_SQL_SHIFT = '+5 hours';

export function nowIso() {
  return new Date().toISOString();
}

/** PKT calendar date (YYYY-MM-DD) for an instant. Defaults to now. */
export function pktDate(when = Date.now()) {
  const ms = when instanceof Date ? when.getTime() : (typeof when === 'string' ? Date.parse(when) : when);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** PKT calendar year (YYYY) for an instant. */
export function pktYear(when = Date.now()) {
  const d = pktDate(when);
  return d ? d.slice(0, 4) : null;
}

/**
 * Human-readable PKT wall-clock ("YYYY-MM-DD HH:MM PKT") for a stored UTC value.
 * Stored timestamps are UTC, so they must be shifted +5h before display or the
 * whole UI (and every alert) would read 5 hours early.
 */
export function pktDateTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t + PKT_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) + ' PKT';
}

/**
 * Parse a datetime-local value (e.g. "2026-08-06T14:30", no timezone) as PKT
 * wall-clock and return a UTC ISO string. Values that already carry a timezone
 * (Z or +hh:mm) are respected as-is.
 * @returns {string|null} UTC ISO string, or null if unparseable.
 */
export function parseLocalToUtcIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (hasZone) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  // Naive "YYYY-MM-DDTHH:MM[:SS[.mmm]]" — treat as PKT wall-clock.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
  if (m) {
    const [, y, mo, d, h, mi, sec, ms] = m;
    const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec || 0), +((ms || '0').padEnd(3, '0'))) - PKT_OFFSET_MS;
    return new Date(utcMs).toISOString();
  }
  // Date only — midnight PKT.
  const dOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dOnly) {
    const [, y, mo, d] = dOnly;
    return new Date(Date.UTC(+y, +mo - 1, +d) - PKT_OFFSET_MS).toISOString();
  }
  // No trailing Date.parse fallback: it would interpret a zone-less string in
  // the HOST timezone, reintroducing the very UTC/PKT skew we normalize away.
  return null;
}

/**
 * Is this instant inside a sane window for an incident? Guards against typos
 * and hostile input (year 0001 / 99999) that would corrupt refs and charts.
 * Allows a small future skew for clock drift between phones and the server.
 */
export function isSaneIncidentTime(iso, { pastYears = 10, futureMinutes = 60 } = {}) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  return t >= now - pastYears * 365.25 * 86400000 && t <= now + futureMinutes * 60000;
}

/** Never let a future timestamp through where "latest" math depends on it. */
export function clampToNow(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return nowIso();
  return t > Date.now() ? nowIso() : new Date(t).toISOString();
}
