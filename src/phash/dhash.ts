/**
 * 64-bit Difference-Hash (dHash) für den Bildabgleich.
 * Bild wird auf 9x8 Graustufen verkleinert; jedes Bit sagt, ob ein Pixel
 * heller ist als sein rechter Nachbar. Robust gegen Beleuchtung und leichte
 * Unschärfe — gut genug, um Kandidaten innerhalb EINES Sets vorzuschlagen.
 */

const W = 9;
const H = 8;

/** 64 Booleans -> 16 Hex-Zeichen */
export function bitsToHex(bits: boolean[]): string {
  if (bits.length !== 64) throw new Error(`bitsToHex: erwarte 64 Bits, bekam ${bits.length}`);
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    const nibble = (Number(bits[i]) << 3) | (Number(bits[i + 1]) << 2) | (Number(bits[i + 2]) << 1) | Number(bits[i + 3]);
    hex += nibble.toString(16);
  }
  return hex;
}

/** Hamming-Distanz zweier Hex-Hashes (0 = identisch, 64 = maximal verschieden) */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/** Graustufen-Matrix (W*H) -> dHash-Bits */
export function grayToBits(gray: number[]): boolean[] {
  const bits: boolean[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits.push(gray[y * W + x] > gray[y * W + x + 1]);
    }
  }
  return bits;
}

let scratch: HTMLCanvasElement | null = null;

/** Hash aus einer beliebigen Bildquelle (Bild, Video-Ausschnitt, Canvas). */
export function hashImageSource(
  source: CanvasImageSource,
  sx?: number,
  sy?: number,
  sw?: number,
  sh?: number,
): string {
  const canvas = (scratch ??= document.createElement('canvas'));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas-Kontext nicht verfügbar');
  ctx.imageSmoothingEnabled = true;
  if (sx != null && sy != null && sw != null && sh != null) {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    ctx.drawImage(source, 0, 0, W, H);
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    gray.push(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
  }
  return bitsToHex(grayToBits(gray));
}
