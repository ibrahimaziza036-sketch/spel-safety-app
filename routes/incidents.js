import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db.js';
import { config, UNITS, INCIDENT_TYPES, SEVERITIES, STATUSES } from '../config.js';
import { queueIncidentAlerts, priorSimilarCount, RECUR_WINDOW_DAYS } from '../services/notify.js';
import { requireAuth, requireRole } from '../services/auth.js';
import { audit, diffFields, incidentHistory } from '../services/audit.js';
import { createLimiter, limitMiddleware } from '../services/ratelimit.js';
import { uploadDir } from '../utils/paths.js';
import { bumpStorageUsed, invalidateStorageCache, storageIsFull } from '../services/storage.js';
import { nowIso, pktYear, parseLocalToUtcIso, isSaneIncidentTime, clampToNow, PKT_SQL_SHIFT } from '../utils/time.js';

// Only safety officers and admins may investigate / edit.
const canEdit = requireRole('safety_officer', 'admin');

const router = express.Router();

// PKT-local calendar date of the event, for filtering and grouping.
const DATE_EXPR = `date(datetime(COALESCE(occurred_at, created_at), '${PKT_SQL_SHIFT}'))`;
// Voided incidents are excluded from all normal reads/statistics.
const NOT_VOID = 'voided_at IS NULL';

// ---- abuse control for the PUBLIC intake endpoint ----
// Genuine reporting is low-volume; these caps stop a flood from exhausting the
// disk, bloating the dataset, or triggering a notification storm.
const intakePerIp = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: config.intake.perIpPerHour,
  name: 'intake-ip',
});
const intakeGlobal = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: config.intake.globalPerHour,
  name: 'intake-global',
});
// When the GLOBAL cap trips, EVERY report (even a real Fatal one) is refused —
// so make that loud and visible to operators rather than a silent 429.
let globalCapWarnedAt = 0;
const intakeLimit = limitMiddleware({
  perIp: intakePerIp,
  global: intakeGlobal,
  message: 'Too many reports from this device. If this is an emergency, call the safety officer directly.',
  onGlobalBlock: () => {
    if (Date.now() - globalCapWarnedAt > 60000) {
      globalCapWarnedAt = Date.now();
      console.error('[intake] GLOBAL report rate cap reached — new incident reports are being REFUSED. Raise INTAKE_GLOBAL_PER_HOUR or investigate a flood.');
    }
  },
});
export function intakeStatus() {
  const g = intakeGlobal.peek('__global__');
  return { globalCapReached: !g.allowed, perHour: config.intake.globalPerHour };
}

// ---- photo upload ----
// Only raster image types are accepted, and the stored extension is FORCED from
// an allowlist (never trusted from the client filename). Together with the
// global `X-Content-Type-Options: nosniff` header and the authenticated serving
// route, this prevents a client from smuggling an executable document. SVG is
// intentionally excluded (it can carry script).
const ALLOWED_IMAGE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = ALLOWED_IMAGE[file.mimetype] || '.bin';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: {
    fileSize: config.intake.maxPhotoBytes,
    files: 1,
    // Bound the non-file parts too: without these, a request could stream
    // unlimited/huge text fields into memory.
    fields: 20,
    fieldSize: 64 * 1024,
    fieldNameSize: 100,
    parts: 25,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE[file.mimetype]) return cb(null, false);
    // Refuse new photos once the storage cap is reached, so the disk (and the
    // database sharing it) can never be filled by uploads.
    if (storageIsFull()) {
      req.storageFull = true;
      return cb(null, false);
    }
    cb(null, true);
  },
});

