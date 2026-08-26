import { isPlausibleCard, orderCorners, STRIP_TOP, STRIP_WIDTH, WARP_H, WARP_W, type Pt } from './quad';

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

export function initCv(): Promise<Cv> {
  if (!cvPromise) {
    setStatus({ state: 'loading', detail: 'lade OpenCV (~13 MB, einmalig) …' });
    cvPromise = import('@techstark/opencv-js')
      .then(async (mod) => {
        // Das UMD-Modul exportiert je nach Bundling das cv-Objekt direkt
        // oder ein Promise darauf (Emscripten-readyPromise).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidate: any = await Promise.resolve((mod as any).default ?? mod);
        if (candidate?.Mat) {
          setStatus({ state: 'ready', detail: 'bereit' });
          return candidate as Cv;
        }
        // Fallback: auf onRuntimeInitialized warten
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('OpenCV-Initialisierung: Timeout nach 30 s')), 30_000);
          candidate.onRuntimeInitialized = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
        if (!candidate?.Mat) throw new Error('OpenCV geladen, aber cv.Mat fehlt');
        setStatus({ state: 'ready', detail: 'bereit' });
        return candidate as Cv;
      })
      .catch((err) => {
        cvPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ state: 'error', detail: msg });
        throw new Error(`OpenCV konnte nicht geladen werden: ${msg}`);
      });
  }
  return cvPromise;
}

/** cv, wenn bereits geladen — sonst null (Loop soll nie auf das Laden warten). */
let cvSync: Cv | null = null;
export function cvIfReady(): Cv | null {
  if (!cvSync && status.state === 'ready' && cvPromise) {
    // Promise ist resolved; synchron abgreifen
    void cvPromise.then((c) => (cvSync = c));
  }
  return cvSync;
}
// Beim ersten erfolgreichen Laden cvSync füllen
onCvStatus((s) => {
  if (s.state === 'ready' && cvPromise) void cvPromise.then((c) => (cvSync = c));
});

export interface DetectResult {
  /** Geordnete Ecken (TL,TR,BR,BL) in Koordinaten des Eingabebildes, oder null */
  quad: [Pt, Pt, Pt, Pt] | null;
  /** Varianz des Laplace = Schärfemaß (höher = schärfer) */
  sharpness: number;
  /** Grund, warum kein Viereck akzeptiert wurde (Diagnose) */
  rejectReason?: string;
}

/**
 * Findet die Kartenkontur in einem (verkleinerten) Frame.
 * Alle cv-Objekte werden hier sauber freigegeben — Leaks lassen die App
 * nach Minuten abstürzen.
 */
export function detectCardQuad(cv: Cv, imageData: ImageData): DetectResult {
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
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Schärfemaß: Varianz des Laplace
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, stddev);
    const sharpness = stddev.data64F[0] ** 2;

    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 40, 120);
    cv.dilate(edges, edges, kernel);

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameW = imageData.width;
    const frameH = imageData.height;
    let best: [Pt, Pt, Pt, Pt] | null = null;
    let bestArea = 0;
    let lastReason: string | undefined;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < 0.06 * frameW * frameH) {
        contour.delete();
        continue;
      }
      const peri = cv.arcLength(contour, true);
      approx?.delete();
      approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts: Pt[] = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
        const ordered = orderCorners(pts);
        const check = isPlausibleCard(ordered, frameW, frameH);
        if (check.ok) {
          if (area > bestArea) {
            best = ordered;
            bestArea = area;
          }
        } else {
          lastReason = check.reason;
        }
      } else {
        lastReason = 'kein Viereck';
      }
      contour.delete();
    }

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
export function extractNumberStrip(
  cv: Cv,
  warpedCanvas: HTMLCanvasElement,
  side: 'left' | 'right',
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
  const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
  try {
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
    clahe.apply(gray, enhanced);
    const scale = 2.2;
    cv.resize(enhanced, resized, new cv.Size(Math.round(w * scale), Math.round(h * scale)), 0, 0, cv.INTER_CUBIC);
    const out = document.createElement('canvas');
    cv.imshow(out, resized);
    return out;
  } finally {
    full.delete();
    roi.delete();
    gray.delete();
    enhanced.delete();
    resized.delete();
    clahe.delete();
  }
}
