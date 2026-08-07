import express from 'express';
import { db } from '../db.js';
import { UNITS } from '../config.js';
import { pktDate, PKT_SQL_SHIFT, PKT_OFFSET_MS } from '../utils/time.js';

const router = express.Router();

// Voided records are corrections/duplicates and must not skew any statistic.
const NOT_VOID = 'voided_at IS NULL';
// The event's own time is the reporting reference, not when it was filed.
const EVENT_TIME = 'COALESCE(occurred_at, created_at)';

/** Resolve a range key to UTC ISO bounds + the previous equal-length window. */
function rangeBounds(range) {
  const now = Date.now();
  if (range === '30d') {
    return {
      key: '30d', label: 'Last 30 days',
      start: new Date(now - 30 * 86400000).toISOString(),
      prevStart: new Date(now - 60 * 86400000).toISOString(),
      prevEnd: new Date(now - 30 * 86400000).toISOString(),
    };
  }
  if (range === 'ytd') {
    const pk = new Date(now + PKT_OFFSET_MS);
    const yearStart = Date.UTC(pk.getUTCFullYear(), 0, 1) - PKT_OFFSET_MS; // Jan 1, 00:00 PKT
    const windowLen = now - yearStart;
    return {
      key: 'ytd', label: 'This year',
      start: new Date(yearStart).toISOString(),
      prevStart: new Date(yearStart - windowLen).toISOString(),
      prevEnd: new Date(yearStart).toISOString(),
    };
  }
  return { key: 'all', label: 'All time', start: null, prevStart: null, prevEnd: null };
}

