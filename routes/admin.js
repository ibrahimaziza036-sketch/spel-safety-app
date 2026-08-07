import express from 'express';
import { whatsAppStatus, getQrDataUrl } from '../services/whatsapp.js';
import { emailStatus, verifyEmail, effectiveEmail, sendAdminEmail } from '../services/email.js';
import { getJSON, setJSON } from '../services/settings.js';
import { db } from '../db.js';
import { ROLES } from '../config.js';
import { createUser, findUser } from '../services/auth.js';
import { listRecipients, addRecipient, deleteRecipient } from '../services/recipients.js';
import { audit, recentAudit } from '../services/audit.js';
import { alertQueueStatus, retryAlert } from '../services/notify.js';
import { storageStatus } from '../services/storage.js';
import { runRetention } from '../services/retention.js';
import { getReminderConfig, setReminderConfig, sendReminderDigest, buildReminderData } from '../services/reminders.js';
import { intakeStatus } from './incidents.js';
import { dbPath } from '../db.js';
import fs from 'node:fs';

const router = express.Router();

// ---- alert recipients (WhatsApp numbers + emails) ----
router.get('/recipients', (req, res) => {
  res.json({ ok: true, recipients: listRecipients() });
});

router.post('/recipients', express.json({ limit: '8kb' }), (req, res) => {
  const { channel, value, label } = req.body || {};
  try {
    const id = addRecipient({ channel, value, label });
    audit(req, { entity: 'recipient', entityId: id, action: 'create', detail: `${channel}: ${value}` });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.delete('/recipients/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT channel, value FROM recipients WHERE id = ?').get(id);
  const ok = deleteRecipient(id);
  if (!ok) return res.status(404).json({ ok: false, error: 'Not found' });
  audit(req, { entity: 'recipient', entityId: id, action: 'delete', detail: row ? `${row.channel}: ${row.value}` : null });
  res.json({ ok: true });
});

// ---- channel status ----
router.get('/whatsapp/status', (req, res) => res.json({ ok: true, ...whatsAppStatus() }));

router.get('/whatsapp/qr', async (req, res) => {
  const dataUrl = await getQrDataUrl();
  res.json({ ok: true, dataUrl });
});

router.get('/email/status', (req, res) => res.json({ ok: true, ...emailStatus() }));

router.get('/email/verify', async (req, res) => res.json({ ok: true, ...(await verifyEmail()) }));

// ---- SMTP config via GUI (password write-only, never returned) ----
router.get('/email/config', (req, res) => {
  const e = effectiveEmail();
  res.json({
    ok: true,
    enabled: e.enabled, host: e.host, port: e.port, secure: e.secure,
    user: e.user, from: e.from, hasPassword: Boolean(e.pass),
  });
});

router.post('/email/config', express.json({ limit: '8kb' }), (req, res) => {
  const b = req.body || {};
  const current = getJSON('email_config') || {};
  const next = {
    enabled: !!b.enabled,
    host: String(b.host || '').trim(),
    port: Number(b.port) || 587,
    secure: !!b.secure,
    user: String(b.user || '').trim(),
    from: String(b.from || '').trim(),
    // Keep the existing password unless a new non-empty one is provided.
    pass: (typeof b.pass === 'string' && b.pass.length) ? b.pass : (current.pass ?? ''),
  };
  if (next.enabled && !next.host) return res.status(400).json({ ok: false, error: 'SMTP host required to enable email' });
  setJSON('email_config', next);
  audit(req, { entity: 'system', action: 'email_config', detail: `enabled=${next.enabled} host=${next.host}` });
  res.json({ ok: true });
});

// Send a real test email to the configured recipients.
router.post('/email/test', async (req, res) => {
  const r = await sendAdminEmail({
    subject: '✅ SPEL Safety — test email',
    text: 'This is a test email. If you received it, email alerts are configured correctly.',
  });
  audit(req, { entity: 'system', action: 'email_test', detail: r.ok ? 'sent' : ('failed: ' + r.reason) });
  res.json({ ok: r.ok, error: r.ok ? undefined : r.reason });
});

// ---- daily follow-up reminders ----
router.get('/reminders', (req, res) => {
  const data = buildReminderData();
  res.json({ ok: true, config: getReminderConfig(), due: { overdue: data.overdue.length, overdueSla: data.overdueSla.length } });
});

router.post('/reminders', express.json({ limit: '8kb' }), (req, res) => {
  const next = setReminderConfig(req.body || {});
  audit(req, { entity: 'system', action: 'reminders_config', detail: `enabled=${next.enabled} hour=${next.hour}` });
  res.json({ ok: true, config: next });
});

// Send the digest right now (test / on-demand).
router.post('/reminders/test', async (req, res) => {
  const r = await sendReminderDigest();
  audit(req, { entity: 'system', action: 'reminders_test', detail: r.attempted ? `wa=${r.waDelivered} email=${r.emailDelivered}` : (r.reason || 'nothing due') });
  res.json({ ok: true, ...r });
});

// Recent notification attempts, for troubleshooting delivery.
router.get('/notifications', (req, res) => {
  const rows = db.prepare(
    `SELECT n.*, i.ref_no FROM notifications_log n
     LEFT JOIN incidents i ON i.id = n.incident_id
     ORDER BY n.id DESC LIMIT 100`
  ).all();
  res.json({ ok: true, notifications: rows });
});

// ---- alert outbox: surfaces any alert that has NOT been delivered ----
router.get('/alerts', (req, res) => {
  res.json({ ok: true, ...alertQueueStatus() });
});

router.post('/alerts/:id/retry', (req, res) => {
  const ok = retryAlert(Number(req.params.id));
  if (!ok) return res.status(404).json({ ok: false, error: 'Not found' });
  audit(req, { entity: 'alert', entityId: Number(req.params.id), action: 'retry' });
  res.json({ ok: true });
});

// ---- system health: storage + retention ----
router.get('/system', (req, res) => {
  const counts = {
    incidents: db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n,
    voided: db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE voided_at IS NOT NULL').get().n,
    capa: db.prepare('SELECT COUNT(*) AS n FROM capa').get().n,
    notifications: db.prepare('SELECT COUNT(*) AS n FROM notifications_log').get().n,
    auditEntries: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  };
  let dbBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { dbBytes += fs.statSync(dbPath + suffix).size; } catch { /* file may not exist */ }
  }
  res.json({ ok: true, storage: storageStatus(), database: { bytes: dbBytes }, intake: intakeStatus(), counts, node: process.version, uptimeSec: Math.round(process.uptime()) });
});

