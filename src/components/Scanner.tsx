import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkOcrAssets,
  getOcrStatus,
  initOcr,
  onOcrStatus,
  recognizeDigits,
  type AssetCheck,
  type OcrStatus,
} from '../ocr/ocr';
import { normalizeLocalId, parseScanText, scanMatchesSet } from '../logic/numberParse';
import { hashImageSource } from '../phash/dhash';
import { buildHashIndex, loadHashIndex, matchHash } from '../phash/matcher';
import type { SetInfo } from '../types';

interface Props {
  activeSet: SetInfo | undefined;
  /** Übernimmt die erkannte Nummer in die Liste; true = erfolgreich. */
  onHit: (numerator: string) => Promise<boolean>;
}

type Phase = 'idle' | 'starting' | 'scanning' | 'error';

const SCAN_INTERVAL_MS = 320;
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
  framesSkipped: number;
  skipReason: string;
  videoInfo: string;
  captureInfo: string;
  brightness: string;
  left: SideDiag | null;
  right: SideDiag | null;
}

const EMPTY_DIAG: DiagInfo = {
  framesAnalyzed: 0,
  framesSkipped: 0,
  skipReason: '',
  videoInfo: '–',
  captureInfo: '–',
  brightness: '–',
  left: null,
  right: null,
};

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

