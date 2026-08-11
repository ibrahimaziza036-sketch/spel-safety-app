# SPEL Safety — Go-Live Runbook (production)

Target: run permanently on the office server **192.168.11.6** (the same Windows
box that hosts MS SQL). The app keeps its own built-in **SQLite** as the live
database; a scheduled job also **pushes a copy into MS SQL** for backup/reporting.

## How access works (one QR per unit, IP hidden)

- Each unit gets **one** QR that points to a **public HTTPS hostname**
  (e.g. `https://safety.spelgroup.com/report.html?unit=UNIT1`) via Cloudflare
  Tunnel. **Your server IP is never shown** — only the hostname.
- The report form is an **offline-capable PWA**: once a phone has opened it even
  once, scanning the QR again **opens the form with no internet**. If the worker
  submits while offline, the report is **saved on the phone and sent
  automatically the moment the internet is back** — nothing is lost.
- HTTPS is required for the offline feature (service workers only run over
  HTTPS), which is exactly why we use the Cloudflare hostname, not a raw IP.

> "Never down": this setup auto-recovers from every software failure (crash,
> reboot, WhatsApp drop) and **never loses a report or an alert** (offline queue
> on the phone + durable server queue + crash-safe WAL database). Add a UPS and
> an external uptime check (Step 7). True zero-downtime would need a second
> standby server — ask if you want that later.

---

## 0. Prerequisites (on 192.168.11.6)

- **Node.js 22.5+** — `node -v`
- **git**
- **cloudflared** — `winget install --id Cloudflare.cloudflared`
- A domain on **Cloudflare** you control (e.g. `spelgroup.com`) so you can use a
  stable HTTPS hostname like `safety.spelgroup.com`. (Do **not** use a temporary
  `*.trycloudflare.com` URL for printed posters.)
- MS SQL Server reachable on this box, and a **database + login** for the backup
  copy (e.g. database `SPEL_Safety`, a SQL login with write access to it).

## 1. Get the code

```bash
git clone https://github.com/ibrahimaziza036-sketch/spel-safety-app.git
cd spel-safety-app
```

## 2. One-command setup

```bash
npm run setup
```

Answer the prompts:
- Deployment mode → **2 (Internet)**  — single masked HTTPS QR + offline PWA.
- Public hostname → **safety.spelgroup.com** (your Cloudflare hostname)
- Admin username / password → a **strong** password (write it down)
- WhatsApp alert numbers → e.g. `923444007943,92300…`
- Email backup → **Yes** (so alerts still arrive if WhatsApp drops)
- **Push a daily backup copy into MS SQL Server? → Yes**
  - server `localhost` (or `HOST\INSTANCE`), port `1433`, database name, SQL
    username + password, daily hour (e.g. `2` = 2 AM PKT).

This installs everything (including the MS SQL driver), writes `.env`, creates
the Cloudflare Tunnel + DNS, starts the app under PM2, generates the QR posters,
and runs the smoke test.

## 3. Make it start on boot + auto-restart (Windows)

```bash
npm i -g pm2 pm2-windows-startup && pm2-startup install && pm2 save
```
Verify: reboot the server → `pm2 list` shows `spel-safety` **online**.

## 4. Link WhatsApp (one time)

On the server open `http://localhost:3000/admin.html`, log in, go to **WhatsApp
Connection**, scan the QR with the dedicated SPEL WhatsApp number. Add
management as **Alert Recipients**.

## 5. Print the QR posters

Open `https://safety.spelgroup.com/qr/index.html` and print. **One QR per unit** —
put each on that unit's shop floor.

## 6. MS SQL backup — verify it works

```bash
npm run mssql-sync
```
Expected: `✓ MS SQL push complete: spel_incidents=…, spel_capa=…`. After that it
runs **automatically every day** at the hour you set. The mirrored tables are
`spel_incidents`, `spel_investigations`, `spel_capa`, `spel_notifications_log`,
`spel_audit_log`, `spel_recipients`. (SQLite stays the live DB; MS SQL is the
backup copy — build reports on the `spel_*` tables, or restore from them.)

## 7. Reliability hardening (do these — lives depend on it)

- **UPS** on the server.
- **External uptime monitor** on `https://safety.spelgroup.com/healthz` every
  minute (e.g. UptimeRobot) — the app can't alarm about its own death.
- **Local file backup** too: schedule `npm run backup` daily (Windows Task
  Scheduler) and keep a copy off the server. (MS SQL push + file backup = two
  independent backups.)
- **Protect the public URL** in Cloudflare: **Turnstile** (bot check) sitewide
  and/or **Cloudflare Access** on `/admin.html` + the dashboard. The public
  report form stays open; built-in rate limits blunt a flood.
- **Email backup ON** so a WhatsApp outage never means silence.

## 8. Go-live verification checklist

- [ ] `pm2 list` → online; reboot test passes.
- [ ] Scan a unit QR on a phone → form opens → submit → appears on dashboard →
      WhatsApp (and email) alert received.
- [ ] **Offline test:** open the form once, then turn **airplane mode on**,
      submit → "Report saved on your phone". Turn the internet back on → within
      a few seconds it sends itself and appears on the dashboard.
- [ ] `npm run mssql-sync` succeeds and rows appear in the `spel_*` MS SQL tables.
- [ ] Void the test incidents afterwards so real stats stay clean.
- [ ] Admin password is strong and recorded safely.

## Day-to-day commands

```bash
pm2 logs spel-safety      # live logs
pm2 restart spel-safety   # after a config change
npm run mssql-sync        # push to MS SQL now
npm run backup            # local file backup now
npm run qr                # regenerate posters
```

---

### Optional: on-site LAN fallback

If you also want the form reachable directly on the factory LAN during a **total
internet outage** (not just queued on the phone), set `LAN_BASE_URL=http://192.168.11.6:3000`
in `.env` and re-run `npm run qr` — posters then get a second "On factory Wi-Fi"
QR. Note the **offline PWA only works over the HTTPS hostname**, so the LAN QR is
a plain online-only fallback. For most cases the offline PWA already covers
internet outages, so a single masked QR is recommended.
