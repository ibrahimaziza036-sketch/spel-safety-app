# SPEL Safety — Deploy on Oracle Cloud (Always Free)

A forever-free, always-on Ubuntu server that runs the whole app (WhatsApp alerts,
public HTTPS QR, offline PWA, dashboard). No inbound ports are opened — traffic
comes in through a **Cloudflare Tunnel** (outbound-only), which is both simpler
and safer.

> **Data/MS SQL note:** this server is in the cloud, so it **cannot reach the
> factory MS SQL** on 192.168.11.6. Leave the MS SQL backup **OFF** and rely on
> the built-in file backups (Step 9). A factory link can be added later.

---

## Pick your public URL method

You need a **stable HTTPS URL** for the QR posters. Two ways:

- **A — Free, NO domain to buy (recommended for now): DuckDNS + Caddy.** A free
  `something.duckdns.org` hostname + Caddy for automatic HTTPS. See **Section 0b**.
- **B — Cloudflare Tunnel (needs a domain on Cloudflare).** Nicer (no inbound
  ports) but requires a domain like `safety.spelgroup.com`. See **Section 0**.

Both give offline-capable HTTPS. You can start on DuckDNS today and switch to a
company domain later by editing two lines.

## 0. (Path B) Domain on Cloudflare

- Use a company domain (e.g. **spelgroup.com**) added to a **free** Cloudflare
  account (nameservers → Cloudflare). Then you'll use `safety.spelgroup.com`.
- No domain? A cheap one (~$1–10/year) added to Cloudflare — or just use Path A.

## 0b. (Path A) FREE, no domain — DuckDNS + Caddy  ⭐ recommended for now

Do **Steps 1–4** below first (create VM, install Node/Chromium, clone,
npm install). Then, instead of the Cloudflare tunnel:

1. **DuckDNS:** sign in at **duckdns.org** (Google/GitHub), create a subdomain
   e.g. `spelsafety`, and set its IP to your Oracle VM's **public IP**. Your URL
   becomes `https://spelsafety.duckdns.org`.
2. **Open inbound 80 + 443 on Oracle:**
   - Oracle console → your VM's subnet → **Security List → Ingress rules** → add
     TCP **80** and TCP **443** from `0.0.0.0/0`.
   - On the VM, open them in the OS firewall too:
     ```bash
     sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
3. **Install Caddy** (auto-HTTPS reverse proxy):
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   ```
4. **Configure Caddy** — put this in `/etc/caddy/Caddyfile` (see `Caddyfile.example`):
   ```
   spelsafety.duckdns.org {
       encode zstd gzip
       reverse_proxy 127.0.0.1:3000
   }
   ```
   ```bash
   sudo systemctl restart caddy
   ```
   Caddy gets a free HTTPS certificate automatically.
5. **Configure the app:** run `npm run setup`, choose **mode 4 (Reverse proxy)**,
   hostname `spelsafety.duckdns.org`. (Admin / WhatsApp / email / MS SQL=No —
   same as Step 5 below.) This skips the Cloudflare tunnel.
6. Continue with **Step 6** (Chromium path) and **Step 7** (start on boot). Your
   public URL is `https://spelsafety.duckdns.org`.

> Switch to a real domain later: change the Caddyfile hostname, set `BASE_URL` in
> `.env`, run `npm run qr`, restart. Two edits.

---

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
