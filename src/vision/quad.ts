/**
 * Reine Geometrie für die freie Kartenerkennung — bewusst ohne OpenCV-Typen,
 * damit sie ohne DOM/WASM unit-testbar ist.
 */

export interface Pt {
  x: number;
  y: number;
}

/** Ecken in die Reihenfolge TL, TR, BR, BL bringen (Summen-/Differenz-Trick). */
export function orderCorners(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  if (pts.length !== 4) throw new Error(`orderCorners: erwarte 4 Punkte, bekam ${pts.length}`);
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  const tr = byDiff[0];
  const bl = byDiff[3];
  return [tl, tr, br, bl];
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Fläche eines Polygons (Schnürsenkelformel). */
export function polygonArea(pts: Pt[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export interface QuadCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Mindestfläche einer Karte im Bild. Bewusst EINE Konstante für Vorfilter und
 * Plausibilitätsprüfung — zwei verschiedene Schwellen haben schon dazu geführt,
 * dass eine erkannte Karte lautlos zwischen den Prüfungen verschwand.
 */
export const MIN_AREA_FRACTION = 0.04;

/**
 * Ist das Viereck plausibel eine (aufrecht liegende, beliebig gedrehte/
 * gekippte) Pokémon-Karte? Seitenverhältnis 88:63 ≈ 1,4 mit großzügiger
 * Perspektiv-Toleranz.
 */
export function isPlausibleCard(ordered: [Pt, Pt, Pt, Pt], frameW: number, frameH: number): QuadCheck {
  const [tl, tr, br, bl] = ordered;
  const area = polygonArea(ordered);
  const frameArea = frameW * frameH;
  if (area < MIN_AREA_FRACTION * frameArea) return { ok: false, reason: 'zu klein' };
  if (area > 0.95 * frameArea) return { ok: false, reason: 'zu groß' };

  const top = dist(tl, tr);
  const bottom = dist(bl, br);
  const left = dist(tl, bl);
  const right = dist(tr, br);
  if (Math.min(top, bottom, left, right) < 1) return { ok: false, reason: 'entartet' };

  // Gegenüberliegende Seiten dürfen perspektivisch verschieden sein, aber nicht absurd
  const oppH = Math.max(top, bottom) / Math.min(top, bottom);
  const oppV = Math.max(left, right) / Math.min(left, right);
  if (oppH > 1.7 || oppV > 1.7) return { ok: false, reason: 'zu schief' };

  // Hochformat: Vertikale ~1,4x der Horizontalen (63x88 mm), mit Toleranz
  const aspect = ((left + right) / 2) / ((top + bottom) / 2);
  if (aspect < 1.05 || aspect > 1.8) return { ok: false, reason: `Seitenverhältnis ${aspect.toFixed(2)}` };

  return { ok: true };
}

/** Größte Eckpunkt-Verschiebung zwischen zwei Vierecken (für die Stabilitätsprüfung). */
export function maxCornerDelta(a: [Pt, Pt, Pt, Pt], b: [Pt, Pt, Pt, Pt]): number {
  let max = 0;
  for (let i = 0; i < 4; i++) {
    max = Math.max(max, dist(a[i], b[i]));
  }
  return max;
}

/** Viereck-Koordinaten skalieren (Detektions-Auflösung -> Video-/Anzeige-Auflösung). */
export function scaleQuad(q: [Pt, Pt, Pt, Pt], factor: number): [Pt, Pt, Pt, Pt] {
  return q.map((p) => ({ x: p.x * factor, y: p.y * factor })) as [Pt, Pt, Pt, Pt];
}

/**
 * Zielformat der entzerrten Karte (Pixel, Verhältnis 63:88).
 * Bewusst großzügig: Die Sammlernummer ist auf der Karte nur ~1,5 % der
 * Kartenhöhe hoch — bei kleinerem Ziel bleibt der OCR zu wenig Substanz.
 */
export const WARP_W = 900;
export const WARP_H = 1257;

/** Nummernbereich in der entzerrten Karte (relative Koordinaten). */
export const STRIP_TOP = 0.845;
export const STRIP_WIDTH = 0.47;
