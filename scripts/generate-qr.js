// Generates a printable QR code per unit into public/qr/.
// Each QR opens the report form pre-set to that unit.
// Run:  npm run qr
import QRCode from 'qrcode';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, UNITS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'qr');
fs.mkdirSync(outDir, { recursive: true });

const cards = [];

for (const unit of UNITS) {
  const url = `${config.baseUrl}/report.html?unit=${unit}`;
  const file = path.join(outDir, `${unit}.png`);
  await QRCode.toFile(file, url, { width: 600, margin: 2, errorCorrectionLevel: 'M' });
  console.log(`✓ ${unit}  ->  ${url}`);
  cards.push(`
    <div class="card">
      <div class="unit">${unit}</div>
      <img src="./${unit}.png" alt="${unit} QR" />
      <div class="cta">Scan to report a safety incident</div>
      <div class="url">${url}</div>
    </div>`);
}

// A print-ready sheet so someone can print all posters at once.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>SPEL Safety — Unit QR Posters</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  body{font-family:Segoe UI,Arial,sans-serif;background:#fff;margin:0;padding:20px}
  .sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
  .card{border:2px solid #1d4ed8;border-radius:16px;padding:22px;text-align:center;page-break-inside:avoid}
  .unit{font-size:30px;font-weight:900;color:#1e3a8a}
  .card img{width:280px;height:280px}
  .cta{font-size:20px;font-weight:700;margin-top:6px}
  .url{color:#64748b;font-size:12px;margin-top:6px;word-break:break-all}
  h1{color:#1e3a8a}
  @media print{.no-print{display:none}}
</style></head>
<body>
  <h1>SPEL Safety — Incident Report QR Posters</h1>
  <p class="no-print">Print this page and put each unit's QR poster on the shop floor. Workers scan to report instantly.</p>
  <div class="sheet">${cards.join('')}</div>
</body></html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`\nGenerated ${UNITS.length} QR codes in public/qr/`);
console.log(`Printable sheet: ${config.baseUrl}/qr/index.html`);
