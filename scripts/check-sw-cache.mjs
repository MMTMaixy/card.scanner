/**
 * Prüft am gebauten Stand (dist/), dass der Service Worker installiert und
 * dass die großen Rechenkerne (OpenCV, Tesseract-WASM) beim ersten Abruf
 * tatsächlich im Laufzeit-Cache landen — sonst wäre die App offline
 * scan-unfähig, obwohl der Precache klein aussieht.
 *
 * Aufruf: npm run check:sw   (setzt voraus, dass npm run build gelaufen ist)
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const PORT = 4188;
const executablePath = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));
if (!executablePath) {
  console.error('Kein Chromium gefunden (CHROMIUM_PATH setzen).');
  process.exit(1);
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
preview.stdout.on('data', (d) => (output += d));
preview.stderr.on('data', (d) => (output += d));

function shutdown(code) {
  preview.kill('SIGTERM');
  process.exit(code);
}

const start = Date.now();
while (!/Local:/.test(output)) {
  if (Date.now() - start > 60_000) {
    console.error('vite preview startet nicht:\n' + output);
    shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

await page.waitForFunction(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!reg?.active;
}, null, { timeout: 60_000 });
console.log('Service Worker aktiv');

// Beim allerersten Laden kontrolliert der Service Worker die Seite noch nicht
// zwingend — erst danach laufen Abrufe durch seine Routen.
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
console.log('Seite wird vom Service Worker kontrolliert');

// Einen Tesseract-Core und den OpenCV-Chunk anfordern und prüfen,
// ob die Laufzeit-Regel sie in den Cache legt.
const report = await page.evaluate(async () => {
  const assets = await fetch('./assets/').catch(() => null);
  void assets;
  // Dateinamen aus dem Precache-Manifest sind gehasht; den OpenCV-Chunk
  // finden wir über das Verzeichnislisting nicht — daher gezielt laden.
  const urls = [
    './tesseract/tesseract-core-simd-lstm.wasm.js',
    './tesseract/worker.min.js',
    './opencv/opencv.js',
  ];
  const fetched = [];
  for (const u of urls) {
    const r = await fetch(u);
    fetched.push(`${u}: HTTP ${r.status}`);
    await r.body?.cancel();
  }
  // kurz warten, bis Workbox geschrieben hat
  await new Promise((r) => setTimeout(r, 1500));
  const names = await caches.keys();
  const contents = {};
  for (const n of names) {
    const c = await caches.open(n);
    contents[n] = (await c.keys()).map((r) => new URL(r.url).pathname);
  }
  return { fetched, contents };
});

console.log('\nAbrufe:', report.fetched.join(' | '));
for (const [name, urls] of Object.entries(report.contents)) {
  console.log(`\nCache "${name}" (${urls.length}):`);
  urls.forEach((u) => console.log('   ' + u));
}

await browser.close();

const problems = [];

// 1. App-Shell muss vollständig vorab gecacht sein, sonst startet die App
//    offline gar nicht. Besonders leicht zu übersehen: das Haupt-Bundle.
const precache = Object.entries(report.contents).find(([n]) => n.includes('precache'))?.[1] ?? [];
if (!precache.some((u) => /\/assets\/.*\.js$/.test(u))) {
  problems.push('Kein JavaScript-Bundle im Precache — die App startet offline nicht.');
}
if (!precache.some((u) => u.endsWith('/index.html'))) problems.push('index.html fehlt im Precache.');
if (!precache.some((u) => u.includes('traineddata'))) {
  problems.push('OCR-Sprachdaten fehlen im Precache.');
}

// 2. Die großen Rechenkerne müssen beim ersten Abruf dauerhaft landen.
const runtime = Object.entries(report.contents).find(([n]) => n.includes('rechenkerne'))?.[1] ?? [];
if (!runtime.some((u) => u.includes('tesseract-core'))) problems.push('Tesseract-Kern nicht im Laufzeit-Cache.');
if (!runtime.some((u) => u.includes('opencv'))) problems.push('OpenCV nicht im Laufzeit-Cache.');

if (problems.length > 0) {
  console.error('\nFEHLGESCHLAGEN:');
  problems.forEach((p) => console.error('  - ' + p));
  shutdown(2);
}
console.log('\nApp-Shell vorab gecacht, Rechenkerne landen beim ersten Abruf im Cache.');
shutdown(0);
