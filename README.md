# SPEL Safety App — Incident Reporting & Alerting

Ek simple, self-hosted system taake **koi bhi worker phone se QR scan kar ke incident report kare**, aur
**management ko foran email + WhatsApp alert** chala jaye. Phir safety officer detailed
investigation (root cause + CAPA) bhare, aur management ek live **dashboard** pe dekhe kis unit
mein sab se zyada incidents ho rahe hain.

---

## Ismein kya kya hai

| Module | Kaam |
|---|---|
| **Initial Report** | QR-driven mobile form, bina login. Submit hote hi alert. |
| **Instant Alerts** | Email (SMTP) + WhatsApp (whatsapp-web.js) sab management ko. |
| **Investigation** | Kya/kaise hua, 5-Why root cause, immediate actions. |
| **CAPA** | Corrective/Preventive actions — owner + due date + status tracking. |
| **Dashboard** | Unit-wise, severity-wise, type-wise, monthly trend, overdue actions, days-since-last. |
| **Login & roles** | viewer / safety_officer / admin. Report form public rehta hai; baaki sab login ke peeche. |
| **Admin** | Users banao, WhatsApp QR link karo, email test karo, notification log dekho. |

---

## Requirements

- **Node.js 22.5+** (built-in SQLite ke liye) — `node -v` se check karo. Yahan 24 par test hua.
- Ek server/PC jo hamesha chalta rahe (jaise office ka ek PC ya VM).
- WhatsApp alerts ke liye: ek **dedicated phone number** with WhatsApp installed.
- Email alerts ke liye: SMTP details (Office 365 / Gmail / koi bhi).

---

## Setup — 5 steps

```bash
# 1. Dependencies install karo (pehli dafa ~1-2 min, Chromium download hota hai)
npm install

# 2. Config file banao
copy .env.example .env        # Windows
# cp .env.example .env        # Mac/Linux

# 3. .env ko edit karo (neeche "Configuration" dekho) — emails, WhatsApp numbers, SMTP

# 4. App chalao
npm start

# 5. Har unit ka QR code banao (print karne ke liye)
npm run qr
```

Ab browser mein kholo:
- Login:      `http://localhost:3000/login.html`  (default: `admin` / jo `ADMIN_PASSWORD` `.env` mein set kiya)
- Dashboard:  `http://localhost:3000/`  (login zaroori)
- Report:     `http://localhost:3000/report.html?unit=UNIT1`  (public — koi login nahi)
- Admin:      `http://localhost:3000/admin.html`  (sirf admin)
- QR posters: `http://localhost:3000/qr/index.html`

> **Pehli dafa login:** app boot par ek admin banata hai (`ADMIN_USERNAME` / `ADMIN_PASSWORD` `.env` se).
> Agar `ADMIN_PASSWORD` blank ho to ek random password bana kar console pe print hota hai — usay note kar lo.

> **Demo data:** dashboard bhara hua dekhna ho to `node --disable-warning=ExperimentalWarning scripts/seed.js`
> chalao. Reset karne ke liye `data/safety.db` delete kar ke app dobara start karo.

---

## Configuration (`.env`)

| Key | Matlab |
|---|---|
| `BASE_URL` | Jo URL phones/browsers use karenge. LAN par server PC ka IP, e.g. `http://192.168.1.50:3000`. Emails/WhatsApp ke links isi se bante hain. |
| `MANAGEMENT_EMAILS` | (Optional seed) emails jinko alert jaye. **Behtar:** Admin → Alert Recipients se manage karo. |
| `MANAGEMENT_WHATSAPP` | (Optional seed) numbers. **Behtar:** Admin → Alert Recipients se add karo (0300… bhi chalega). |
| `SMTP_HOST/PORT/USER/PASS` | Email bhejne ke liye. Office 365: `smtp.office365.com`/`587`. |
| `WHATSAPP_ENABLED` | `true`/`false`. |
| `WHATSAPP_MIN_SEVERITY` | Is severity se upar WhatsApp jayega (email sab ke liye jata hai). |

---

## WhatsApp link karna (pehli dafa)

1. `.env` mein `WHATSAPP_ENABLED=true` set karo, app start karo.
2. Server par `http://localhost:3000/admin.html` kholo — QR nazar aayega
   (ya terminal mein bhi QR print hota hai).
3. Dedicated SPEL WhatsApp number wale phone par: **WhatsApp → Linked Devices → Link a Device** → QR scan karo.
4. Status **"Connected ✓"** ho jaye to alerts active hain. Session save rehti hai — dobara scan nahi karna padta.

> ⚠️ whatsapp-web.js **unofficial** hai (WhatsApp Web ko automate karta hai). Internal safety
> alerts (kam volume) ke liye theek. Bulk/spam bhejne pe number ban ho sakta hai — sirf
> management alerts ke liye use karo.

---

## Login & roles

| Role | Kya kar sakta hai |
|---|---|
| **viewer** | Dashboard aur incidents dekh sakta hai (read-only). |
| **safety_officer** | Upar wala + investigation, CAPA, status edit kar sakta hai. |
| **admin** | Sab kuch + Admin page (users banana, WhatsApp/email setup, logs). |

