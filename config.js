// Central configuration. Reads .env (via dotenv) with safe defaults so the app
// still boots even before .env is filled in.
import 'dotenv/config';

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// Fixed reference data for SPEL.
export const UNITS = [
  'UNIT1', 'UNIT2', 'UNIT3', 'UNIT4', 'UNIT5RYK',
  'UNIT6', 'UNIT7', 'UNIT8', 'UNIT9',
];

export const INCIDENT_TYPES = [
  'Injury',
  'Near-miss',
  'Fire',
  'Chemical spill',
  'Equipment damage',
  'Electrical',
  'Environmental',
  'Property damage',
  'Other',
];

// Ordered least -> most severe. Index used for threshold comparisons.
export const SEVERITIES = ['Minor', 'Serious', 'Major', 'Fatal'];

export const STATUSES = ['Open', 'Under Investigation', 'Closed'];

// Access roles, least -> most privileged.
export const ROLES = ['viewer', 'safety_officer', 'admin'];

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),

  managementEmails: list(process.env.MANAGEMENT_EMAILS),
  managementWhatsApp: list(process.env.MANAGEMENT_WHATSAPP),

  email: {
    enabled: bool(process.env.EMAIL_ENABLED, false),
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'safety@spelgroup.com',
  },

  whatsapp: {
    enabled: bool(process.env.WHATSAPP_ENABLED, false),
    headless: bool(process.env.WHATSAPP_HEADLESS, true),
    chromePath: process.env.WHATSAPP_CHROME_PATH || '',
    minSeverity: SEVERITIES.includes(process.env.WHATSAPP_MIN_SEVERITY)
      ? process.env.WHATSAPP_MIN_SEVERITY
      : 'Minor',
    // Per-message send timeout so one unreachable number can't stall the rest.
    sendTimeoutMs: Number(process.env.WHATSAPP_SEND_TIMEOUT_MS || 25000),
  },

  // Abuse control for the PUBLIC incident-report endpoint. Genuine reporting is
  // low-volume, so these limits are generous for humans yet stop a flood.
  intake: {
    perIpPerHour: Number(process.env.INTAKE_PER_IP_PER_HOUR || 20),
    globalPerHour: Number(process.env.INTAKE_GLOBAL_PER_HOUR || 300),
    maxPhotoBytes: Number(process.env.MAX_PHOTO_BYTES || 10 * 1024 * 1024),
    // Total storage the photo directory may consume; uploads are refused above it.
    maxUploadDirBytes: Number(process.env.MAX_UPLOAD_DIR_BYTES || 2 * 1024 * 1024 * 1024),
    // Field length caps (characters).
    maxDescription: Number(process.env.MAX_DESCRIPTION_CHARS || 5000),
    maxShortField: Number(process.env.MAX_SHORT_FIELD_CHARS || 200),
  },

  // Notification delivery: bounded queue + retry + circuit breaker.
  notify: {
    concurrency: Number(process.env.NOTIFY_CONCURRENCY || 2),
    maxPerWindow: Number(process.env.NOTIFY_MAX_PER_WINDOW || 60),
    windowMs: Number(process.env.NOTIFY_WINDOW_MS || 10 * 60 * 1000),
    maxAttempts: Number(process.env.NOTIFY_MAX_ATTEMPTS || 5),
    retrySweepMs: Number(process.env.NOTIFY_RETRY_SWEEP_MS || 60 * 1000),
  },

  // Data retention (0 = keep forever).
  retention: {
    notificationLogDays: Number(process.env.RETENTION_NOTIFICATION_LOG_DAYS || 180),
    incidentDays: Number(process.env.RETENTION_INCIDENT_DAYS || 0),
    // Delete the photo FILE (keeping the incident record) after this many days,
    // so the storage cap is self-healing under normal use. 0 = keep photos.
    photoDays: Number(process.env.RETENTION_PHOTO_DAYS || 365),
    sweepMs: Number(process.env.RETENTION_SWEEP_MS || 6 * 60 * 60 * 1000),
  },

  auth: {
    // Session cookie signing secret. MUST be set to a long random string in
    // production (a fallback is used only so dev boots).
    sessionSecret: process.env.SESSION_SECRET || 'spel-safety-dev-secret-change-me',
    // Initial admin, seeded on first run if no users exist.
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '', // if blank, a random one is generated + printed
    // Set true only when served over HTTPS (marks the session cookie Secure).
    cookieSecure: bool(process.env.COOKIE_SECURE, false),
    // Number of proxy hops to trust for the real client IP. Set to the actual
    // hop count when behind nginx/IIS; 0 = direct (do not trust XFF at all).
    trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
  },

  // Where incident photos are stored. Point this at a SEPARATE disk/volume in
  // production so a full photo directory can never break the database.
  uploadDir: process.env.UPLOAD_DIR || '',
};

// The insecure default secret — used to warn/fail-fast in production.
export const DEV_SESSION_SECRET = 'spel-safety-dev-secret-change-me';

// Severity rank helper (higher = more severe).
export function severityRank(sev) {
  const i = SEVERITIES.indexOf(sev);
  return i === -1 ? 0 : i;
}
