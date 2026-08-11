// Daily follow-up reminders.
//
// The dashboard already shows overdue actions and un-investigated incidents, but
// the people who must act (unit/maintenance owners, safety officers) live on
// WhatsApp — not the portal. This worker PUSHES a once-a-day digest to the alert
// recipients over WhatsApp + email so nothing rots silently.
//
// Design (mirrors services/retention.js):
//  - A light timer ticks every few minutes; it only sends once per PKT day,
//    at/after the configured hour, tracked by a watermark in `settings` so a
//    restart never double-sends.
//  - If a digest is due but every channel is down, it is NOT marked sent — the
//    next tick retries, so a morning WhatsApp outage just delays (never drops)
//    the reminder.
//  - Investigation SLA is severity-scaled (Fatal/Major fast, Minor slow), which
//    matches ISO/OSHA far better than one flat "stale" threshold.
import { db } from '../db.js';
import { config } from '../config.js';
import { getJSON, setJSON, getSetting, setSetting } from './settings.js';
import { pktDate, PKT_OFFSET_MS } from '../utils/time.js';
import { sendIncidentWhatsApp } from './whatsapp.js';
import { sendAdminEmail, emailUsable } from './email.js';
import { activeValues } from './recipients.js';

const NOT_VOID = 'voided_at IS NULL';
const EVENT_TIME = 'COALESCE(occurred_at, created_at)';

const DEFAULTS = {
  // OFF by default — automated digests only go out if an admin explicitly turns
  // them on. The instant per-incident alert is separate and always on.
  enabled: false,
  hour: 8, // 08:00 PKT
  // Days an incident may stay un-investigated before it counts as past SLA.
  slaDays: { Fatal: 1, Major: 1, Serious: 3, Minor: 7 },
};

export function getReminderConfig() {
  const c = getJSON('reminder_config') || {};
  return {
    enabled: c.enabled !== undefined ? !!c.enabled : DEFAULTS.enabled,
    hour: Number.isInteger(c.hour) ? c.hour : DEFAULTS.hour,
    slaDays: { ...DEFAULTS.slaDays, ...(c.slaDays || {}) },
  };
}

export function setReminderConfig(patch = {}) {
  const cur = getReminderConfig();
  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    hour: Math.min(23, Math.max(0, Number(patch.hour ?? cur.hour) || 0)),
    slaDays: { ...cur.slaDays, ...(patch.slaDays || {}) },
  };
  // Clamp SLA days to sane positive integers.
  for (const k of Object.keys(next.slaDays)) {
    next.slaDays[k] = Math.min(365, Math.max(1, Number(next.slaDays[k]) || 1));
  }
  setJSON('reminder_config', next);
  return next;
}

const trunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const daysAgo = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000));

/** Gather everything overdue right now. */
export function buildReminderData() {
  const cfg = getReminderConfig();
  const todayPkt = pktDate();

  const overdue = db.prepare(`
    SELECT c.action, c.owner, c.due_date, i.ref_no, i.unit
    FROM capa c JOIN incidents i ON i.id = c.incident_id
    WHERE i.${NOT_VOID} AND c.status != 'Done' AND c.due_date IS NOT NULL AND c.due_date < ?
    ORDER BY c.due_date ASC LIMIT 40
  `).all(todayPkt).map((r) => ({
    ...r,
    daysOverdue: Math.max(0, Math.floor((Date.now() - Date.parse(r.due_date + 'T00:00:00Z')) / 86400000)),
  }));

  // Open incidents with NO investigation yet, past their severity SLA.
  const openUninvestigated = db.prepare(`
    SELECT i.id, i.ref_no, i.unit, i.type, i.severity, ${EVENT_TIME} AS at
    FROM incidents i
    WHERE i.${NOT_VOID} AND i.status != 'Closed'
      AND NOT EXISTS (SELECT 1 FROM investigations v WHERE v.incident_id = i.id)
    ORDER BY at ASC
  `).all();
  const overdueSla = [];
  for (const r of openUninvestigated) {
    const ageDays = daysAgo(r.at);
    const sla = cfg.slaDays[r.severity] ?? 7;
    if (ageDays >= sla) overdueSla.push({ ...r, ageDays, sla });
  }
  return { overdue, overdueSla, cfg };
}

