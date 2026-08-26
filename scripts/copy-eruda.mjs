// Kopiert die eruda-Mobil-Debug-Konsole nach public/, damit sie ohne CDN
// (und auch bei kaputtem App-Bundle) per <script src="eruda.js"> ladbar ist.
// Aktiviert wird sie über den Query-Parameter ?debug=1 (siehe index.html).
import { copyFileSync } from 'node:fs';

copyFileSync(
  new URL('../node_modules/eruda/eruda.js', import.meta.url),
  new URL('../public/eruda.js', import.meta.url),
);
console.log('public/eruda.js aktualisiert');
