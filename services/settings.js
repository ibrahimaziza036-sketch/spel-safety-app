// Simple key-value settings in the DB, so things like SMTP config can be
// managed from the admin GUI instead of editing .env on the server.
import { db } from '../db.js';
import { nowIso } from '../utils/time.js';

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

export function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, String(value), nowIso());
}
export function getJSON(key) {
  const v = getSetting(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export function setJSON(key, obj) { setSetting(key, JSON.stringify(obj)); }
