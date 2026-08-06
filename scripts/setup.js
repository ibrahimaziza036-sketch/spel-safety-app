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
    line('  Ise theek karke setup dobara chala sakte hain (safe to re-run).');
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
  if (DRY) line('  (DRY RUN — kuch execute nahi hoga, sirf preview)\n');

  // ---- Preflight ----
  step(1, 'Checking prerequisites');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    line(`\x1b[31m✗ Node ${process.versions.node} — chahiye 22.5+ (built-in SQLite ke liye). Node upgrade karein.\x1b[0m`);
    process.exit(1);
  }
  line(`   ✓ Node ${process.versions.node}`);
  const haveCloudflared = has('cloudflared');
  line(`   ${haveCloudflared ? '✓' : '•'} cloudflared ${haveCloudflared ? 'installed' : 'NOT found (tunnel step skip ho jayega ya install karna hoga)'}`);

  // ---- Deployment mode ----
  step(2, 'Deployment mode');
  line('   1) LAN-only  — sirf factory network se access');
  line('   2) Internet  — Cloudflare Tunnel se kahin se bhi (HTTPS)');
  const mode = (await ask('   Choose 1 ya 2', '1')) === '2' ? 'internet' : 'lan';

  let baseUrl, cookieSecure, trustProxy, tunnelHost = '';
  if (mode === 'lan') {
    const ip = await ask('   Server ka LAN IP (e.g. 192.168.1.50)', 'localhost');
    baseUrl = `http://${ip}:3000`; cookieSecure = 'false'; trustProxy = '0';
  } else {
    tunnelHost = await ask('   Public hostname (e.g. safety.spelgroup.com)');
    while (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(tunnelHost)) {
      tunnelHost = await ask('   Valid hostname likhein (e.g. safety.spelgroup.com)');
    }
    baseUrl = `https://${tunnelHost}`; cookieSecure = 'true'; trustProxy = '1';
  }

  // ---- Credentials / recipients ----
  step(3, 'Admin, email & recipients');
  const adminUser = await ask('   Admin username', 'admin');
  let adminPass = await ask('   Admin password (khali chhoda to strong bana denge)');
  if (!adminPass) { adminPass = randomBytes(9).toString('base64url'); line(`   → generated admin password: \x1b[1m${adminPass}\x1b[0m  (note it!)`); }

  const waNumbers = await ask('   WhatsApp alert numbers, comma-separated (0300… bhi chalega)');
  const emailOn = await askYN('   Email backup ON karein? (recommended)', false);
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

  // ---- Write .env ----
  step(4, 'Writing .env (secrets auto-generated)');
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath) && !DRY) {
    const ow = await askYN('   .env pehle se hai — overwrite karun?', false);
    if (!ow) line('   → .env chhod diya (jaisa hai waisa rahega)');
    if (ow) writeEnv();
  } else { writeEnv(); }
  function writeEnv() {
    const env = [
      `PORT=3000`,
      `BASE_URL=${baseUrl}`,
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
  if (await askYN('   Demo incidents daalun (test/pitch ke liye)?', false)) {
    run('npm', ['run', 'seed'], { optional: true });
  } else { line('   → skip (empty start)'); }

  // ---- Cloudflare Tunnel ----
  if (mode === 'internet') {
    step(7, 'Cloudflare Tunnel');
    if (!haveCloudflared) {
      line('   \x1b[33m! cloudflared install nahi hai. Install karke setup dobara chalayein:\x1b[0m');
      line('     winget install --id Cloudflare.cloudflared   (ya https://github.com/cloudflare/cloudflared/releases)');
    } else {
      line('   \x1b[1m>> Browser khulega — apne Cloudflare account se login/authorize karein.\x1b[0m');
      await ask('   Tayaar hain? Enter dabayein');
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
      line('   Installing cloudflared as a service (boot par auto-start)…');
      run('cloudflared', ['service', 'install'], { optional: true });
      line('   \x1b[33m! Agar service install permission maange to Administrator terminal se: cloudflared service install\x1b[0m');
    }
  }

  // ---- PM2 (24/7) ----
  step(8, 'Starting app 24/7 with PM2');
  if (!has('pm2')) { line('   Installing pm2 globally…'); run('npm', ['install', '-g', 'pm2'], { optional: true }); }
  run('pm2', ['start', 'server.js', '--name', 'spel-safety', '--node-args=--disable-warning=ExperimentalWarning'], { optional: true });
  run('pm2', ['save'], { optional: true });
  line('   Boot par auto-start ke liye:');
  line(isWin ? '     npm i -g pm2-windows-startup && pm2-startup install' : '     pm2 startup   (jo command bataye woh chalayein)');

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
  line(`  App URL:   ${baseUrl}`);
  line(`  Login:     ${baseUrl}/login.html   (user: ${adminUser})`);
  line('\n  \x1b[1mAkhri 1 kaam — sirf ye insaani step baaki hai:\x1b[0m');
  line(`   • WhatsApp link karo: ${mode === 'internet' ? baseUrl : 'http://localhost:3000'}/admin.html kholo (admin login) → QR scan karo.`);
  if (!emailOn) line('   • (Recommended) baad mein email backup ON kar lena — WhatsApp down ho to alert phir bhi pohanche.');
  line('\n  Manage: pm2 logs spel-safety | pm2 restart spel-safety | npm run backup');
  rl.close();
}

main().catch((e) => { console.error(e); rl.close(); process.exit(1); });
