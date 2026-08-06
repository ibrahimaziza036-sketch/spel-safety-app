// Reliability monitor for the alert channels.
//
// The whole safety system relies on WhatsApp alerts, and the free WhatsApp
// channel is inherently fragile. This monitor makes an outage LOUD instead of
// silent: if WhatsApp stays down beyond a threshold, it emails the admins over
// the (independent) email channel and records it, and announces recovery.
//
// This only works as a true backstop if EMAIL is configured — email is the
// second, more reliable channel. If email is off, the outage is still surfaced
// on the dashboard/admin and in the logs.
import { config } from '../config.js';
import { whatsAppStatus } from './whatsapp.js';
import { sendAdminEmail, emailUsable } from './email.js';
import { audit } from './audit.js';

const DOWN_ALARM_MS = Number(process.env.WHATSAPP_DOWN_ALARM_MINUTES || 5) * 60 * 1000;

let alarmActive = false;   // an outage alarm has been raised and not yet cleared
let lastAlarmAt = 0;
let monitorTimer = null;

async function tick() {
  if (!config.whatsapp.enabled) return;
  const wa = whatsAppStatus();

  if (wa.state === 'ready') {
    if (alarmActive) {
      alarmActive = false;
      console.log('[monitor] WhatsApp RECOVERED — alerts flowing again.');
      audit({}, { entity: 'system', action: 'whatsapp_recovered', actorName: 'system', detail: 'WhatsApp channel is back' });
      if (emailUsable()) {
        await sendAdminEmail({
          subject: '✅ SPEL Safety — WhatsApp alerting RECOVERED',
          text: 'The WhatsApp alerting channel is connected again. Any alerts queued during the outage have been (or are being) delivered.',
        });
      }
    }
    return;
  }

  // Not ready. Raise the alarm once it has been down long enough.
  if (wa.downMs >= DOWN_ALARM_MS && !alarmActive) {
    alarmActive = true;
    lastAlarmAt = Date.now();
    const mins = Math.round(wa.downMs / 60000);
    const msg = `WhatsApp alerting has been DOWN for ~${mins} min (state: ${wa.state}${wa.error ? ', ' + wa.error : ''}). `
      + `Incident alerts are being QUEUED and will send when it reconnects, but please check the Admin → WhatsApp Connection page. `
      + `If it needs a re-scan, open ${config.baseUrl}/admin.html on the server.`;
    console.error('[monitor] 🔴 ' + msg);
    audit({}, { entity: 'system', action: 'whatsapp_down_alarm', actorName: 'system', detail: msg.slice(0, 500) });
    if (emailUsable()) {
      const r = await sendAdminEmail({ subject: '🔴 SPEL Safety — WhatsApp alerting is DOWN', text: msg });
      if (!r.ok) console.error('[monitor] could not send down-alarm email: ' + r.reason);
    } else {
      console.error('[monitor] EMAIL is not configured — cannot send a backup down-alarm. Configure SMTP so outages reach you off-WhatsApp.');
    }
  }
}

export function startMonitor() {
  monitorTimer = setInterval(() => { tick().catch((e) => console.error('[monitor] tick error:', e.message)); }, 60000);
  monitorTimer.unref?.();
  return monitorTimer;
}

export function stopMonitor() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}

/** Current alarm state, surfaced to the admin UI. */
export function monitorStatus() {
  return { whatsappAlarmActive: alarmActive, lastAlarmAt: lastAlarmAt || null, downAlarmMinutes: DOWN_ALARM_MS / 60000 };
}
