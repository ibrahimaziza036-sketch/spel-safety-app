// Push the current SQLite data into MS SQL Server once (manual / Task Scheduler).
//   npm run mssql-sync
// Requires MSSQL_* configured in .env (see GO_LIVE.md).
import { runMssqlBackup, mssqlUsable } from '../services/mssql-backup.js';

if (!mssqlUsable()) {
  console.error('MS SQL backup is not enabled/configured. Set MSSQL_ENABLED=true and MSSQL_* in .env.');
  process.exit(1);
}
const r = await runMssqlBackup({ verbose: true });
if (r.ok) {
  console.log('✓ MS SQL push complete:', Object.entries(r.tables).map(([t, n]) => `${t}=${n}`).join(', '));
  process.exit(0);
} else {
  console.error('✗ MS SQL push failed:', r.error);
  process.exit(1);
}
