// SQLite database using Node's built-in module (no native compile needed).
// Requires Node >= 22.5. Started as experimental; run with
// --disable-warning=ExperimentalWarning (see package.json scripts).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const dbPath = path.join(dataDir, 'safety.db');
export const db = new DatabaseSync(dbPath);

// Pragmas for reliability + concurrency (multiple units writing at once).
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_no          TEXT UNIQUE,
    unit            TEXT NOT NULL,
    location        TEXT,
    occurred_at     TEXT,              -- when the incident happened (ISO)
    type            TEXT NOT NULL,
    severity        TEXT NOT NULL,
    description     TEXT NOT NULL,
    injured_person  TEXT,
    reporter_name   TEXT,
    reporter_contact TEXT,
    photo_path      TEXT,
    status          TEXT NOT NULL DEFAULT 'Open',
    created_at      TEXT NOT NULL      -- when the report was filed (ISO)
  );

  CREATE TABLE IF NOT EXISTS investigations (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id       INTEGER NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
    what_happened     TEXT,
    how_happened      TEXT,
    root_cause        TEXT,            -- 5-why / narrative
    immediate_actions TEXT,
    investigated_by   TEXT,
    investigated_at   TEXT,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capa (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'Corrective',   -- Corrective | Preventive
    owner       TEXT,
    due_date    TEXT,
    status      TEXT NOT NULL DEFAULT 'Open',          -- Open | In Progress | Done
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,          -- email | whatsapp
    recipient   TEXT,
    status      TEXT NOT NULL,          -- sent | failed | skipped
    detail      TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,          -- scrypt: "salt:hash"
    role          TEXT NOT NULL DEFAULT 'viewer',  -- viewer | safety_officer | admin
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recipients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel    TEXT NOT NULL,             -- email | whatsapp
    value      TEXT NOT NULL,             -- email address, or WhatsApp number like 923001234567
    label      TEXT,                      -- e.g. "CEO", "GM Safety"
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(channel, value)
  );

  -- Append-only accountability trail. Never UPDATEd or DELETEd by app code
  -- (except the documented retention purge), so a safety record stays auditable.
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity      TEXT NOT NULL,            -- incident | investigation | capa | user | recipient
    entity_id   INTEGER,
    incident_id INTEGER,                  -- denormalised for per-incident history
    action      TEXT NOT NULL,            -- create | update | status | void | delete | login ...
    actor_id    INTEGER,                  -- users.id, or NULL for anonymous/public
    actor_name  TEXT NOT NULL,            -- username, or 'public (QR report)'
    changes     TEXT,                     -- JSON { field: { from, to } }
    detail      TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL
  );

  -- Durable alert outbox so a Fatal alert is never lost to a transient outage.
  CREATE TABLE IF NOT EXISTS alert_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id   INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    channel       TEXT NOT NULL,          -- email | whatsapp
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    next_attempt_at TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(incident_id, channel)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_incident ON audit_log(incident_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_alertq_status ON alert_queue(status, next_attempt_at);

  CREATE INDEX IF NOT EXISTS idx_incidents_unit ON incidents(unit);
  CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
  CREATE INDEX IF NOT EXISTS idx_capa_incident ON capa(incident_id);
`);

// ---- lightweight migrations (idempotent) ----
// Adds columns to databases created by earlier versions. ALTER TABLE ADD COLUMN
// throws if the column exists, so each is attempted independently.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('incidents', 'updated_at', 'TEXT');
// Reporter's employee code (shown alongside the reporter name).
addColumn('incidents', 'reporter_code', 'TEXT');
// Recipients (per channel) an alert has already reached, so a retry never
// re-sends to someone who already got it.
addColumn('alert_queue', 'sent_to', 'TEXT');
// Soft delete ("void") — incident records are evidence, so they are never
// destroyed by a user action; they are marked void with a reason + actor.
addColumn('incidents', 'voided_at', 'TEXT');
addColumn('incidents', 'voided_by', 'TEXT');
addColumn('incidents', 'void_reason', 'TEXT');

// CAPA effectiveness verification: a completed action must be checked (weeks
// later) to confirm it actually removed the risk before the incident can close.
addColumn('capa', 'verified_at', 'TEXT');
addColumn('capa', 'verified_by', 'TEXT');
addColumn('capa', 'effectiveness', 'TEXT'); // Effective | Not Effective | Recurred
addColumn('capa', 'verify_note', 'TEXT');

// Idempotency key from the report form. An offline/retried submission carries the
// same token, so the server creates the incident at most once (no duplicates
// from a flaky network or a queue-flush race).
addColumn('incidents', 'client_token', 'TEXT');

db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_voided ON incidents(voided_at);');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_client_token ON incidents(client_token) WHERE client_token IS NOT NULL;');

export default db;
