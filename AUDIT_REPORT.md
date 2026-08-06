# SPEL Safety App — Quality & Security Audit Report

**Date:** 2026-08-06
**Scope:** Full application — security (CSRF/abuse/DoS, injection, access control), correctness/logic, privacy & data lifecycle, robustness/operations, code quality.
**Method:** 5 independent audit passes; every finding then adversarially verified against the source before being accepted (false alarms discarded).
**Result:** **53 confirmed findings** — 0 Critical, 2 High, 23 Medium, 27 Low, 1 Info.

---

## ✅ REMEDIATION STATUS — all findings addressed (2026-08-06)

Every confirmed finding below has been fixed and verified (`npm run smoke` — 33/33 passing),
**except one deliberately accepted risk** (see note).

| Area | What changed |
|---|---|
| **Public endpoint abuse (both HIGH)** | Per-IP (20/hr) + global (300/hr) rate limit; total photo-storage cap (at cap, reports still work without photos); `UPLOAD_DIR` can point at a separate volume; field length/count/body caps; scalar coercion; INSERT in a transaction with photo cleanup on failure |
| **Notification storm / WhatsApp ban** | Durable outbox + bounded worker (concurrency, per-window send cap, circuit breaker) with exponential-backoff retry |
| **Alert reliability** | Email + WhatsApp dispatched independently; SMTP timeouts; per-send WhatsApp timeout; attachment readability guard; WhatsApp auto-reconnect with backoff; queue flush on reconnect; undelivered alerts surfaced in Admin with manual retry |
| **CSRF** | Origin/Referer allowlist + per-session double-submit token; `urlencoded` scoped to the public intake route only |
| **Audit trail / accountability** | Append-only `audit_log` (actor from session, server clock, before/after diff); `investigated_by` server-set; `updated_at`; reason-required edit route; void/restore instead of delete; history shown on the incident page + Admin viewer |
| **Login hardening** | Async scrypt (off the event loop); bounded per-IP + global throttle; `TRUST_PROXY_HOPS` for the true client IP; stronger generated admin password |
| **Session** | SQLite-backed store (survives restart, prunes expired); `Secure` cookie via `COOKIE_SECURE`; HSTS when on HTTPS |
| **Privacy** | Viewer role cannot see injured-person names, reporter contacts or photos; photo route restricted to officer/admin; privacy notice on the report form; export + redaction endpoints for data-subject requests; at-rest encryption guidance |
| **Correctness** | `occurred_at` parsed as PKT and sanity/future-clamped; PKT-correct CAPA overdue (server + client); pagination with totals; numeric + transactional `ref_no`; `statusBadge` escaping; strict PK WhatsApp number validation; voided records excluded from all statistics |
| **Ops** | Graceful shutdown (WAL checkpoint + Chromium destroy); `/readyz` with real dependency checks; retention/cleanup job + Admin panel; verified `VACUUM INTO` backup script; generic 5xx messages; `uncaughtException` now exits for a clean supervisor restart; shared time/path utils; fixed docs, `.gitignore`, pinned Node range |

**Verification:** after remediation, two further adversarial passes checked the fixes themselves.
The first found 8 High + 17 Medium regressions the remediation had introduced (e.g. all timestamps
displaying in UTC instead of PKT, viewer PII leaking through audit history, the photo route using a
stale role, a partial WhatsApp failure re-sending to delivered recipients); all were fixed. A second
pass confirmed 30 of those fixes correct and found 5 smaller follow-ups (all fixed). The app now
passes an automated end-to-end regression suite (`npm run smoke`, 33/33).

**Accepted risk (management decision):** injury photos and names continue to be sent in
email/WhatsApp alerts, so responders get the full picture immediately. The trade-off is that this
PII lands permanently on personal phones. Mitigations in place: viewer-role redaction in-app,
photo access restricted to officer/admin, privacy notice on the form, and redaction/export tooling.
`WHATSAPP_MIN_SEVERITY` can reduce volume, and a minimal-alert mode remains available as an option.

---

## 1. Overall verdict

**Core theek hai — koi critical loophole nahi.** Baseline security genuinely solid hai:

- ✅ No SQL injection (saari queries parameterised)
- ✅ No RCE, no auth bypass, no privilege escalation
- ✅ Output escaping (stored XSS closed), CSP + `nosniff` + `X-Frame-Options`
- ✅ Session regenerate on login, immediate privilege revocation, login brute-force throttle
- ✅ Uploads web root se bahar, sirf authenticated route se serve

