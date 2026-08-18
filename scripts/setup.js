// SPEL Safety — one-command server setup.
//
//   npm run setup
//
// Runs the WHOLE deployment: dependencies, .env (with generated secrets),
// optional demo data, PM2 (24/7), optional Cloudflare Tunnel (create + DNS +
// Windows service), QR posters, and a smoke test. It pauses ONLY where a human
// is physically required: the Cloudflare browser login and the WhatsApp QR scan.
//
// Safe to re-run. Nothing here is app-specific enough to need node:sqlite, so it
// runs even before `npm install`.
//
// Set SETUP_DRY_RUN=1 to preview every command/step without executing anything.
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DRY = !!process.env.SETUP_DRY_RUN;
const isWin = process.platform === 'win32';

// Pipe-safe line reader: buffer 'line' events in a queue so no input is dropped
// (rl.question can drop lines with piped stdin), and return '' after EOF so the
// script uses defaults instead of hanging. Works for both a real terminal and
// scripted input.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const _queue = [];
const _waiters = [];
let _closed = false;
rl.on('line', (l) => { if (_waiters.length) _waiters.shift()(l); else _queue.push(l); });
rl.on('close', () => { _closed = true; while (_waiters.length) _waiters.shift()(''); });
function readLine() {
  if (_queue.length) return Promise.resolve(_queue.shift());
  if (_closed) return Promise.resolve('');
  return new Promise((res) => _waiters.push(res));
}
const ask = async (q, def = '') => {
  process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
  const a = (await readLine()).trim();
  return a || def;
};
const askYN = async (q, def = true) => {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y');
};
const line = (s = '') => console.log(s);
const step = (n, s) => console.log(`\n\x1b[1m[${n}] ${s}\x1b[0m`);

// NOTE: commands are joined into a single shell string (no args array passed to
// spawnSync) — this avoids Node's DEP0190 shell+args warning. Only fixed strings
// and a regex-validated hostname are ever interpolated, so there is no injection.
function run(cmd, args = [], { optional = false, cwd = ROOT } = {}) {
  const printable = [cmd, ...args].join(' ');
  if (DRY) { line(`   (dry) ${printable}`); return { status: 0 }; }
  line(`   $ ${printable}`);
  const r = spawnSync(printable, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0 && !optional) {
    line(`\n\x1b[31m✗ Command failed: ${printable}\x1b[0m`);
    line('  Fix it and run setup again (safe to re-run).');
    process.exit(1);
  }
  return r;
}
function capture(cmd, args = []) {
  if (DRY) { line(`   (dry) ${[cmd, ...args].join(' ')}`); return ''; }
  const r = spawnSync([cmd, ...args].join(' '), { cwd: ROOT, encoding: 'utf8', shell: true });
  return (r.stdout || '') + (r.stderr || '');
}
function has(cmd) {
  const r = spawnSync(`${cmd} --version`, { encoding: 'utf8', shell: true });
  return r.status === 0;
}
function gen(bytes = 32) { return randomBytes(bytes).toString('hex'); }

