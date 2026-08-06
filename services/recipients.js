// Alert recipients (WhatsApp numbers + emails), stored in the DB so they can be
// managed from the admin GUI without editing .env. The .env MANAGEMENT_* values
// are used only to seed this table on first run.
import { db } from '../db.js';
import { config } from '../config.js';

const nowIso = () => new Date().toISOString();

// Normalize a Pakistani (or international) number to the form whatsapp-web.js
// expects: digits only, with country code, no + or leading 0.
//   03001234567      -> 923001234567
//   +92 300 1234567  -> 923001234567
//   3001234567       -> 923001234567
//   447911123456     -> 447911123456 (already has a country code)
export function normalizeWhatsApp(raw) {
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);            // 0092... -> 92...
  if (d.startsWith('92')) {
    // Strip a stray trunk 0 after the country code (92 0300... -> 92300...),
    // which would otherwise be stored as an undeliverable number.
    if (d.startsWith('920')) d = '92' + d.slice(3);
    return d;
  }
  if (d.startsWith('0') && d.length === 11) return '92' + d.slice(1); // 0300xxxxxxx
  if (d.length === 10 && d.startsWith('3')) return '92' + d;          // 300xxxxxxx
  return d; // assume it already includes a country code
}

/**
 * Validate a normalized number. Pakistani mobiles must be 92 + 3XXXXXXXXX
 * (12 digits); other country codes are accepted on length alone but must not
 * begin with a trunk 0, which is never valid internationally.
 * @returns {string|null} an error message, or null when valid.
 */
export function whatsAppNumberError(normalized) {
  const d = String(normalized || '');
  if (!/^\d+$/.test(d)) return 'Number must contain digits only';
  if (d.startsWith('0')) return 'Number must include the country code (e.g. 92 for Pakistan), not a leading 0';
  if (d.startsWith('92')) {
    if (!/^923\d{9}$/.test(d)) {
      return 'Pakistani mobile must be like 03001234567 (becomes 923001234567)';
    }
    return null;
  }
  if (d.length < 10 || d.length > 15) return 'Enter a valid phone number with country code';
  return null;
}

export function listRecipients(channel) {
  if (channel) return db.prepare('SELECT * FROM recipients WHERE channel = ? ORDER BY id').all(channel);
  return db.prepare('SELECT * FROM recipients ORDER BY channel, id').all();
}

// Active recipient values for a channel — used by the notifier.
export function activeValues(channel) {
  return db.prepare('SELECT value FROM recipients WHERE channel = ? AND active = 1 ORDER BY id')
    .all(channel).map((r) => r.value);
}

// Add a recipient. Throws Error (with a user-facing message) on invalid input
// or duplicate — callers turn that into a 400/409.
export function addRecipient({ channel, value, label }) {
  if (!['email', 'whatsapp'].includes(channel)) throw new Error('Invalid channel');
  let v = String(value || '').trim();
  if (channel === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('Enter a valid email address');
  } else {
    v = normalizeWhatsApp(v);
    const err = whatsAppNumberError(v);
    if (err) throw new Error(err);
  }
  const exists = db.prepare('SELECT id FROM recipients WHERE channel = ? AND value = ?').get(channel, v);
  if (exists) throw new Error('That recipient is already added');
  const info = db.prepare(
    'INSERT INTO recipients (channel, value, label, active, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(channel, v, (label || '').trim() || null, nowIso());
  return Number(info.lastInsertRowid);
}

export function deleteRecipient(id) {
  return db.prepare('DELETE FROM recipients WHERE id = ?').run(id).changes > 0;
}

// One-time seed from .env (only when the table is empty), so existing config
// isn't lost when upgrading to GUI-managed recipients.
export function seedRecipientsFromEnv() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM recipients').get().n;
  if (count > 0) return;
  for (const e of config.managementEmails) {
    try { addRecipient({ channel: 'email', value: e, label: 'from .env' }); } catch { /* ignore */ }
  }
  for (const w of config.managementWhatsApp) {
    try { addRecipient({ channel: 'whatsapp', value: w, label: 'from .env' }); } catch { /* ignore */ }
  }
}
