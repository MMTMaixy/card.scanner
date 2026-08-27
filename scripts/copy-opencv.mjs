// Kopiert OpenCV.js aus node_modules nach public/opencv/, damit es als
// klassisches <script> geladen werden kann.
//
// Warum nicht per import()? OpenCV.js ist ein Emscripten-Modul, das ein
// `then` exportiert. Ein Modul-Namensraum mit `then` gilt in JavaScript als
// Promise-artig — beim dynamischen Import ruft die Laufzeit dieses `then` mit
// falschem Empfänger auf und bricht ab ("Promise.prototype.then called on
// incompatible receiver"). Als klassisches Script gibt es dieses Problem nicht.
//
// Läuft automatisch vor `npm run dev` und `npm run build`.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';

const src = new URL('../node_modules/@techstark/opencv-js/dist/opencv.js', import.meta.url);
const outDir = new URL('../public/opencv/', import.meta.url);
const dest = new URL('opencv.js', outDir);

mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
console.log(`public/opencv/opencv.js: ${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB`);
