import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkOcrAssets,
  getOcrStatus,
  initOcr,
  onOcrStatus,
  recognizeCode,
  recognizeDigits,
  type AssetCheck,
  type OcrStatus,
} from '../ocr/ocr';
import {
  cvIfReady,
  detectCardQuad,
  extractCodeBoxes,
  extractNumberStrip,
  getCvStatus,
  initCv,
  onCvStatus,
  warpCard,
  type CvStatus,
} from '../vision/cardDetect';
import {
  cardWidthFraction,
  isCardBigEnoughForOcr,
  maxCornerDelta,
  MIN_CARD_WIDTH_FRACTION,
  scaleQuad,
  WARP_H,
  WARP_W,
  type Pt,
} from '../vision/quad';
import { normalizeLocalId, parseScanText } from '../logic/numberParse';

/** Was eine gescannte Karte hergibt, bevor das Set bestimmt ist. */
export interface Reading {
  numerator: string;
  denominator: number;
  /** Roher OCR-Text der Set-Code-Passe (kann leer sein) */
  codeText: string;
}

interface Props {
  /**
   * Prüft, ob ein gelesener Nenner in der gewählten Sprache überhaupt zu
   * einem Set gehört. Ersetzt die frühere Prüfung gegen das vorgewählte Set.
   */
  isPlausibleReading: (denominator: number, numerator: string) => boolean;
  /** Übernimmt die Lesung; true = Karte wurde eingetragen. */
  onScan: (reading: Reading) => Promise<boolean>;
  /** Foto-Abgleich mit der entzerrten Karte (Fallback ohne lesbare Nummer). */
  onPhotoMatch: (warped: HTMLCanvasElement) => Promise<void>;
  /**
   * Erkennung anhalten, solange ein Dialog offen ist. Sonst tauscht ein
   * weiterer Treffer die offene Set-Rückfrage unter dem Finger aus.
   */
  paused?: boolean;
}

type Phase = 'idle' | 'starting' | 'scanning' | 'error';
type Quad = [Pt, Pt, Pt, Pt];

/** Erkennungs-Takt: Konturensuche ist billig (verkleinerter Frame). */
const DETECT_INTERVAL_MS = 140;
/** Breite des Frames für die Konturensuche. */
const DETECT_W = 480;
/**
 * Obergrenze für die OCR-Quelle. Bewusst hoch: Die Sammlernummer ist winzig,
 * jede Verkleinerung vor dem Entzerren kostet genau die Details, die die OCR
 * braucht. Gemessen im Selftest: Aus 1280 wurde „oosi0a4“ statt „005/084“.
 */
const WORK_W = 2560;
/** Mindest-Schärfe (Varianz des Laplace) — darunter keine OCR. */
const SHARPNESS_MIN = 45;
/** So viele stabile Frames in Folge, bevor die OCR startet. */
const STABLE_N = 2;
/**
 * Max. Eckverschiebung (Anteil der Framebreite), die noch als stabil gilt.
 * Auf dem Gerät wurden mit 0,025 rund 90 % der Frames als „instabil“
 * verworfen — beim Halten in der Hand zittert der Umriss immer etwas.
 */
const STABLE_DELTA = 0.045;
/** Sperre gegen Doppelzählung; wird verlängert, solange die Karte im Bild liegt. */
const LOCK_MS = 2000;
/** Zwei übereinstimmende Lesungen innerhalb dieses Fensters = Treffer. */
const CONSENSUS_WINDOW_MS = 2200;

interface SideDiag {
  raw: string;
  parsed: string;
  ms: number;
}

interface DiagInfo {
  framesAnalyzed: number;
  ocrRuns: number;
  rejects: Record<string, number>;
  videoInfo: string;
  captureInfo: string;
  sharpness: string;
  detect: string;
  brightness: string;
  left: SideDiag | null;
  right: SideDiag | null;
  code: string;
}

const EMPTY_DIAG: DiagInfo = {
  framesAnalyzed: 0,
  ocrRuns: 0,
  rejects: {},
  videoInfo: '–',
  captureInfo: '–',
  sharpness: '–',
  detect: '–',
  brightness: '–',
  left: null,
  right: null,
  code: '–',
};

interface CameraDevice {
  deviceId: string;
  label: string;
}

