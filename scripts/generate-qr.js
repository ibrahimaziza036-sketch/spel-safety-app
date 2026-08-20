// Generates a printable poster per unit into public/qr/index.html.
// Bilingual (English + Urdu) so shop-floor workers understand it. Each QR opens
// the report form pre-set to that unit. QR images are embedded (data URIs) so
// the sheet is a SINGLE self-contained file you can open + print anywhere.
//
// If LAN_BASE_URL is set, each poster also gets a second "factory Wi-Fi" QR.
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

async function qrDataUrl(url) {
  return QRCode.toDataURL(url, { width: 640, margin: 1, errorCorrectionLevel: 'M' });
}

const posters = [];
for (const unit of UNITS) {
  const url = `${PUBLIC_BASE}/report.html?unit=${unit}`;
  const img = await qrDataUrl(url);
  // Also write a standalone PNG (handy if someone wants just the code).
  await QRCode.toFile(path.join(outDir, `${unit}.png`), url, { width: 640, margin: 2 });
  const lanImg = LAN_BASE ? await qrDataUrl(`${LAN_BASE}/report.html?unit=${unit}`) : '';
  console.log(`✓ ${unit}  ->  ${url}`);

  const qrBlock = LAN_BASE
    ? `<div class="qrs">
         <div class="qrcol"><div class="qrtag data">📱 Mobile data / موبائل ڈیٹا</div><img class="qr" src="${img}" alt="${unit} QR"/></div>
         <div class="qrcol"><div class="qrtag wifi">📶 Factory Wi‑Fi / فیکٹری وائی فائی</div><img class="qr" src="${lanImg}" alt="${unit} Wi-Fi QR"/></div>
       </div>`
    : `<img class="qr big" src="${img}" alt="${unit} QR"/>`;

  posters.push(`
  <div class="poster">
    <div class="brand"><span class="shield">🛡️</span> SPEL <b>Safety</b></div>
    <div class="titles">
      <div class="t-en">🚨 Report a Safety Incident</div>
      <div class="t-ur" dir="rtl" lang="ur">🚨 کسی بھی حادثے کی اطلاع دیں</div>
    </div>
    <div class="unit"><span class="unit-lbl" dir="rtl" lang="ur">یونٹ</span> ${unit}</div>
    ${qrBlock}
    <div class="scan">
      <div class="s-en">Scan with your phone camera</div>
      <div class="s-ur" dir="rtl" lang="ur">اپنے موبائل کیمرے سے اسکین کریں</div>
    </div>
    <div class="steps">
      <div class="step"><span class="ico">📷</span><div class="txt"><div class="en">Open camera &amp; scan the code</div><div class="ur" dir="rtl" lang="ur">کیمرہ کھول کر کوڈ اسکین کریں</div></div></div>
      <div class="step"><span class="ico">✍️</span><div class="txt"><div class="en">Fill the short form — what happened, where</div><div class="ur" dir="rtl" lang="ur">مختصر فارم بھریں — کیا ہوا، کہاں ہوا</div></div></div>
      <div class="step"><span class="ico">✅</span><div class="txt"><div class="en">Press Submit — management is alerted instantly</div><div class="ur" dir="rtl" lang="ur">Submit دبائیں — مینجمنٹ کو فوراً اطلاع مل جائے گی</div></div></div>
    </div>
    <div class="note">
      <div class="n-en">Even a near‑miss matters. Reports are confidential and keep everyone safe.</div>
      <div class="n-ur" dir="rtl" lang="ur">معمولی خطرہ بھی اہم ہے۔ اطلاع رازدارانہ رہتی ہے اور سب کی حفاظت میں مدد دیتی ہے۔</div>
    </div>
    <div class="url">${url}</div>
  </div>`);
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>SPEL Safety — Unit QR Posters</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; background: #eef2f7; color: #0f172a; }
  .sheet { }
  .poster {
    width: 190mm; min-height: 277mm; margin: 0 auto 16px; background: #fff;
    border: 3px solid #1d4ed8; border-radius: 14px; padding: 14mm 12mm;
    text-align: center; page-break-after: always; display: flex; flex-direction: column; align-items: center;
  }
  .brand { font-size: 26px; font-weight: 800; color: #1e3a8a; letter-spacing: .5px; }
  .brand .shield { font-size: 26px; }
  .brand b { color: #f97316; }
  .titles { margin: 10px 0 4px; }
  .t-en { font-size: 30px; font-weight: 900; color: #b91c1c; }
  .t-ur { font-size: 30px; font-weight: 700; color: #b91c1c; font-family: "Noto Nastaliq Urdu","Urdu Typesetting","Jameel Noori Nastaleeq","Segoe UI",Tahoma,Arial,sans-serif; line-height: 2.2; margin-top: 2px; }
  .unit { font-size: 46px; font-weight: 900; color: #1e3a8a; margin: 8px 0 6px; }
  .unit-lbl { font-size: 24px; color: #64748b; font-weight: 700; font-family: "Noto Nastaliq Urdu","Urdu Typesetting","Segoe UI",Tahoma,Arial,sans-serif; }
  .qr.big { width: 320px; height: 320px; }
  .qrs { display: flex; gap: 22px; justify-content: center; margin: 4px 0; }
  .qrcol .qr { width: 240px; height: 240px; }
  .qrtag { font-size: 15px; font-weight: 800; padding: 5px 10px; border-radius: 8px; margin-bottom: 6px; }
  .qrtag.wifi { background: #dcfce7; color: #166534; }
  .qrtag.data { background: #dbeafe; color: #1e40af; }
  .scan { margin: 10px 0 6px; }
  .s-en { font-size: 20px; font-weight: 700; }
  .s-ur { font-size: 24px; font-weight: 700; color: #1e3a8a; font-family: "Noto Nastaliq Urdu","Urdu Typesetting","Jameel Noori Nastaleeq","Segoe UI",Tahoma,Arial,sans-serif; line-height: 2.2; }
  .steps { width: 100%; max-width: 150mm; margin: 10px auto; text-align: left; }
  .step { display: flex; align-items: center; gap: 14px; border-top: 1px solid #e2e8f0; padding: 9px 0; }
  .step .ico { font-size: 30px; width: 40px; text-align: center; }
  .step .txt { flex: 1; }
  .step .en { font-size: 16px; font-weight: 600; }
  .step .ur { font-size: 19px; color: #334155; font-family: "Noto Nastaliq Urdu","Urdu Typesetting","Jameel Noori Nastaleeq","Segoe UI",Tahoma,Arial,sans-serif; line-height: 2; text-align: right; }
  .note { margin-top: auto; padding-top: 10px; }
  .n-en { font-size: 14px; color: #475569; }
  .n-ur { font-size: 18px; color: #475569; font-family: "Noto Nastaliq Urdu","Urdu Typesetting","Segoe UI",Tahoma,Arial,sans-serif; line-height: 2; }
  .url { font-size: 11px; color: #94a3b8; margin-top: 8px; word-break: break-all; }
  .no-print { text-align: center; padding: 14px; }
  .no-print button { background: #1d4ed8; color: #fff; border: none; border-radius: 10px; padding: 12px 22px; font-size: 16px; font-weight: 700; cursor: pointer; }
  @media print { .no-print { display: none; } body { background: #fff; } .poster { border-width: 2px; margin: 0 auto; } }
</style></head>
<body>
  <div class="no-print">
    <p>SPEL Safety — ${UNITS.length} unit posters (English + Urdu). Print &amp; put one on each unit's shop floor.</p>
    <button onclick="window.print()">🖨️ Print all posters</button>
  </div>
  <div class="sheet">${posters.join('')}</div>
</body></html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`\nGenerated ${UNITS.length} bilingual posters in public/qr/index.html`);
console.log(`Open + print: ${PUBLIC_BASE}/qr/index.html`);
