import {
  aspectError,
  CODE_BOTTOM,
  CODE_TOP,
  CODE_WIDTH,
  isPlausibleCard,
  MIN_AREA_FRACTION,
  orderCorners,
  STRIP_TOP,
  STRIP_WIDTH,
  WARP_H,
  WARP_W,
  type Pt,
} from './quad';

/**
 * Freie Kartenerkennung mit OpenCV.js (lokal gebündelt, ~13 MB, wird erst
 * beim Kamera-Start als eigener Chunk geladen und vom Service Worker
 * gecacht). Pipeline: Graustufen -> Canny-Kanten -> Konturen -> größtes
 * plausibles Viereck mit Kartenseitenverhältnis -> perspektivische
 * Entzerrung auf 630x880 -> Nummernstreifen mit CLAHE.
 */

// OpenCV-Objekt bewusst untypisiert: die cv-API ist riesig und die
// Emscripten-Typen bringen hier keinen Sicherheitsgewinn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any;

export interface CvStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  detail: string;
}

let status: CvStatus = { state: 'idle', detail: 'noch nicht geladen' };
const listeners = new Set<(s: CvStatus) => void>();

function setStatus(next: CvStatus) {
  status = next;
  listeners.forEach((l) => l(status));
  if (next.state === 'error') {
    window.__showBootError?.(`Kartenerkennung (OpenCV): ${next.detail}`);
  }
}

export function getCvStatus(): CvStatus {
  return status;
}

export function onCvStatus(listener: (s: CvStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

let cvPromise: Promise<Cv> | null = null;
/** Synchron abgreifbar, sobald geladen — die Erkennungsschleife darf nie warten. */
let cvSync: Cv | null = null;

/** Lädt eine Datei als klassisches <script> und wartet auf das load-Ereignis. */
function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-cv="1"]`);
    if (existing) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.dataset.cv = '1';
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Datei nicht ladbar: ${url}`));
    document.head.appendChild(el);
  });
}

/**
 * OpenCV.js wird bewusst als klassisches <script> geladen, nicht per import().
 * Als Emscripten-Modul exportiert es ein `then`; ein Modul-Namensraum mit
 * `then` gilt in JavaScript als Promise-artig, wodurch die Laufzeit beim
 * dynamischen Import dieses `then` mit falschem Empfänger aufruft und
 * abbricht. Als Script gibt es das Problem nicht.
 */
export function initCv(): Promise<Cv> {
  if (!cvPromise) {
    const url = new URL(`${import.meta.env.BASE_URL}opencv/opencv.js`, location.href).href;
    setStatus({ state: 'loading', detail: 'lade OpenCV (~13 MB, einmalig) …' });
    cvPromise = loadScript(url)
      .then(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let candidate: any = (window as any).cv;
        if (!candidate) throw new Error('Script geladen, aber window.cv fehlt');

        // Emscripten liefert je nach Build direkt das Modul, ein echtes
        // Promise darauf, oder erst nach onRuntimeInitialized ein fertiges.
        if (typeof candidate.then === 'function' && !candidate.Mat) {
          candidate = await candidate;
        }
        if (!candidate?.Mat) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Zeitüberschreitung nach 60 s bei der Initialisierung')),
              60_000,
            );
            candidate.onRuntimeInitialized = () => {
              clearTimeout(timeout);
              resolve();
            };
          });
        }
        if (!candidate?.Mat) throw new Error('geladen, aber cv.Mat fehlt');
        cvSync = candidate as Cv;
        setStatus({ state: 'ready', detail: 'bereit' });
        return candidate as Cv;
      })
      .catch((err) => {
        cvPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ state: 'error', detail: msg });
        throw new Error(`OpenCV konnte nicht geladen werden: ${msg} (${url})`);
      });
  }
  return cvPromise;
}

/** cv, wenn bereits geladen — sonst null (Loop soll nie auf das Laden warten). */
export function cvIfReady(): Cv | null {
  return cvSync;
}