- **Report form (`/report.html`) hamesha public** hai — worker bina login QR se report karta hai.
- Baaki har page/API login maangta hai; edit sirf safety_officer/admin; Admin page sirf admin.
- Naye users **Admin → Users & Roles** se banao. Pehle admin ka password first login ke baad zaroor change karo (naya admin banao, purana delete karo — ya `.env` mein `ADMIN_PASSWORD` edit karke DB reset).

## LAN par sab ke liye chalana

Taake har koi apne phone se access kare (same office WiFi/network):

1. Server PC ka IP nikalo: `ipconfig` (Windows) → e.g. `192.168.1.50`.
2. `.env` mein `BASE_URL=http://192.168.1.50:3000` set karo.
3. Windows Firewall mein port `3000` inbound allow karo.
4. Phone ko usi WiFi se connect kar ke `http://192.168.1.50:3000/report.html?unit=UNIT1` kholo.

Internet/multiple sites se access chahiye ho to ye VPN ke andar ya ek proper server pe host karo
(ya reverse proxy + HTTPS ke saath). Ismein poochh lena, main help kar dunga.

## 24/7 chalta rehna (Windows)

`npm start` band ho jaye to app ruk jayegi. Hamesha chalane ke liye **PM2**:

```bash
npm install -g pm2
pm2 start server.js --name spel-safety --node-args="--disable-warning=ExperimentalWarning"
pm2 save
pm2 startup   # boot par auto-start ke liye jo command bataye woh chalao
```

---

## Data kahan hai

| Cheez | Path | Note |
|---|---|---|
| Database | `data/safety.db` | SQLite (+ `-wal`, `-shm` files) |
| Incident photos | `data/uploads/` | Web root se **bahar**; sirf login ke saath serve hote hain. `UPLOAD_DIR` se badla ja sakta hai |
| WhatsApp session | `data/.wwebjs_auth/` | ⚠️ **Ye ek credential hai** — isay share/backup na karo. Delete karoge to dobara QR scan |
| WhatsApp cache | `data/.wwebjs_cache/` | Safely deletable |
| Backups | `backups/` | `npm run backup` se banti hain |

> ⚠️ `data/` folder mein **injury photos aur logon ke naam** hote hain — isay confidential samjho.
> Windows par folder ko **BitLocker** se encrypt karo aur `data/` ki NTFS permissions sirf service account tak mehdood karo.

### Backup (sahi tareeqa)

`safety.db` ko chalte hue seedha copy **na** karo — WAL ki wajah se adhoora (torn) snapshot mil sakta hai. Isko use karo:

```bash
npm run backup
```

Ye ek consistent snapshot (`VACUUM INTO`) banata hai, `integrity_check` se verify karta hai, photos bhi copy karta hai, aur `.env` ke secrets redact kar deta hai. Kisi doosri machine / encrypted drive par le jao, aur **restore ko kabhi kabhi test bhi karo**.

---

## Security & data governance

**Access**
- **Admin password:** pehli login ke baad `ADMIN_PASSWORD` (`.env`) zaroor change karo — ya Admin → Users se naya admin bana ke purana delete karo.
- **Brute-force:** login par throttle (per-IP + global ceiling); 8 galat koshishon ke baad block.
- **Roles live:** role change/delete karte hi session foran revoke (har request par DB se re-check).
- **CSRF:** har state-changing request par Origin check + per-session token.
- **Viewer role** ko injured-person naam, reporter contact aur photos **nahi** dikhte (restricted).
- **HTTPS (internet exposure):** TLS lagao, `.env` mein `COOKIE_SECURE=true` aur `TRUST_PROXY_HOPS=<hop count>` set karo. Production mein `SESSION_SECRET` set karna **zaroori** hai warna app boot nahi karega.

**Abuse control (public QR endpoint)**
- Per-IP `INTAKE_PER_IP_PER_HOUR` (default 20) + global `INTAKE_GLOBAL_PER_HOUR` (default 300).
- Photo storage cap `MAX_UPLOAD_DIR_BYTES` (default 2 GB) — cap par photos refuse hoti hain, **reports phir bhi accept** hoti hain.
- Field length caps; oversized text truncate ho jata hai, request fail nahi hoti.
- Alerts ek **bounded queue** se jate hain (`NOTIFY_MAX_PER_WINDOW`) + circuit-breaker — WhatsApp number spam-ban se bacha rehta hai.

**Alert reliability**
- Alerts ek **durable outbox** mein jate hain aur retry hote hain (exponential backoff). WhatsApp disconnect ho to reconnect hote hi queue flush ho jati hai.
- Jo alert nahi gaya wo **Admin → Alert Delivery** mein dikhta hai, manual retry ke saath.