function buildText({ overdue, overdueSla }) {
  const lines = ['📋 *SPEL SAFETY — Daily follow-up*', ''];
  if (overdueSla.length) {
    lines.push(`⏰ *${overdueSla.length} incident(s) past investigation SLA:*`);
    for (const r of overdueSla.slice(0, 15)) {
      lines.push(`• ${r.ref_no} · ${r.unit} — ${r.severity} ${r.type} (open ${r.ageDays}d, SLA ${r.sla}d)`);
    }
    if (overdueSla.length > 15) lines.push(`  …and ${overdueSla.length - 15} more`);
    lines.push('');
  }
  if (overdue.length) {
    lines.push(`🛠 *${overdue.length} overdue action(s):*`);
    for (const c of overdue.slice(0, 15)) {
      lines.push(`• ${c.ref_no} · ${c.unit} — "${trunc(c.action, 60)}" (${c.daysOverdue}d late · ${c.owner || 'no owner'})`);
    }
    if (overdue.length > 15) lines.push(`  …and ${overdue.length - 15} more`);
    lines.push('');
  }
  lines.push(`Open the dashboard: ${config.baseUrl}/`);
  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml({ overdue, overdueSla }) {
  const rows = (arr, cols) => arr.map((r) => `<tr>${cols(r)}</tr>`).join('');
  let body = '';
  if (overdueSla.length) {
    body += `<h3 style="margin:16px 0 6px;font-size:15px">⏰ ${overdueSla.length} incident(s) past investigation SLA</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="color:#6b7280;text-align:left"><th style="padding:4px 6px">Ref</th><th>Unit</th><th>Type</th><th>Severity</th><th>Open</th></tr>
        ${rows(overdueSla.slice(0, 25), (r) => `<td style="padding:4px 6px"><b>${esc(r.ref_no)}</b></td><td>${esc(r.unit)}</td><td>${esc(r.type)}</td><td>${esc(r.severity)}</td><td>${r.ageDays}d (SLA ${r.sla}d)</td>`)}
      </table>`;
  }
  if (overdue.length) {
    body += `<h3 style="margin:16px 0 6px;font-size:15px">🛠 ${overdue.length} overdue action(s)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="color:#6b7280;text-align:left"><th style="padding:4px 6px">Ref</th><th>Unit</th><th>Action</th><th>Owner</th><th>Late</th></tr>
        ${rows(overdue.slice(0, 25), (c) => `<td style="padding:4px 6px"><b>${esc(c.ref_no)}</b></td><td>${esc(c.unit)}</td><td>${esc(trunc(c.action, 80))}</td><td>${esc(c.owner || '—')}</td><td>${c.daysOverdue}d</td>`)}
      </table>`;
  }
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:680px;margin:0 auto">
    <h2 style="font-size:18px">📋 SPEL Safety — Daily follow-up</h2>
    <p style="color:#6b7280;font-size:13px">Items that need attention today. Please chase the owners.</p>
    ${body}
    <p style="margin-top:18px"><a href="${esc(config.baseUrl)}/" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open dashboard →</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:18px">Automated daily reminder from the SPEL Safety App.</p>
  </div>`;
}

/**
 * Send the digest now. Returns {attempted, delivered, ...}. `delivered` is true
 * if any channel accepted it OR there is nothing to send OR no channel exists —
 * i.e. "there is nothing more we can do for today".
 */
export async function sendReminderDigest() {
  const data = buildReminderData();
  const { overdue, overdueSla } = data;
  if (!overdue.length && !overdueSla.length) {
    return { attempted: false, delivered: true, reason: 'nothing due', counts: { overdue: 0, overdueSla: 0 } };
  }
  const text = buildText(data);
  const html = buildHtml(data);

  const waRecipients = activeValues('whatsapp');
  const waPossible = config.whatsapp.enabled && waRecipients.length > 0;
  const emailPossible = emailUsable();

  let waDelivered = false;
  let emailDelivered = false;
  if (waPossible) {
    try { const r = await sendIncidentWhatsApp({ text }); waDelivered = r.some((x) => x.status === 'sent'); }
    catch (e) { console.error('[reminders] whatsapp send failed:', e.message); }
  }
  if (emailPossible) {
    try { const r = await sendAdminEmail({ subject: '📋 SPEL Safety — daily follow-up', text, html }); emailDelivered = !!r?.ok; }
    catch (e) { console.error('[reminders] email send failed:', e.message); }
  }

  const noChannel = !waPossible && !emailPossible;
  return {
    attempted: true,
    delivered: waDelivered || emailDelivered || noChannel,
    waDelivered, emailDelivered, noChannel,
    counts: { overdue: overdue.length, overdueSla: overdueSla.length },
  };
}

const LAST_SENT_KEY = 'reminder_last_sent';

async function tick() {
  try {
    const cfg = getReminderConfig();
    if (!cfg.enabled) return;
    const hourPkt = new Date(Date.now() + PKT_OFFSET_MS).getUTCHours();
    const today = pktDate();
    if (hourPkt < cfg.hour) return;                 // too early today
    if (getSetting(LAST_SENT_KEY) === today) return; // already handled today
    const r = await sendReminderDigest();
    // Mark the day handled only once we've actually delivered (or there is
    // nothing we can do); otherwise leave it so the next tick retries.
    if (r.delivered) {
      setSetting(LAST_SENT_KEY, today);
      if (r.attempted) {
        console.log(`[reminders] daily digest sent (overdue=${r.counts.overdue}, sla=${r.counts.overdueSla}, wa=${r.waDelivered}, email=${r.emailDelivered})`);
      }
    } else {
      console.warn('[reminders] digest due but no channel delivered — will retry next tick');
    }
  } catch (err) {
    console.error('[reminders] tick failed:', err.message);
  }
}

let timer = null;
let initial = null;
export function startReminderWorker() {
  timer = setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  timer.unref?.();
  // First check shortly after boot (won't send unless it's past the hour and
  // not already sent today).
  initial = setTimeout(() => { tick().catch(() => {}); }, 25000);
  initial.unref?.();
  return timer;
}

export function stopReminderWorker() {
  if (timer) { clearInterval(timer); timer = null; }
  if (initial) { clearTimeout(initial); initial = null; }
}