const CAMERA_STORAGE_KEY = 'scanner.cameraId';

/**
 * Wartet, bis das Video wirklich Bilder liefert: loadedmetadata ist gefeuert
 * UND videoWidth > 0. Vorher auf die Canvas zu zeichnen ergäbe leere Frames.
 */
function waitForVideoReady(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.videoWidth > 0 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (video.videoWidth > 0 && video.readyState >= 2) {
        cleanup();
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(
          new Error(
            `Video wird nicht bereit (videoWidth=${video.videoWidth}, readyState=${video.readyState}) — der Kamerastream liefert keine Bilder.`,
          ),
        );
      }
    };
    const timer = setInterval(check, 100);
    video.addEventListener('loadedmetadata', check);
    function cleanup() {
      clearInterval(timer);
      video.removeEventListener('loadedmetadata', check);
    }
  });
}

export function Scanner({ isPlausibleReading, onScan, onPhotoMatch, paused = false }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [flash, setFlash] = useState<'ok' | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>(getOcrStatus());
  const [cvStatus, setCvStatus] = useState<CvStatus>(getCvStatus());
  const [assetChecks, setAssetChecks] = useState<AssetCheck[] | null>(null);
  const [diag, setDiag] = useState<DiagInfo>(EMPTY_DIAG);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ocrBusyRef = useRef(false);
  const pendingRef = useRef<{ key: string; count: number; ts: number } | null>(null);
  const locksRef = useRef(new Map<string, number>());
  const audioRef = useRef<AudioContext | null>(null);
  const pausedRef = useRef(false);
  const externalPauseRef = useRef(false);
  /** Zuletzt gelesener Set-Code je Kartennummer (spart die teure zweite Passe). */
  const codeCacheRef = useRef<{ key: string; text: string } | null>(null);
  const detCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const countersRef = useRef({ analyzed: 0, ocrRuns: 0, rejects: {} as Record<string, number> });
  const lastQuadRef = useRef<Quad | null>(null);
  const stableCountRef = useRef(0);
  const lastDiagTsRef = useRef(0);
  const lastFrameDiagTsRef = useRef(0);
  const brightnessRef = useRef('–');
  const diagFrameRef = useRef<HTMLCanvasElement>(null);
  const diagLeftRef = useRef<HTMLCanvasElement>(null);
  const diagRightRef = useRef<HTMLCanvasElement>(null);
  const sideDiagRef = useRef<{ left: SideDiag | null; right: SideDiag | null }>({ left: null, right: null });
  const codeDiagRef = useRef('–');
  const diagCodeRef = useRef<HTMLCanvasElement>(null);
  const captureInfoRef = useRef('–');

  useEffect(() => onOcrStatus(setOcrStatus), []);
  useEffect(() => onCvStatus(setCvStatus), []);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    pendingRef.current = null;
    ocrBusyRef.current = false;
    lastQuadRef.current = null;
    setTorchOn(false);
    setPhase('idle');
  }, []);

  useEffect(() => stop, [stop]);

  // Von außen angeforderte Pause (offener Dialog)
  useEffect(() => {
    externalPauseRef.current = paused;
  }, [paused]);

  // Bei verstecktem Tab pausieren
  useEffect(() => {
    const onVisibility = () => {
      pausedRef.current = document.hidden;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  function beep() {
    try {
      const ctx = (audioRef.current ??= new AudioContext());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1100;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);
    } catch {
      // Ton ist nice-to-have
    }
  }

  function reject(reason: string) {
    countersRef.current.rejects[reason] = (countersRef.current.rejects[reason] ?? 0) + 1;
  }

  /** Erkannten Kartenumriss (Detektions-Koordinaten) farbig ins Livebild zeichnen. */
  function drawOverlay(quad: Quad | null, detW: number) {
    const canvas = overlayRef.current;
    const container = containerRef.current;
    const video = videoRef.current;
    if (!canvas || !container || !video) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!quad || !video.videoWidth) return;

    // Detektions-Koordinaten -> Video -> Container (object-fit: cover)
    const toVideo = video.videoWidth / detW;
    const s = Math.max(cw / video.videoWidth, ch / video.videoHeight);
    const ox = (video.videoWidth * s - cw) / 2;
    const oy = (video.videoHeight * s - ch) / 2;
    const pts = quad.map((p) => ({ x: p.x * toVideo * s - ox, y: p.y * toVideo * s - oy }));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#ffe14d';
    ctx.shadowColor = 'rgba(255, 225, 77, 0.55)';
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** Diagnose: Frame-Vorschau + mittlere Helligkeit (throttled). */
  function updateFrameDiag(video: HTMLVideoElement) {
    const now = Date.now();
    if (now - lastFrameDiagTsRef.current < 600) return;
    lastFrameDiagTsRef.current = now;
    const canvas = diagFrameRef.current;
    if (!canvas) return;
    const w = 320;
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 32) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      n++;
    }
    const mean = n ? sum / n : 0;
    brightnessRef.current =
      mean < 3 ? `${mean.toFixed(1)} — Frame ist SCHWARZ, Capture liefert keine Bilder!` : mean.toFixed(1);
  }

  function copyToDiagCanvas(src: HTMLCanvasElement, dest: HTMLCanvasElement | null) {
    if (!dest) return;
    dest.width = src.width;
    dest.height = src.height;
    dest.getContext('2d')?.drawImage(src, 0, 0);
  }

  function describeParse(raw: string): string {
    const parsed = parseScanText(raw);
    if (!parsed) return 'kein Zähler/Nenner-Muster';
    const fits = isPlausibleReading(parsed.denominator, parsed.numerator);
    return `gelesen ${parsed.numerator}/${parsed.denominator} — Nenner ${
      fits ? 'kommt in dieser Sprache vor' : 'gehoert zu keinem Set dieser Sprache'
    }`;
  }

  function pushDiag(sharpness: number | null, detect: string, videoInfo: string) {
    const now = Date.now();
    if (now - lastDiagTsRef.current < 300) return;
    lastDiagTsRef.current = now;
    setDiag({
      framesAnalyzed: countersRef.current.analyzed,
      ocrRuns: countersRef.current.ocrRuns,
      rejects: { ...countersRef.current.rejects },
      videoInfo,
      captureInfo: captureInfoRef.current,
      sharpness: sharpness == null ? '–' : `${sharpness.toFixed(0)} (Minimum ${SHARPNESS_MIN})`,
      detect,
      brightness: brightnessRef.current,
      left: sideDiagRef.current.left,
      right: sideDiagRef.current.right,
      code: codeDiagRef.current,
    });
  }

  const handleReading = useCallback(
    async (text: string, codeText: string): Promise<boolean> => {
      const parsed = parseScanText(text);
      if (!parsed || !isPlausibleReading(parsed.denominator, parsed.numerator)) return false;

      const key = `${normalizeLocalId(parsed.numerator)}/${parsed.denominator}`;
      const now = Date.now();

      // Karte liegt noch im Bild -> Sperre verlängern, nicht doppelt zählen
      const lockedUntil = locksRef.current.get(key);
      if (lockedUntil && now < lockedUntil) {
        locksRef.current.set(key, now + LOCK_MS);
        return false;
      }

      // Konsens: zwei übereinstimmende Lesungen kurz hintereinander
      const pending = pendingRef.current;
      if (!pending || pending.key !== key || now - pending.ts > CONSENSUS_WINDOW_MS) {
        pendingRef.current = { key, count: 1, ts: now };
        return false;
      }
      pendingRef.current = null;

      const ok = await onScan({
        numerator: parsed.numerator,
        denominator: parsed.denominator,
        codeText,
      });
      if (ok) {
        locksRef.current.set(key, Date.now() + LOCK_MS);
        beep();
        setFlash('ok');
        setTimeout(() => setFlash(null), 450);
      }
      return ok;
    },
    [isPlausibleReading, onScan],
  );

  /** OCR auf der entzerrten Karte (läuft asynchron neben der Erkennungsschleife). */
  const runOcr = useCallback(
    async (quadDet: Quad, detW: number) => {
      const video = videoRef.current;
      const cv = cvIfReady();
      if (!video || !cv) return;
      ocrBusyRef.current = true;
      try {
        const ww = Math.min(WORK_W, video.videoWidth);
        const wh = Math.round((video.videoHeight / video.videoWidth) * ww);
        const work = (workCanvasRef.current ??= document.createElement('canvas'));
        work.width = ww;
        work.height = wh;
        const ctx = work.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, ww, wh);

        const quadWork = scaleQuad(quadDet, ww / detW);
        const warped = warpCard(cv, work, quadWork);

        countersRef.current.ocrRuns++;

        // --- Passe 1: Sammlernummer aus der unteren Infozeile ---
        // Beide Hälften, je zwei Vorverarbeitungen. 'binary' trifft besser,
        // wenn die Karte den Sucher füllt; 'gray' rettet die Fälle, in denen
        // die Nummer sehr klein ist. Die zweite Variante läuft nur, wenn die
        // erste nichts Gültiges ergab.
        let numberText: string | null = null;
        outer: for (const side of ['left', 'right'] as const) {
          for (const variant of ['binary', 'gray'] as const) {
            const strip = extractNumberStrip(cv, warped, side, variant);
            captureInfoRef.current = `Karte ${WARP_W}×${WARP_H}, Zeile ${strip.width}×${strip.height} (${variant})`;
            copyToDiagCanvas(strip, side === 'left' ? diagLeftRef.current : diagRightRef.current);
            const t0 = performance.now();
            const text = await recognizeDigits(strip);
            const ms = Math.round(performance.now() - t0);
            const raw = text.replace(/\s+/g, ' ').trim();
            sideDiagRef.current[side] = { raw: `${variant}: ${raw}`, parsed: describeParse(raw), ms };

            const parsed = parseScanText(raw);
            if (!parsed || !isPlausibleReading(parsed.denominator, parsed.numerator)) continue;
            numberText = raw;
            break outer;
          }
        }
        if (!numberText) return;

        // --- Passe 2: Set-Code aus dem kleinen Kästchen derselben Zeile ---
        // Das Kästchen wird erst als dunkler Block lokalisiert, dann strikt
        // innerhalb geschnitten, invertiert und stark vergrößert. Ohne diese
        // Isolierung liefert Tesseract nur Zeichensalat (im Selftest belegt).
        // Diese Passe ist teuer (mehrere OCR-Läufe). Für dieselbe Kartennummer
        // läuft sie deshalb nur EINMAL; der Bestätigungs-Frame nutzt das
        // gespeicherte Ergebnis. Das halbiert die Wartezeit bis zum Treffer.
        const parsedNow = parseScanText(numberText);
        const codeKey = parsedNow
          ? `${normalizeLocalId(parsedNow.numerator)}/${parsedNow.denominator}`
          : '';
        let codeText = '';
        if (codeKey && codeCacheRef.current?.key === codeKey) {
          codeText = codeCacheRef.current.text;
        } else {
          for (const side of ['left', 'right'] as const) {
            for (const [i, box] of extractCodeBoxes(cv, warped, side).entries()) {
              if (side === 'left' && i === 0) copyToDiagCanvas(box, diagCodeRef.current);
              const text = (await recognizeCode(box)).replace(/\s+/g, ' ').trim();
              if (text) codeText += (codeText ? ' ' : '') + text;
            }
            // Rechte Seite nur, wenn links nichts kam
            if (codeText) break;
          }
          if (codeKey) codeCacheRef.current = { key: codeKey, text: codeText };
        }
        codeDiagRef.current = codeText || '∅ leer';

        await handleReading(numberText, codeText);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        ocrBusyRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleReading, isPlausibleReading],
  );

  /** Erkennungsschleife: Kontur suchen, Overlay zeichnen, Gating, ggf. OCR anstoßen. */
  const detectTick = useCallback(() => {
    const video = videoRef.current;
    const videoInfo = video?.videoWidth
      ? `${video.videoWidth}×${video.videoHeight}, readyState=${video.readyState}, ${video.paused ? 'PAUSIERT' : 'läuft'}`
      : '–';

    if (pausedRef.current) return;
    if (externalPauseRef.current) {
      reject('Rückfrage offen');
      pushDiag(null, 'wartet auf deine Set-Auswahl', videoInfo);
      return;
    }
    if (!video || !video.videoWidth || video.readyState < 2) {
      reject('Video nicht bereit');
      pushDiag(null, '–', videoInfo);
      return;
    }
    const cv = cvIfReady();
    if (!cv) {
      reject('OpenCV lädt noch');
      pushDiag(null, '–', videoInfo);
      return;
    }

    const detW = DETECT_W;
    const detH = Math.round((video.videoHeight / video.videoWidth) * detW);
    const det = (detCanvasRef.current ??= document.createElement('canvas'));
    det.width = detW;
    det.height = detH;
    const ctx = det.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, detW, detH);
    const imageData = ctx.getImageData(0, 0, detW, detH);

    let result;
    try {
      result = detectCardQuad(cv, imageData);
    } catch (err) {
      reject('OpenCV-Fehler');
      setErrorMsg(`Kartenerkennung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    countersRef.current.analyzed++;
    updateFrameDiag(video);
    drawOverlay(result.quad, detW);

    let detectMsg: string;
    if (!result.quad) {
      stableCountRef.current = 0;
      lastQuadRef.current = null;
      reject(result.rejectReason ? `keine Karte (${result.rejectReason})` : 'keine Karte');
      detectMsg = result.rejectReason ? `keine Karte (${result.rejectReason})` : 'keine Karte im Bild';
    } else {
      // Stabilität: Ecken dürfen sich kaum bewegen
      const prev = lastQuadRef.current;
      lastQuadRef.current = result.quad;
      if (prev && maxCornerDelta(prev, result.quad) <= STABLE_DELTA * detW) {
        stableCountRef.current++;
      } else {
        stableCountRef.current = 0;
      }

      if (!isCardBigEnoughForOcr(result.quad, detW)) {
        reject('Karte zu klein');
        detectMsg = `Karte erkannt, aber zu klein (${(cardWidthFraction(result.quad, detW) * 100).toFixed(0)} % der Bildbreite, nötig ${MIN_CARD_WIDTH_FRACTION * 100} %) — näher heranhalten`;
      } else if (result.sharpness < SHARPNESS_MIN) {
        reject('unscharf');
        detectMsg = 'Karte erkannt, aber unscharf';
      } else if (stableCountRef.current < STABLE_N) {
        reject('instabil (Bewegung)');
        detectMsg = 'Karte erkannt, wartet auf ruhiges Bild';
      } else if (ocrBusyRef.current) {
        reject('OCR beschäftigt');
        detectMsg = 'Karte stabil, OCR läuft bereits';
      } else {
        detectMsg = 'Karte stabil → OCR';
        void runOcr(result.quad, detW);
      }
    }
    pushDiag(result.sharpness, detectMsg, videoInfo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runOcr]);

  // Laufende Erkennungsschleife
  useEffect(() => {
    if (phase !== 'scanning') return;
    const id = setInterval(detectTick, DETECT_INTERVAL_MS);
    timerRef.current = id;
    return () => clearInterval(id);
  }, [phase, detectTick]);

  /** Stream anfordern: gewünschte Kamera, 10 fps (längere Belichtung bei wenig Licht). */
  async function acquireStream(deviceId: string | null): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 10 },
      },
      audio: false,
    });
  }

  async function attachStream(stream: MediaStream) {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) throw new Error('Video-Element fehlt.');
    video.srcObject = stream;
    await video.play();
    // Verdachtsfall aus der Praxis: NIE zeichnen, bevor das Video bereit ist
    await waitForVideoReady(video, 8000);

    const track = stream.getVideoTracks()[0];
    setCurrentDeviceId(track.getSettings().deviceId ?? null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps: any = track.getCapabilities?.() ?? {};
    setTorchSupported(!!caps.torch);
    setTorchOn(false);

    // Kameraliste (Labels gibt es erst nach erteilter Berechtigung)
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((d) => d.kind === 'videoinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Kamera ${i + 1}` })),
      );
    } catch {
      // Liste ist optional
    }
  }

  async function switchCamera(deviceId: string) {
    try {
      localStorage.setItem(CAMERA_STORAGE_KEY, deviceId);
    } catch {
      // Speicherung optional
    }
    try {
      const stream = await acquireStream(deviceId);
      await attachStream(stream);
    } catch (err) {
      setErrorMsg(`Kamerawechsel fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
    } catch (err) {
      setErrorMsg(`Taschenlampe nicht schaltbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function start() {
    setErrorMsg(null);
    setPhase('starting');
    countersRef.current = { analyzed: 0, ocrRuns: 0, rejects: {} };
    sideDiagRef.current = { left: null, right: null };
    captureInfoRef.current = '–';
    setDiag(EMPTY_DIAG);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Kamera-API nicht verfügbar. Die Seite muss über HTTPS (oder localhost) laufen – siehe README, Abschnitt „Auf dem Tablet testen“.',
        );
      }
      // OCR + OpenCV parallel zum Kamera-Start laden; Status kommt über Listener
      const ocrReady = initOcr();
      const cvReady = initCv();
      checkOcrAssets().then(setAssetChecks).catch(() => {});

      let savedId: string | null = null;
      try {
        savedId = localStorage.getItem(CAMERA_STORAGE_KEY);
      } catch {
        // egal
      }
      let stream: MediaStream;
      try {
        stream = await acquireStream(savedId);
      } catch {
        // Gespeicherte Kamera existiert nicht mehr -> Standard
        stream = await acquireStream(null);
      }
      await attachStream(stream);
      await Promise.all([ocrReady, cvReady]);
      setPhase('scanning');
    } catch (err) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      let msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        msg =
          'Kamera-Zugriff wurde verweigert. In Chrome: Schloss-Symbol in der Adressleiste → Berechtigungen → Kamera erlauben, dann neu versuchen.';
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        msg = 'Keine Kamera gefunden.';
      }
      setErrorMsg(msg);
      setPhase('error');
    }
  }

  /**
   * Foto-Abgleich: Karte erkennen, entzerren und die entzerrte Karte an die
   * App geben. Welche Sets verglichen werden, entscheidet die App — der
   * Abgleich läuft bewusst nur über die Kandidatensets.
   */
  async function photoMatch() {
    setPhotoBusy(true);
    setErrorMsg(null);
    try {
      const video = videoRef.current;
      const cv = cvIfReady();
      if (!video || !video.videoWidth) throw new Error('Video liefert kein Bild (videoWidth=0).');
      if (!cv) throw new Error('OpenCV ist noch nicht geladen.');

      const detW = DETECT_W;
      const detH = Math.round((video.videoHeight / video.videoWidth) * detW);
      const det = (detCanvasRef.current ??= document.createElement('canvas'));
      det.width = detW;
      det.height = detH;
      const dctx = det.getContext('2d', { willReadFrequently: true });
      if (!dctx) throw new Error('Canvas nicht verfügbar.');
      dctx.drawImage(video, 0, 0, detW, detH);
      const result = detectCardQuad(cv, dctx.getImageData(0, 0, detW, detH));
      if (!result.quad) {
        throw new Error('Keine Karte im Bild erkannt — Karte flach und vollständig ins Bild legen.');
      }

      const ww = Math.min(WORK_W, video.videoWidth);
      const wh = Math.round((video.videoHeight / video.videoWidth) * ww);
      const work = (workCanvasRef.current ??= document.createElement('canvas'));
      work.width = ww;
      work.height = wh;
      work.getContext('2d')?.drawImage(video, 0, 0, ww, wh);
      const warped = warpCard(cv, work, scaleQuad(result.quad, ww / detW));

      await onPhotoMatch(warped);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoBusy(false);
    }
  }

  function statusLabel(s: OcrStatus | CvStatus): string {
    switch (s.state) {
      case 'idle':
        return `nicht initialisiert (${s.detail})`;
      case 'loading':
        return `lädt … ${s.detail}`;
      case 'ready':
        return `bereit`;
      case 'error':
        return `FEHLER: ${s.detail}`;
    }
  }

  const rejectEntries = Object.entries(diag.rejects).sort((a, b) => b[1] - a[1]);

  return (
    <section className="card-section scanner">
      <h2>Scannen</h2>

      {(phase === 'idle' || phase === 'error') && (
        <button className="primary" onClick={() => void start()}>
          📷 Kamera starten
        </button>
      )}

      {phase === 'starting' && (
        <p className="muted">
          Starte Kamera … (OCR: {statusLabel(ocrStatus)} · OpenCV: {statusLabel(cvStatus)})
        </p>
      )}

      {errorMsg && <p className="inline-error">{errorMsg}</p>}

      <div
        ref={containerRef}
        className={`scanner-view ${phase === 'scanning' || phase === 'starting' ? '' : 'hidden'} ${flash === 'ok' ? 'flash-ok' : ''}`}
      >
        <video ref={videoRef} playsInline muted />
        <canvas ref={overlayRef} className="scanner-overlay" />
        {phase === 'scanning' && (
          <div className="scanner-hint">
            Karte einfach ins Bild halten – der gelbe Rahmen zeigt die erkannte Karte
          </div>
        )}
      </div>

      {phase === 'scanning' && (
        <div className="scanner-actions">
          {torchSupported && (
            <button onClick={() => void toggleTorch()} className={torchOn ? 'torch-on' : ''}>
              🔦 {torchOn ? 'Licht aus' : 'Licht an'}
            </button>
          )}
          {devices.length > 1 && (
            <select
              value={currentDeviceId ?? ''}
              onChange={(e) => void switchCamera(e.target.value)}
              title="Kamera wählen"
            >
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => void photoMatch()} disabled={photoBusy}>
            {photoBusy ? 'Vergleiche Bild …' : '🔍 Foto-Abgleich (ohne Nummer)'}
          </button>
          <button onClick={stop}>Kamera stoppen</button>
        </div>
      )}

      {phase !== 'idle' && (
        <details className="diag">
          <summary>🔧 Diagnose</summary>

          <dl className="diag-grid">
            <dt>OCR-Engine</dt>
            <dd className={ocrStatus.state === 'error' ? 'diag-bad' : ''}>{statusLabel(ocrStatus)}</dd>

            <dt>OpenCV</dt>
            <dd className={cvStatus.state === 'error' ? 'diag-bad' : ''}>{statusLabel(cvStatus)}</dd>

            <dt>Video-Stream</dt>
            <dd>{diag.videoInfo}</dd>

            <dt>Erkennung</dt>
            <dd>{diag.detect}</dd>

            <dt>Schärfe (Laplace-Varianz)</dt>
            <dd>{diag.sharpness}</dd>

            <dt>Frames analysiert</dt>
            <dd>
              {diag.framesAnalyzed} · OCR-Läufe: {diag.ocrRuns}
            </dd>

            <dt>Verworfen (Gating)</dt>
            <dd>
              {rejectEntries.length === 0
                ? '–'
                : rejectEntries.map(([reason, n]) => `${reason}: ${n}`).join(' · ')}
            </dd>

            <dt>Capture</dt>
            <dd>{diag.captureInfo}</dd>

            <dt>Mittlere Helligkeit</dt>
            <dd className={diag.brightness.includes('SCHWARZ') ? 'diag-bad' : ''}>{diag.brightness}</dd>

            <dt>OCR links (roh)</dt>
            <dd>
              {diag.left ? (
                <>
                  „{diag.left.raw || '∅ leer'}“ → {diag.left.parsed} <span className="muted">({diag.left.ms} ms)</span>
                </>
              ) : (
                '–'
              )}
            </dd>

            <dt>Set-Code (roh)</dt>
            <dd>{diag.code}</dd>

            <dt>OCR rechts (roh)</dt>
            <dd>
              {diag.right ? (
                <>
                  „{diag.right.raw || '∅ leer'}“ → {diag.right.parsed} <span className="muted">({diag.right.ms} ms)</span>
                </>
              ) : (
                '–'
              )}
            </dd>
          </dl>

          <p className="diag-label">Letzter Frame (Capture-Vorschau):</p>
          <canvas ref={diagFrameRef} className="diag-frame" />

          <p className="diag-label">Untere Infozeile links / rechts (entzerrt, aufbereitet):</p>
          <canvas ref={diagLeftRef} className="diag-crop" />
          <canvas ref={diagRightRef} className="diag-crop" />

          <p className="diag-label">Set-Code-Ausschnitt (4fach vergrößert):</p>
          <canvas ref={diagCodeRef} className="diag-crop" />

          <p className="diag-label">Tesseract-Dateien (Pfad-Check):</p>
          {assetChecks ? (
            <ul className="diag-assets">
              {assetChecks.map((a) => (
                <li key={a.url} className={a.ok ? '' : 'diag-bad'}>
                  {a.ok ? '✓' : '✗'} {a.url.split('/').slice(-1)[0]} — {a.info}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">läuft …</p>
          )}
        </details>
      )}
    </section>
  );
}
