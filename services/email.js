// Email channel via Nodemailer. Lazy-creates the transport so the app boots
// even when SMTP is not configured. Never throws to the caller — returns a
// per-recipient result so a mail failure can't block incident submission.
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import { config } from '../config.js';
import { activeValues } from './recipients.js';

let transporter = null;
let verified = false;

function getTransport() {
  if (transporter) return transporter;
  if (!config.email.host) return null;
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure, // true for 465, false for 587 (STARTTLS)
    auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
    // Without explicit timeouts a dead SMTP host can hang the send for minutes.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

export async function verifyEmail() {
  const t = getTransport();
  if (!t) return { ok: false, reason: 'SMTP not configured' };
  try {
    await t.verify();
    verified = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function emailStatus() {
  return {
    enabled: config.email.enabled,
    configured: Boolean(config.email.host),
    verified,
    from: config.email.from,
    recipients: activeValues('email'),
  };
}

/** Can email actually be used right now (enabled + SMTP configured)? */
export function emailUsable() {
  return Boolean(config.email.enabled && config.email.host);
}

/**
 * Send an operational/ops email to the management + email recipients — used for
 * the "WhatsApp is DOWN" alarm and failed-alert escalation. Returns {ok, reason}.
 * This is the reliability backstop: it must not depend on the WhatsApp channel.
 */
export async function sendAdminEmail({ subject, text, html }) {
  if (!emailUsable()) return { ok: false, reason: 'email not configured' };
  const recipients = activeValues('email');
  if (recipients.length === 0) return { ok: false, reason: 'no email recipients' };
  const t = getTransport();
  if (!t) return { ok: false, reason: 'SMTP not configured' };
  try {
    await t.sendMail({ from: config.email.from, to: recipients.join(', '), subject, text, html: html || undefined });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Send the alert email to all management recipients.
 * @returns {Promise<Array<{recipient:string,status:string,detail?:string}>>}
 */
export async function sendIncidentEmail({ subject, html, text, attachment }) {
  const recipients = activeValues('email');
  // Guard empties first so the audit log always gets at least one row.
  if (recipients.length === 0) {
    return [{ recipient: '(none)', status: 'skipped', detail: 'no email recipients added' }];
  }
  if (!config.email.enabled) {
    return recipients.map((r) => ({ recipient: r, status: 'skipped', detail: 'email disabled' }));
  }
  const t = getTransport();
  if (!t) {
    return recipients.map((r) => ({ recipient: r, status: 'failed', detail: 'SMTP not configured' }));
  }

  // Only attach the photo if it is actually readable — a missing file must not
  // fail the whole alert for every recipient.
  const attachments = [];
  if (attachment?.path) {
    try {
      fs.accessSync(attachment.path, fs.constants.R_OK);
      attachments.push(attachment);
    } catch {
      console.warn('[email] photo not readable, sending without attachment:', attachment.path);
    }
  } else if (attachment) {
    attachments.push(attachment);
  }

  // One message to all recipients (they see each other) — fine for an internal
  // management group. Switch to per-recipient loop if you need privacy.
  try {
    await t.sendMail({
      from: config.email.from,
      to: recipients.join(', '),
      subject,
      text,
      html,
      attachments,
    });
    return recipients.map((r) => ({ recipient: r, status: 'sent' }));
  } catch (err) {
    return recipients.map((r) => ({ recipient: r, status: 'failed', detail: err.message }));
  }
}
