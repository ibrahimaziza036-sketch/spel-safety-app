// Alert delivery.
//
// Design:
//  - Every incident gets a DURABLE outbox row per channel (alert_queue), so an
//    alert is never lost to a transient WhatsApp/SMTP outage — it is retried.
//  - Sending runs through a BOUNDED worker pool with a per-window cap and a
//    circuit breaker, so a flood of reports cannot spam management or get the
//    WhatsApp number banned.
//  - Email and WhatsApp are dispatched in PARALLEL, so a slow SMTP server can
//    never delay the WhatsApp alert.
import path from 'node:path';
import { db } from '../db.js';
import { config, severityRank } from '../config.js';
import { nowIso, pktDateTime } from '../utils/time.js';
import { photoAbsPath } from '../utils/paths.js';
import { sendIncidentEmail, sendAdminEmail, emailUsable } from './email.js';
import { sendIncidentWhatsApp, whatsAppStatus } from './whatsapp.js';

const SEVERITY_EMOJI = { Minor: '🟡', Serious: '🟠', Major: '🔴', Fatal: '⚫' };

// Stored times are UTC — display them on the PKT wall clock in alerts.
const fmtDateTime = pktDateTime;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildText(inc, link) {
  const emoji = SEVERITY_EMOJI[inc.severity] || '⚪';
  return [
    `🚨 *SPEL SAFETY ALERT* 🚨`,
    `Ref: ${inc.ref_no}`,
    `Unit: ${inc.unit}`,
    `Type: ${inc.type}  |  Severity: ${emoji} ${inc.severity.toUpperCase()}`,
    `When: ${fmtDateTime(inc.occurred_at)}`,
    inc.location ? `Location: ${inc.location}` : null,
    ``,
    `What happened:`,
    inc.description,
    inc.injured_person ? `\nInjured: ${inc.injured_person}` : null,
    `\nReported by: ${inc.reporter_name || 'Anonymous'}${inc.reporter_code ? ' [' + inc.reporter_code + ']' : ''}${inc.reporter_contact ? ' (' + inc.reporter_contact + ')' : ''}`,
    ``,
    `Investigate: ${link}`,
  ].filter((l) => l !== null).join('\n');
}

