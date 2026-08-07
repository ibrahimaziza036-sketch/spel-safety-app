// End-to-end smoke test against a RUNNING server. Verifies auth, RBAC, the
// public intake path, abuse controls, audit trail and dashboard math.
//
// Usage:  npm run smoke            (expects the app on BASE_URL / localhost:3000)
//         ADMIN_PASSWORD=... npm run smoke
import 'dotenv/config';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Minimal cookie-jar fetch. */
function makeClient() {
  const jar = new Map();
  let csrf = null;
  return {
    get csrf() { return csrf; },
    async fetch(pathname, opts = {}) {
      const headers = new Headers(opts.headers || {});
      if (jar.size) headers.set('cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
      // Same-origin Origin header so CSRF's origin check passes.
      headers.set('origin', BASE);
      const method = (opts.method || 'GET').toUpperCase();
      if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-csrf-token', csrf);
      const res = await fetch(BASE + pathname, { ...opts, headers, redirect: 'manual' });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      return res;
    },
    async json(pathname, opts) {
      const res = await this.fetch(pathname, opts);
      let body = null;
      try { body = await res.json(); } catch { /* non-json */ }
      return { res, body };
    },
    async loadCsrf() {
      const { body } = await this.json('/api/meta');
      csrf = body?.csrfToken || null;
      return csrf;
    },
    async login(username, password) {
      const { res } = await this.json('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 200) await this.loadCsrf();
      return res.status;
    },
  };
}

const form = (obj) => {
  const fd = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) fd.set(k, v);
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fd.toString() };
};

console.log(`\nSPEL Safety App — smoke test against ${BASE}\n`);

// ---------------------------------------------------------------- public paths
console.log('Public access & abuse control');
const anon = makeClient();
{
  const { res } = await anon.json('/healthz');
  check('healthz responds', res.status === 200);
}
{
  const { res, body } = await anon.json('/readyz');
  check('readyz reports db ok', res.status === 200 && body?.checks?.db === true, JSON.stringify(body?.checks));
}
{
  const { res } = await anon.json('/api/meta');
  check('meta is public', res.status === 200);
}
{
  const res = await anon.fetch('/');
  check('dashboard page requires login (302)', res.status === 302);
}
{
  const { res } = await anon.json('/api/dashboard/stats');
  check('dashboard API requires login (401)', res.status === 401);
}
{
  const res = await anon.fetch('/report.html');
  check('report form stays public (200)', res.status === 200);
}
{
  const { res } = await anon.json('/api/admin/users');
  check('admin API blocked for anonymous', res.status === 401 || res.status === 403);
}

// public submit
let publicRef = null;
{
  const { res, body } = await anon.json('/api/incidents', form({
    unit: 'UNIT1', type: 'Near-miss', severity: 'Minor',
    description: 'smoke test — public submission', location: 'Smoke test area',
  }));
  publicRef = body?.ref_no;
  check('public incident submit works (201)', res.status === 201, `status=${res.status}`);
  check('ref_no follows INC-YYYY-NNNN', /^INC-\d{4}-\d{4,}$/.test(publicRef || ''), publicRef);
}
// hostile input on the public endpoint
{
  const fd = new URLSearchParams();
  fd.append('unit', 'UNIT1'); fd.append('unit', 'UNIT2');       // repeated key
  fd.append('description', 'array test'); fd.append('description', 'second');
  fd.set('type', 'Injury'); fd.set('severity', 'Minor');
  const { res } = await anon.json('/api/incidents', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fd.toString(),
  });
  check('repeated/array params do not 500', res.status === 201 || res.status === 400, `status=${res.status}`);
}
{
  const { res, body } = await anon.json('/api/incidents', form({
    unit: 'UNIT1', type: 'Injury', severity: 'Minor',
    description: 'x'.repeat(20000), // over the cap
  }));
  check('oversized description is capped, not rejected/crashed', res.status === 201, `status=${res.status}`);
  if (body?.id) {
    // length verified below once logged in
    globalThis.__cappedId = body.id;
  }
}
{
  const { res } = await anon.json('/api/incidents', form({
    unit: 'UNIT1', type: 'Injury', severity: 'Minor',
    description: 'bad date test', occurred_at: '99999-01-01T00:00',
  }));
  check('absurd occurred_at does not 500', res.status === 201 || res.status === 400, `status=${res.status}`);
}

