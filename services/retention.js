// Data retention & cleanup.
//
// Without this the notification log, the alert outbox and the photo directory
// grow forever — eventually filling the disk the database lives on. Incident
// records themselves are safety/compliance evidence and are kept by default
// (RETENTION_INCIDENT_DAYS=0); only logs and orphaned files are pruned.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { uploadDir } from '../utils/paths.js';
import { invalidateStorageCache } from './storage.js';

function cutoffIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** Prune old notification log rows and settled outbox entries. */
function pruneLogs() {
  const out = { notifications: 0, alertQueue: 0 };
  const days = config.retention.notificationLogDays;
  if (days > 0) {
    const cutoff = cutoffIso(days);
    out.notifications = db.prepare('DELETE FROM notifications_log WHERE created_at < ?').run(cutoff).changes;
    // Settled outbox rows only — pending/failed alerts are never dropped.
    out.alertQueue = db.prepare(
      "DELETE FROM alert_queue WHERE status IN ('sent','skipped') AND updated_at < ?"
    ).run(cutoff).changes;
  }
  return out;
}

/**
 * Delete photo files no longer referenced by any incident (e.g. left behind by
 * a crash, or whose incident was purged). Files newer than 1h are left alone so
 * an in-flight upload is never removed.
 */
function pruneOrphanPhotos() {
  let removed = 0;
  let files;
  try { files = fs.readdirSync(uploadDir); } catch { return 0; }
  const referenced = new Set(
    db.prepare("SELECT photo_path FROM incidents WHERE photo_path IS NOT NULL").all()
      .map((r) => path.basename(r.photo_path))
  );
  const minAge = Date.now() - 3600000;
  // ONLY touch files that match the exact name multer generates
  // (`<ts>-<rand>.<ext>`). Anything an operator dropped in the dir is left alone.
  const MULTER_NAME = /^\d+-\d+\.(?:jpg|png|gif|webp)$/;
  for (const f of files) {
    if (!MULTER_NAME.test(f)) continue;
    if (referenced.has(f)) continue;
    const full = path.join(uploadDir, f);
    try {
      if (fs.statSync(full).mtimeMs > minAge) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch { /* ignore */ }
  }
  if (removed) invalidateStorageCache();
  return removed;
}

/** Purge incidents past the retention window (only when explicitly enabled). */
function pruneIncidents() {
  const days = config.retention.incidentDays;
  if (!days || days <= 0) return 0;
  const cutoff = cutoffIso(days);
  // Key the purge on RECORD AGE (created_at), not the event date — a back-dated
  // report filed yesterday must not be deleted because it happened years ago.
  // Also never delete an incident whose alert hasn't been fully settled.
  // Protect any incident whose alert is not fully settled — a 'failed'
  // (undelivered, awaiting manual retry) alert is evidence too, not just
  // 'pending'. Deleting would CASCADE away that evidence.
  return db.prepare(`
    DELETE FROM incidents
    WHERE created_at < ?
      AND id NOT IN (SELECT incident_id FROM alert_queue WHERE status IN ('pending','failed'))
  `).run(cutoff).changes;
}

/**
 * Age out old photo FILES (keeping the incident record + audit trail), so the
 * storage cap is self-healing rather than a permanent wall reached by normal
 * use. The record keeps a marker that a photo once existed.
 */
function prunePhotos() {
  const days = config.retention.photoDays;
  if (!days || days <= 0) return 0;
  const cutoff = cutoffIso(days);
  const rows = db.prepare(
    "SELECT id, photo_path FROM incidents WHERE photo_path IS NOT NULL AND photo_path NOT LIKE '(%' AND created_at < ?"
  ).all(cutoff);
  let removed = 0;
  for (const r of rows) {
    try { fs.unlinkSync(path.join(uploadDir, path.basename(r.photo_path))); } catch { /* file may already be gone */ }
    db.prepare("UPDATE incidents SET photo_path='(photo removed by retention)' WHERE id=?").run(r.id);
    removed += 1;
  }
  if (removed) invalidateStorageCache();
  return removed;
}

export function runRetention({ verbose = false } = {}) {
  const result = { ...pruneLogs(), orphanPhotos: 0, photosAged: 0, incidents: 0 };
  result.orphanPhotos = pruneOrphanPhotos();
  result.photosAged = prunePhotos();
  result.incidents = pruneIncidents();
  if (verbose || result.notifications || result.orphanPhotos || result.photosAged || result.incidents) {
    console.log('[retention]', JSON.stringify(result));
  }
  return result;
}

let retentionTimer = null;
let retentionInitial = null;
export function startRetentionWorker() {
  retentionTimer = setInterval(() => {
    try { runRetention(); } catch (err) { console.error('[retention] failed:', err.message); }
  }, config.retention.sweepMs);
  retentionTimer.unref?.();
  // Run once shortly after boot rather than during startup.
  retentionInitial = setTimeout(() => {
    try { runRetention(); } catch { /* ignore */ }
  }, 30000);
  retentionInitial.unref?.();
  return retentionTimer;
}

export function stopRetentionWorker() {
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
  if (retentionInitial) { clearTimeout(retentionInitial); retentionInitial = null; }
}
