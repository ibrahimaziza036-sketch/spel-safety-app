# SPEL Safety — Go-Live Runbook (production)

Target: run permanently on the office server **192.168.11.6** (the same Windows
box that hosts MS SQL). The app keeps its own built-in **SQLite** database — it
does **not** use MS SQL, so there is no extra database service that can go down.

Two ways in, both from one QR poster per unit:
- **Factory Wi-Fi (LAN):** `http://192.168.11.6:3000` — works **even if the
  internet line is down**, as long as the phone is on the factory Wi-Fi.
- **Mobile data / outside:** `https://<your-hostname>` — via Cloudflare Tunnel.

> Reality check on "never down": a single server can still be taken out by power
> loss or hardware failure. This runbook makes the app **auto-recover** from every
> software failure (crash, reboot, WhatsApp drop) and **never lose a report or an
> alert** (durable queue + crash-safe WAL database). For the last mile, add a UPS
> and an external uptime check (Step 7). True zero-downtime would need a second
> standby server — ask if you want that later.

---

## 0. Prerequisites (on 192.168.11.6)

- **Node.js 22.5+** (for built-in SQLite). Check: `node -v`
- **git** (to clone/pull), or copy the folder over.
- **cloudflared** (for the public URL): `winget install --id Cloudflare.cloudflared`
- A domain on **Cloudflare** you control (e.g. `spelgroup.com`), so you can use a
  stable hostname like `safety.spelgroup.com`. (A random `*.trycloudflare.com`
  URL is temporary — do **not** use it for printed QR posters.)

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
- Deployment mode → **3 (Both)**
- Server LAN IP → **192.168.11.6**
- Public hostname → **safety.spelgroup.com** (your Cloudflare hostname)
- Admin username / password → set a **strong** password (write it down)
- WhatsApp alert numbers → e.g. `923444007943,92300…`
- Email backup → **Yes** recommended (so alerts still arrive if WhatsApp drops)

This installs dependencies, writes `.env` (with `BASE_URL` = public and
`LAN_BASE_URL` = `http://192.168.11.6:3000`), creates the Cloudflare Tunnel +
DNS, starts the app under PM2, generates the **dual-QR** posters, and runs the
smoke test.

## 3. Make it start on boot + auto-restart (Windows)

PM2 keeps the app alive if it crashes. To also survive a **reboot**:

```bash
npm i -g pm2 pm2-windows-startup
pm2-startup install
pm2 save
```

Verify: reboot the server, then `pm2 list` should show `spel-safety` **online**.

## 4. Open the LAN port in Windows Firewall

So phones on the factory Wi-Fi can reach `192.168.11.6:3000` (run as
Administrator):

```powershell
New-NetFirewallRule -DisplayName "SPEL Safety 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

## 5. Link WhatsApp (one time)

On the server, open `http://localhost:3000/admin.html`, log in as admin, go to
**WhatsApp Connection**, and scan the QR with the **dedicated SPEL WhatsApp
number** (WhatsApp → Linked Devices). You only do this once; the session
persists and auto-reconnects.

Add alert recipients under **Admin → Alert Recipients** (WhatsApp numbers /
emails of management).

## 6. Print the QR posters

Open `http://192.168.11.6:3000/qr/index.html` and print. Each unit has **two**
QR codes:
- 📶 green = **On factory Wi-Fi** (use this on-site; works with no internet)
- 📱 blue = **Mobile data / outside**

Put each unit's poster on that unit's shop floor.

## 7. Reliability hardening (do these — lives depend on it)

- **UPS** on the server so a power blip doesn't take it down.
- **External uptime monitor** hitting `https://<hostname>/healthz` every minute
  (e.g. UptimeRobot / a ping from another PC) so you're told immediately if the
  whole box dies — the app can't alarm about its own death.
- **Automatic backups**: schedule `npm run backup` daily via Windows Task
  Scheduler (backs up the SQLite DB + photos). Keep a copy off the server.
- **Protect the public URL**: in Cloudflare, enable **Turnstile** (bot check) in
  front of the site and/or **Cloudflare Access** on `/admin.html` and the
  dashboard. The public report form stays open (workers need it); the built-in
  rate limits already blunt a flood.
- **Email backup ON** so a WhatsApp outage never means silence.

## 8. Go-live verification checklist

- [ ] `pm2 list` → `spel-safety` online; reboot test passes.
- [ ] Phone on **factory Wi-Fi**, turn **mobile data off** → scan the green QR →
      form opens, submit a test → appears on the dashboard.
- [ ] Phone on **mobile data only** → scan the blue QR → form opens → submit →
      appears on the dashboard.
- [ ] Test incident fired a **WhatsApp** alert (and email, if enabled).
- [ ] Void the two test incidents afterwards (Admin can void from the incident
      page) so real stats stay clean.
- [ ] Admin password is strong and recorded somewhere safe.

## Day-to-day commands

```bash
pm2 logs spel-safety      # live logs
pm2 restart spel-safety   # restart after a config change
npm run backup            # manual backup
npm run qr                # regenerate posters (after changing units/URLs)
```