function buildHtml(inc, link) {
  const color = { Minor: '#eab308', Serious: '#f97316', Major: '#dc2626', Fatal: '#111827' }[inc.severity] || '#6b7280';
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
    <div style="background:${color};color:#fff;padding:16px 20px">
      <div style="font-size:18px;font-weight:700">🚨 SPEL SAFETY ALERT</div>
      <div style="opacity:.9;font-size:13px">${esc(inc.ref_no)} · ${esc(inc.unit)}</div>
    </div>
    <div style="padding:20px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#6b7280;width:130px">Type</td><td style="padding:6px 0"><b>${esc(inc.type)}</b></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Severity</td><td style="padding:6px 0"><b style="color:${color}">${esc(inc.severity.toUpperCase())}</b></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">When</td><td style="padding:6px 0">${esc(fmtDateTime(inc.occurred_at))}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Location</td><td style="padding:6px 0">${esc(inc.location || '—')}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">What happened</td><td style="padding:6px 0">${esc(inc.description)}</td></tr>
        ${inc.injured_person ? `<tr><td style="padding:6px 0;color:#6b7280">Injured</td><td style="padding:6px 0">${esc(inc.injured_person)}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#6b7280">Reported by</td><td style="padding:6px 0">${esc(inc.reporter_name || 'Anonymous')}${inc.reporter_code ? ' [' + esc(inc.reporter_code) + ']' : ''}${inc.reporter_contact ? ' (' + esc(inc.reporter_contact) + ')' : ''}</td></tr>
      </table>
      <div style="margin-top:20px">
        <a href="${esc(link)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Open &amp; Investigate →</a>
      </div>
      <p style="color:#9ca3af;font-size:12px;margin-top:20px">Automated alert from the SPEL Safety App. Do not reply to this email.</p>
    </div>
  </div>`;
}

function logNotification(incidentId, channel, results) {
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT INTO notifications_log (incident_id, channel, recipient, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const r of results) {
    stmt.run(incidentId, channel, r.recipient, r.status, r.detail || null, now);
  }
}

// ---------------------------------------------------------------------------
// Durable outbox
// ---------------------------------------------------------------------------

/** Enqueue the alert rows for a new incident and kick the worker. */
export function queueIncidentAlerts(inc) {
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO alert_queue (incident_id, channel, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(incident_id, channel) DO NOTHING
  `);

  insert.run(inc.id, 'email', now, now, now);

  // WhatsApp only at/above the configured severity threshold.
  if (severityRank(inc.severity) >= severityRank(config.whatsapp.minSeverity)) {
    insert.run(inc.id, 'whatsapp', now, now, now);
  } else {
    db.prepare(`
      INSERT INTO alert_queue (incident_id, channel, status, attempts, created_at, updated_at, last_error)
      VALUES (?, 'whatsapp', 'skipped', 0, ?, ?, ?)
      ON CONFLICT(incident_id, channel) DO NOTHING
    `).run(inc.id, now, now, `below threshold ${config.whatsapp.minSeverity}`);
    logNotification(inc.id, 'whatsapp', [
      { recipient: '(all)', status: 'skipped', detail: `below threshold ${config.whatsapp.minSeverity}` },
    ]);
  }

  pump();
}

// ---------------------------------------------------------------------------
// Bounded worker with rate cap + circuit breaker
// ---------------------------------------------------------------------------

const CHANNELS = ['whatsapp', 'email']; // whatsapp first: it's the priority channel
// Per-channel concurrency + rate window, so a slow SMTP server can never consume
// the slots (or the send cap) that WhatsApp needs.
const inFlight = { whatsapp: 0, email: 0 };
const windows = { whatsapp: { start: Date.now(), count: 0 }, email: { start: Date.now(), count: 0 } };
let pumping = false;
// How long a WhatsApp alert may wait for the client to (re)connect before it is
// counted as a real delivery attempt instead of a free deferral.
const MAX_DEFER_MS = 6 * 60 * 60 * 1000;

// 0 (or negative) means "no cap" rather than "block everything forever".
const sendCap = config.notify.maxPerWindow > 0 ? config.notify.maxPerWindow : Infinity;
// Concurrency must be at least 1, or a misconfig would silently wedge the queue.
const concurrency = Math.max(1, config.notify.concurrency || 1);

function windowAllows(channel) {
  const w = windows[channel];
  const now = Date.now();
  if (now - w.start >= config.notify.windowMs) { w.start = now; w.count = 0; }
  return w.count < sendCap;
}
function noteSend(channel) { windows[channel].count += 1; }

/** Exponential backoff: 1m, 2m, 4m, 8m … capped at 30m. */
function backoffIso(attempts) {
  const mins = Math.min(30, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + mins * 60000).toISOString();
}

function claimBatch(channel, slots) {
  const now = nowIso();
  return db.prepare(`
    SELECT q.*, i.ref_no, i.severity, i.voided_at FROM alert_queue q
    JOIN incidents i ON i.id = q.incident_id
    WHERE q.channel = ? AND q.status = 'pending'
      AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
    ORDER BY CASE i.severity WHEN 'Fatal' THEN 0 WHEN 'Major' THEN 1 WHEN 'Serious' THEN 2 ELSE 3 END, q.id
    LIMIT ?
  `).all(channel, now, slots);
}

/**
 * Settle a queue row. outcome:
 *   'sent'    — delivered to at least one recipient (or a no-recipient no-op).
 *   'skipped' — nothing to do (channel disabled, incident gone/voided).
 *   'retry'   — a real failure; back off and try again until maxAttempts.
 */
function settle(row, outcome, detail) {
  const now = nowIso();
  if (outcome === 'sent' || outcome === 'skipped') {
    db.prepare('UPDATE alert_queue SET status=?, attempts=?, last_error=?, next_attempt_at=NULL, updated_at=? WHERE id=?')
      .run(outcome, row.attempts + 1, detail ? detail.slice(0, 500) : null, now, row.id);
    return;
  }
  const attempts = row.attempts + 1;
  const exhausted = attempts >= config.notify.maxAttempts;
  db.prepare('UPDATE alert_queue SET status=?, attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?')
    .run(exhausted ? 'failed' : 'pending', attempts, (detail || '').slice(0, 500),
      exhausted ? null : backoffIso(attempts), now, row.id);
  // A safety alert that could NOT be delivered after all retries must never pass
  // silently — escalate to admins over email (the independent channel).
  if (exhausted) escalateFailedAlert(row, detail);
}

function escalateFailedAlert(row, detail) {
  try {
    const inc = db.prepare('SELECT ref_no, unit, type, severity FROM incidents WHERE id = ?').get(row.incident_id);
    const ref = inc?.ref_no || ('incident #' + row.incident_id);
    console.error(`[notify] 🔴 ESCALATION: ${row.channel} alert for ${ref} FAILED after all retries — ${detail || ''}`);
    if (row.channel !== 'whatsapp' || !emailUsable()) return; // email failure escalating over email is pointless
    sendAdminEmail({
      subject: `🔴 SPEL Safety — WhatsApp alert NOT delivered (${ref})`,
      text: `The WhatsApp alert for ${ref} (${inc?.severity} ${inc?.type} at ${inc?.unit}) could not be delivered after ${config.notify.maxAttempts} attempts.\n`
        + `Reason: ${detail || 'unknown'}.\n\nPlease follow up directly and check Admin → Alert Delivery to retry.\n${config.baseUrl}/incident.html?id=${row.incident_id}`,
    }).catch(() => {});
  } catch (err) {
    console.error('[notify] escalation failed:', err.message);
  }
}

/** Classify per-recipient results into a single settle outcome. */
function outcomeOf(results) {
  const anyFailed = results.some((r) => r.status === 'failed');
  const anySent = results.some((r) => r.status === 'sent');
  // A partial failure must retry so the missed recipient is not dropped.
  if (anyFailed) return { outcome: 'retry', detail: results.find((r) => r.status === 'failed').detail, sent: anySent };
  if (anySent) return { outcome: 'sent', detail: null, sent: true };
  return { outcome: 'skipped', detail: results[0]?.detail || 'no recipients', sent: false };
}

async function deliver(row) {
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.incident_id);
  if (!inc) return settle(row, 'skipped', 'incident removed');
  // A voided incident (duplicate/correction) must not blast an alert.
  if (inc.voided_at) return settle(row, 'skipped', 'incident voided');

  const link = `${config.baseUrl}/incident.html?id=${inc.id}`;
  const text = buildText(inc, link);
  const html = buildHtml(inc, link);
  const subject = `🚨 ${inc.severity.toUpperCase()} incident — ${inc.unit} (${inc.ref_no})`;
  const imagePath = photoAbsPath(inc.photo_path);

  if (row.channel === 'email') {
    const attachment = imagePath ? { filename: path.basename(imagePath), path: imagePath } : null;
    const results = await sendIncidentEmail({ subject, html, text, attachment });
    logNotification(inc.id, 'email', results);
    const { outcome, detail, sent } = outcomeOf(results);
    if (sent) noteSend('email');
    return settle(row, outcome, detail);
  }

  if (row.channel === 'whatsapp') {
    const st = whatsAppStatus();
    // While the client is (re)connecting, defer WITHOUT burning an attempt — but
    // only up to MAX_DEFER_MS, and keep the row visible with a reason so it is
    // never silently stuck. The 'ready' event triggers another pump.
    if (st.enabled && st.state !== 'ready' && st.recipients.length > 0) {
      const age = Date.now() - Date.parse(row.created_at);
      if (age < MAX_DEFER_MS) {
        db.prepare("UPDATE alert_queue SET next_attempt_at=?, last_error=?, updated_at=? WHERE id=?")
          .run(backoffIso(1), `waiting for WhatsApp to connect (state=${st.state})`, nowIso(), row.id);
        return;
      }
      return settle(row, 'retry', `WhatsApp not connected for ${Math.round(age / 3600000)}h (state=${st.state})`);
    }

    // Per-recipient dedup: never re-send to someone who already got it on a
    // previous attempt. This is what keeps a partial failure from re-blasting
    // the reachable recipients (the anti-spam guarantee).
    let alreadySent = [];
    try { alreadySent = row.sent_to ? JSON.parse(row.sent_to) : []; } catch { alreadySent = []; }
    const skip = new Set(alreadySent);

    const results = await sendIncidentWhatsApp({ text, imagePath, skip });
    logNotification(inc.id, 'whatsapp', results.filter((r) => r.detail !== 'already delivered'));

    // Record everyone now delivered (including this attempt's new sends).
    const nowSent = new Set([...alreadySent, ...results.filter((r) => r.status === 'sent').map((r) => r.recipient)]);
    db.prepare('UPDATE alert_queue SET sent_to=? WHERE id=?').run(JSON.stringify([...nowSent]), row.id);

    const deliveredNow = results.some((r) => r.status === 'sent' && r.detail !== 'already delivered');
    if (deliveredNow) noteSend('whatsapp'); // count one send-event per incident, not per retry

    const transient = results.filter((r) => r.status === 'failed' && !r.permanent);
    const permanent = results.filter((r) => r.status === 'failed' && r.permanent);
    const anySent = results.some((r) => r.status === 'sent');

    if (transient.length) {
      // Retry — but only the still-undelivered recipients will be attempted next
      // time, so the reachable ones are never re-messaged.
      return settle(row, 'retry', transient[0].detail);
    }
    if (anySent) {
      // Delivered to everyone reachable; permanently-bad numbers are noted, not
      // retried, and do NOT mark the alert as failed.
      return settle(row, 'sent', permanent.length ? 'not on WhatsApp: ' + permanent.map((r) => r.recipient).join(', ') : null);
    }
    if (permanent.length) return settle(row, 'failed', 'no configured number is on WhatsApp');
    return settle(row, 'skipped', results[0]?.detail || 'no recipients');
  }

  // Unknown channel — settle so it can never loop forever.
  return settle(row, 'skipped', 'unknown channel: ' + row.channel);
}

function runOne(row) {
  inFlight[row.channel] += 1;
  return (async () => {
    try {
      // Mark in-flight (crash-recovery guard) INSIDE the try so a failure here
      // still hits finally and cannot leak an inFlight slot.
      db.prepare('UPDATE alert_queue SET next_attempt_at=? WHERE id=?')
        .run(new Date(Date.now() + 120000).toISOString(), row.id);
      await deliver(row);
    } catch (err) {
      console.error('[notify] delivery error:', err.message);
      try { settle(row, 'retry', err.message); } catch { /* ignore */ }
    } finally {
      inFlight[row.channel] -= 1;
    }
  })();
}

/** Drain the outbox within per-channel concurrency + rate limits. Never throws. */
export async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const claims = [];
      for (const channel of CHANNELS) {
        if (!windowAllows(channel)) {
          if (db.prepare("SELECT 1 FROM alert_queue WHERE channel=? AND status='pending' LIMIT 1").get(channel)) {
            console.warn(`[notify] ${channel} send cap reached (${config.notify.maxPerWindow}/window) — pausing until the window resets`);
          }
          continue;
        }
        const slots = concurrency - inFlight[channel];
        if (slots <= 0) continue;
        for (const row of claimBatch(channel, slots)) claims.push(row);
      }
      if (!claims.length) break;
      // Email + WhatsApp rows run concurrently here, so a slow SMTP send never
      // delays a WhatsApp alert.
      await Promise.allSettled(claims.map((row) => runOne(row)));
    }
  } catch (err) {
    console.error('[notify] pump error:', err.message);
  } finally {
    pumping = false;
  }
}

/** Periodic sweep so retries fire even with no new traffic. */
let sweepTimer = null;
export function startNotifyWorker() {
  sweepTimer = setInterval(() => { pump().catch(() => {}); }, config.notify.retrySweepMs);
  sweepTimer.unref?.();
  pump().catch(() => {});
  return sweepTimer;
}

/** True while a pump is running or sends are in flight (used by shutdown). */
export function notifyBusy() {
  return pumping || inFlight.whatsapp > 0 || inFlight.email > 0;
}

/**
 * Called when WhatsApp (re)connects: clear the backoff on rows that were only
 * DEFERRED waiting for the connection, so they send immediately rather than
 * sitting until their next_attempt_at (which the deferral had pushed 1m out).
 */
export function flushDeferred() {
  db.prepare(
    "UPDATE alert_queue SET next_attempt_at=NULL WHERE channel='whatsapp' AND status='pending' AND attempts=0"
  ).run();
  pump().catch(() => {});
}

/** Stop the periodic sweep (graceful shutdown). */
export function stopNotifyWorker() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

/** Outbox health for the admin UI: what is failed, retrying, or deferred. */
export function alertQueueStatus() {
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM alert_queue GROUP BY status').all();
  // Show failures, anything that has already been retried, and anything still
  // pending with a reason recorded (e.g. deferred waiting for WhatsApp) — but
  // not brand-new rows that are about to send on this pump.
  const problems = db.prepare(`
    SELECT q.id, q.channel, q.status, q.attempts, q.last_error, q.next_attempt_at,
           i.ref_no, i.severity, i.unit
    FROM alert_queue q JOIN incidents i ON i.id = q.incident_id
    WHERE q.status = 'failed'
       OR (q.status = 'pending' AND (q.attempts > 0 OR q.last_error IS NOT NULL))
    ORDER BY CASE i.severity WHEN 'Fatal' THEN 0 WHEN 'Major' THEN 1 WHEN 'Serious' THEN 2 ELSE 3 END, q.id DESC
    LIMIT 50
  `).all();
  const capped = CHANNELS.filter((c) => !windowAllows(c));
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    problems,
    rateCappedChannels: capped,
  };
}

/** Admin action: reset a failed alert so it is retried immediately. */
export function retryAlert(id) {
  const changed = db.prepare(
    "UPDATE alert_queue SET status='pending', attempts=0, next_attempt_at=?, last_error=NULL, updated_at=? WHERE id=?"
  ).run(nowIso(), nowIso(), id).changes;
  if (changed) pump().catch(() => {});
  return changed > 0;
}

/**
 * Back-compat wrapper: send immediately (used by tests / manual triggers).
 * Prefer queueIncidentAlerts so delivery is durable.
 */
export async function notifyIncident(inc) {
  queueIncidentAlerts(inc);
  await pump();
}