**Lekin ek structural loophole hai:** public (bina login) `POST /api/incidents` — QR reporting endpoint — par **koi abuse control nahi** (no rate limit, no storage cap, no field caps). Dono HIGH findings isi ek darwaze se aate hain:

1. **Disk-exhaustion outage** — 10MB uploads ki flood; `data/uploads` aur `safety.db` ek hi disk par hain → disk full → `SQLITE_FULL` → **poora system band** (reporting, investigation, CAPA, dashboard).
2. **Notification storm / WhatsApp ban** — har submission par email + WhatsApp sab recipients ko jata hai; flood se **company ka WhatsApp number permanently ban** ho sakta hai = primary alert channel khatam.

Life-safety alerting system mein availability outage hi worst case hai. Trusted LAN par risk kam hai — **lekin QR URL internet par expose karne se pehle "Fix now" karna zaroori hai.**

**Doosra theme (hack nahi, compliance risk):** accountability kamzor hai — kaun ne investigation/CAPA/status edit ki iska koi audit trail nahi, `investigated_by` client-supplied hai, records silently mutable hain. ISO 45001 / OSHA / litigation ke liye evidentiary value kam hai.

---

## 2. 🔴 FIX NOW — public darwaze ko lock karo (internet exposure se pehle)

| Sev | Issue | Fix |
|---|---|---|
| **High** | `POST /api/incidents` public + **no rate limit**; 10MB uploads `safety.db` wali disk par → disk full → **full app outage** | Per-IP + global rate limit; storage cap + cleanup job; **uploads ko DB se alag volume par** |
| **High** | Har report par email + WhatsApp sab ko (default `WHATSAPP_MIN_SEVERITY=Minor`) → flood se **WhatsApp number ban** | Create route rate-limit; notifier ko **bounded queue** (concurrency + per-window cap) + dedupe; default min-severity Serious/Major; circuit-breaker |
| Med | Wahi missing limit = **unbounded DB bloat / junk data** dashboards mein | Rate limit se cover; optional "pending/moderation" state |
| Med | Text fields par **koi length/count cap nahi** (~1MB/field, unlimited fields) → memory + oversized email/WhatsApp | multer `limits {fields, fieldSize}`; `json/urlencoded` limit; description ≤5–10k, names ≤200 → 400/413 |
| Med | CREATE array/object body params coerce nahi karta → `description[]=a&b` se **unhandled 500**, aur 10MB photo **orphan** | LIST wala `scalar()` coercion; `typeof==='string'` check; INSERT try/catch + `unlink` |

---

## 3. 🟠 SHOULD FIX SOON — alert reliability + audit trail

| Sev | Issue | Fix |
|---|---|---|
| Med | **Same-site CSRF**: global `express.urlencoded()` se sibling `*.spelgroup.com` origin se form-POST → **backdoor admin** ban sakta hai | Unused global `urlencoded` hatao; Origin/Referer allowlist **ya** CSRF token |
| Med | Login `scryptSync` event loop block karta hai; `trust proxy` misconfig par 8 fails se **sab lock out** | Async hashing; `trust proxy` real hop count; true client IP |
| Med | Login throttle `Map` **unbounded** grow karta hai, spoofable IP | TTL/LRU + hard cap + periodic sweep |
| Med | `occurred_at` server-local timezone mein parse, baaki app UTC assume karta hai → UTC host par **+5h skew**, galat PKT day/month buckets | Naive string ko UTC+5 maano (ya client se offset/`Z`); `TZ=UTC` regression test |
| Med | **Alerts fire-and-forget, koi retry/queue nahi** → WhatsApp reconnect ya SMTP blip ke waqt **Fatal alert silently lost** | Pending alert persist + retry on `ready` event; unsent high-severity alerts admin UI mein dikhao |
| Med | Email **pehle await** hota hai WhatsApp se, aur nodemailer ke **timeouts nahi** → dead SMTP se WhatsApp alert minutes late | `Promise.allSettled`; connection/greeting/socket timeouts |
| Med | WhatsApp disconnect/Chromium crash ke baad **koi reconnection nahi** → channel dead till manual restart | Backoff `destroy()`+re-init on `disconnected`; health probe; admin ko email |
| Med | **Koi audit trail nahi**: edits in-place, `investigated_by`/`investigated_at` forgeable, status PATCH mein actor nahi, in-app incident edit route nahi | Append-only `audit_log` (actor `req.session.user` se, before/after, server timestamp) same transaction mein; `updated_at`; role-gated edit route |
| Med | **Health/injury PII** unofficial WhatsApp + email attachment se personal phones par permanently | **Minimal alert** bhejo (ref/unit/type/severity + secure login link); PII/photo dekhne ke liye app login |
| Med | **Backup guidance unsafe**: "copy .db" torn WAL, `-wal/-shm` aur `data/uploads` (photos) miss, unencrypted | `VACUUM INTO`/`.backup`; `data/uploads` include; encrypt + rotate; restore test + `integrity_check` |
| Med | `uncaughtException` handler **fatal errors nigal jata hai** → zombie process `/healthz` green deta hai magar alert nahi kar sakta | Log → flush → `process.exit(1)`; PM2 clean restart kare |
| Med | `GET /api/incidents` **LIMIT 500, no pagination** → 500 se zyada hone par purane incidents UI se ghayab | Pagination + total count (ya minimum `truncated:true` flag) |