// ---- input helpers ----
/** A repeated/nested query or body key arrives as an array/object — take a scalar. */
const scalar = (v) => {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
};
/** Trim and hard-cap a free-text field so it cannot bloat the DB or the alert. */
const text = (v, max) => {
  const s = scalar(v).trim();
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * Viewers may see the safety facts but not the personal details. Officers and
 * admins see the full record.
 */
const PII_FIELDS = ['injured_person', 'reporter_contact', 'reporter_name', 'reporter_code'];

function canSeePii(role) {
  return role === 'safety_officer' || role === 'admin';
}

function redactForRole(incident, role) {
  if (!incident) return incident;
  if (canSeePii(role)) return incident;
  const { injured_person, reporter_contact, reporter_name, reporter_code, photo_path, ...rest } = incident;
  return {
    ...rest,
    injured_person: injured_person ? '(restricted)' : null,
    reporter_contact: reporter_contact ? '(restricted)' : null,
    reporter_name: reporter_name ? '(restricted)' : null,
    reporter_code: reporter_code ? '(restricted)' : null,
    photo_path: null,
    pii_restricted: true,
  };
}

/**
 * The audit trail stores before/after values that can include PII — so a viewer
 * must not read raw history either. Mask PII fields inside each entry's diff and
 * drop details that may quote personal data.
 */
function redactHistoryForRole(history, role) {
  if (canSeePii(role)) return history;
  return history.map((e) => {
    let changes = e.changes;
    if (changes) {
      try {
        const obj = JSON.parse(changes);
        for (const f of PII_FIELDS) {
          if (obj[f]) obj[f] = { from: obj[f].from ? '(restricted)' : null, to: obj[f].to ? '(restricted)' : null };
        }
        changes = JSON.stringify(obj);
      } catch { /* leave as-is */ }
    }
    // 'update'/'redact' details can quote free text; hide them from viewers.
    const detail = ['create', 'status', 'void', 'restore'].includes(e.action) ? e.detail : null;
    return { ...e, changes, detail };
  });
}

function touchIncident(id) {
  db.prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

// ---------- CREATE initial incident report (public, QR-driven) ----------
// The body parsers are scoped to THIS route only. A global express.urlencoded()
// would let a cross-site HTML form post to any authenticated endpoint; keeping
// it here means only the intentionally-public route accepts form encoding.
// Both parsers no-op for the other's content type, so multipart (with photo)
// and plain urlencoded submissions both work.
router.post('/', intakeLimit,
  express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 30 }),
  upload.single('photo'),
  (req, res) => {
  const b = req.body || {};
  const errors = [];
  const unit = scalar(b.unit);
  const type = scalar(b.type);
  const severity = scalar(b.severity);
  const description = text(b.description, config.intake.maxDescription);

  if (!UNITS.includes(unit)) errors.push('Invalid or missing unit.');
  if (!INCIDENT_TYPES.includes(type)) errors.push('Invalid or missing incident type.');
  if (!SEVERITIES.includes(severity)) errors.push('Invalid or missing severity.');
  if (!description) errors.push('Description is required.');
  if (errors.length) {
    // Clean up an orphaned upload if validation failed.
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ ok: false, errors });
  }
  // Storage full is NOT a validation failure — the report must still go through
  // (safety first); the photo is simply dropped and the reporter is told.
  const warnings = [];
  if (req.storageFull) {
    warnings.push('Photo storage is full, so your photo was not saved — the report has still been submitted. Please inform IT.');
  }

  const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
  if (req.file) bumpStorageUsed(req.file.size || 0);
  const created = nowIso();

  // occurred_at arrives as a naive datetime-local value from a phone in
  // Pakistan; interpret it as PKT wall-clock and store UTC. Reject nonsense
  // (year 0001 / 99999) and clamp a future value so "days since last incident"
  // and the trend chart can't be poisoned.
  let occurred = created;
  let occurredRewritten = false;
  if (b.occurred_at) {
    const parsed = parseLocalToUtcIso(scalar(b.occurred_at));
    if (parsed && isSaneIncidentTime(parsed)) occurred = clampToNow(parsed);
    else occurredRewritten = true;
  }
  if (occurredRewritten) {
    warnings.push('The "when it happened" time was not valid, so the current time was used. You can correct it later.');
  }

  // Per-year reference number (INC-YYYY-NNNN) on the incident's PKT year, taken
  // and inserted inside one IMMEDIATE transaction so two concurrent reports
  // cannot claim the same sequence. Numeric CAST ordering keeps working past
  // 9999 records in a year.
  const year = pktYear(occurred);
  const insertIncident = db.prepare(`
    INSERT INTO incidents
      (ref_no, unit, location, occurred_at, type, severity, description,
       injured_person, reporter_name, reporter_code, reporter_contact, photo_path, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?)
  `);
  const nextSeq = db.prepare(
    `SELECT MAX(CAST(substr(ref_no, 10) AS INTEGER)) AS n FROM incidents WHERE ref_no LIKE ?`
  );

  let id;
  let refNo;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const seq = (nextSeq.get(`INC-${year}-%`).n || 0) + 1;
      refNo = `INC-${year}-${String(seq).padStart(4, '0')}`;
      const info = insertIncident.run(
        refNo,
        unit,
        text(b.location, config.intake.maxShortField) || null,
        occurred,
        type,
        severity,
        description,
        text(b.injured_person, config.intake.maxShortField) || null,
        text(b.reporter_name, config.intake.maxShortField) || null,
        text(b.reporter_code, config.intake.maxShortField) || null,
        text(b.reporter_contact, config.intake.maxShortField) || null,
        photoPath,
        created,
        created,
      );
      id = Number(info.lastInsertRowid);
      db.exec('COMMIT');
    } catch (err) {
      // Guard ROLLBACK: on some errors (e.g. SQLITE_FULL) SQLite has already
      // auto-rolled-back, so a bare ROLLBACK would throw and MASK the real
      // cause. Preserve the original error.
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  } catch (err) {
    // Never leave an orphaned photo behind if the record could not be written.
    if (req.file) fs.unlink(req.file.path, () => { invalidateStorageCache(); });
    console.error('[incidents] create failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not save the report. Please try again or call the safety officer.' });
  }

  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  audit(req, {
    entity: 'incident', entityId: id, incidentId: id, action: 'create',
    detail: `${unit} · ${type} · ${severity}`,
  });

  // Durable outbox + bounded queue: the response must feel instant, and an
  // alert must survive a transient WhatsApp/SMTP outage.
  queueIncidentAlerts(incident);

  res.status(201).json({ ok: true, id, ref_no: refNo, warnings });
  });

