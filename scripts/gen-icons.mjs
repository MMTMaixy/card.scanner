// Erzeugt einfache PWA-Icons (PNG) ohne externe Abhängigkeiten.
// Design: dunkler Hintergrund, weiße "Karte" mit blauem Scan-Balken.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelFn) {
  // RGBA, Filter 0 pro Zeile
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x1a, 0x1d, 0x24, 255];
const CARD = [0xe8, 0xea, 0xf0, 255];
const ACCENT = [0x4c, 0x8d, 0xff, 255];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

function pixel(x, y, size) {
  const u = x / size;
  const v = y / size;
  // Karte: hochkant, zentriert
  const cardX0 = 0.30, cardX1 = 0.70, cardY0 = 0.18, cardY1 = 0.82;
  const inCard = inRoundedRect(u, v, cardX0, cardY0, cardX1, cardY1, 0.06);
  // Scan-Balken quer über die Karte
  const inBar = v >= 0.46 && v <= 0.54 && u >= 0.12 && u <= 0.88;
  if (inBar) return ACCENT;
  if (inCard) return CARD;
  return BG;
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const png = encodePng(size, pixel);
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png);
  console.log(`icon-${size}.png: ${png.length} bytes`);
}
// Maskable: gleiche Grafik, aber Motiv kleiner (safe zone)
for (const size of [512]) {
  const png = encodePng(size, (x, y, s) => {
    const shrink = 0.72;
    const cx = (x - s / 2) / shrink + s / 2;
    const cy = (y - s / 2) / shrink + s / 2;
    if (cx < 0 || cy < 0 || cx >= s || cy >= s) return BG;
    return pixel(cx, cy, s);
  });
  writeFileSync(new URL(`../public/icons/icon-maskable-${size}.png`, import.meta.url), png);
  console.log(`icon-maskable-${size}.png: ${png.length} bytes`);
}