export interface DetectResult {
  /** Geordnete Ecken (TL,TR,BR,BL) in Koordinaten des Eingabebildes, oder null */
  quad: [Pt, Pt, Pt, Pt] | null;
  /** Varianz des Laplace = Schärfemaß (höher = schärfer) */
  sharpness: number;
  /** Grund, warum kein Viereck akzeptiert wurde (Diagnose) */
  rejectReason?: string;
}

/** Berührt das Viereck den Bildrand? Dann fehlt vermutlich ein Kartenteil. */
function touchesBorder(quad: [Pt, Pt, Pt, Pt], w: number, h: number): boolean {
  const m = 3;
  return quad.some((p) => p.x <= m || p.y <= m || p.x >= w - m || p.y >= h - m);
}

/**
 * Findet die Kartenkontur in einem (verkleinerten) Frame.
 * Alle cv-Objekte werden hier sauber freigegeben — Leaks lassen die App
 * nach Minuten abstürzen.
 */
export function detectCardQuad(cv: Cv, imageData: ImageData, debug?: string[]): DetectResult {
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const lap = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const hsv = new cv.Mat();
  const sat = new cv.Mat();
  const satMask = new cv.Mat();
  const channels = new cv.MatVector();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const bigKernel = cv.Mat.ones(7, 7, cv.CV_8U);
  const mean = new cv.Mat();
  const stddev = new cv.Mat();

  const frameW = imageData.width;
  const frameH = imageData.height;
  const minArea = MIN_AREA_FRACTION * frameW * frameH;

  let best: [Pt, Pt, Pt, Pt] | null = null;
  let bestScore = Infinity;
  let bestArea = 0;
  let lastReason: string | undefined;
  let borderTouch = false;

  /** Sucht in einem Binärbild nach kartenförmigen Vierecken. */
  function collectFrom(binary: Cv, source: string): void {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let approx: Cv | null = null;
    let hull: Cv | null = null;
    try {
      cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);

        // Über die KONVEXE HÜLLE messen, nicht über die Rohkontur: Auf einem
        // Kantenbild ist eine Kartenkontur ein dünner Ring. Bricht der Ring
        // auf, liefert contourArea nur die Fläche der „Linienschlange“ — die
        // Karte fiele durch jeden Flächenfilter.
        hull?.delete();
        hull = new cv.Mat();
        cv.convexHull(contour, hull);
        const area = cv.contourArea(hull);
        if (area < minArea) {
          contour.delete();
          continue;
        }

        let pts: Pt[] | null = null;
        const peri = cv.arcLength(hull, true);
        approx?.delete();
        approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, 0.02 * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
        } else {
          // Fallback: gedrehtes Umschließungsrechteck. Fängt abgerundete
          // Kartenecken und Konturen, die approxPolyDP nicht auf 4 Ecken
          // reduziert. Nur akzeptieren, wenn die Hülle das Rechteck gut füllt.
          const rect = cv.minAreaRect(hull);
          const rectArea = rect.size.width * rect.size.height;
          if (rectArea > 0 && area / rectArea > 0.7) {
            const corners = cv.RotatedRect.points(rect);
            pts = corners.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
          } else {
            lastReason = 'kein Viereck';
          }
        }

        if (pts && pts.length === 4) {
          const ordered = orderCorners(pts);
          const check = isPlausibleCard(ordered, frameW, frameH);
          const pct = ((area / (frameW * frameH)) * 100).toFixed(1);
          if (check.ok) {
            if (touchesBorder(ordered, frameW, frameH)) {
              borderTouch = true;
              debug?.push(`${source}#${i} ${pct}% → am Bildrand`);
            } else {
              // Nicht der GRÖSSTE Treffer gewinnt, sondern der mit dem
              // kartenähnlichsten Seitenverhältnis. Auf echten Fotos gibt es
              // regelmäßig andere Rechtecke (Licht- und Schattenkanten der
              // Unterlage), die sonst die Karte verdrängen.
              const score = aspectError(check.aspect ?? 0);
              const better =
                score < bestScore - 0.02 || (Math.abs(score - bestScore) <= 0.02 && area > bestArea);
              if (better) {
                best = ordered;
                bestScore = score;
                bestArea = area;
                debug?.push(`${source}#${i} ${pct}%, Verh. ${check.aspect?.toFixed(2)} → ANGENOMMEN`);
              } else {
                debug?.push(`${source}#${i} ${pct}%, Verh. ${check.aspect?.toFixed(2)} → schlechter`);
              }
            }
          } else {
            lastReason = check.reason;
            debug?.push(`${source}#${i} ${pct}% → ${check.reason}`);
          }
        }
        contour.delete();
      }
    } finally {
      contours.delete();
      hierarchy.delete();
      approx?.delete();
      hull?.delete();
    }
  }

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Schärfemaß: Varianz des Laplace
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, stddev);
    const sharpness = stddev.data64F[0] ** 2;

    // Quelle 1: Kanten
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 40, 120);
    cv.dilate(edges, edges, kernel);
    collectFrom(edges, 'Kante');

    // Quelle 2: Farbsättigung.
    // Karten sind bunt bedruckt, typische Unterlagen (Tisch, Stoff) sind es
    // nicht. Auf einem echten Foto war die hellblaue Kartenunterkante zu
    // kontrastarm für Canny — die Kontur schloss an der Rückzug-Linie, und
    // der entzerrte Ausschnitt verlor genau die Zeile mit der Nummer.
    // Über die Sättigung ist die Karte dort klar von der Unterlage getrennt.
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    channels.get(1).copyTo(sat);
    cv.threshold(sat, satMask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(satMask, satMask, cv.MORPH_CLOSE, bigKernel);
    collectFrom(satMask, 'Sättigung');

    if (!best && borderTouch) lastReason = 'Karte ragt aus dem Bild';
    return { quad: best, sharpness, rejectReason: best ? undefined : lastReason };
  } finally {
    src.delete();
    gray.delete();
    lap.delete();
    blur.delete();
    edges.delete();
    hsv.delete();
    sat.delete();
    satMask.delete();
    channels.delete();
    kernel.delete();
    bigKernel.delete();
    mean.delete();
    stddev.delete();
  }
}