---

## 4. 🟢 NICE TO HAVE — hygiene, privacy governance, robustness

**Correctness / edge cases**
- `occurred_at` extreme years → malformed ref_no / `RangeError` 500 / arbitrary backdating → sane window validate karo
- CAPA "overdue" UTC "today" use karta hai, PKT nahi → 00:00–05:00 PKT mein under-count
- Future-dated `occurred_at` `MAX()` poison karta hai → "days since last" **0** dikhata hai
- `ref_no` string-sort (9999 ke baad break) + non-atomic read-then-insert (multi-process par collide)
- INSERT throw hone par uploaded photo orphan
- Unreadable attachment se **poori email** sab recipients ke liye fail
- WhatsApp loop mein per-send timeout nahi → ek hung recipient baaki sab ke alerts rok deta hai
- `statusBadge()` escape nahi karta (aaj safe, latent XSS)

**Privacy / data lifecycle**
- PII (names, contacts, injury photos) **unencrypted at rest** → BitLocker/volume encryption + `data/` ACLs
- Koi **retention/purge policy** nahi; `notifications_log`, incidents, photos hamesha barhte hain
- Koi soft-delete/void nahi; hard delete **cascade** karke linked evidence tabah kar deta hai
- Injury photos + PII **har authenticated user** (including `viewer`) parh sakta hai → safety_officer/admin tak gate karo
- Koi data-subject search/export/erasure nahi; third-party (injured person) PII ke liye consent/privacy notice nahi

**Operations / docs**
- README photos ko `public/uploads` batata hai — asal path `data/uploads` → **operator galat folder backup karega**
- `.wwebjs_cache` repo root mein likhta hai, git-ignored nahi; `data/.wwebjs_auth` ek **WhatsApp credential** blob hai (docs mein flag nahi)
- `node:sqlite` experimental; Node `engines` sirf floor hai → tested version pin karo
- `express-session` default MemoryStore (leak, restart par khatam) → SQLite-backed store
- Koi **graceful shutdown** nahi → WAL checkpoint nahi, Chromium zombie
- `refreshSession` har request (static assets samet) par sync DB query → static skip / short TTL cache
- Global error handler raw `err.message` return karta hai → 5xx par generic message
- `/healthz` hamesha `ok:true` → `/readyz` with `SELECT 1` + subsystem state
- Duplicated `nowIso()` + hardcoded PKT offset 4 modules mein → shared util

---

## 5. Leadership summary (one paragraph)

The SPEL Safety App is **well-built at its core** — no injection, no auth bypass, no data-breach-class hole. **Ek hi bara masla hai:** the public QR-report endpoint has no abuse protection, and because uploads share a disk with the database, a flood can take the whole system offline or get the WhatsApp alert number banned. Fixing the 5 "Fix now" items — essentially **rate limiting + input caps on `POST /api/incidents`, and separating uploads from the DB disk** — removes most of the availability risk. The "Should fix soon" set is about **reliable alert delivery and a proper audit trail**, which matter because this is a safety/compliance record. The rest is hygiene and privacy governance. **Do not expose the QR URL to the internet until the "Fix now" items are done.**
