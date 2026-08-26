import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

/**
 * Tesseract läuft in einem eigenen Web Worker (tesseract.js bringt ihn mit),
 * damit das Kamerabild flüssig bleibt. Alle Assets (Worker-Script, WASM-Core,
 * Sprachdaten) liegen lokal unter public/tesseract/ und werden vom Service
 * Worker vorab gecacht -> OCR funktioniert offline und ohne CDN.
 */

let workerPromise: Promise<Worker> | null = null;

function assetBase(): string {
  // Absolute URL nötig, weil tesseract.js den Worker über eine Blob-URL startet
  // und relative Pfade darin nicht auflösbar sind.
  return new URL(`${import.meta.env.BASE_URL}tesseract`, location.href).href;
}

export function initOcr(onProgress?: (status: string, progress: number) => void): Promise<Worker> {
  if (!workerPromise) {
    const base = assetBase();
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${base}/worker.min.js`,
      corePath: `${base}/`,
      langPath: base,
      gzip: true,
      logger: (m) => onProgress?.(m.status, m.progress ?? 0),
    })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789/',
          tessedit_pageseg_mode: PSM.SINGLE_LINE,
        });
        return worker;
      })
      .catch((err) => {
        workerPromise = null;
        throw new Error(
          `OCR konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
  return workerPromise;
}

export async function recognizeDigits(canvas: HTMLCanvasElement): Promise<string> {
  const worker = await initOcr();
  const { data } = await worker.recognize(canvas);
  return data.text ?? '';
}
