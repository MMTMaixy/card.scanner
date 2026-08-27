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
  /** Gemessenes Seitenverhältnis (Höhe/Breite), wenn plausibel */
  aspect?: number;
}

/**
 * Mindestfläche einer Karte im Bild. Bewusst EINE Konstante für Vorfilter und
 * Plausibilitätsprüfung — zwei verschiedene Schwellen haben schon dazu geführt,
 * dass eine erkannte Karte lautlos zwischen den Prüfungen verschwand.
 */
export const MIN_AREA_FRACTION = 0.04;

/** Seitenverhältnis einer Pokémon-Karte: 88 mm hoch zu 63 mm breit. */
export const CARD_ASPECT = 88 / 63;
/**
 * Erlaubter Bereich fürs Seitenverhältnis.
 *
 * Bewusst eng: Mit der früheren Spanne 1,05–1,8 wurde auf einem echten Foto
 * ein 31 % zu breites Rechteck (Verhältnis 1,13) als Karte akzeptiert. Da
 * unter mehreren Treffern der größte gewann, verdrängte es die richtige
 * Karte — und der entzerrte Ausschnitt zeigte dann die falsche Zeile.
 */
export const ASPECT_MIN = 1.2;
export const ASPECT_MAX = 1.65;

/**
 * Wie gut passt ein Seitenverhältnis zur Karte? 0 = perfekt.
 * Logarithmisch, damit Abweichungen nach oben und unten gleich zählen.
 */
export function aspectError(aspect: number): number {
  return Math.abs(Math.log(aspect / CARD_ASPECT));
}

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
  if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
    return { ok: false, reason: `Seitenverhältnis ${aspect.toFixed(2)}` };
  }

  return { ok: true, aspect };
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

/**
 * Untere Infozeile der entzerrten Karte (relative Koordinaten).
 * Dort stehen Sammlernummer, Set-Code-Kästchen, Seltenheitssymbol und
 * Copyright — die Region deckt bewusst die ganze Zeile ab, nicht nur die
 * Nummer.
 */
export const STRIP_TOP = 0.845;
/** Breite einer Hälfte der Infozeile (Nummer steht links oder rechts). */
export const STRIP_WIDTH = 0.47;

/**
 * Das Set-Code-Kästchen sitzt am linken (moderne Karten) bzw. rechten Rand
 * derselben Zeile und ist sehr klein — es bekommt eine eigene, enger
 * geschnittene und stärker vergrößerte OCR-Passe.
 */
export const CODE_TOP = 0.86;
export const CODE_BOTTOM = 0.975;
/** Gleiche Hälfte wie die Nummernregion — der Code steht in derselben Zeile. */
export const CODE_WIDTH = 0.47;

/**
 * Mindestbreite der Karte im Bild, damit die OCR überhaupt startet.
 *
 * Hergeleitet im Selftest: Füllt die Karte weniger als etwa ein Drittel der
 * Bildbreite, ist die Sammlernummer nur wenige Pixel hoch — dann liefert die
 * OCR nicht nur „nichts“, sondern gelegentlich eine FALSCHE Nummer
 * (gemessen: „5/55“ statt „5/84“). Ohne vorgewähltes Set würde die Karte
 * dadurch still im falschen Set landen. Lieber gar nicht lesen und den
 * Nutzer bitten, näher heranzugehen.
 */
export const MIN_CARD_WIDTH_FRACTION = 0.35;

/** Breite des Vierecks (Mittel aus Ober- und Unterkante) relativ zum Bild. */
export function cardWidthFraction(quad: [Pt, Pt, Pt, Pt], frameW: number): number {
  const top = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const bottom = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  return (top + bottom) / 2 / frameW;
}

export function isCardBigEnoughForOcr(quad: [Pt, Pt, Pt, Pt], frameW: number): boolean {
  return cardWidthFraction(quad, frameW) >= MIN_CARD_WIDTH_FRACTION;
}