// ---------- LIST incidents (with filters + pagination) ----------
router.get('/', requireAuth, (req, res) => {
  const unit = scalar(req.query.unit);
  const severity = scalar(req.query.severity);
  const status = scalar(req.query.status);
  const type = scalar(req.query.type);
  const from = scalar(req.query.from);
  const to = scalar(req.query.to);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  const where = [NOT_VOID];
  const params = [];
  if (unit) {
    if (!UNITS.includes(unit)) return res.status(400).json({ ok: false, error: 'Invalid unit' });
    where.push('unit = ?'); params.push(unit);
  }
  if (severity) {
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ ok: false, error: 'Invalid severity' });
    where.push('severity = ?'); params.push(severity);
  }
  if (status) {
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
    where.push('status = ?'); params.push(status);
  }
  if (type) {
    if (!INCIDENT_TYPES.includes(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
    where.push('type = ?'); params.push(type);
  }
  if (from) {
    if (!dateRe.test(from)) return res.status(400).json({ ok: false, error: 'Invalid from date' });
    where.push(`${DATE_EXPR} >= ?`); params.push(from);
  }
  if (to) {
    if (!dateRe.test(to)) return res.status(400).json({ ok: false, error: 'Invalid to date' });
    where.push(`${DATE_EXPR} <= ?`); params.push(to);
  }

  // Pagination so incidents beyond the first page are reachable rather than
  // silently dropped once the archive grows.
  const limit = Math.min(Math.max(parseInt(scalar(req.query.limit), 10) || 100, 1), 200);
  const page = Math.max(parseInt(scalar(req.query.page), 10) || 1, 1);
  const offset = (page - 1) * limit;

  const whereSql = 'WHERE ' + where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM incidents ${whereSql}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM incidents ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const role = req.session?.user?.role;
  res.json({
    ok: true,
    incidents: rows.map((r) => redactForRole(r, role)),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

// ---------- GET one incident + investigation + CAPA + history ----------
router.get('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!incident) return res.status(404).json({ ok: false, error: 'Not found' });
  const investigation = db.prepare('SELECT * FROM investigations WHERE incident_id = ?').get(id) || null;
  const capa = db.prepare('SELECT * FROM capa WHERE incident_id = ? ORDER BY id').all(id);
  const role = req.session?.user?.role;
  res.json({
    ok: true,
    incident: redactForRole(incident, role),
    investigation, // RCA is safety content (not PII) — visible to all roles
    capa,
    // Repeat-incident signal: prior similar (same unit+type) events in the window.
    recurrence: { count: priorSimilarCount(incident), windowDays: RECUR_WINDOW_DAYS },
    history: redactHistoryForRole(incidentHistory(id), role),
  });
});

// ---------- EDIT the incident record (correction, role-gated + audited) ----------
router.patch('/:id', canEdit, express.json({ limit: '64kb' }), (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ ok: false, error: 'Not found' });
  if (before.voided_at) return res.status(409).json({ ok: false, error: 'This record is voided and cannot be edited.' });

  const b = req.body || {};
  const next = {
    unit: b.unit !== undefined ? scalar(b.unit) : before.unit,
    type: b.type !== undefined ? scalar(b.type) : before.type,
    severity: b.severity !== undefined ? scalar(b.severity) : before.severity,
    location: b.location !== undefined ? text(b.location, config.intake.maxShortField) : before.location,
    description: b.description !== undefined ? text(b.description, config.intake.maxDescription) : before.description,
    injured_person: b.injured_person !== undefined ? text(b.injured_person, config.intake.maxShortField) : before.injured_person,
    occurred_at: before.occurred_at,
  };
  if (!UNITS.includes(next.unit)) return res.status(400).json({ ok: false, error: 'Invalid unit' });
  if (!INCIDENT_TYPES.includes(next.type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
  if (!SEVERITIES.includes(next.severity)) return res.status(400).json({ ok: false, error: 'Invalid severity' });
  if (!next.description) return res.status(400).json({ ok: false, error: 'Description cannot be empty' });
  if (b.occurred_at !== undefined) {
    const parsed = parseLocalToUtcIso(scalar(b.occurred_at));
    if (!parsed || !isSaneIncidentTime(parsed)) return res.status(400).json({ ok: false, error: 'Invalid incident date/time' });
    next.occurred_at = clampToNow(parsed);
  }
  if (!b.reason || !String(b.reason).trim()) {
    return res.status(400).json({ ok: false, error: 'A reason for the correction is required.' });
  }

  db.prepare(`
    UPDATE incidents SET unit=?, type=?, severity=?, location=?, description=?,
      injured_person=?, occurred_at=?, updated_at=? WHERE id=?
  `).run(next.unit, next.type, next.severity, next.location || null, next.description,
    next.injured_person || null, next.occurred_at, nowIso(), id);

  const after = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  audit(req, {
    entity: 'incident', entityId: id, incidentId: id, action: 'update',
    changes: diffFields(before, after, ['unit', 'type', 'severity', 'location', 'description', 'injured_person', 'occurred_at']),
    detail: String(b.reason).slice(0, 500),
  });
  res.json({ ok: true });
});

// ---------- VOID an incident (soft delete — evidence is never destroyed) ----------
router.post('/:id/void', requireRole('admin'), express.json({ limit: '16kb' }), (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ ok: false, error: 'Not found' });
  if (before.voided_at) return res.json({ ok: true, alreadyVoided: true });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ ok: false, error: 'A reason is required to void a record.' });

  db.prepare('UPDATE incidents SET voided_at=?, voided_by=?, void_reason=?, updated_at=? WHERE id=?')
    .run(nowIso(), req.session.user.username, reason.slice(0, 500), nowIso(), id);
  audit(req, { entity: 'incident', entityId: id, incidentId: id, action: 'void', detail: reason.slice(0, 500) });
  res.json({ ok: true });
});