// ---------------------------------------------------------------- admin + RBAC
console.log('\nAuthentication & RBAC');
if (!ADMIN_PASS) {
  console.log('  ! ADMIN_PASSWORD not set — skipping authenticated checks');
} else {
  const admin = makeClient();
  check('wrong password rejected (401)', await admin.login(ADMIN_USER, 'definitely-wrong') === 401);
  const code = await admin.login(ADMIN_USER, ADMIN_PASS);
  check('admin login succeeds', code === 200, `status=${code}`);

  if (code === 200) {
    check('csrf token issued', Boolean(admin.csrf));
    {
      const { res, body } = await admin.json('/api/dashboard/stats');
      check('dashboard stats load', res.status === 200 && typeof body?.period?.total === 'number');
      check('monthly trend has 12 buckets', body?.monthly?.length === 12, String(body?.monthly?.length));
      check('todayPkt present', Boolean(body?.todayPkt));
      check('follow-through present', body?.followup && typeof body.followup.investigated === 'number');
      check('needs-attention + overdue lists present', Array.isArray(body?.needsAttention) && Array.isArray(body?.overdueCapa));
    }
    {
      const { res, body } = await admin.json('/api/incidents?page=1');
      check('incident list paginates', res.status === 200 && typeof body?.total === 'number' && body?.page === 1);
    }
    if (globalThis.__cappedId) {
      const { body } = await admin.json('/api/incidents/' + globalThis.__cappedId);
      const len = body?.incident?.description?.length || 0;
      check('description was truncated to the cap', len > 0 && len <= 5000, `len=${len}`);
    }
    // CSRF: a state-changing call without the token must be refused
    {
      const res = await fetch(BASE + '/api/incidents/1/status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ status: 'Closed' }),
      });
      check('cross-origin state change blocked', res.status === 403 || res.status === 401, `status=${res.status}`);
    }
    // audit trail
    {
      const { res, body } = await admin.json('/api/admin/audit?limit=10');
      check('audit trail records entries', res.status === 200 && body?.entries?.length > 0);
      check('audit entry names an actor', Boolean(body?.entries?.[0]?.actor_name));
    }
    // alert outbox
    {
      const { res, body } = await admin.json('/api/admin/alerts');
      check('alert outbox reachable', res.status === 200 && body?.counts !== undefined);
    }
    // system health
    {
      const { res, body } = await admin.json('/api/admin/system');
      check('system health reports storage', res.status === 200 && typeof body?.storage?.usedBytes === 'number');
    }
    // recipients validation
    {
      const { res } = await admin.json('/api/admin/recipients', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'whatsapp', value: '0300' }),
      });
      check('bad WhatsApp number rejected (400)', res.status === 400, `status=${res.status}`);
    }
    // viewer RBAC
    {
      const vName = 'smoke_viewer_' + Date.now();
      const { res: mk } = await admin.json('/api/admin/users', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: vName, password: 'viewer-pass-123', role: 'viewer' }),
      });
      check('admin can create a viewer', mk.status === 201, `status=${mk.status}`);
      const viewerId = (await (await admin.fetch('/api/admin/users')).json()).users.find((u) => u.username === vName)?.id;

      const viewer = makeClient();
      const vCode = await viewer.login(vName, 'viewer-pass-123');
      check('viewer can log in', vCode === 200);
      {
        const { res } = await viewer.json('/api/incidents?page=1');
        check('viewer can read incidents', res.status === 200);
      }
      {
        const { res } = await viewer.json('/api/incidents/1/investigation', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root_cause: 'should be blocked' }),
        });
        check('viewer cannot edit investigation (403)', res.status === 403, `status=${res.status}`);
      }
      {
        const { res } = await viewer.json('/api/admin/users');
        check('viewer cannot reach admin API (403)', res.status === 403, `status=${res.status}`);
      }
      {
        const { body } = await viewer.json('/api/incidents?page=1');
        const anyPii = (body?.incidents || []).some((i) => i.reporter_contact && i.reporter_contact !== '(restricted)');
        check('viewer sees PII restricted', !anyPii);
      }
      // revocation is immediate
      if (viewerId) {
        await admin.fetch('/api/admin/users/' + viewerId, { method: 'DELETE' });
        const { res } = await viewer.json('/api/dashboard/stats');
        check('deleted user loses access immediately (401)', res.status === 401, `status=${res.status}`);
      }
    }
  }
}

// ---------------------------------------------------------------- results
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  • ' + f);
  process.exit(1);
}
console.log('All smoke tests passed. ✓');
