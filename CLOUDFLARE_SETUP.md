# SPEL Safety — Internet access via Cloudflare Tunnel (Windows LAN server)

Isse aap ka LAN server bina router port-forward kiye, HTTPS ke saath, kahin se bhi
(4G/WiFi) reachable ban jata hai. `cloudflared` pehle se installed hai.

> **Kaun kya karega:** neeche `[AAP]` wale steps aap ke Cloudflare account/browser
> se hote hain (main inhe nahi kar sakta). `[APP]` wale main aap ke liye kar/likh
> chuka hun ya guide kar dunga.

---

## Zaroori pehle se

- Ek **Cloudflare account** (free) — `[AAP]`
- Ek **domain jo Cloudflare pe manage ho**. Options:
  - `spelgroup.com` agar already Cloudflare pe hai → `safety.spelgroup.com` use karo.
  - Agar corporate domain pe risk na lena ho → ek **chhota dedicated domain** (e.g. `spel-safety.com`) Cloudflare pe add karo, `safety.spel-safety.com`.
  - Sirf test ke liye → **Part 1 (Quick Tunnel)** — koi domain/account nahi chahiye.
- Server ko **outbound internet** chahiye (WhatsApp/email + tunnel ke liye).

---

## Part 1 — 2-minute QUICK TEST (bina account/domain)  `[AAP]`

Sirf ye confirm karne ke liye ke tunnel chal jata hai. App pehle se `npm start` pe chal rahi ho, phir alag terminal mein:

```bash
cloudflared tunnel --url http://localhost:3000
```

Ye ek random URL dega jaise `https://random-words.trycloudflare.com`. Us URL ko
mobile (4G pe) se kholo — login page aa jayega = tunnel kaam kar raha hai. ✅
(Ye URL har baar badalta hai aur sirf test ke liye hai — production ke liye Part 2.)

> ⚠️ Ye URL jab tak command chal rahi hai, aap ki app **internet pe LIVE** hai.
> Test ke baad `Ctrl+C` se band kar dein.

---

## Part 2 — Production: named tunnel + apka domain  `[AAP]`

Terminal (server pe) mein ek-ek karke:

```bash
# 1. Cloudflare account se login (browser khulega — apna account + domain chuno)
cloudflared tunnel login

# 2. Tunnel banao
cloudflared tunnel create spel-safety

# 3. DNS route banao (apna hostname use karo)
cloudflared tunnel route dns spel-safety safety.spelgroup.com
```

Step 2 ek **Tunnel UUID** aur ek credentials file dega:
`C:\Users\Ibrahim.Aziz\.cloudflared\<UUID>.json`

Ab config file banao: `C:\Users\Ibrahim.Aziz\.cloudflared\config.yml`
(template project mein hai: `cloudflared-config.example.yml` — UUID aur hostname
bhar dein):

```yaml
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: C:\Users\Ibrahim.Aziz\.cloudflared\<YOUR-TUNNEL-UUID>.json
ingress:
  - hostname: safety.spelgroup.com
    service: http://localhost:3000
  - service: http_status:404
```

Chala kar test karo:

```bash
cloudflared tunnel run spel-safety
```

`https://safety.spelgroup.com` kahin se bhi khulna chahiye. Theek chale to isay
**Windows service** bana do (boot par auto-start, hamesha chalti rahe):

```bash
cloudflared service install
```

---

## Part 3 — App ko tunnel ke liye set karo  `[APP]`

Tunnel LIVE hone ke BAAD (Part 2 chal raha ho), `.env` mein ye teen cheezein:

```
BASE_URL=https://safety.spelgroup.com
COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
```

> ⚠️ **Order zaroori:** `COOKIE_SECURE=true` sirf tab set karo jab aap **https tunnel
> URL** se access kar rahe ho. Agar abhi bhi `http://localhost` se test kar rahe ho to
> login cookie set nahi hogi. Tunnel live hone par hi ye flip karo.

Phir:

```bash
npm start          # ya: pm2 restart spel-safety
npm run qr         # QR codes ab https URL ke saath banenge — naye QR print karo
```

Ab har unit ka QR internet URL ka hai → worker WiFi ya 4G, kahin se bhi scan karke
report kar sakta hai.

---

## Part 4 — Extra hardening (recommended)  `[AAP]` (Cloudflare dashboard)

Ye internet-exposure ko LAN se bhi zyada mehfooz bana dete hain.

### 4a. Cloudflare Access — staff area lock (Zero Trust)
Cloudflare Dashboard → **Zero Trust → Access → Applications → Add application → Self-hosted**:

1. **App 1 (public bypass)** — Application domain mein ye paths add karo:
   `safety.spelgroup.com/report.html`, `/api/incidents`, `/api/meta`,
   `/css`, `/js`, `/favicon.svg`
   Policy: **Bypass → Everyone.** (taake workers bina login report kar sakein)
2. **App 2 (staff protected)** — Application domain: `safety.spelgroup.com` (poora)
   Policy: **Allow →** sirf approved emails (aap + management).
   Ab dashboard/admin/incidents Cloudflare ke apne login ke peeche — hacker aap ka
   login page dekh bhi nahi sakta.

### 4b. Turnstile (CAPTCHA) + geo on the report form
- **WAF → Custom rules:** `safety.spelgroup.com/api/incidents` par
  **Country ≠ Pakistan** ko **Managed Challenge/Block** karo → sirf PK se reports.
- Chahein to report page par Cloudflare **Turnstile** widget bhi laga sakte hain
  (thoda code change — bata dena to laga dun).

### 4c. Rate limiting (Cloudflare edge)
WAF → Rate limiting rules: `/api/incidents` aur `/api/auth/login` par edge-level
limit (app ke andar bhi hai, ye extra layer).

---

## Troubleshooting

- **Login nahi ho raha tunnel URL pe:** `COOKIE_SECURE=true` set hai? `TRUST_PROXY_HOPS=1`? App restart kiya?
- **502/error:** app (`npm start`) chal rahi hai port 3000 pe? `cloudflared` chal raha hai?
- **QR purana URL khol raha:** `npm run qr` dobara chalaya? Naye QR print kiye?
- **IP-based rate-limit galat lag raha (sab block):** `TRUST_PROXY_HOPS` deployment ke mutabiq hona chahiye (cloudflared local = 1).
- **Service band ho gaya:** `cloudflared service install` kiya hai to boot par khud chalti hai; warna `pm2` ki tarah isay bhi manage karo.

## Rollback (LAN-only wapis)
`.env` mein `BASE_URL=http://192.168.x.x:3000`, `COOKIE_SECURE=false`,
`TRUST_PROXY_HOPS=0`; `cloudflared` band; `npm run qr` dobara.