**Accountability / compliance**
- **Audit trail:** har change (kaun, kab, kya — before/after) permanent record hota hai. Incident page par "Record History" aur Admin par poora trail.
- `investigated_by` **login se** aata hai, type nahi kiya ja sakta.
- Incident **edit** karne ke liye reason zaroori; record **void** hota hai (delete nahi) — evidence mehfooz.
- **Retention:** notification log `RETENTION_NOTIFICATION_LOG_DAYS` (default 180 din) ke baad prune; orphan photos cleanup. Incident records default par hamesha rakhe jate hain (OHS retention) — `RETENTION_INCIDENT_DAYS` se badla ja sakta hai.
- **Data-subject requests:** Admin API se ek incident ka poora record export (`/api/admin/export/incident/:id`) ya personal details redact (`/api/admin/redact/incident/:id`) ho sakta hai.

**Ops**
- `/healthz` (process alive) aur `/readyz` (DB + channels ki asli halat).
- **Graceful shutdown:** SIGTERM/SIGINT par connections close, WAL checkpoint, Chromium destroy. PM2 use karo taake restart clean ho.
- Sessions **DB mein** save hoti hain — restart par log-out nahi hote.
- `npm run smoke` — poora end-to-end regression test (auth, RBAC, abuse controls, audit trail).

> **Testing:** teen independent adversarial audits chalaye gaye (app build, auth layer, poora quality/security audit). Saare confirmed findings fix + verify kiye gaye. Report: [AUDIT_REPORT.md](AUDIT_REPORT.md).

### Ek accepted risk (management ka faisla)

Alerts mein **injury photo aur naam** jaate hain (WhatsApp + email) — ye jaan-boojh kar rakha gaya hai taake emergency mein management ko foran poori tasveer mile. Iska matlab ye PII personal phones par permanently reh jata hai. Kam karna ho to `.env` mein `WHATSAPP_MIN_SEVERITY` barha do, ya kaho to minimal-alert mode (sirf ref + secure link) bana dein.

## Troubleshooting — WhatsApp messages nahi ja rahe

whatsapp-web.js unofficial hai, to Chromium ka page kabhi kabhi "detach" ho jata hai — client `ready` dikhata hai magar send fail hote hain (`detached Frame` error). App ab isay **khud pakadta hai** aur reconnect kar leta hai (send-failure par foran, warna har 60s ki health-check par). Phir bhi masla ho to:

1. **Admin → 📤 Alert Delivery** dekho — jo alert nahi gaya wo yahan dikhta hai, `Retry` button ke saath.
2. **Admin → 📱 WhatsApp Connection** state check karo. Agar `Disconnected`/`Error` ho to page thodi der baad refresh karo (auto-reconnect chal raha hota hai), ya app restart karo (`pm2 restart spel-safety`).
3. State `Waiting for QR scan` ho gaya → linked device logout ho gaya; QR dobara scan karo.
4. Recipient number sahi format mein hai? (`923001234567` — Admin → Alert Recipients).
5. Aakhri chara: app restart — fresh Chromium se client saaf ho jata hai, aur queue mein rukay alerts khud send ho jate hain (kuch bhi lost nahi hota).

> Alerts ek **durable queue** mein hain — WhatsApp thodi der down ho to bhi alert **lost nahi hota**, reconnect hote hi chala jata hai.

### "WhatsApp kabhi band na ho" — reliability layers

App mein ye sab laga hai taake WhatsApp outage silent na rahe aur khud recover ho:

1. **Auto-reconnect** — disconnect/`detached frame`/hung-init sab par khud dobara connect (15s→2min backoff).
2. **Health-probe (har 60s)** — cached "ready" par bharosa nahi; asal `getState()` se check.
3. **Watchdog** — 3 min se zyada down rahe to poora client force-restart.
4. **Durable queue** — outage mein alerts queue hote hain, reconnect par khud send (kuch lost nahi).
5. **Down-alarm** — 5 min se zyada down ho to **admins ko EMAIL** + dashboard par bada laal banner + audit log.
6. **Escalation** — koi alert saari koshishon ke baad bhi na jaye to us incident ka **email** admins ko.

> ⚠️ **AHEM:** free `whatsapp-web.js` (browser automation) **100% guarantee kabhi nahi de sakta** — WhatsApp Web update, phone offline, ya number-ban se ruk sakta hai. Isay "kabhi miss na ho" banane ke liye **ek doosra channel zaroori hai:**
> - **Email ON karo** (`.env`: `EMAIL_ENABLED=true` + SMTP + Alert Recipients mein email) — ye down-alarm aur backup dono deta hai. **Abhi email OFF hai, is liye backup dormant hai.**
> - **Production-grade WhatsApp** chahiye to **official WhatsApp Business API** (Twilio/Meta) par jao — browser nahi, ban risk nahi, 99.9% uptime (per-message choti cost).
> - **SMS fallback** (kisi Pakistani SMS gateway se) bhi laga sakte hain — sab se reliable local channel.

## Aage kya add kar sakte hain (roadmap)

- Email/WhatsApp **escalation** agar incident time pe close na ho
- PDF export of full incident report
- Scheduled weekly safety summary to management
- SAP / HR se employee master link
- Minimal-alert mode (PII app ke andar hi rahe)

Koi bhi feature chahiye ho to bata dena.
