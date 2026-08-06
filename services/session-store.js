// A small SQLite-backed express-session store.
//
// The default MemoryStore never prunes expired sessions (slow leak) and drops
// every session on restart, logging all users out. This store persists sessions
// in the app database and sweeps expired rows.
import session from 'express-session';
import { db } from '../db.js';
import { nowIso } from '../utils/time.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

const Store = session.Store;

export class SqliteStore extends Store {
  constructor({ sweepMs = 10 * 60 * 1000 } = {}) {
    super();
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      all: db.prepare('SELECT sid, data FROM sessions WHERE expires_at >= ?'),
      clear: db.prepare('DELETE FROM sessions'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at >= ?'),
    };
    this.sweep();
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  sweep() {
    try { this.stmts.sweep.run(nowIso()); } catch (err) { console.error('[session] sweep failed:', err.message); }
  }

  expiryFor(sess) {
    const ms = sess?.cookie?.maxAge ?? 12 * 60 * 60 * 1000;
    const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + ms);
    return expires.toISOString();
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < nowIso()) {
        this.stmts.destroy.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) { return cb(err); }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.expiryFor(sess));
      return cb?.(null);
    } catch (err) { return cb?.(err); }
  }

  destroy(sid, cb) {
    try { this.stmts.destroy.run(sid); return cb?.(null); }
    catch (err) { return cb?.(err); }
  }

  touch(sid, sess, cb) {
    try { this.stmts.touch.run(this.expiryFor(sess), sid); return cb?.(null); }
    catch (err) { return cb?.(err); }
  }

  length(cb) {
    try { return cb(null, this.stmts.length.get(nowIso()).n); }
    catch (err) { return cb(err); }
  }

  clear(cb) {
    try { this.stmts.clear.run(); return cb?.(null); }
    catch (err) { return cb?.(err); }
  }

  /** Destroy every session belonging to a user (used when access is revoked). */
  destroyForUser(userId) {
    let removed = 0;
    try {
      for (const row of this.stmts.all.all(nowIso())) {
        try {
          const data = JSON.parse(row.data);
          if (data?.user?.id === userId) { this.stmts.destroy.run(row.sid); removed += 1; }
        } catch { /* ignore malformed row */ }
      }
    } catch (err) { console.error('[session] destroyForUser failed:', err.message); }
    return removed;
  }

  stop() { clearInterval(this.timer); }
}
