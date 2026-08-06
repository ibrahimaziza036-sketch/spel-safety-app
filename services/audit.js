// Append-only audit trail. Every change to a safety record records WHO did it,
// WHEN (server clock — never client-supplied), and WHAT changed.
import { db } from '../db.js';
import { nowIso } from '../utils/time.js';

const insert = db.prepare(`
  INSERT INTO audit_log (entity, entity_id, incident_id, action, actor_id, actor_name, changes, detail, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Actor description for a request — falls back to the anonymous QR reporter. */
export function actorOf(req) {
  const u = req?.session?.user;
  if (u) return { id: u.id, name: u.username };
  return { id: null, name: 'public (QR report)' };
}

/**
 * Record an audit entry. Never throws — a logging failure must not roll back or
 * block the operation being recorded, but it is surfaced on the console.
 */
export function audit(req, { entity, entityId = null, incidentId = null, action, changes = null, detail = null, actorName = null }) {
  try {
    const actor = actorOf(req);
    // Allow an explicit label (e.g. 'anonymous' for a failed login, which is not
    // a QR reporter).
    if (actorName && !actor.id) actor.name = actorName;
    insert.run(
      entity,
      entityId,
      incidentId,
      action,
      actor.id,
      actor.name,
      changes ? JSON.stringify(changes) : null,
      detail,
      req?.clientIp || req?.ip || null,
      nowIso(),
    );
  } catch (err) {
    console.error('[audit] failed to record entry:', err.message);
  }
}

/**
 * Build a { field: { from, to } } diff for the fields that actually changed.
 * Used so the trail stores real deltas rather than whole-record snapshots.
 */
export function diffFields(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    const b = before?.[f] ?? null;
    const a = after?.[f] ?? null;
    if (String(b ?? '') !== String(a ?? '')) changes[f] = { from: b, to: a };
  }
  return Object.keys(changes).length ? changes : null;
}

/** Full history for one incident (newest first). */
export function incidentHistory(incidentId) {
  return db.prepare(
    `SELECT id, entity, action, actor_name, changes, detail, created_at
     FROM audit_log WHERE incident_id = ? ORDER BY id DESC`
  ).all(incidentId);
}

/** Recent audit entries across the system, for the admin viewer. */
export function recentAudit(limit = 200) {
  return db.prepare(
    `SELECT a.*, i.ref_no FROM audit_log a
     LEFT JOIN incidents i ON i.id = a.incident_id
     ORDER BY a.id DESC LIMIT ?`
  ).all(limit);
}
