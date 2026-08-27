/**
 * Automatischer Test der Vision-Pipeline im echten Browser.
 * Lädt selftest.html in Chromium (headless), wartet auf das Ergebnis und
 * beendet alles wieder.
 *
 * Aufruf:
 *   npm run test:vision        gegen den Dev-Server
 *   npm run test:vision:prod   gegen den Produktions-Build (dist/)
 *
 * Beide Varianten sind nötig: Dev-Server und Bundler behandeln Module
 * unterschiedlich. Ein Ladefehler von OpenCV trat ausschließlich im
 * Produktions-Build auf und blieb im Dev-Test unsichtbar.
 *
 * Warum überhaupt ein Browser: OpenCV.js (WASM), Canvas und Tesseract lassen
 * sich in Node nicht sinnvoll nachbilden. Die Kernlogik (Geometrie, Parsing,
 * CSV) prüfen zusätzlich die normalen Unit-Tests.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const PROD = process.argv.includes('--prod');
const PORT = PROD ? 4199 : 5199;
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

const executablePath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error(
    'Kein Chromium gefunden. Pfad über CHROMIUM_PATH setzen oder Playwright-Browser installieren.',
  );
  process.exit(1);
}

if (PROD && !existsSync(new URL('../dist/selftest.html', import.meta.url))) {
  console.error('dist/selftest.html fehlt — bitte zuerst `npm run build` ausführen.');
  process.exit(1);
}

const vite = spawn('npx', ['vite', PROD ? 'preview' : 'dev', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(PROD ? 'Modus: Produktions-Build (dist/)' : 'Modus: Dev-Server');
let viteOutput = '';
vite.stdout.on('data', (d) => (viteOutput += d));
vite.stderr.on('data', (d) => (viteOutput += d));

function shutdown(code) {
  vite.kill('SIGTERM');
  process.exit(code);
}

// Auf den Dev-Server warten
const startedAt = Date.now();
while (!/ready in|Local:/.test(viteOutput)) {
  if (Date.now() - startedAt > 60_000) {
    console.error('Vite-Dev-Server startet nicht:\n' + viteOutput);
    shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[selftest]')) console.log(t.replace('[selftest] ', ''));
});
page.on('pageerror', (e) => console.error('  [Seitenfehler]', e.message));

await page.goto(`http://localhost:${PORT}/selftest.html`, { waitUntil: 'domcontentloaded' });

let result;
try {
  await page.waitForFunction(() => window.__selftest?.done === true, null, { timeout: 240_000 });
  result = await page.evaluate(() => window.__selftest);
} catch {
  console.error('\nZeitüberschreitung — der Selftest wurde nicht fertig.');
  await browser.close();
  shutdown(1);
}

await browser.close();
if (!result.ok) {
  console.error(`\nFEHLGESCHLAGEN: ${result.error}`);
  shutdown(2);
}
console.log('\nVision-Pipeline OK');
shutdown(0);
