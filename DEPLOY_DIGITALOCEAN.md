# SPEL Safety — Deploy on DigitalOcean (free HTTPS via DuckDNS + Caddy)

A clean Ubuntu droplet (x86 — no ARM/capacity issues). Free stable HTTPS URL via
DuckDNS + Caddy, so **no domain purchase needed**. All app features work:
WhatsApp alerts, public QR + 4G, offline PWA, dashboard.

> MS SQL backup stays **off** (this cloud server can't reach the factory LAN) —
> use the built-in daily file backup instead.

---

## Part A — Create the droplet (browser)

1. **digitalocean.com** → sign up (Google/email). Add a card or PayPal — new
   users usually get free trial credit, so the first ~2 months can be free.
2. **Create → Droplets.**
3. **Region:** Bangalore (**BLR1**) — closest to Pakistan, fast.
4. **Image:** Ubuntu **24.04 (LTS)**.
5. **Size:** Basic → Regular. Choose **2 GB RAM / 1 vCPU ($12/mo)** — comfortable
   for WhatsApp. (While on free credit you can pick 4 GB. 1 GB/$6 works too but is
   tight — we add swap either way.)
6. **Authentication:** simplest = **Password** → set a strong root password
   (write it down). (Or add an SSH key if you prefer.)
7. **Hostname:** `spel-safety`. → **Create Droplet.**
8. Wait ~1 min → copy the droplet's **public IP**.

## Part B — Connect (from your Windows PC)

PowerShell:
```powershell
ssh root@YOUR_DROPLET_IP
```
Type `yes` to trust, then the root password. (SSH key users: `ssh -i <key> root@IP`.)

## Part C — Install Node, Chromium, Caddy, swap  (run as root)

```bash
apt update && apt -y upgrade
# Node.js 22 (built-in SQLite)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git
node -v                        # >= 22.5

# Chromium for WhatsApp
snap install chromium
which chromium                 # note the path (e.g. /snap/bin/chromium)

# 2 GB swap (safe headroom for Chromium)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Caddy (auto-HTTPS reverse proxy)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# Open the firewall if ufw is active (harmless if not)
ufw allow 22,80,443/tcp 2>/dev/null || true
```

## Part D — Free hostname (DuckDNS, browser)

1. **duckdns.org** → sign in (Google/GitHub).
2. Add a subdomain, e.g. **`spelsafety`** → your URL becomes
   `https://spelsafety.duckdns.org`.
3. Put the droplet's **public IP** in the box → **update ip**.

## Part E — Get the app + configure

```bash
git clone https://github.com/ibrahimaziza036-sketch/spel-safety-app.git
cd spel-safety-app
npm install
npm run setup
```
Setup answers:
- Deployment mode → **4 (Reverse proxy)**
- Hostname → **spelsafety.duckdns.org**
- Admin username / **strong password**
- WhatsApp alert numbers → e.g. `923444007943,9230…`
- Email backup → **Yes**
- MS SQL backup → **No**

Then point the app at Chromium and restart:
```bash
sed -i 's#^WHATSAPP_CHROME_PATH=.*#WHATSAPP_CHROME_PATH=/snap/bin/chromium#' .env
pm2 restart spel-safety
```

## Part F — Caddy (free auto-HTTPS)

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
spelsafety.duckdns.org {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
EOF
systemctl restart caddy
```
(Replace the hostname with your DuckDNS one if different.) Caddy fetches a free
HTTPS certificate automatically in a few seconds.

## Part G — Auto-start on reboot

```bash
pm2 startup systemd     # copy & run the `sudo …` line it prints
pm2 save
```

## Part H — Finish

1. Open **https://spelsafety.duckdns.org/admin.html** → log in → **WhatsApp
   Connection** → scan the QR with the dedicated SPEL number. Add management under
   **Alert Recipients**.
2. Print posters: **https://spelsafety.duckdns.org/qr/index.html** (one QR/unit).
3. **Offline test:** open the form, enable airplane mode, submit → "saved on your
   phone"; turn internet back on → it sends itself.

## Part I — Backups + monitoring

```bash
( crontab -l 2>/dev/null; echo "0 2 * * * cd $HOME/spel-safety-app && /usr/bin/npm run backup >> backup.log 2>&1" ) | crontab -
```
- Add a free **UptimeRobot** check on `https://spelsafety.duckdns.org/healthz`.
- Keep **email backup ON**.

## Everyday commands

```bash
pm2 logs spel-safety      # live logs
pm2 restart spel-safety   # after editing .env
npm run backup            # backup now
npm run qr                # regenerate posters
```
