// Safe backup.
//
// Copying safety.db while the app is running can capture a TORN snapshot (the
// WAL holds committed pages that aren't in the main file yet). VACUUM INTO
// writes a consistent, already-compacted copy — safe to run live.
//
// The photos in data/uploads are part of the record too, so they are copied as
// well. Run:  npm run backup  [-- <destination-dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dbPath } from '../db.js';
import { uploadDir } from '../utils/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destArg = process.argv[2];
const destRoot = destArg ? path.resolve(destArg) : path.join(rootDir, 'backups');
const dest = path.join(destRoot, `spel-safety-${stamp}`);

fs.mkdirSync(dest, { recursive: true });

// 1. Consistent database snapshot.
const dbOut = path.join(dest, 'safety.db');
db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
console.log('✓ database  -> ' + dbOut);

// 2. Verify the copy before declaring success.
import('node:sqlite').then(({ DatabaseSync }) => {
  const check = new DatabaseSync(dbOut, { readOnly: true });
  const result = check.prepare('PRAGMA integrity_check').get();
  const status = result?.integrity_check ?? Object.values(result || {})[0];
  const counts = check.prepare('SELECT COUNT(*) AS n FROM incidents').get().n;
  check.close();
  if (status !== 'ok') {
    console.error('✗ integrity_check FAILED: ' + status);
    process.exit(1);
  }
  console.log(`✓ verified  -> integrity_check ok, ${counts} incidents`);

  // 3. Photos.
  const photoOut = path.join(dest, 'uploads');
  fs.mkdirSync(photoOut, { recursive: true });
  let copied = 0;
  try {
    for (const f of fs.readdirSync(uploadDir)) {
      fs.copyFileSync(path.join(uploadDir, f), path.join(photoOut, f));
      copied += 1;
    }
  } catch (err) {
    console.warn('! photos: ' + err.message);
  }
  console.log(`✓ photos    -> ${copied} file(s) in ${photoOut}`);

  // 4. Config, minus secrets.
  try {
    const env = fs.readFileSync(path.join(rootDir, '.env'), 'utf8')
      .split('\n')
      .map((l) => l.replace(/^(SMTP_PASS|SESSION_SECRET|ADMIN_PASSWORD)=.*/i, '$1=<redacted — restore manually>'))
      .join('\n');
    fs.writeFileSync(path.join(dest, 'env.redacted.txt'), env);
    console.log('✓ config    -> env.redacted.txt (secrets removed)');
  } catch { /* .env may not exist */ }

  console.log(`\nBackup complete: ${dest}`);
  console.log('IMPORTANT:');
  console.log('  • Copy this folder to a DIFFERENT machine / encrypted drive.');
  console.log('  • It contains injury photos and personal names — treat it as confidential.');
  console.log('  • data/.wwebjs_auth (WhatsApp login) is NOT included by design; it is a credential.');
  console.log('  • Test a restore periodically: point the app at the copied safety.db and open the dashboard.');
});
