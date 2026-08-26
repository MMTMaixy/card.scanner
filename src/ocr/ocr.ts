import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

/**
 * Tesseract läuft in einem eigenen Web Worker (tesseract.js bringt ihn mit),
 * damit das Kamerabild flüssig bleibt. Alle Assets (Worker-Script, WASM-Core,
 * Sprachdaten) liegen lokal unter public/tesseract/ und werden vom Service
 * Worker vorab gecacht -> OCR funktioniert offline und ohne CDN.
 *
 * Wichtig für GitHub-Pages-Unterordner (base: './'): alle Pfade werden hier
 * ABSOLUT aus import.meta.env.BASE_URL + location.href abgeleitet, weil
 * tesseract.js den Worker über eine Blob-URL startet und relative Pfade
 * darin ins Leere zeigen würden.
 */

export function ocrAssetBase(): string {
  return new URL(`${import.meta.env.BASE_URL}tesseract`, location.href).href;
}

// --- Beobachtbarer Lade-Status (für die Diagnose-Ansicht) ---

export interface OcrStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** z. B. "loading language traineddata 40 %" oder die Fehlermeldung */
  detail: string;
}

let status: OcrStatus = { state: 'idle', detail: 'noch nicht gestartet' };
const listeners = new Set<(s: OcrStatus) => void>();

function setStatus(next: OcrStatus) {
  status = next;
  listeners.forEach((l) => l(status));
  if (next.state === 'error') {
    // Nie stillschweigend verschlucken: auch global sichtbar machen
    window.__showBootError?.(`OCR: ${next.detail}`);
  }
}

export function getOcrStatus(): OcrStatus {
  return status;
}

export function onOcrStatus(listener: (s: OcrStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

// --- Initialisierung ---

let workerPromise: Promise<Worker> | null = null;

export function initOcr(): Promise<Worker> {
  if (!workerPromise) {
    const base = ocrAssetBase();
    setStatus({ state: 'loading', detail: `starte (Assets: ${base}/)` });
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${base}/worker.min.js`,
      corePath: `${base}/`,
      langPath: base,
      gzip: true,
      logger: (m) => {
        if (status.state === 'loading') {
          setStatus({
            state: 'loading',
            detail: `${m.status} ${(Math.max(0, m.progress ?? 0) * 100).toFixed(0)} %`,
          });
        }
      },
      errorHandler: (err: unknown) => {
        setStatus({
          state: 'error',
          detail: `Worker-Fehler: ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    })
      .then(async (worker) => {
        // Kein SINGLE_LINE: der Ausschnitt enthält mehrere Textzeilen
        // (Nummer + Copyright). SINGLE_LINE staucht das ganze Bild auf eine
        // Zeilenhöhe zusammen -> Ziffern werden winzig -> leeres Ergebnis.
        // SINGLE_BLOCK liest alle Zeilen; die Nummer filtert danach der
        // Regex + Nenner-Check. Ebenfalls bewusst KEINE Ziffern-Whitelist:
        // LSTM liefert mit Whitelist auf gemischtem Text oft gar nichts.
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        });
        setStatus({ state: 'ready', detail: 'initialisiert' });
        return worker;
      })
      .catch((err) => {
        workerPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ state: 'error', detail: msg });
        throw new Error(`OCR konnte nicht geladen werden: ${msg}`);
      });
  }
  return workerPromise;
}

export async function recognizeDigits(canvas: HTMLCanvasElement): Promise<string> {
  const worker = await initOcr();
  const { data } = await worker.recognize(canvas);
  return data.text ?? '';
}

// --- Asset-Preflight für die Diagnose ---

export interface AssetCheck {
  url: string;
  ok: boolean;
  /** HTTP-Status oder Fehlermeldung */
  info: string;
}

/**
 * Prüft, ob die Tesseract-Dateien unter den erwarteten URLs wirklich liegen.
 * Ein 404 auf GitHub Pages liefert eine text/html-Fehlerseite — genau das
 * würde die OCR sonst mit kryptischen Folgefehlern quittieren.
 */
export async function checkOcrAssets(): Promise<AssetCheck[]> {
  const base = ocrAssetBase();
  const files = [
    'worker.min.js',
    'eng.traineddata.gz',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-lstm.wasm.js',
  ];
  const results: AssetCheck[] = [];
  for (const file of files) {
    const url = `${base}/${file}`;
    try {
      const res = await fetch(url, { method: 'GET' });
      const type = res.headers.get('content-type') ?? '?';
      const size = res.headers.get('content-length');
      // Body nicht herunterladen — nur Header interessieren
      await res.body?.cancel();
      const htmlWarning = type.includes('text/html') ? ' (HTML statt Datei — falscher Pfad!)' : '';
      results.push({
        url,
        ok: res.ok && !htmlWarning,
        info: `HTTP ${res.status}, ${type}${size ? `, ${(Number(size) / 1024).toFixed(0)} KB` : ''}${htmlWarning}`,
      });
    } catch (err) {
      results.push({ url, ok: false, info: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
