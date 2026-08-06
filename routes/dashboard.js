import express from 'express';
import { db } from '../db.js';
import { UNITS } from '../config.js';
import { pktDate, PKT_SQL_SHIFT, PKT_OFFSET_MS } from '../utils/time.js';

const router = express.Router();

// Voided records are corrections/duplicates and must not skew any statistic.
const NOT_VOID = 'voided_at IS NULL';
// The event's own time is the reporting reference, not when it was filed.
const EVENT_TIME = 'COALESCE(occurred_at, created_at)';

function countBy(column) {
  return db.prepare(
    `SELECT ${column} AS key, COUNT(*) AS n FROM incidents WHERE ${NOT_VOID} GROUP BY ${column} ORDER BY n DESC`
  ).all();
}

router.get('/stats', (req, res) => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ${NOT_VOID}`).get().n;

  const byStatus = Object.fromEntries(countBy('status').map((r) => [r.key, r.n]));
  const byUnit = countBy('unit');
  const byType = countBy('type');
  const bySeverity = countBy('severity');

  // Last 12 calendar months trend, in PKT (UTC+5), with zero-incident months
  // included so a quiet month reads as 0 instead of vanishing from the chart.
  const monthRows = db.prepare(`
    SELECT strftime('%Y-%m', datetime(${EVENT_TIME}, '${PKT_SQL_SHIFT}')) AS month, COUNT(*) AS n
    FROM incidents WHERE ${NOT_VOID} GROUP BY month
  `).all();
  const monthMap = Object.fromEntries(monthRows.map((r) => [r.month, r.n]));
  const nowPkt = new Date(Date.now() + PKT_OFFSET_MS);
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(nowPkt.getUTCFullYear(), nowPkt.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    monthly.push({ month: key, n: monthMap[key] || 0 });
  }

  // CAPA health. "Overdue" is judged against today's PKT date so the count does
  // not flip during the early-morning hours in Pakistan.
  const capaTotal = db.prepare(`
    SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id = c.incident_id WHERE i.${NOT_VOID}
  `).get().n;
  const capaOpen = db.prepare(`
    SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id = c.incident_id
    WHERE i.${NOT_VOID} AND c.status != 'Done'
  `).get().n;
  const capaDone = capaTotal - capaOpen;
  const todayPkt = pktDate();
  const capaOverdue = db.prepare(`
    SELECT COUNT(*) AS n FROM capa c JOIN incidents i ON i.id = c.incident_id
    WHERE i.${NOT_VOID} AND c.status != 'Done' AND c.due_date IS NOT NULL AND c.due_date < ?
  `).get(todayPkt).n;

  // Days since last incident (overall + per unit), based on when the incident
  // actually occurred. A future-dated value is clamped to now so the counter
  // cannot be forced to 0 by a bad date.
  const lastOverall = db.prepare(
    `SELECT MAX(${EVENT_TIME}) AS last FROM incidents WHERE ${NOT_VOID}`
  ).get().last;
  const daysSince = (iso) => {
    if (!iso) return null;
    const t = Math.min(Date.parse(iso), Date.now());
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  };
  const perUnitLast = db.prepare(
    `SELECT unit, MAX(${EVENT_TIME}) AS last, COUNT(*) AS n FROM incidents WHERE ${NOT_VOID} GROUP BY unit`
  ).all();
  const unitMap = Object.fromEntries(perUnitLast.map((r) => [r.unit, r]));
  const units = UNITS.map((u) => ({
    unit: u,
    count: unitMap[u]?.n || 0,
    daysSinceLast: unitMap[u] ? daysSince(unitMap[u].last) : null,
  }));

  res.json({
    ok: true,
    total,
    byStatus,
    byUnit,
    byType,
    bySeverity,
    monthly,
    capa: { total: capaTotal, open: capaOpen, done: capaDone, overdue: capaOverdue },
    daysSinceLastOverall: daysSince(lastOverall),
    units,
    todayPkt,
  });
});

export default router;
