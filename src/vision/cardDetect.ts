import {
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
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  let approx: Cv | null = null;
  let hull: Cv | null = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Schärfemaß: Varianz des Laplace
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, stddev);
    const sharpness = stddev.data64F[0] ** 2;

    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 40, 120);
    cv.dilate(edges, edges, kernel);

    // RETR_LIST statt RETR_EXTERNAL: bei einem Kantenbild ist die Karte ein
    // dünner Ring — dessen INNERE Begrenzung ist oft die sauberere Kontur.
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameW = imageData.width;
    const frameH = imageData.height;
    const minArea = MIN_AREA_FRACTION * frameW * frameH;
    let best: [Pt, Pt, Pt, Pt] | null = null;
    let bestArea = 0;
    let lastReason: string | undefined;
    let borderTouch = false;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);

      // Über die KONVEXE HÜLLE messen, nicht über die Rohkontur: Auf einem
      // Kantenbild ist eine Kartenkontur ein dünner Ring. Bricht der Ring auf
      // (Reflexion, schwacher Kontrast), liefert contourArea nur die Fläche
      // der „Linienschlange“ — die Karte fiele durch jeden Flächenfilter.
      // Die Hülle stellt die volle Kartenfläche wieder her.
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
        if (check.ok) {
          if (touchesBorder(ordered, frameW, frameH)) {
            borderTouch = true;
            debug?.push(`#${i} Fläche ${((area / (frameW * frameH)) * 100).toFixed(1)}% → am Bildrand`);
          } else if (area > bestArea) {
            best = ordered;
            bestArea = area;
            debug?.push(`#${i} Fläche ${((area / (frameW * frameH)) * 100).toFixed(1)}% → ANGENOMMEN`);
          } else {
            debug?.push(`#${i} Fläche ${((area / (frameW * frameH)) * 100).toFixed(1)}% → plausibel, aber kleiner`);
          }
        } else {
          lastReason = check.reason;
          debug?.push(`#${i} Fläche ${((area / (frameW * frameH)) * 100).toFixed(1)}% → ${check.reason}`);
        }
      } else {
        debug?.push(`#${i} Fläche ${((area / (frameW * frameH)) * 100).toFixed(1)}% → kein Viereck`);
      }
      contour.delete();
    }

    if (!best && borderTouch) lastReason = 'Karte ragt aus dem Bild';
    return { quad: best, sharpness, rejectReason: best ? undefined : lastReason };
  } finally {
    src.delete();
    gray.delete();
    lap.delete();
    blur.delete();
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
    mean.delete();
    stddev.delete();
    approx?.delete();
    hull?.delete();
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
export type StripVariant = 'binary' | 'gray';

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

  const full = cv.imread(warpedCanvas);
  const roi = full.roi(new cv.Rect(x, y, w, h));
  const gray = new cv.Mat();
  const enhanced = new cv.Mat();
  const resized = new cv.Mat();
  const binary = new cv.Mat();
  // Milder als das Maximum: Auf der fast flachen Kartenfläche verstärkt ein
  // hoher clipLimit nur Rauschen zu großflächigen Helligkeitsverläufen.
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  try {
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    clahe.apply(gray, enhanced);
    const scale = 2.2;
    cv.resize(enhanced, resized, new cv.Size(Math.round(w * scale), Math.round(h * scale)), 0, 0, cv.INTER_CUBIC);
    const out = document.createElement('canvas');
    if (variant === 'gray') {
      cv.imshow(out, resized);
      return out;
    }
    // Adaptive Schwelle: macht die Ziffern schwarz auf weiß und entfernt
    // Helligkeitsverläufe. Ohne diesen Schritt lieferte Tesseract im Selftest
    // auf einer gestochen scharfen Nummer leeren Text, weil seine interne
    // Schwellwertbildung am Verlauf scheiterte.
    cv.adaptiveThreshold(resized, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 12);
    cv.imshow(out, binary);
    return out;
  } finally {
    full.delete();
    roi.delete();
    gray.delete();
    enhanced.delete();
    resized.delete();
    binary.delete();
    clahe.delete();
  }
}
