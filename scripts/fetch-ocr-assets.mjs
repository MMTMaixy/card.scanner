// Bündelt die Tesseract-OCR-Assets lokal in public/tesseract/, damit die App
// komplett offline (und ohne CDN) läuft. Einmal ausführen: node scripts/fetch-ocr-assets.mjs
// Die Dateien werden ins Repo committet — spätere Builds brauchen kein Netz.
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const outDir = new URL('../public/tesseract/', import.meta.url);
mkdirSync(outDir, { recursive: true });

// 1) Worker + WASM-Cores (LSTM-only reicht: wir nutzen OEM 1)
const copies = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
];
for (const [src, dest] of copies) {
  copyFileSync(new URL(`../${src}`, import.meta.url), new URL(dest, outDir));
  console.log(`kopiert: ${dest}`);
}

// 2) Sprachdaten (tessdata_fast, LSTM) — klein und schnell, für Ziffern völlig ausreichend
const langTarget = new URL('eng.traineddata.gz', outDir);
if (existsSync(langTarget)) {
  console.log('eng.traineddata.gz bereits vorhanden');
} else {
  const url = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata';
  console.log(`lade ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  writeFileSync(langTarget, gzipSync(data, { level: 9 }));
  console.log(`eng.traineddata.gz: ${statSync(langTarget).size} bytes`);
}
