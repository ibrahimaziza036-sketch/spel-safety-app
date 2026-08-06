# SPEL Safety — Production server par deploy karna

Ye app aur Cloudflare Tunnel **ek hi server par** chalte hain (tunnel `localhost:3000`
ko expose karta hai). Is liye **jis server par app live hogi, sab kuch usi par** karo —
apne dev/test machine par tunnel banane ki zaroorat nahi.

---

## ⚡ Sab se aasan: EK COMMAND (recommended)

Production server par (Node 22.5+ + cloudflared installed):

```bash
git clone https://github.com/ibrahimaziza036-sketch/spel-safety-app.git
cd spel-safety-app
npm run setup
```

`npm run setup` **poora deployment khud kar deta hai** — dependencies, `.env` +
auto-generated secrets, PM2 (24/7), Cloudflare Tunnel (create + DNS + Windows
service), QR posters, aur smoke test. Bas kuch sawal poochhega (LAN ya internet,
hostname, admin password, WhatsApp numbers, email).

**Sirf 2 cheezein aap ko physically karni hongi** (software ye nahi kar sakta —
security features hain):
1. **Cloudflare login** — script browser khol degi, aap authorize karenge (ek click).
2. **WhatsApp QR scan** — end par `/admin.html` khol kar QR scan karenge.

> Baaki neeche manual steps sirf **reference / troubleshooting** ke liye hain —
> `npm run setup` yehi sab automate karta hai. Re-run karna safe hai.

---

---

## Server requirements
- **Node.js 22.5+** (`node -v`) — built-in `node:sqlite` ke liye.
- **Outbound internet** (WhatsApp + email + tunnel ke liye) — chahe users LAN par hi hon.
- Ek machine jo **hamesha chalti rahe** (server/VM). PM2 se 24/7.

---

## Step 1 — App laao
```bash
git clone https://github.com/ibrahimaziza036-sketch/spel-safety-app.git
cd spel-safety-app
npm install
```
(Private repo hai — clone ke liye GitHub login/token chahiye. Ya poora folder copy kar lo,
lekin `node_modules` copy mat karo, `npm install` chala lo.)

## Step 2 — Config (`.env`)
```bash
copy .env.example .env       # Windows
```
`.env` mein bharo:
- **`SESSION_SECRET`** — naya generate karo: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **`ADMIN_USERNAME` / `ADMIN_PASSWORD`** — strong password.
- **`MANAGEMENT_EMAILS`** + SMTP (`EMAIL_ENABLED=true`, host/user/pass) — backup channel ON karo.
- **`WHATSAPP_ENABLED=true`**.
- LAN-only chala rahe ho: `BASE_URL=http://<server-LAN-IP>:3000`, `COOKIE_SECURE=false`.
  Tunnel/HTTPS ke saath: `BASE_URL=https://safety.<domain>`, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`.
- Production mein `UPLOAD_DIR` ko ek **alag disk/volume** par set karo (photos DB se alag).

## Step 3 — Data (naya ya migrate)
- **Naya start (recommended):** kuch na karo — DB khud ban jaayegi. App chalne ke baad
  admin se login karke **Alert Recipients** aur **WhatsApp QR** set karo.
- **Purana data le jaana ho:** dev machine se `data/` folder copy karo (`safety.db*`,
  `uploads/`, aur `.wwebjs_auth/` agar WhatsApp session bhi le jaana ho). `data/` GitHub par
  nahi hai (by-design), is liye ye manually copy hota hai.
- Demo data chahiye (test ke liye): `npm run seed`.

## Step 4 — Chalao (24/7)
```bash
npm install -g pm2
pm2 start server.js --name spel-safety --node-args="--disable-warning=ExperimentalWarning"
pm2 save
pm2 startup     # jo command bataye, boot auto-start ke liye chalao
```

## Step 5 — WhatsApp link + recipients
- Server par `http://localhost:3000/admin.html` kholo (admin login) → QR scan (dedicated number).
- Alert Recipients mein numbers/emails add karo.

## Step 6 — QR posters
```bash
npm run qr      # BASE_URL ke hisaab se QR banayega — print karke units par lagao
```

## Step 7 — Internet access (agar bahar se chahiye) — Cloudflare Tunnel
Yehi wo hissa hai jo **isi server par** hota hai. Poori guide: `CLOUDFLARE_SETUP.md`.
Khulasa (server par):
```bash
cloudflared tunnel login
cloudflared tunnel create spel-safety
cloudflared tunnel route dns spel-safety safety.<domain>
# config.yml (cloudflared-config.example.yml se) -> service http://localhost:3000
cloudflared service install
```
Phir `.env` mein `BASE_URL=https://safety.<domain>`, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`
set karo, `pm2 restart spel-safety`, aur `npm run qr` dobara.

---

## Verify (server par)
```bash
npm run smoke                       # end-to-end regression (33 checks)
curl http://localhost:3000/readyz   # {"ok":true, checks...}
```

## Backup (regularly)
```bash
npm run backup      # consistent snapshot (DB + photos), verified. Kisi aur drive par le jao.
```

## Yaad rahe
- `.env` aur `data/` **har server par alag** hote hain — GitHub par nahi jaate (secrets/PII).
- WhatsApp session machine-specific hai — naye server par (aam tor par) **dobara QR scan** karna hoga.
- Har server ka apna `SESSION_SECRET` ho.