// ---------- RESTORE a voided incident ----------
router.post('/:id/restore', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, voided_at FROM incidents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  if (!row.voided_at) return res.json({ ok: true, notVoided: true });
  db.prepare('UPDATE incidents SET voided_at=NULL, voided_by=NULL, void_reason=NULL, updated_at=? WHERE id=?')
    .run(nowIso(), id);
  audit(req, { entity: 'incident', entityId: id, incidentId: id, action: 'restore' });
  res.json({ ok: true });
});

// ---------- SAVE / UPDATE investigation (detailed report) ----------
router.post('/:id/investigation', canEdit, express.json({ limit: '256kb' }), (req, res) => {
  const id = Number(req.params.id);
  const incident = db.prepare('SELECT id, status, voided_at FROM incidents WHERE id = ?').get(id);
  if (!incident) return res.status(404).json({ ok: false, error: 'Not found' });
  if (incident.voided_at) return res.status(409).json({ ok: false, error: 'This record is voided.' });

  const b = req.body || {};
  const now = nowIso();
  const fields = {
    what_happened: text(b.what_happened, config.intake.maxDescription) || null,
    how_happened: text(b.how_happened, config.intake.maxDescription) || null,
    root_cause: text(b.root_cause, config.intake.maxDescription) || null,
    immediate_actions: text(b.immediate_actions, config.intake.maxDescription) || null,
  };
  // Accountability: the investigator and the timestamp come from the SESSION and
  // the server clock — never from client input, which could name anyone.
  const investigatedBy = req.session.user.username;

  const before = db.prepare('SELECT * FROM investigations WHERE incident_id = ?').get(id);
  if (before) {
    db.prepare(`
      UPDATE investigations SET what_happened=?, how_happened=?, root_cause=?,
        immediate_actions=?, investigated_by=?, investigated_at=COALESCE(investigated_at, ?), updated_at=?
      WHERE incident_id=?
    `).run(fields.what_happened, fields.how_happened, fields.root_cause,
      fields.immediate_actions, investigatedBy, now, now, id);
  } else {
    db.prepare(`
      INSERT INTO investigations
        (incident_id, what_happened, how_happened, root_cause, immediate_actions,
         investigated_by, investigated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fields.what_happened, fields.how_happened, fields.root_cause,
      fields.immediate_actions, investigatedBy, now, now);
  }

  // Filing an investigation moves an Open incident to "Under Investigation".
  const moved = db.prepare(`UPDATE incidents SET status='Under Investigation', updated_at=? WHERE id=? AND status='Open'`)
    .run(now, id).changes > 0;
  touchIncident(id);

  const after = db.prepare('SELECT * FROM investigations WHERE incident_id = ?').get(id);
  audit(req, {
    entity: 'investigation', entityId: after?.id ?? null, incidentId: id,
    action: before ? 'update' : 'create',
    // Include investigated_by so a re-assignment of the named investigator is
    // itself on the record.
    changes: diffFields(before, after, ['what_happened', 'how_happened', 'root_cause', 'immediate_actions', 'investigated_by']),
    detail: moved ? 'status -> Under Investigation' : null,
  });
  res.json({ ok: true });
});

// ---------- ADD a CAPA action ----------
router.post('/:id/capa', canEdit, express.json({ limit: '64kb' }), (req, res) => {
  const id = Number(req.params.id);
  const incident = db.prepare('SELECT id, voided_at FROM incidents WHERE id = ?').get(id);
  if (!incident) return res.status(404).json({ ok: false, error: 'Not found' });
  if (incident.voided_at) return res.status(409).json({ ok: false, error: 'This record is voided.' });
  const b = req.body || {};
  const action = text(b.action, config.intake.maxDescription);
  if (!action) return res.status(400).json({ ok: false, error: 'Action text required' });
  const kind = ['Corrective', 'Preventive'].includes(b.kind) ? b.kind : 'Corrective';
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(scalar(b.due_date)) ? scalar(b.due_date) : null;
  const info = db.prepare(`
    INSERT INTO capa (incident_id, action, kind, owner, due_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'Open', ?)
  `).run(id, action, kind, text(b.owner, config.intake.maxShortField) || null, dueDate, nowIso());
  touchIncident(id);
  audit(req, {
    entity: 'capa', entityId: Number(info.lastInsertRowid), incidentId: id, action: 'create',
    detail: `${kind}: ${action.slice(0, 200)}`,
  });
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

// ---------- UPDATE a CAPA (status / fields) ----------
router.patch('/capa/:capaId', canEdit, express.json({ limit: '64kb' }), (req, res) => {
  const capaId = Number(req.params.capaId);
  const before = db.prepare('SELECT * FROM capa WHERE id = ?').get(capaId);
  if (!before) return res.status(404).json({ ok: false, error: 'Not found' });
  const b = req.body || {};
  const status = ['Open', 'In Progress', 'Done'].includes(b.status) ? b.status : before.status;
  const kind = ['Corrective', 'Preventive'].includes(b.kind) ? b.kind : before.kind;
  // Never let a required action be blanked; ignore empty/whitespace.
  const action = (typeof b.action === 'string' && b.action.trim())
    ? text(b.action, config.intake.maxDescription) : before.action;
  const owner = b.owner !== undefined ? (text(b.owner, config.intake.maxShortField) || null) : before.owner;
  const dueDate = b.due_date !== undefined
    ? (/^\d{4}-\d{2}-\d{2}$/.test(scalar(b.due_date)) ? scalar(b.due_date) : null)
    : before.due_date;

  db.prepare('UPDATE capa SET action=?, kind=?, owner=?, due_date=?, status=? WHERE id=?')
    .run(action, kind, owner, dueDate, status, capaId);
  touchIncident(before.incident_id);

  const after = db.prepare('SELECT * FROM capa WHERE id = ?').get(capaId);
  audit(req, {
    entity: 'capa', entityId: capaId, incidentId: before.incident_id, action: 'update',
    changes: diffFields(before, after, ['action', 'kind', 'owner', 'due_date', 'status']),
  });
  res.json({ ok: true });
});

// ---------- VERIFY a CAPA's effectiveness (close-out with proof) ----------
// A completed action must be checked (weeks later) to confirm it actually
// removed the risk. This is the gate the incident's closure depends on.
const EFFECTIVENESS = ['Effective', 'Not Effective', 'Recurred'];
router.post('/capa/:capaId/verify', canEdit, express.json({ limit: '16kb' }), (req, res) => {
  const capaId = Number(req.params.capaId);
  const before = db.prepare('SELECT * FROM capa WHERE id = ?').get(capaId);
  if (!before) return res.status(404).json({ ok: false, error: 'Not found' });
  if (before.status !== 'Done') {
    return res.status(409).json({ ok: false, error: 'Mark the action Done before verifying its effectiveness.' });
  }
  const b = req.body || {};
  if (!EFFECTIVENESS.includes(b.effectiveness)) return res.status(400).json({ ok: false, error: 'Invalid effectiveness value' });
  const verifyNote = text(b.note, config.intake.maxShortField) || null;
  db.prepare('UPDATE capa SET effectiveness=?, verify_note=?, verified_by=?, verified_at=? WHERE id=?')
    .run(b.effectiveness, verifyNote, req.session.user.username, nowIso(), capaId);
  touchIncident(before.incident_id);
  const after = db.prepare('SELECT * FROM capa WHERE id = ?').get(capaId);
  audit(req, {
    entity: 'capa', entityId: capaId, incidentId: before.incident_id, action: 'update',
    changes: diffFields(before, after, ['effectiveness', 'verify_note', 'verified_by']),
    detail: `effectiveness verified: ${b.effectiveness}`,
  });
  res.json({ ok: true });
});

// ---------- UPDATE incident status ----------
router.patch('/:id/status', canEdit, express.json({ limit: '16kb' }), (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (!STATUSES.includes(b.status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
  const before = db.prepare('SELECT id, status, voided_at FROM incidents WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ ok: false, error: 'Not found' });
  if (before.voided_at) return res.status(409).json({ ok: false, error: 'This record is voided.' });
  if (before.status === b.status) return res.json({ ok: true, unchanged: true });

  // Closure gate: an incident can only close once its corrective/preventive
  // actions are actually Done AND each Done action has been verified effective.
  // This is what turns "actions created" into "risk actually reduced".
  if (b.status === 'Closed') {
    const rows = db.prepare('SELECT status, effectiveness FROM capa WHERE incident_id = ?').all(id);
    const openActions = rows.filter((r) => r.status !== 'Done').length;
    const unverified = rows.filter((r) => r.status === 'Done' && !r.effectiveness).length;
    const ineffective = rows.filter((r) => r.status === 'Done' && (r.effectiveness === 'Not Effective' || r.effectiveness === 'Recurred')).length;
    if (openActions) return res.status(409).json({ ok: false, error: `Cannot close: ${openActions} action(s) are not yet marked Done.` });
    if (unverified) return res.status(409).json({ ok: false, error: `Cannot close: ${unverified} completed action(s) are awaiting effectiveness verification.` });
    if (ineffective) return res.status(409).json({ ok: false, error: `Cannot close: ${ineffective} action(s) were Not Effective / Recurred — add a new corrective action instead of closing.` });
  }

  db.prepare('UPDATE incidents SET status=?, updated_at=? WHERE id=?').run(b.status, nowIso(), id);
  audit(req, {
    entity: 'incident', entityId: id, incidentId: id, action: 'status',
    changes: { status: { from: before.status, to: b.status } },
  });
  res.json({ ok: true });
});

export default router;