router.post('/retention/run', (req, res) => {
  const result = runRetention({ verbose: true });
  audit(req, { entity: 'system', action: 'retention_run', detail: JSON.stringify(result) });
  res.json({ ok: true, result });
});

// ---- audit trail viewer ----
router.get('/audit', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  res.json({ ok: true, entries: recentAudit(limit) });
});

// ---- data-subject support: export one incident's full record ----
router.get('/export/incident/:id', (req, res) => {
  const id = Number(req.params.id);
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!incident) return res.status(404).json({ ok: false, error: 'Not found' });
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.session.user.username,
    incident,
    investigation: db.prepare('SELECT * FROM investigations WHERE incident_id = ?').get(id) || null,
    capa: db.prepare('SELECT * FROM capa WHERE incident_id = ? ORDER BY id').all(id),
    notifications: db.prepare('SELECT * FROM notifications_log WHERE incident_id = ? ORDER BY id').all(id),
    history: db.prepare('SELECT * FROM audit_log WHERE incident_id = ? ORDER BY id').all(id),
  };
  audit(req, { entity: 'incident', entityId: id, incidentId: id, action: 'export' });
  res.setHeader('Content-Disposition', `attachment; filename="${incident.ref_no || 'incident-' + id}.json"`);
  res.json(payload);
});

// ---- data-subject support: redact personal details, keep safety facts ----
router.post('/redact/incident/:id', express.json({ limit: '8kb' }), (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ ok: false, error: 'Not found' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ ok: false, error: 'A reason is required for redaction.' });

  db.prepare(`
    UPDATE incidents SET injured_person='(redacted)', reporter_name='(redacted)',
      reporter_contact=NULL, photo_path=NULL, updated_at=? WHERE id=?
  `).run(new Date().toISOString(), id);
  audit(req, {
    entity: 'incident', entityId: id, incidentId: id, action: 'redact',
    detail: reason.slice(0, 500),
  });
  res.json({ ok: true, note: 'Personal details removed; safety data retained. The photo file is cleaned up by the retention job.' });
});

// ---- user management (admin only; the whole /api/admin mount is admin-gated) ----
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
  res.json({ ok: true, users });
});

router.post('/users', express.json({ limit: '8kb' }), (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ ok: false, error: 'Username required' });
  if (!password || String(password).length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  if (!ROLES.includes(role)) return res.status(400).json({ ok: false, error: 'Invalid role' });
  const name = String(username).trim();
  if (name.length > 60) return res.status(400).json({ ok: false, error: 'Username is too long' });
  if (findUser(name)) return res.status(409).json({ ok: false, error: 'Username already exists' });
  const id = createUser({ username: name, password, role });
  audit(req, { entity: 'user', entityId: id, action: 'create', detail: `${name} (${role})` });
  res.status(201).json({ ok: true, id });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session?.user?.id) return res.status(400).json({ ok: false, error: 'You cannot delete your own account' });
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
  const target = db.prepare('SELECT username, role FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ ok: false, error: 'Not found' });
  if (target.role === 'admin' && admins <= 1) return res.status(400).json({ ok: false, error: 'Cannot delete the last admin' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  // The session store is swept by refreshSession (which re-reads the user on
  // every request), so the deleted user loses access immediately.
  audit(req, { entity: 'user', entityId: id, action: 'delete', detail: `${target.username} (${target.role})` });
  res.json({ ok: true });
});

export default router;