router.get('/stats', (req, res) => {
  const rb = rangeBounds(String(req.query.range || 'all'));
  const rangeWhere = rb.start ? ` AND ${EVENT_TIME} >= ?` : '';
  const rangeArgs = rb.start ? [rb.start] : [];

  const countBy = (col) => db.prepare(
    `SELECT ${col} AS key, COUNT(*) AS n FROM incidents WHERE ${NOT_VOID}${rangeWhere} GROUP BY ${col} ORDER BY n DESC`
  ).all(...rangeArgs);

  // ---- period volume + delta vs previous equal window ----
  const total = db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ${NOT_VOID}${rangeWhere}`).get(...rangeArgs).n;
  let prevTotal = null;
  let deltaPct = null;
  if (rb.prevStart) {
    prevTotal = db.prepare(
      `SELECT COUNT(*) AS n FROM incidents WHERE ${NOT_VOID} AND ${EVENT_TIME} >= ? AND ${EVENT_TIME} < ?`
    ).get(rb.prevStart, rb.prevEnd).n;
    if (prevTotal > 0) deltaPct = Math.round(((total - prevTotal) / prevTotal) * 100);
  }

  const bySeverity = countBy('severity');
  const byUnit = countBy('unit');
  const byType = countBy('type');

  // Near-miss share — a LEADING indicator: lots of near-miss reporting is healthy.
  const nearMiss = (byType.find((t) => t.key === 'Near-miss') || {}).n || 0;
  const nearMissShare = { nearMiss, total, pct: total ? Math.round((nearMiss / total) * 100) : 0 };

  // ---- current status (not range-dependent) ----
  const byStatus = Object.fromEntries(
    db.prepare(`SELECT status, COUNT(*) AS n FROM incidents WHERE ${NOT_VOID} GROUP BY status`).all().map((r) => [r.status, r.n])
  );
  const openNow = (byStatus.Open || 0) + (byStatus['Under Investigation'] || 0);

  const capaTotal = db.prepare(`SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id=c.incident_id WHERE i.${NOT_VOID}`).get().n;
  const capaOpen = db.prepare(`SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id=c.incident_id WHERE i.${NOT_VOID} AND c.status!='Done'`).get().n;
  const todayPkt = pktDate();
  const capaOverdue = db.prepare(
    `SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id=c.incident_id WHERE i.${NOT_VOID} AND c.status!='Done' AND c.due_date IS NOT NULL AND c.due_date < ?`
  ).get(todayPkt).n;
  // Effectiveness verification: Done actions not yet checked, and ones that failed.
  const capaAwaitingVerify = db.prepare(
    `SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id=c.incident_id WHERE i.${NOT_VOID} AND c.status='Done' AND (c.effectiveness IS NULL OR c.effectiveness='')`
  ).get().n;
  const capaNotEffective = db.prepare(
    `SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id=c.incident_id WHERE i.${NOT_VOID} AND c.effectiveness IN ('Not Effective','Recurred')`
  ).get().n;

  // ---- 12-month trend (always; PKT months, zero-filled) ----
  const monthRows = db.prepare(
    `SELECT strftime('%Y-%m', datetime(${EVENT_TIME}, '${PKT_SQL_SHIFT}')) AS month, COUNT(*) AS n FROM incidents WHERE ${NOT_VOID} GROUP BY month`
  ).all();
  const monthMap = Object.fromEntries(monthRows.map((r) => [r.month, r.n]));
  const nowPkt = new Date(Date.now() + PKT_OFFSET_MS);
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(nowPkt.getUTCFullYear(), nowPkt.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    monthly.push({ month: key, n: monthMap[key] || 0 });
  }

  // ---- days since last (current) ----
  const daysSince = (iso) => {
    if (!iso) return null;
    const t = Math.min(Date.parse(iso), Date.now());
    return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000));
  };
  const lastOverall = db.prepare(`SELECT MAX(${EVENT_TIME}) AS last FROM incidents WHERE ${NOT_VOID}`).get().last;

  // ---- unit scorecard (count in range; streak + open current) ----
  const unitAgg = Object.fromEntries(byUnit.map((r) => [r.key, r.n]));
  const unitLast = Object.fromEntries(
    db.prepare(`SELECT unit, MAX(${EVENT_TIME}) AS last FROM incidents WHERE ${NOT_VOID} GROUP BY unit`).all().map((r) => [r.unit, r.last])
  );
  const unitOpen = Object.fromEntries(
    db.prepare(`SELECT unit, COUNT(*) AS n FROM incidents WHERE ${NOT_VOID} AND status!='Closed' GROUP BY unit`).all().map((r) => [r.unit, r.n])
  );
  const units = UNITS.map((u) => ({
    unit: u,
    count: unitAgg[u] || 0,
    open: unitOpen[u] || 0,
    daysSinceLast: unitLast[u] ? daysSince(unitLast[u]) : null,
  }));

  // ---- FOLLOW-THROUGH (the heart): are reported incidents being acted on? ----
  // For incidents in the selected range: how far did each progress?
  const stage = (extra) => db.prepare(
    `SELECT COUNT(*) AS n FROM incidents i WHERE i.${NOT_VOID}${rb.start ? ` AND ${EVENT_TIME} >= ?` : ''} AND ${extra}`
  ).get(...rangeArgs).n;
  const followup = {
    reported: total,
    investigated: stage('EXISTS (SELECT 1 FROM investigations v WHERE v.incident_id = i.id)'),
    withActions: stage('EXISTS (SELECT 1 FROM capa c WHERE c.incident_id = i.id)'),
    closed: stage("i.status = 'Closed'"),
  };

  // ---- "Needs attention": reported but NOT acted on (no action taken / reason unclear) ----
  // Any non-closed incident that either has no investigation yet, or has been
  // open too long. Ordered oldest-first (most neglected on top).
  const STALE_DAYS = 7;
  const openRows = db.prepare(`
    SELECT i.id, i.ref_no, i.unit, i.severity, i.status, ${EVENT_TIME} AS at,
      (SELECT 1 FROM investigations v WHERE v.incident_id = i.id) AS investigated,
      (SELECT COUNT(*) FROM capa c WHERE c.incident_id = i.id AND c.status != 'Done') AS openActions
    FROM incidents i WHERE i.${NOT_VOID} AND i.status != 'Closed'
    ORDER BY at ASC
  `).all();
  const needsAttention = [];
  for (const r of openRows) {
    const ageDays = daysSince(r.at) ?? 0;
    let reason = null;
    if (!r.investigated) reason = 'No investigation started';
    else if (r.openActions > 0 && ageDays >= STALE_DAYS) reason = `${r.openActions} action(s) pending · open ${ageDays}d`;
    else if (ageDays >= STALE_DAYS) reason = `Open ${ageDays} days, not closed`;
    if (reason) needsAttention.push({ id: r.id, ref_no: r.ref_no, unit: r.unit, severity: r.severity, status: r.status, ageDays, reason });
    if (needsAttention.length >= 8) break;
  }

  // ---- actionable lists ----
  const recent = db.prepare(`
    SELECT i.id, i.ref_no, i.unit, i.type, i.severity, i.status, ${EVENT_TIME} AS at,
      (SELECT 1 FROM investigations v WHERE v.incident_id = i.id) AS investigated,
      (SELECT COUNT(*) FROM capa c WHERE c.incident_id = i.id) AS capaCount
    FROM incidents i WHERE i.${NOT_VOID} ORDER BY i.id DESC LIMIT 6
  `).all();

  const overdueCapa = db.prepare(`
    SELECT c.id, c.incident_id, c.action, c.owner, c.due_date, i.ref_no, i.unit
    FROM capa c JOIN incidents i ON i.id=c.incident_id
    WHERE i.${NOT_VOID} AND c.status!='Done' AND c.due_date IS NOT NULL AND c.due_date < ?
    ORDER BY c.due_date ASC LIMIT 6
  `).all(todayPkt).map((r) => ({
    ...r,
    daysOverdue: Math.max(0, Math.floor((Date.now() - Date.parse(r.due_date + 'T00:00:00Z')) / 86400000)),
  }));

  // ---- recurring hotspots: same unit+type happening again in a rolling window ----
  // A cluster (>=2 of the same type at the same unit) is the strongest sign a
  // control is missing or ineffective — surface the worst ones for action.
  const HOTSPOT_DAYS = 90;
  const hotspotSince = new Date(Date.now() - HOTSPOT_DAYS * 86400000).toISOString();
  const hotspots = db.prepare(`
    SELECT unit, type, COUNT(*) AS n, MAX(${EVENT_TIME}) AS last
    FROM incidents WHERE ${NOT_VOID} AND ${EVENT_TIME} >= ?
    GROUP BY unit, type HAVING n >= 2
    ORDER BY n DESC, last DESC LIMIT 6
  `).all(hotspotSince).map((r) => ({ ...r, daysSinceLast: daysSince(r.last), windowDays: HOTSPOT_DAYS }));

  res.json({
    ok: true,
    range: { key: rb.key, label: rb.label },
    period: { total, prevTotal, deltaPct },
    bySeverity, byUnit, byType,
    nearMissShare,
    byStatus, openNow,
    capa: { total: capaTotal, open: capaOpen, done: capaTotal - capaOpen, overdue: capaOverdue, awaitingVerification: capaAwaitingVerify, notEffective: capaNotEffective },
    monthly,
    daysSinceLastOverall: daysSince(lastOverall),
    units,
    followup,
    needsAttention,
    recent,
    overdueCapa,
    hotspots,
    todayPkt,
  });
});

export default router;
