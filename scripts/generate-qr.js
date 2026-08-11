// Generates a printable QR poster per unit into public/qr/.
// Each QR opens the report form pre-set to that unit.
//
// If LAN_BASE_URL is set (e.g. http://192.168.11.6:3000), each poster gets TWO
// QR codes:
//   • "On factory Wi-Fi"     -> the LAN URL   (works even if the internet is down)
//   • "Mobile data / outside" -> the public URL (BASE_URL, via Cloudflare Tunnel)
// Otherwise a single QR (BASE_URL) is generated.
//
// Run:  npm run qr
import QRCode from 'qrcode';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, UNITS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'qr');
fs.mkdirSync(outDir, { recursive: true });

const PUBLIC_BASE = config.baseUrl;
const LAN_BASE = config.lanBaseUrl && config.lanBaseUrl !== PUBLIC_BASE ? config.lanBaseUrl : '';
const DUAL = Boolean(LAN_BASE);

async function qrFile(name, url) {
  const file = path.join(outDir, `${name}.png`);
  await QRCode.toFile(file, url, { width: 600, margin: 2, errorCorrectionLevel: 'M' });
  return `./${name}.png`;
}

const cards = [];
for (const unit of UNITS) {
  const publicUrl = `${PUBLIC_BASE}/report.html?unit=${unit}`;
  const publicImg = await qrFile(unit, publicUrl);

  if (DUAL) {
    const lanUrl = `${LAN_BASE}/report.html?unit=${unit}`;
    const lanImg = await qrFile(`${unit}-lan`, lanUrl);
    console.log(`✓ ${unit}\n    Wi-Fi:  ${lanUrl}\n    Public: ${publicUrl}`);
    cards.push(`
      <div class="card">
        <div class="unit">${unit}</div>
        <div class="cta">Scan to report a safety incident</div>
        <div class="qrs">
          <div class="qr">
            <div class="tag wifi">📶 On factory Wi-Fi</div>
            <img src="${lanImg}" alt="${unit} Wi-Fi QR" />
            <div class="hint">Works even if the internet is down</div>
          </div>
          <div class="qr">
            <div class="tag data">📱 Mobile data / outside</div>
            <img src="${publicImg}" alt="${unit} public QR" />
            <div class="hint">Needs mobile data / Wi-Fi with internet</div>
          </div>
        </div>
      </div>`);
  } else {
    console.log(`✓ ${unit}  ->  ${publicUrl}`);
    cards.push(`
      <div class="card">
        <div class="unit">${unit}</div>
        <div class="cta">Scan to report a safety incident</div>
        <div class="qrs single"><div class="qr"><img src="${publicImg}" alt="${unit} QR" /><div class="url">${publicUrl}</div></div></div>
      </div>`);
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>SPEL Safety — Unit QR Posters</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  body{font-family:Segoe UI,Arial,sans-serif;background:#fff;margin:0;padding:20px}
  .sheet{display:grid;grid-template-columns:repeat(${DUAL ? 1 : 2},1fr);gap:18px}
  .card{border:2px solid #1d4ed8;border-radius:16px;padding:22px;text-align:center;page-break-inside:avoid}
  .unit{font-size:32px;font-weight:900;color:#1e3a8a}
  .cta{font-size:20px;font-weight:700;margin:4px 0 14px}
  .qrs{display:flex;gap:24px;justify-content:center;flex-wrap:wrap}
  .qrs.single{display:block}
  .qr{flex:1;min-width:240px;max-width:320px}
  .qr img{width:260px;height:260px}
  .tag{font-size:16px;font-weight:800;padding:6px 10px;border-radius:8px;margin-bottom:8px;display:inline-block}
  .tag.wifi{background:#dcfce7;color:#166534}
  .tag.data{background:#dbeafe;color:#1e40af}
  .hint{color:#64748b;font-size:13px;margin-top:4px}
  .url{color:#64748b;font-size:12px;margin-top:6px;word-break:break-all}
  h1{color:#1e3a8a}
  @media print{.no-print{display:none}}
</style></head>
<body>
  <h1>SPEL Safety — Incident Report QR Posters</h1>
  <p class="no-print">Print this page and put each unit's poster on the shop floor.${DUAL ? ' Two QR codes per unit: use the green one on factory Wi-Fi (works even without internet), or the blue one on mobile data / from outside.' : ''}</p>
  <div class="sheet">${cards.join('')}</div>
</body></html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`\nGenerated QR posters for ${UNITS.length} units in public/qr/ (${DUAL ? 'dual: Wi-Fi + public' : 'single'})`);
console.log(`Printable sheet: ${PUBLIC_BASE}/qr/index.html`);
