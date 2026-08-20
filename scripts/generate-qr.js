// Generates a clean, print-ready poster per unit into public/qr/index.html.
// Minimal + bilingual (English + Urdu): big unit name, one hero QR, and a single
// "scan to report" line — nothing crowded. QR images are embedded (data URIs) so
// the sheet is ONE self-contained file you can open + print anywhere.
//
// If LAN_BASE_URL is set, each poster gets two labelled QRs instead of one.
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
const shortUrl = PUBLIC_BASE.replace(/^https?:\/\//, '');

const qrDataUrl = (url) => QRCode.toDataURL(url, { width: 700, margin: 1, errorCorrectionLevel: 'M' });

const posters = [];
for (const unit of UNITS) {
  const url = `${PUBLIC_BASE}/report.html?unit=${unit}`;
  const img = await qrDataUrl(url);
  await QRCode.toFile(path.join(outDir, `${unit}.png`), url, { width: 700, margin: 2 });
  console.log(`✓ ${unit}  ->  ${url}`);

  const qrBlock = LAN_BASE
    ? `<div class="qrs">
         <div class="qrcol"><img class="qr dual" src="${img}" alt="${unit} QR"/><div class="qrtag">📱 Mobile data · موبائل ڈیٹا</div></div>
         <div class="qrcol"><img class="qr dual" src="${await qrDataUrl(`${LAN_BASE}/report.html?unit=${unit}`)}" alt="${unit} Wi-Fi QR"/><div class="qrtag">📶 Factory Wi‑Fi · وائی فائی</div></div>
       </div>`
    : `<img class="qr" src="${img}" alt="${unit} QR"/>`;

  posters.push(`
  <section class="poster">
    <div class="brand"><span>🛡️</span> SPEL <b>Safety</b></div>
    <div class="unit">${unit}</div>
    <div class="title">
      <div class="en">Report a Safety Incident</div>
      <div class="ur" dir="rtl" lang="ur">حادثے کی اطلاع دیں</div>
    </div>
    ${qrBlock}
    <div class="scan">
      <div class="en">📷 Scan with your phone camera</div>
      <div class="ur" dir="rtl" lang="ur">اپنے موبائل کیمرے سے اسکین کریں</div>
    </div>
    <div class="url">${shortUrl}</div>
  </section>`);
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>SPEL Safety — Unit QR Posters</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; background: #e9edf3; color: #0f172a; }
  .ur { font-family: "Noto Nastaliq Urdu","Urdu Typesetting","Jameel Noori Nastaleeq","Segoe UI",Tahoma,Arial,sans-serif; }

  .poster {
    width: 210mm; height: 297mm; margin: 0 auto; background: #fff;
    padding: 26mm 20mm; page-break-after: always;
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    border-top: 10mm solid #1d4ed8;
  }
  .brand { font-size: 22px; font-weight: 800; color: #1e3a8a; letter-spacing: .3px; }
  .brand b { color: #f97316; }
  .brand span { font-size: 22px; }

  .unit { font-size: 64px; font-weight: 900; color: #1e3a8a; line-height: 1; margin-top: 6mm; }

  .title .en { font-size: 26px; font-weight: 800; color: #b91c1c; text-align: center; }
  .title .ur { font-size: 30px; font-weight: 700; color: #b91c1c; text-align: center; line-height: 2.1; margin-top: 2mm; }

  .qr { width: 92mm; height: 92mm; }
  .qrs { display: flex; gap: 16mm; align-items: center; }
  .qr.dual { width: 66mm; height: 66mm; }
  .qrcol { text-align: center; }
  .qrtag { font-size: 15px; font-weight: 700; color: #334155; margin-top: 4mm; }

  .scan { text-align: center; }
  .scan .en { font-size: 20px; font-weight: 700; color: #0f172a; }
  .scan .ur { font-size: 24px; font-weight: 700; color: #1e3a8a; line-height: 2.1; margin-top: 1mm; }

  .url { font-size: 13px; color: #94a3b8; letter-spacing: .5px; }

  .no-print { text-align: center; padding: 16px; }
  .no-print button { background: #1d4ed8; color: #fff; border: none; border-radius: 10px; padding: 12px 24px; font-size: 16px; font-weight: 700; cursor: pointer; }
  @media print { .no-print { display: none; } body { background: #fff; } }
</style></head>
<body>
  <div class="no-print">
    <p>SPEL Safety — ${UNITS.length} clean unit posters (English + Urdu). Print &amp; place one on each unit.</p>
    <button onclick="window.print()">🖨️ Print all posters</button>
  </div>
  ${posters.join('')}
</body></html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`\nGenerated ${UNITS.length} clean bilingual posters in public/qr/index.html`);
console.log(`Open + print: ${PUBLIC_BASE}/qr/index.html`);