async function main() {
  line('\n==================================================');
  line('  SPEL Safety — Server Setup');
  line('==================================================');
  if (DRY) line('  (DRY RUN — nothing will execute, preview only)\n');

  // ---- Preflight ----
  step(1, 'Checking prerequisites');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    line(`\x1b[31m✗ Node ${process.versions.node} — needs 22.5+ (for built-in SQLite). Please upgrade Node.\x1b[0m`);
    process.exit(1);
  }
  line(`   ✓ Node ${process.versions.node}`);
  const haveCloudflared = has('cloudflared');
  line(`   ${haveCloudflared ? '✓' : '•'} cloudflared ${haveCloudflared ? 'installed' : 'NOT found (the tunnel step will be skipped, or install it first)'}`);

  // ---- Deployment mode ----
  step(2, 'Deployment mode');
  line('   1) LAN-only  — access from the factory network only');
  line('   2) Internet  — from anywhere via Cloudflare Tunnel (HTTPS)');
  line('   3) Both       — factory Wi-Fi AND mobile-data/outside (recommended)');
  line('   4) Reverse proxy — you provide HTTPS (Caddy/Nginx, incl. free DuckDNS+Caddy, no domain to buy)');
  const choice = await ask('   Choose 1, 2, 3 or 4', '3');
  const mode = choice === '1' ? 'lan' : choice === '2' ? 'internet' : choice === '4' ? 'proxy' : 'both';

  let baseUrl, cookieSecure, trustProxy, tunnelHost = '', lanBase = '';
  if (mode === 'lan') {
    const ip = await ask('   Server LAN IP (e.g. 192.168.11.6)', 'localhost');
    baseUrl = `http://${ip}:3000`; cookieSecure = 'false'; trustProxy = '0';
  } else if (mode === 'proxy') {
    // A reverse proxy (Caddy/Nginx) terminates HTTPS and forwards to the app on
    // localhost:3000. Works with a free DuckDNS hostname — no domain purchase.
    let host = await ask('   Public hostname your HTTPS proxy serves (e.g. spelsafety.duckdns.org)');
    while (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      host = await ask('   Enter a valid hostname (e.g. spelsafety.duckdns.org)');
    }
    baseUrl = `https://${host}`; cookieSecure = 'true'; trustProxy = '1';
  } else if (mode === 'internet') {
    tunnelHost = await ask('   Public hostname (e.g. safety.spelgroup.com)');
    while (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(tunnelHost)) {
      tunnelHost = await ask('   Enter a valid hostname (e.g. safety.spelgroup.com)');
    }
    baseUrl = `https://${tunnelHost}`; cookieSecure = 'true'; trustProxy = '1';
  } else {
    // Both: public HTTPS URL for alert links + remote/4G access, AND a LAN URL
    // for on-site QR that keeps working even if the internet line is down.
    const ip = await ask('   Server LAN IP (e.g. 192.168.11.6)', 'localhost');
    tunnelHost = await ask('   Public hostname (e.g. safety.spelgroup.com)');
    while (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(tunnelHost)) {
      tunnelHost = await ask('   Enter a valid hostname (e.g. safety.spelgroup.com)');
    }
    baseUrl = `https://${tunnelHost}`;
    lanBase = `http://${ip}:3000`;
    // cookieSecure=false so an on-site admin can still log in over the LAN (http)
    // during an internet outage; the login cookie is httpOnly + sameSite=lax and
    // the network is internal. trust 1 hop for the Cloudflare tunnel.
    cookieSecure = 'false'; trustProxy = '1';
  }

  // ---- Credentials / recipients ----
  step(3, 'Admin, email & recipients');
  const adminUser = await ask('   Admin username', 'admin');
  let adminPass = await ask('   Admin password (leave blank to auto-generate a strong one)');
  if (!adminPass) { adminPass = randomBytes(9).toString('base64url'); line(`   → generated admin password: \x1b[1m${adminPass}\x1b[0m  (note it!)`); }

  const waNumbers = await ask('   WhatsApp alert numbers, comma-separated (0300… works too)');
  const emailOn = await askYN('   Enable email backup? (recommended)', false);
  let smtp = { enabled: 'false', host: '', port: '587', user: '', pass: '', from: '', mgmt: '' };
  if (emailOn) {
    smtp.enabled = 'true';
    smtp.host = await ask('     SMTP host', 'smtp.office365.com');
    smtp.port = await ask('     SMTP port', '587');
    smtp.user = await ask('     SMTP username (email)');
    smtp.pass = await ask('     SMTP password / app-password');
    smtp.from = await ask('     From address', smtp.user || 'safety@spelgroup.com');
    smtp.mgmt = await ask('     Management emails (comma-separated)');
  }

  // ---- Optional MS SQL backup mirror ----
  const mssqlOn = await askYN('   Also push a daily backup copy into MS SQL Server?', false);
  let mssql = { enabled: 'false', server: 'localhost', port: '1433', database: '', user: '', pass: '', hour: '2' };
  if (mssqlOn) {
    mssql.enabled = 'true';
    mssql.server = await ask('     MS SQL server (host or host\\instance)', 'localhost');
    mssql.port = await ask('     MS SQL port', '1433');
    mssql.database = await ask('     MS SQL database name');
    mssql.user = await ask('     MS SQL username');
    mssql.pass = await ask('     MS SQL password');
    mssql.hour = await ask('     Daily push hour (0-23, PKT)', '2');
  }

  // ---- Write .env ----
  step(4, 'Writing .env (secrets auto-generated)');
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath) && !DRY) {
    const ow = await askYN('   .env already exists — overwrite?', false);
    if (!ow) line('   → kept existing .env (unchanged)');
    if (ow) writeEnv();
  } else { writeEnv(); }
  function writeEnv() {
    const env = [
      `PORT=3000`,
      `BASE_URL=${baseUrl}`,
      `LAN_BASE_URL=${lanBase}`,
      `SESSION_SECRET=${gen(32)}`,
      `ADMIN_USERNAME=${adminUser}`,
      `ADMIN_PASSWORD=${adminPass}`,
      `COOKIE_SECURE=${cookieSecure}`,
      `TRUST_PROXY_HOPS=${trustProxy}`,
      `MANAGEMENT_EMAILS=${smtp.mgmt}`,
      `MANAGEMENT_WHATSAPP=${waNumbers}`,
      `EMAIL_ENABLED=${smtp.enabled}`,
      `SMTP_HOST=${smtp.host}`,
      `SMTP_PORT=${smtp.port}`,
      `SMTP_SECURE=false`,
      `SMTP_USER=${smtp.user}`,
      `SMTP_PASS=${smtp.pass}`,
      `EMAIL_FROM=${smtp.from}`,
      `MSSQL_ENABLED=${mssql.enabled}`,
      `MSSQL_SERVER=${mssql.server}`,
      `MSSQL_PORT=${mssql.port}`,
      `MSSQL_DATABASE=${mssql.database}`,
      `MSSQL_USER=${mssql.user}`,
      `MSSQL_PASSWORD=${mssql.pass}`,
      `MSSQL_ENCRYPT=true`,
      `MSSQL_BACKUP_HOUR=${mssql.hour}`,
      `WHATSAPP_ENABLED=true`,
      `WHATSAPP_HEADLESS=true`,
      `WHATSAPP_MIN_SEVERITY=Minor`,
      '',
    ].join('\n');
    if (DRY) { line('   (dry) would write .env with the above keys'); return; }
    fs.writeFileSync(envPath, env);
    line('   ✓ .env written');
  }

  // ---- Dependencies ----
  step(5, 'Installing dependencies (npm install)');
  run('npm', ['install']);

  // ---- Optional demo data ----
  step(6, 'Demo data');
  if (await askYN('   Add demo incidents (for testing/pitch)?', false)) {
    run('npm', ['run', 'seed'], { optional: true });
  } else { line('   → skip (empty start)'); }

  // ---- Cloudflare Tunnel ----
  if (mode === 'internet' || mode === 'both') {
    step(7, 'Cloudflare Tunnel');
    if (!haveCloudflared) {
      line('   \x1b[33m! cloudflared is not installed. Install it and run setup again:\x1b[0m');
      line('     winget install --id Cloudflare.cloudflared   (or https://github.com/cloudflare/cloudflared/releases)');
    } else {
      line('   \x1b[1m>> A browser will open — log in / authorize with your Cloudflare account.\x1b[0m');
      await ask('   Ready? Press Enter');
      run('cloudflared', ['tunnel', 'login']);
      // create (ignore error if it already exists)
      run('cloudflared', ['tunnel', 'create', 'spel-safety'], { optional: true });
      // find the tunnel UUID
      const out = capture('cloudflared', ['tunnel', 'list']);
      const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+spel-safety/i)
        || out.match(/spel-safety\s+.*?([0-9a-f-]{36})/i);
      const uuid = m ? m[1] : '<TUNNEL-UUID>';
      run('cloudflared', ['tunnel', 'route', 'dns', 'spel-safety', tunnelHost], { optional: true });
      // write config.yml
      const cfgDir = path.join(os.homedir(), '.cloudflared');
      const cfg = `tunnel: ${uuid}\ncredentials-file: ${path.join(cfgDir, uuid + '.json')}\ningress:\n  - hostname: ${tunnelHost}\n    service: http://localhost:3000\n  - service: http_status:404\n`;
      if (DRY) { line(`   (dry) would write ${path.join(cfgDir, 'config.yml')}`); }
      else { fs.mkdirSync(cfgDir, { recursive: true }); fs.writeFileSync(path.join(cfgDir, 'config.yml'), cfg); line(`   ✓ config.yml written (UUID ${uuid})`); }
      line('   Installing cloudflared as a service (auto-start on boot)…');
      run('cloudflared', ['service', 'install'], { optional: true });
      line('   \x1b[33m! If the service install asks for permission, run it from an Administrator terminal: cloudflared service install\x1b[0m');
    }
  }

  // ---- PM2 (24/7) ----
  step(8, 'Starting app 24/7 with PM2');
  if (!has('pm2')) { line('   Installing pm2 globally…'); run('npm', ['install', '-g', 'pm2'], { optional: true }); }
  run('pm2', ['start', 'server.js', '--name', 'spel-safety', '--node-args=--disable-warning=ExperimentalWarning'], { optional: true });
  run('pm2', ['save'], { optional: true });
  line('   To auto-start on boot:');
  line(isWin ? '     npm i -g pm2-windows-startup && pm2-startup install' : '     pm2 startup   (run the command it prints)');

  // ---- QR posters ----
  step(9, 'Generating QR posters');
  run('npm', ['run', 'qr'], { optional: true });

  // ---- Smoke test ----
  step(10, 'Running smoke test');
  if (!DRY) { spawnSync('npm run smoke', { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ADMIN_PASSWORD: adminPass } }); }
  else { line('   (dry) npm run smoke'); }

  // ---- Done ----
  line('\n==================================================');
  line('  ✓ Setup complete');
  line('==================================================');
  line(`  Public URL: ${baseUrl}`);
  if (lanBase) line(`  LAN URL:    ${lanBase}   (works even if the internet is down)`);
  line(`  Login:      ${baseUrl}/login.html   (user: ${adminUser})`);
  if (lanBase) line(`  QR posters: ${lanBase}/qr/index.html   (two codes per unit: Wi-Fi + mobile-data)`);
  line('\n  \x1b[1mLast step — only this manual step remains:\x1b[0m');
  line(`   • Link WhatsApp: open http://localhost:3000/admin.html on the server (admin login) → scan the QR.`);
  if (!emailOn) line('   • (Recommended) turn on email backup later — so alerts still arrive if WhatsApp goes down.');
  line('\n  Manage: pm2 logs spel-safety | pm2 restart spel-safety | npm run backup');
  rl.close();
}

main().catch((e) => { console.error(e); rl.close(); process.exit(1); });
