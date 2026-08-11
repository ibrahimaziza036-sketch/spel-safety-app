// Optional data backup: mirror the SQLite tables into MS SQL Server on a
// schedule. The LIVE database stays SQLite (fast, embedded, always-available);
// this only PUSHES a copy so the data is also in MS SQL for backup/reporting/DBA
// tooling. Everything here is best-effort — a MS SQL outage NEVER affects the
// safety app.
//
// The `mssql` driver is imported lazily, so the app runs fine even if MS SQL is
// not configured (or the package isn't installed yet).
import { db } from '../db.js';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';
import { pktDate, PKT_OFFSET_MS } from '../utils/time.js';

// Tables worth backing up. `users` is intentionally excluded (password hashes),
// and alert_queue is transient runtime state.
const TABLES = ['incidents', 'investigations', 'capa', 'notifications_log', 'audit_log', 'recipients'];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/; // guard identifiers before interpolating

export function mssqlUsable() {
  const m = config.mssql;
  return Boolean(m.enabled && m.server && m.database);
}

function mssqlTypeName(sqliteType) {
  const t = String(sqliteType || '').toUpperCase();
  if (t.includes('INT')) return 'BIGINT';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'FLOAT';
  return 'NVARCHAR(MAX)';
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Run the backup now. Connects, ensures each target table exists (creating it or
 * adding any new columns — never dropping), then full-refreshes its contents.
 * Returns { ok, tables:{name:rowCount}, error? }. Never throws.
 */
export async function runMssqlBackup({ verbose = false } = {}) {
  if (!mssqlUsable()) return { ok: false, error: 'MS SQL backup not enabled/configured' };

  let mssql;
  try {
    mssql = (await import('mssql')).default;
  } catch (err) {
    return { ok: false, error: `mssql driver not installed (run: npm install). ${err.message}` };
  }

  const m = config.mssql;
  const prefix = IDENT.test(m.tablePrefix) ? m.tablePrefix : 'spel_';
  const pool = new mssql.ConnectionPool({
    server: m.server,
    port: m.port,
    database: m.database,
    user: m.user,
    password: m.password,
    options: { encrypt: m.encrypt, trustServerCertificate: true },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 120000,
  });

  const result = { ok: true, tables: {} };
  try {
    await pool.connect();
    for (const table of TABLES) {
      if (!IDENT.test(table)) continue;
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => IDENT.test(c.name));
      if (!cols.length) continue;
      const full = `${prefix}${table}`;

      // Ensure the table exists with the current columns (create, then add any
      // missing ones — never drop, so existing MS SQL reports keep working).
      const colDefs = cols.map((c) => `[${c.name}] ${mssqlTypeName(c.type)}`).join(', ');
      await pool.request().batch(
        `IF OBJECT_ID(N'[dbo].[${full}]','U') IS NULL CREATE TABLE [dbo].[${full}] (${colDefs});`
      );
      for (const c of cols) {
        await pool.request().query(
          `IF COL_LENGTH('dbo.${full}', '${c.name}') IS NULL ALTER TABLE [dbo].[${full}] ADD [${c.name}] ${mssqlTypeName(c.type)};`
        );
      }

      // Full refresh: mirror the current SQLite contents.
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        await new mssql.Request(tx).query(`DELETE FROM [dbo].[${full}];`);
        const colNames = cols.map((c) => c.name);
        for (const batch of chunk(rows, 100)) {
          const req = new mssql.Request(tx);
          const valuesSql = batch.map((row, ri) => '(' + colNames.map((cn, ci) => {
            const p = `p${ri}_${ci}`;
            const type = mssqlTypeName(cols[ci].type);
            let val = row[cn];
            if (val === undefined) val = null;
            if (type === 'BIGINT') req.input(p, mssql.BigInt, val === null ? null : Number(val));
            else if (type === 'FLOAT') req.input(p, mssql.Float, val === null ? null : Number(val));
            else req.input(p, mssql.NVarChar(mssql.MAX), val === null ? null : String(val));
            return `@${p}`;
          }).join(',') + ')').join(',');
          if (valuesSql) {
            await req.query(`INSERT INTO [dbo].[${full}] (${colNames.map((c) => `[${c}]`).join(',')}) VALUES ${valuesSql};`);
          }
        }
        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch { /* ignore */ }
        throw err;
      }
      result.tables[full] = rows.length;
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }

  if (verbose || !result.ok) console.log('[mssql-backup]', JSON.stringify(result));
  return result;
}

// ---- daily scheduled worker (same pattern as retention/reminders) ----
const LAST_RUN_KEY = 'mssql_last_run';

async function tick() {
  try {
    if (!mssqlUsable()) return;
    const hourPkt = new Date(Date.now() + PKT_OFFSET_MS).getUTCHours();
    const today = pktDate();
    if (hourPkt < config.mssql.hour) return;
    if (getSetting(LAST_RUN_KEY) === today) return;
    const r = await runMssqlBackup({ verbose: true });
    // Mark the day done only on success, so a transient MS SQL outage retries.
    if (r.ok) setSetting(LAST_RUN_KEY, today);
    else console.warn('[mssql-backup] push failed, will retry next tick:', r.error);
  } catch (err) {
    console.error('[mssql-backup] tick failed:', err.message);
  }
}

let timer = null;
let initial = null;
export function startMssqlBackupWorker() {
  if (!config.mssql.enabled) return null; // nothing to schedule
  timer = setInterval(() => { tick().catch(() => {}); }, 10 * 60 * 1000); // check every 10 min
  timer.unref?.();
  initial = setTimeout(() => { tick().catch(() => {}); }, 40000);
  initial.unref?.();
  return timer;
}
export function stopMssqlBackupWorker() {
  if (timer) { clearInterval(timer); timer = null; }
  if (initial) { clearTimeout(initial); initial = null; }
}