/**
 * Entzerrt die Karte perspektivisch auf 630x880 (Hochformat).
 * quad in Koordinaten von srcCanvas.
 */
export function warpCard(cv: Cv, srcCanvas: HTMLCanvasElement, quad: [Pt, Pt, Pt, Pt]): HTMLCanvasElement {
  const src = cv.imread(srcCanvas);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(WARP_W, WARP_H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const out = document.createElement('canvas');
    out.width = WARP_W;
    out.height = WARP_H;
    cv.imshow(out, dst);
    return out;
  } finally {
    src.delete();
    dst.delete();
    srcTri.delete();
    dstTri.delete();
    M.delete();
  }
}

/**
 * Schneidet den Nummernbereich (untere Ecke) aus der entzerrten Karte,
 * wendet CLAHE (adaptive Kontrastnormalisierung — hilft bei wenig Licht)
 * an und skaliert für die OCR hoch.
 */
/**
 * 'binary' = CLAHE + adaptive Schwelle (beste Wahl, wenn die Karte den Sucher
 * gut füllt), 'gray' = nur CLAHE (besser, wenn die Nummer sehr klein ist und
 * die Binarisierung zu viel Substanz wegschneidet). Der Scanner probiert
 * 'binary' zuerst und fällt auf 'gray' zurück.
 */
export type StripVariant = 'binary' | 'gray' | 'binary_inv';

/**
 * Schneidet einen Bereich der entzerrten Karte aus, hebt den Kontrast
 * adaptiv an (CLAHE) und vergrößert ihn für die OCR.
 */