export function Scanner({ activeSet, onHit }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [flash, setFlash] = useState<'ok' | null>(null);
  const [guide, setGuide] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [indexProgress, setIndexProgress] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ localId: string; distance: number; name: string }[] | null>(null);
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>(getOcrStatus());
  const [assetChecks, setAssetChecks] = useState<AssetCheck[] | null>(null);
  const [diag, setDiag] = useState<DiagInfo>(EMPTY_DIAG);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<{ key: string; count: number; ts: number } | null>(null);
  const locksRef = useRef(new Map<string, number>());
  const audioRef = useRef<AudioContext | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pausedRef = useRef(false);
  const countersRef = useRef({ analyzed: 0, skipped: 0 });
  const diagFrameRef = useRef<HTMLCanvasElement>(null);
  const diagLeftRef = useRef<HTMLCanvasElement>(null);
  const diagRightRef = useRef<HTMLCanvasElement>(null);

  // OCR-Ladestatus live anzeigen (initialisiert / lädt / Fehler)
  useEffect(() => onOcrStatus(setOcrStatus), []);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    pendingRef.current = null;
    busyRef.current = false;
    setPhase('idle');
  }, []);

  useEffect(() => stop, [stop]);

  // Führungsrahmen an Containergröße anpassen (gleiche Formel wie der Crop!)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      let gw = 0.74 * w;
      let gh = (gw * 88) / 63;
      if (gh > 0.86 * h) {
        gh = 0.86 * h;
        gw = (gh * 63) / 88;
      }
      setGuide({ x: (w - gw) / 2, y: (h - gh) / 2, w: gw, h: gh });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase]);

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

  /** object-fit: cover — rechnet ein Rechteck in Container-Koordinaten in Video-Pixel um. */
  function mapRectToVideo(
    cx: number,
    cy: number,
    cw2: number,
    ch2: number,
  ): { sx: number; sy: number; sw: number; sh: number } | null {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || !video.videoWidth) return null;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const ox = (vw * scale - cw) / 2;
    const oy = (vh * scale - ch) / 2;
    const x0 = Math.max(0, (cx + ox) / scale);
    const y0 = Math.max(0, (cy + oy) / scale);
    const x1 = Math.min(vw, (cx + cw2 + ox) / scale);
    const y1 = Math.min(vh, (cy + ch2 + oy) / scale);
    if (x1 - x0 < 10 || y1 - y0 < 10) return null;
    return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
  }

  /**
   * Schneidet eine Ecke des Führungsrahmens aus dem Videobild, skaliert hoch
   * und verstärkt den Kontrast (Graustufen + Spreizung) für die OCR.
   */
  function cropCorner(side: 'left' | 'right'): HTMLCanvasElement | null {
    const video = videoRef.current;
    if (!video || !guide) return null;

    const cropW = 0.46 * guide.w;
    const cropH = 0.13 * guide.h;
    const cx = side === 'left' ? guide.x : guide.x + guide.w - cropW;
    const cy = guide.y + guide.h - cropH;
    const rect = mapRectToVideo(cx, cy, cropW, cropH);
    if (!rect) return null;
    const { sx, sy, sw, sh } = rect;
    if (sw < 20 || sh < 10) return null;

    const upscale = Math.min(2.5, Math.max(1.5, 640 / sw));
    const canvas = (cropCanvasRef.current ??= document.createElement('canvas'));
    canvas.width = Math.round(sw * upscale);
    canvas.height = Math.round(sh * upscale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    // Graustufen + Kontrastspreizung
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      const g = Math.round(((d[i] - min) / range) * 255);
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Diagnose: Frame-Vorschau zeichnen und mittlere Helligkeit bestimmen. */
  function updateFrameDiag(video: HTMLVideoElement): string {
    const canvas = diagFrameRef.current;
    if (!canvas) return '–';
    const w = 320;
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '–';
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 32) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      n++;
    }
    const mean = n ? sum / n : 0;
    if (mean < 3) return `${mean.toFixed(1)} — Frame ist SCHWARZ, Capture liefert keine Bilder!`;
    return mean.toFixed(1);
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
    if (!activeSet) return `gelesen ${parsed.numerator}/${parsed.denominator}, kein Set aktiv`;
    const fits = scanMatchesSet(parsed, activeSet);
    return `gelesen ${parsed.numerator}/${parsed.denominator} — Nenner ${
      fits ? 'passt' : `passt NICHT (erwartet ${activeSet.officialCount})`
    }`;
  }

  const handleReading = useCallback(
    async (text: string): Promise<boolean> => {
      if (!activeSet) return false;
      const parsed = parseScanText(text);
      if (!parsed || !scanMatchesSet(parsed, activeSet)) return false;

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

      const ok = await onHit(parsed.numerator);
      if (ok) {
        locksRef.current.set(key, Date.now() + LOCK_MS);
        beep();
        setFlash('ok');
        setTimeout(() => setFlash(null), 450);
      }
      return ok;
    },
    [activeSet, onHit],
  );

  const tick = useCallback(async () => {
    const video = videoRef.current;
    const skip = (reason: string) => {
      countersRef.current.skipped++;
      setDiag((d) => ({
        ...d,
        framesSkipped: countersRef.current.skipped,
        skipReason: reason,
      }));
    };
    if (busyRef.current) return; // kein State-Update, sonst flackert die Anzeige
    if (pausedRef.current) return skip('Tab im Hintergrund');
    if (!video) return skip('kein Video-Element');
    if (!video.videoWidth || video.readyState < 2) {
      return skip(`Video nicht bereit (videoWidth=${video.videoWidth}, readyState=${video.readyState})`);
    }

    busyRef.current = true;
    try {
      const videoInfo = `${video.videoWidth}×${video.videoHeight}, readyState=${video.readyState}, ${
        video.paused ? 'PAUSIERT' : 'läuft'
      }`;
      const brightness = updateFrameDiag(video);

      let captureInfo = '–';
      const sideResults: { left: SideDiag | null; right: SideDiag | null } = { left: null, right: null };
      let hit = false;

      for (const side of ['left', 'right'] as const) {
        const crop = cropCorner(side);
        if (!crop) {
          sideResults[side] = { raw: '', parsed: 'Crop fehlgeschlagen (Rahmen/Video-Geometrie)', ms: 0 };
          continue;
        }
        captureInfo = `${crop.width}×${crop.height}`;
        copyToDiagCanvas(crop, side === 'left' ? diagLeftRef.current : diagRightRef.current);
        const t0 = performance.now();
        const text = await recognizeDigits(crop);
        const ms = Math.round(performance.now() - t0);
        const raw = text.replace(/\s+/g, ' ').trim();
        sideResults[side] = { raw, parsed: describeParse(raw), ms };
        if (await handleReading(text)) {
          hit = true;
          break;
        }
      }

      countersRef.current.analyzed++;
      setDiag((d) => ({
        framesAnalyzed: countersRef.current.analyzed,
        framesSkipped: countersRef.current.skipped,
        skipReason: '',
        videoInfo,
        captureInfo,
        brightness,
        left: sideResults.left ?? (hit ? d.left : null),
        right: sideResults.right ?? (hit ? d.right : null),
      }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    } finally {
      busyRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleReading, guide]);

  // Laufender Scan-Loop
  useEffect(() => {
    if (phase !== 'scanning') return;
    const id = setInterval(() => void tick(), SCAN_INTERVAL_MS);
    timerRef.current = id;
    return () => clearInterval(id);
  }, [phase, tick]);

  /**
   * pHash-Fallback für Karten ohne (lesbare) moderne Sammlernummer:
   * aktuelles Kamerabild im Rahmen hashen und gegen den Bild-Index des Sets
   * vergleichen. Nie automatisch übernehmen — nur Kandidaten vorschlagen.
   */
  async function photoMatch() {
    if (!activeSet || !guide) return;
    setCandidates(null);
    setPhotoBusy(true);
    setErrorMsg(null);
    try {
      let index = await loadHashIndex(activeSet.id);
      if (!index) {
        index = await buildHashIndex(activeSet, (done, total) =>
          setIndexProgress(`Bild-Index wird einmalig geladen: ${done}/${total} …`),
        );
      }
      const video = videoRef.current;
      if (!video || !video.videoWidth) throw new Error('Video liefert kein Bild (videoWidth=0).');
      const rect = mapRectToVideo(guide.x, guide.y, guide.w, guide.h);
      if (!rect) throw new Error('Kein Kamerabild verfügbar.');
      const hash = hashImageSource(video, rect.sx, rect.sy, rect.sw, rect.sh);
      const matches = matchHash(hash, index, 3);
      setCandidates(
        matches.map((m) => ({
          ...m,
          name: activeSet.cards.find((c) => c.localId === m.localId)?.nameLocal ?? '?',
        })),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoBusy(false);
      setIndexProgress(null);
    }
  }

  async function pickCandidate(localId: string) {
    const ok = await onHit(localId);
    if (ok) {
      beep();
      setFlash('ok');
      setTimeout(() => setFlash(null), 450);
      setCandidates(null);
    }
  }

  async function start() {
    setErrorMsg(null);
    setPhase('starting');
    countersRef.current = { analyzed: 0, skipped: 0 };
    setDiag(EMPTY_DIAG);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Kamera-API nicht verfügbar. Die Seite muss über HTTPS (oder localhost) laufen – siehe README, Abschnitt „Auf dem Tablet testen“.',
        );
      }
      // OCR parallel zum Kamera-Start initialisieren; Status kommt über onOcrStatus
      const ocrReady = initOcr();
      // Asset-Preflight für die Diagnose (nicht blockierend)
      checkOcrAssets().then(setAssetChecks).catch(() => {});

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Video-Element fehlt.');
      video.srcObject = stream;
      await video.play();
      // Verdachtsfall 2: NIE auf die Canvas zeichnen, bevor das Video bereit ist
      await waitForVideoReady(video, 8000);
      await ocrReady;
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

  function ocrStatusLabel(s: OcrStatus): string {
    switch (s.state) {
      case 'idle':
        return `nicht initialisiert (${s.detail})`;
      case 'loading':
        return `lädt … ${s.detail}`;
      case 'ready':
        return `bereit (${s.detail})`;
      case 'error':
        return `FEHLER: ${s.detail}`;
    }
  }

  return (
    <section className="card-section scanner">
      <h2>Scannen</h2>

      {!activeSet && <p className="muted">Erst oben ein Set wählen – dann kann die Kamera starten.</p>}

      {(phase === 'idle' || phase === 'error') && activeSet && (
        <button className="primary" onClick={() => void start()}>
          📷 Kamera starten
        </button>
      )}

      {phase === 'starting' && (
        <p className="muted">Starte Kamera … (OCR: {ocrStatusLabel(ocrStatus)})</p>
      )}

      {errorMsg && <p className="inline-error">{errorMsg}</p>}

      <div
        ref={containerRef}
        className={`scanner-view ${phase === 'scanning' || phase === 'starting' ? '' : 'hidden'} ${flash === 'ok' ? 'flash-ok' : ''}`}
      >
        <video ref={videoRef} playsInline muted />
        {guide && phase === 'scanning' && (
          <>
            <div
              className="guide"
              style={{ left: guide.x, top: guide.y, width: guide.w, height: guide.h }}
            />
            <div
              className="guide-corner"
              style={{
                left: guide.x,
                top: guide.y + guide.h * 0.87,
                width: guide.w * 0.46,
                height: guide.h * 0.13,
              }}
            />
            <div
              className="guide-corner"
              style={{
                left: guide.x + guide.w * 0.54,
                top: guide.y + guide.h * 0.87,
                width: guide.w * 0.46,
                height: guide.h * 0.13,
              }}
            />
          </>
        )}
        {phase === 'scanning' && (
          <div className="scanner-hint">
            Karte in den Rahmen legen – die Nummer (z. B. 136/189) wird automatisch gelesen
          </div>
        )}
      </div>

      {phase === 'scanning' && (
        <div className="scanner-actions">
          <button onClick={() => void photoMatch()} disabled={photoBusy}>
            {photoBusy ? (indexProgress ?? 'Vergleiche Bild …') : '🔍 Foto-Abgleich (ohne Nummer)'}
          </button>
          <button onClick={stop} className="scanner-stop">
            Kamera stoppen
          </button>
        </div>
      )}

      {candidates && (
        <div className="candidates">
          <p>Ähnlichste Karten im Set — passende antippen:</p>
          {candidates.map((c) => (
            <button key={c.localId} className="chip" onClick={() => void pickCandidate(c.localId)}>
              #{c.localId} {c.name}
              <span className="muted"> (Abstand {c.distance})</span>
            </button>
          ))}
          <button className="chip chip-outline" onClick={() => setCandidates(null)}>
            Keine davon
          </button>
        </div>
      )}

      {phase !== 'idle' && (
        <details className="diag">
          <summary>🔧 Diagnose</summary>

          <dl className="diag-grid">
            <dt>OCR-Engine</dt>
            <dd className={ocrStatus.state === 'error' ? 'diag-bad' : ''}>{ocrStatusLabel(ocrStatus)}</dd>

            <dt>Video-Stream</dt>
            <dd>{diag.videoInfo}</dd>

            <dt>Capture-Canvas</dt>
            <dd>{diag.captureInfo}</dd>

            <dt>Analysierte Frames</dt>
            <dd>
              {diag.framesAnalyzed} (übersprungen: {diag.framesSkipped}
              {diag.skipReason ? ` — zuletzt: ${diag.skipReason}` : ''})
            </dd>

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

          <p className="diag-label">Nummernbereich links / rechts (vergrößert, nach Vorverarbeitung):</p>
          <canvas ref={diagLeftRef} className="diag-crop" />
          <canvas ref={diagRightRef} className="diag-crop" />

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
