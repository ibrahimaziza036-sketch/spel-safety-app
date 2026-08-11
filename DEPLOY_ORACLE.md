# SPEL Safety — Deploy on Oracle Cloud (Always Free)

A forever-free, always-on Ubuntu server that runs the whole app (WhatsApp alerts,
public HTTPS QR, offline PWA, dashboard). No inbound ports are opened — traffic
comes in through a **Cloudflare Tunnel** (outbound-only), which is both simpler
and safer.

> **Data/MS SQL note:** this server is in the cloud, so it **cannot reach the
> factory MS SQL** on 192.168.11.6. Leave the MS SQL backup **OFF** and rely on
> the built-in file backups (Step 9). A factory link can be added later.

---

## 0. One prerequisite — a domain on Cloudflare (for a stable QR URL)

- Best: use a company domain (e.g. **spelgroup.com**) — add it to a **free**
  Cloudflare account (change its nameservers to Cloudflare). Then you'll use
  `safety.spelgroup.com`.
- No domain? A cheap one (~$1–10/year, e.g. a `.xyz`) added to Cloudflare works.
- Just want to test **right now for free** without a domain? You can use a
  temporary `https://<random>.trycloudflare.com` URL (Step 7 note) — but it
  **changes on every restart**, so it's fine for testing, **not** for printed QR
  posters.

## 1. Create the free server

1. Sign up at **oracle.com/cloud/free** (a card is needed for identity — Always
   Free resources are never charged). Pick a **home region** close to Pakistan
   (e.g. Mumbai / UAE / Singapore) for lower latency.
2. **Compute → Instances → Create instance:**
   - Image: **Ubuntu 24.04** (Canonical Ubuntu).
   - Shape: **Ampere (ARM) — VM.Standard.A1.Flex**, set **2 OCPU / 12 GB RAM**
     (well within Always Free). If you see *"Out of capacity"*, try another
     availability domain/region, or retry later (Ampere is popular). Fallback:
     the AMD **VM.Standard.E2.1.Micro** (1 GB — tighter, but works).
   - Add your **SSH public key** (or let it generate one and download it).
   - Create. Note the instance's **public IP**.
3. You do **not** need to open any ports in the VCN security list — the tunnel is
   outbound-only.

## 2. Connect

From your PC:
```bash
ssh -i <your-key> ubuntu@<PUBLIC_IP>
```

## 3. Install Node 22, Chromium, cloudflared

```bash
sudo apt update && sudo apt -y upgrade
# Node.js 22 (has built-in SQLite; ARM64 build)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v      # must be >= 22.5

# Chromium for WhatsApp (ARM — use the system browser, not Puppeteer's)
sudo snap install chromium
which chromium      # note the path, usually /snap/bin/chromium

# cloudflared (ARM64)
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

## 4. Get the code + install dependencies

```bash
git clone https://github.com/ibrahimaziza036-sketch/spel-safety-app.git
cd spel-safety-app
# IMPORTANT on ARM: skip Puppeteer's Chromium download (there is no ARM build;
# we use the system Chromium from Step 3). Without this, npm install can fail.
export PUPPETEER_SKIP_DOWNLOAD=true
npm install
```

## 5. One-command setup

```bash
npm run setup
```
Answers:
- Deployment mode → **2 (Internet)**
- Public hostname → **safety.spelgroup.com** (your Cloudflare hostname)
- Admin username / **strong** password (write it down)
- WhatsApp alert numbers → e.g. `923444007943,9230…`
- Email backup → **Yes** (recommended)
- MS SQL backup → **No** (this cloud server can't reach the factory MS SQL)

A browser-login step for Cloudflare will print a URL — open it on **your PC's
browser**, authorize, done. The tunnel + DNS + PM2 + QR posters are set up
automatically.

## 6. Point the app at the system Chromium (ARM)

```bash
nano .env
# set this line to the path from Step 3:
#   WHATSAPP_CHROME_PATH=/snap/bin/chromium
# (also confirm WHATSAPP_HEADLESS=true)
pm2 restart spel-safety
```

## 7. Start on boot + keep alive

```bash
pm2 startup systemd     # prints a `sudo …` command — copy & run it
pm2 save
```
Now the app auto-starts on reboot and auto-restarts on crash.

> **No-domain test option:** to see it working before DNS is ready, run
> `cloudflared tunnel --url http://localhost:3000` — it prints a temporary
> `https://<random>.trycloudflare.com` URL that works immediately (not for
> printed posters).

## 8. Link WhatsApp (from anywhere)

Open **https://safety.spelgroup.com/admin.html** in your browser → log in →
**WhatsApp Connection** → scan the QR with the dedicated SPEL WhatsApp number.
Add management under **Alert Recipients**. Then print posters from
**https://safety.spelgroup.com/qr/index.html** — one QR per unit.

## 9. Backups + monitoring (do these)

```bash
# daily file backup at 02:00 (SQLite DB + photos) via cron
( crontab -l 2>/dev/null; echo "0 2 * * * cd $HOME/spel-safety-app && /usr/bin/npm run backup >> backup.log 2>&1" ) | crontab -
```
- Copy the `backups/` folder off the server periodically (or to Oracle Object
  Storage — also free tier).
- Add a free **UptimeRobot** monitor on `https://safety.spelgroup.com/healthz`
  (1-min checks) so you're alerted if the server ever goes down.
- Keep **email backup ON** so a WhatsApp outage never means silence.

## 10. Verify (go-live checklist)

- [ ] `pm2 list` → `spel-safety` online; reboot the VM → still online.
- [ ] Scan a unit QR on a phone → form opens → submit → shows on dashboard →
      WhatsApp + email alert received.
- [ ] **Offline test:** open the form once, enable airplane mode, submit →
      "saved on your phone"; turn internet back on → it sends itself.
- [ ] Void the test incidents afterwards.

## Everyday commands

```bash
pm2 logs spel-safety      # live logs
pm2 restart spel-safety   # after editing .env
npm run backup            # backup now
npm run qr                # regenerate posters
```

## If WhatsApp won't start on ARM

- Confirm `WHATSAPP_CHROME_PATH` points at a real Chromium (`chromium --version`
  should print a version).
- `pm2 logs spel-safety` will show the exact error; the app auto-retries.
- The Chromium launch flags the app already uses (`--no-sandbox` etc.) are the
  ones needed on a server.