function extractRegion(
  cv: Cv,
  warpedCanvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  variant: StripVariant,
  /**
   * Fenstergröße der adaptiven Schwelle. Muss KLEINER sein als das zu
   * erkennende Element: Beim Set-Code-Kästchen (dunkler Kasten in heller
   * Umgebung) zog ein zu großes Fenster den lokalen Mittelwert aus der
   * Umgebung — der Kasten samt Text fiel komplett weg.
   */
  blockSize = 41,
): HTMLCanvasElement {
  const full = cv.imread(warpedCanvas);
  const roi = full.roi(new cv.Rect(x, y, w, h));
  const gray = new cv.Mat();
  const enhanced = new cv.Mat();
  const resized = new cv.Mat();
  const binary = new cv.Mat();
  const padded = new cv.Mat();
  // Milder als das Maximum: Auf der fast flachen Kartenfläche verstärkt ein
  // hoher clipLimit nur Rauschen zu großflächigen Helligkeitsverläufen.
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  try {
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    clahe.apply(gray, enhanced);
    cv.resize(enhanced, resized, new cv.Size(Math.round(w * scale), Math.round(h * scale)), 0, 0, cv.INTER_CUBIC);
    const out = document.createElement('canvas');
    // Rand in Weiß: Bei eng geschnittenen Ausschnitten findet Tesseracts
    // Layout-Analyse ohne Rand um den Text oft gar keine Zeile.
    const PAD = 24;
    if (variant === 'gray') {
      cv.copyMakeBorder(resized, padded, PAD, PAD, PAD, PAD, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      cv.imshow(out, padded);
      return out;
    }
    // Adaptive Schwelle: macht die Ziffern schwarz auf weiß und entfernt
    // Helligkeitsverläufe. Ohne diesen Schritt lieferte Tesseract im Selftest
    // auf einer gestochen scharfen Nummer leeren Text, weil seine interne
    // Schwellwertbildung am Verlauf scheiterte.
    // Das Set-Code-Kästchen ist auf vielen Karten heller Text auf dunklem
    // Grund. Tesseract erwartet dunkel auf hell — deshalb gibt es die
    // invertierte Variante.
    cv.adaptiveThreshold(
      resized,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      variant === 'binary_inv' ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY,
      blockSize,
      12,
    );
    cv.copyMakeBorder(binary, padded, PAD, PAD, PAD, PAD, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    cv.imshow(out, padded);
    return out;
  } finally {
    full.delete();
    roi.delete();
    gray.delete();
    enhanced.delete();
    resized.delete();
    binary.delete();
    padded.delete();
    clahe.delete();
  }
}

/**
 * Passe 1 — Sammlernummer: die komplette untere Infozeile, linke oder rechte
 * Hälfte (die Nummer steht je nach Kartenära links oder rechts).
 */
export function extractNumberStrip(
  cv: Cv,
  warpedCanvas: HTMLCanvasElement,
  side: 'left' | 'right',
  variant: StripVariant = 'binary',
): HTMLCanvasElement {
  const x = side === 'left' ? 0 : Math.round(WARP_W * (1 - STRIP_WIDTH));
  const y = Math.round(WARP_H * STRIP_TOP);
  const w = Math.round(WARP_W * STRIP_WIDTH);
  const h = WARP_H - y;
  return extractRegion(cv, warpedCanvas, x, y, w, h, 2.2, variant);
}

/**
 * Passe 2 — Set-Code: dieselbe Zeile, aber eigens optimiert.
 *
 * Drei Unterschiede zur Nummern-Passe, alle im Selftest hergeleitet:
 *  - nur das Band der Code-Zeile (ohne Copyright-Zeile darunter),
 *  - 3,5fache statt 2,2facher Vergrößerung, weil der Code winziger ist,
 *  - umgekehrte Polarität möglich: Das Kästchen ist auf den meisten Karten
 *    heller Text auf dunklem Grund, und so gedruckten Text liest Tesseract
 *    ohne Invertierung nicht.
 */
export function extractCodeStrip(
  cv: Cv,
  warpedCanvas: HTMLCanvasElement,
  side: 'left' | 'right',
  variant: StripVariant = 'binary',
): HTMLCanvasElement {
  const w = Math.round(WARP_W * CODE_WIDTH);
  const x = side === 'left' ? 0 : WARP_W - w;
  const y = Math.round(WARP_H * CODE_TOP);
  const h = Math.round(WARP_H * (CODE_BOTTOM - CODE_TOP));
  return extractRegion(cv, warpedCanvas, x, y, w, h, 3.5, variant, 15);
}

/**
 * Passe 2b — findet das Set-Code-Kästchen als dunklen Block und schneidet
 * NUR dieses aus, invertiert.
 *
 * Warum dieser Umweg: Der Code steht auf den meisten Karten hell auf dunklem
 * Kästchen. Invertiert man den ganzen Streifen, stimmt die Polarität zwar im
 * Kästchen, ist aber im restlichen (hellen) Bild falsch — Tesseract liefert
 * dann Buchstabensalat. Deshalb erst den Kasten lokalisieren, dann gezielt
 * invertieren und stark vergrößern.
 */
export function extractCodeBoxes(
  cv: Cv,
  warpedCanvas: HTMLCanvasElement,
  side: 'left' | 'right',
): HTMLCanvasElement[] {
  const w = Math.round(WARP_W * CODE_WIDTH);
  const x = side === 'left' ? 0 : WARP_W - w;
  const y = Math.round(WARP_H * CODE_TOP);
  const h = Math.round(WARP_H * (CODE_BOTTOM - CODE_TOP));

  const full = cv.imread(warpedCanvas);
  const roi = full.roi(new cv.Rect(x, y, w, h));
  const gray = new cv.Mat();
  const dark = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const out: HTMLCanvasElement[] = [];
  try {
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    // Dunkle Flächen isolieren (Otsu, invertiert -> Kasten wird weiß)
    cv.threshold(gray, dark, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.findContours(dark, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      c.delete();
      const aspect = r.width / Math.max(1, r.height);
      // Ein Code-Kästchen ist breiter als hoch, füllt aber nur einen
      // kleinen Teil der Zeile — das grenzt es gegen Text und Ränder ab.
      if (r.height < h * 0.1 || r.height > h * 0.95) continue;
      if (aspect < 1.1 || aspect > 5) continue;
      if (r.width < w * 0.04 || r.width > w * 0.45) continue;
      boxes.push(r);
    }
    // Größte zuerst — das Kästchen ist der dominante dunkle Block der Zeile
    boxes.sort((a, b) => b.width * b.height - a.width * a.height);

    for (const r of boxes.slice(0, 2)) {
      // Strikt INNERHALB des Kästchens schneiden. Ein mitgeschnittener
      // dunkler Rand ringsum lässt Tesseracts Layout-Analyse scheitern —
      // die Schrift selbst ist dann zwar gestochen scharf, kommt aber als
      // Zeichensalat zurück.
      const inset = Math.max(1, Math.round(r.height * 0.12));
      const bx = r.x + inset;
      const by = r.y + inset;
      const bw = Math.max(4, r.width - 2 * inset);
      const bh = Math.max(4, r.height - 2 * inset);
      const box = gray.roi(new cv.Rect(bx, by, bw, bh));
      const inverted = new cv.Mat();
      const scaled = new cv.Mat();
      const padded = new cv.Mat();
      try {
        cv.bitwise_not(box, inverted);
        const scale = Math.max(6, 160 / Math.max(1, bh));
        cv.resize(inverted, scaled, new cv.Size(Math.round(bw * scale), Math.round(bh * scale)), 0, 0, cv.INTER_CUBIC);
        cv.copyMakeBorder(scaled, padded, 30, 30, 30, 30, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
        const canvas = document.createElement('canvas');
        cv.imshow(canvas, padded);
        out.push(canvas);
      } finally {
        box.delete();
        inverted.delete();
        scaled.delete();
        padded.delete();
      }
    }
    return out;
  } finally {
    full.delete();
    roi.delete();
    gray.delete();
    dark.delete();
    contours.delete();
    hierarchy.delete();
  }
}
