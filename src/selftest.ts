/**
 * Entwicklungs-Selftest der Vision-Pipeline (nicht Teil der App).
 *
 * Fall A (Ground Truth): Eine synthetische Karte mit bekannter Nummer wird per
 * bekannter Perspektivtransformation in eine Szene projiziert. Damit lässt
 * sich objektiv prüfen, ob die erkannten Ecken stimmen und ob die Nummer aus
 * der entzerrten Karte gelesen wird.
 * Fall B: Reales Foto — findet die Erkennung dort überhaupt eine Karte?
 *
 * Ergebnis landet in window.__selftest, damit Playwright es auslesen kann.
 */
import { detectCardQuad, extractCodeBoxes, extractNumberStrip, initCv, warpCard } from './vision/cardDetect';
import { cardWidthFraction, isCardBigEnoughForOcr, scaleQuad, WARP_H, WARP_W, type Pt } from './vision/quad';
import { initOcr, recognizeCode, recognizeDigits } from './ocr/ocr';
import { parseScanText } from './logic/numberParse';
import { codeTokens, identifySet, type SetIndexEntry } from './logic/setIndex';
import setIndexFile from './data/setIndex.json';
import realCardJa from './fixtures/card-ja.jpg';

const log = document.getElementById('log')!;
const out = document.getElementById('out')!;
const lines: string[] = [];
function say(msg: string) {
  lines.push(msg);
  log.textContent = lines.join('\n');
  console.log('[selftest]', msg);
}

interface Result {
  done: boolean;
  ok: boolean;
  lines: string[];
  error?: string;
}

declare global {
  interface Window {
    __selftest?: Result;
  }
}

const result: Result = { done: false, ok: false, lines };
window.__selftest = result;

function finish(ok: boolean, error?: string) {
  Object.assign(result, { ok, error, lines, done: true });
  window.__selftest = { ...result };
  say(ok ? 'ERGEBNIS: OK' : `ERGEBNIS: FEHLER — ${error}`);
}

function show(label: string, canvas: HTMLCanvasElement) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:inline-block;vertical-align:top;margin:0 12px 12px 0';
  const h = document.createElement('p');
  h.textContent = `${label} (${canvas.width}×${canvas.height})`;
  h.style.cssText = 'margin:2px 0;font:12px monospace';
  canvas.style.cssText = 'max-width:420px;border:1px solid #999';
  wrap.append(h, canvas);
  out.append(wrap);
}

/** Zeichnet eine karten-ähnliche Vorlage mit der Nummer 005/084 unten links. */
function makeSyntheticCard(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 630;
  c.height = 880;
  const ctx = c.getContext('2d')!;
  // Kartenrand (heller Rahmen) + Innenfläche
  ctx.fillStyle = '#f2f0e6';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#c8dc78';
  ctx.fillRect(22, 22, c.width - 44, c.height - 44);
  // Artwork
  ctx.fillStyle = '#7a4fa3';
  ctx.fillRect(52, 90, c.width - 104, 330);
  // Textblock
  ctx.fillStyle = '#e9e6d8';
  ctx.fillRect(52, 450, c.width - 104, 300);
  ctx.fillStyle = '#333';
  ctx.font = '20px sans-serif';
  ctx.fillText('Listiges Versteckspiel', 70, 490);
  ctx.fillText('Hinterhältiger Fall', 70, 560);
  // Set-Code-Kästchen unten links, wie auf modernen Karten
  ctx.fillStyle = '#111';
  ctx.fillRect(40, 793, 34, 17);
  ctx.fillStyle = '#f2f0e6';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('PBL', 44, 806);
  // Sammlernummer daneben — Größe wie auf einer echten Karte (~1,6 % Höhe)
  ctx.fillStyle = '#111';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('005/084', 84, 806);
  ctx.font = '11px sans-serif';
  ctx.fillText('©2026 Pokémon/Nintendo', 240, 828);
  return c;
}

/**
 * Projiziert die Karte per bekannter Perspektivtransformation in eine Szene.
 * Liefert Szene + die wahren Eckpunkte (Ground Truth).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildScene(cv: any, card: HTMLCanvasElement, corners: Pt[], w: number, h: number) {
  const scene = document.createElement('canvas');
  scene.width = w;
  scene.height = h;
  const sctx = scene.getContext('2d')!;
  // Hintergrund: Tisch mit leichtem Verlauf (nicht uniform, damit es realistisch bleibt)
  const grad = sctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#8b8d92');
  grad.addColorStop(1, '#5e6066');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, w, h);

  const src = cv.imread(card);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, card.width, 0, card.width, card.height, 0, card.height]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const warpCanvas = document.createElement('canvas');
  cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT);
  cv.imshow(warpCanvas, dst);
  // warpPerspective füllt außerhalb mit Schwarz -> nur die Kartenfläche übernehmen
  sctx.save();
  sctx.beginPath();
  sctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 4; i++) sctx.lineTo(corners[i].x, corners[i].y);
  sctx.closePath();
  sctx.clip();
  sctx.drawImage(warpCanvas, 0, 0);
  sctx.restore();

  src.delete();
  dst.delete();
  srcTri.delete();
  dstTri.delete();
  M.delete();
  return scene;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runCase(
  cv: any,
  name: string,
  scene: HTMLCanvasElement,
  opts: {
    expectQuad: boolean;
    truth?: Pt[];
    expectNumber?: string;
    expectCode?: string;
    /** Grenzfall: Lesung darf ausbleiben, aber niemals falsch sein */
    numberMayBeMissing?: boolean;
    /** Erwartung an das Größen-Gating vor der OCR */
    expectBigEnough?: boolean;
  },
): Promise<boolean> {
  say(`--- Fall „${name}“ (${scene.width}×${scene.height}) ---`);
  const detW = 480;
  const detH = Math.round((scene.height / scene.width) * detW);
  const det = document.createElement('canvas');
  det.width = detW;
  det.height = detH;
  const dctx = det.getContext('2d', { willReadFrequently: true })!;
  dctx.drawImage(scene, 0, 0, detW, detH);

  const dbg: string[] = [];
  const t0 = performance.now();
  const detection = detectCardQuad(cv, dctx.getImageData(0, 0, detW, detH), dbg);
  const ms = Math.round(performance.now() - t0);
  dbg.slice(0, 6).forEach((d) => say(`    ${d}`));
  say(
    `  detectCardQuad: ${ms} ms, Schärfe=${detection.sharpness.toFixed(0)}, quad=${detection.quad ? 'gefunden' : 'null'}, reject=${detection.rejectReason ?? '-'}`,
  );

  if (!detection.quad) {
    if (!opts.expectQuad) {
      say('  erwartet: keine Karte → OK');
      return true;
    }
    say('  FEHLER: erwartet war eine Karte');
    return false;
  }

  const q = detection.quad as [Pt, Pt, Pt, Pt];
  dctx.strokeStyle = '#ffe14d';
  dctx.lineWidth = 3;
  dctx.beginPath();
  dctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) dctx.lineTo(q[i].x, q[i].y);
  dctx.closePath();
  dctx.stroke();
  show(`${name}: Umriss`, det);

  let cornersOk = true;
  if (opts.truth) {
    const scale = detW / scene.width;
    const errors = q.map((p, i) =>
      Math.hypot(p.x - opts.truth![i].x * scale, p.y - opts.truth![i].y * scale),
    );
    const maxErr = Math.max(...errors);
    cornersOk = maxErr <= 8;
    say(
      `  Eckabweichung zur Ground Truth: ${errors.map((e) => e.toFixed(1)).join(', ')} px (max ${maxErr.toFixed(1)}, erlaubt 8) → ${cornersOk ? 'OK' : 'ZU GROSS'}`,
    );
  }

  const widthFraction = cardWidthFraction(q, detW);
  const bigEnough = isCardBigEnoughForOcr(q, detW);
  say(`  Kartenbreite: ${(widthFraction * 100).toFixed(0)} % des Bildes → OCR ${bigEnough ? 'erlaubt' : 'gesperrt'}`);
  let gatingOk = true;
  if (opts.expectBigEnough !== undefined) {
    gatingOk = bigEnough === opts.expectBigEnough;
    if (!gatingOk) say(`  FEHLER: Größen-Gating erwartet ${opts.expectBigEnough}`);
  }

  if (!bigEnough) {
    // Die App liest hier gar nicht — genau darum geht es. Weitere Prüfungen
    // wären ein Test von Code, der im Betrieb nie erreicht wird.
    say('  OCR wird übersprungen (Gating) — wie in der App');
    return cornersOk && gatingOk;
  }

  const ww = Math.min(2560, scene.width);
  const wh = Math.round((scene.height / scene.width) * ww);
  const work = document.createElement('canvas');
  work.width = ww;
  work.height = wh;
  work.getContext('2d')!.drawImage(scene, 0, 0, ww, wh);
  const warped = warpCard(cv, work, scaleQuad(q, ww / detW));
  show(`${name}: entzerrt`, warped);
  if (warped.width !== WARP_W || warped.height !== WARP_H) {
    say(`  FEHLER: entzerrte Größe ${warped.width}×${warped.height}, erwartet ${WARP_W}×${WARP_H}`);
    return false;
  }

  let numberOk = !opts.expectNumber;
  let wrongNumber: string | null = null;
  outer: for (const side of ['left', 'right'] as const) {
    for (const variant of ['binary', 'gray'] as const) {
      const strip = extractNumberStrip(cv, warped, side, variant);
      show(`${name}: ${side}/${variant}`, strip);
      const t1 = performance.now();
      const text = (await recognizeDigits(strip)).replace(/\s+/g, ' ').trim();
      const parsed = parseScanText(text);
      say(
        `  OCR ${side}/${variant}: "${text}" (${Math.round(performance.now() - t1)} ms) -> ${parsed ? `${parsed.numerator}/${parsed.denominator}` : 'kein Muster'}`,
      );
      if (opts.expectNumber && parsed) {
        const got = `${Number(parsed.numerator)}/${parsed.denominator}`;
        if (got === opts.expectNumber) {
          numberOk = true;
          break outer;
        }
        wrongNumber = got;
      }
    }
  }
  if (opts.expectNumber) {
    if (opts.numberMayBeMissing) {
      // An der Auflösungsgrenze zählt nur: keine FALSCHE Nummer erfinden.
      numberOk = !wrongNumber;
      say(
        `  Nummer ${opts.expectNumber}: ${
          wrongNumber ? `FALSCHE Lesung "${wrongNumber}" — das darf nie passieren` : 'keine Fehllesung'
        }`,
      );
    } else {
      say(`  Nummer ${opts.expectNumber} gelesen: ${numberOk ? 'JA' : 'NEIN'}`);
    }
  }

  // Eigene Passe für den Set-Code (stärker vergrößert)
  let codeOk = !opts.expectCode;
  if (opts.expectCode) {
    for (const side of ['left', 'right'] as const) {
      const boxes = extractCodeBoxes(cv, warped, side);
      say(`  Code-Kästchen ${side}: ${boxes.length} gefunden`);
      for (const [i, box] of boxes.entries()) {
        show(`${name}: Code ${side}#${i}`, box);
        const text = (await recognizeCode(box)).replace(/\s+/g, ' ').trim();
        const tokens = codeTokens(text);
        say(`  Set-Code ${side}#${i}: "${text}" -> Tokens ${JSON.stringify(tokens)}`);
        if (tokens.includes(opts.expectCode)) codeOk = true;
      }
    }
    say(`  Set-Code ${opts.expectCode} gelesen: ${codeOk ? 'JA' : 'NEIN'}`);
  }

  return cornersOk && numberOk && codeOk && gatingOk;
}

/** Prüft die komplette Kette an einem echten Kamerafoto. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runRealPhoto(
  cv: any,
  url: string,
  expectNumber: string,
  expectCode: string,
  lang: 'de' | 'ja',
): Promise<boolean> {
  say(`--- Echtes Foto (${lang}) ---`);
  const img = new Image();
  img.src = url;
  await img.decode();
  const scene = document.createElement('canvas');
  scene.width = img.naturalWidth;
  scene.height = img.naturalHeight;
  scene.getContext('2d')!.drawImage(img, 0, 0);

  const detW = 480;
  const detH = Math.round((scene.height / scene.width) * detW);
  const det = document.createElement('canvas');
  det.width = detW;
  det.height = detH;
  const dctx = det.getContext('2d', { willReadFrequently: true })!;
  dctx.drawImage(scene, 0, 0, detW, detH);

  const dbg: string[] = [];
  const detection = detectCardQuad(cv, dctx.getImageData(0, 0, detW, detH), dbg);
  dbg.slice(0, 8).forEach((d) => say(`    ${d}`));
  if (!detection.quad) {
    say(`  FEHLER: keine Karte gefunden (${detection.rejectReason ?? '-'})`);
    return false;
  }
  const q = detection.quad;
  const w = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
  const h = (Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2;
  const aspect = h / w;
  say(`  Verhältnis des Treffers: ${aspect.toFixed(2)} (Karte ist 1,40)`);
  const aspectOk = aspect > 1.28 && aspect < 1.55;
  if (!aspectOk) say('  FEHLER: Treffer hat kein Kartenformat — vermutlich ein Rechteck der Unterlage');

  dctx.strokeStyle = '#ffe14d';
  dctx.lineWidth = 3;
  dctx.beginPath();
  dctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) dctx.lineTo(q[i].x, q[i].y);
  dctx.closePath();
  dctx.stroke();
  show(`Echtes Foto (${lang}): Umriss`, det);

  const ww = Math.min(2560, scene.width);
  const wh = Math.round((scene.height / scene.width) * ww);
  const work = document.createElement('canvas');
  work.width = ww;
  work.height = wh;
  work.getContext('2d')!.drawImage(scene, 0, 0, ww, wh);
  const warped = warpCard(cv, work, scaleQuad(q, ww / detW));
  show(`Echtes Foto (${lang}): entzerrt`, warped);

  let numberOk = false;
  let readNumber = '';
  outer: for (const side of ['left', 'right'] as const) {
    for (const variant of ['binary', 'gray'] as const) {
      const strip = extractNumberStrip(cv, warped, side, variant);
      show(`Echtes Foto: Zeile ${side}/${variant}`, strip);
      const text = (await recognizeDigits(strip)).replace(/\s+/g, ' ').trim();
      const parsed = parseScanText(text);
      say(`  OCR ${side}/${variant}: "${text}" -> ${parsed ? `${parsed.numerator}/${parsed.denominator}` : 'kein Muster'}`);
      if (parsed) {
        readNumber = `${Number(parsed.numerator)}/${parsed.denominator}`;
        if (readNumber === `${Number(expectNumber.split('/')[0])}/${Number(expectNumber.split('/')[1])}`) {
          numberOk = true;
          break outer;
        }
      }
    }
  }
  say(`  Nummer ${expectNumber}: ${numberOk ? 'gelesen' : `NICHT gelesen (bekam „${readNumber || '-'}“)`}`);

  let codeText = '';
  for (const side of ['left', 'right'] as const) {
    for (const box of extractCodeBoxes(cv, warped, side)) {
      show(`Echtes Foto: Code ${side}`, box);
      const text = (await recognizeCode(box)).replace(/\s+/g, ' ').trim();
      if (text) codeText += (codeText ? ' ' : '') + text;
    }
  }
  say(`  Set-Code roh: "${codeText}" -> Tokens ${JSON.stringify(codeTokens(codeText))}`);

  // Was würde die App daraus machen?
  const ident = identifySet({
    sets: (setIndexFile as unknown as { sets: SetIndexEntry[] }).sets,
    lang,
    denominator: Number(expectNumber.split('/')[1]),
    codeText,
  });
  say(`  Set-Bestimmung: ${ident.mode}${ident.set ? ` -> ${ident.set.id}` : ` (${ident.candidates.length} Kandidaten)`}`);
  const codeOk = codeTokens(codeText).includes(expectCode);
  say(`  Set-Code ${expectCode}: ${codeOk ? 'gelesen' : 'nicht gelesen'}`);

  return aspectOk && numberOk;
}

async function run() {
  try {
    say('lade OpenCV …');
    const cv = await initCv();
    say(`OpenCV bereit (CLAHE=${typeof cv.CLAHE}, minAreaRect=${typeof cv.minAreaRect})`);
    say('lade OCR …');
    await initOcr();
    say('OCR bereit');

    const card = makeSyntheticCard();
    const results: boolean[] = [];

    // A1: leicht gedreht, mit Perspektive
    const truthA: Pt[] = [
      { x: 300, y: 210 },
      { x: 812, y: 300 },
      { x: 742, y: 1030 },
      { x: 232, y: 916 },
    ];
    results.push(
      await runCase(cv, 'A1 gedreht+Perspektive', buildScene(cv, card, truthA, 1080, 1400), {
        expectQuad: true,
        truth: truthA,
        expectNumber: '5/84',
        expectCode: 'PBL',
      }),
    );

    // A2: kleiner im Bild (Kamera weiter weg), fast frontal
    const truthB: Pt[] = [
      { x: 400, y: 480 },
      { x: 700, y: 470 },
      { x: 712, y: 900 },
      { x: 408, y: 905 },
    ];
    results.push(
      // Grenzfall: Karte füllt nur ~31 % des Bildes, die Nummer ist dann
      // nur wenige Pixel hoch. Hier zählt, dass nichts Falsches entsteht.
      await runCase(cv, 'A2 klein (Auflösungsgrenze)', buildScene(cv, card, truthB, 1080, 1400), {
        expectQuad: true,
        truth: truthB,
        expectBigEnough: false,
      }),
    );

    // A4: realistischer Tablet-Scan — 1080p-Kamera, Karte füllt den Sucher
    const truthD: Pt[] = [
      { x: 250, y: 300 },
      { x: 1000, y: 330 },
      { x: 980, y: 1400 },
      { x: 230, y: 1370 },
    ];
    results.push(
      await runCase(cv, 'A4 formatfuellend', buildScene(cv, card, truthD, 1200, 1800), {
        expectQuad: true,
        truth: truthD,
        expectNumber: '5/84',
        expectCode: 'PBL',
        expectBigEnough: true,
      }),
    );

    // A3: Karte ragt aus dem Bild — muss sauber abgelehnt werden, statt eine
    // unvollständige Karte zu entzerren.
    const truthC: Pt[] = [
      { x: 600, y: 300 },
      { x: 1300, y: 320 },
      { x: 1290, y: 1300 },
      { x: 590, y: 1280 },
    ];
    results.push(
      await runCase(cv, 'A3 ragt aus dem Bild', buildScene(cv, card, truthC, 1080, 1400), {
        expectQuad: false,
      }),
    );

    // R1: ECHTES Foto vom Gerät (japanische Karte auf Stoff, mit dem
    // Overlay-Rechteck der App im Bild). Genau hier hat die Erkennung
    // zuvor ein 31 % zu breites Rechteck als Karte genommen.
    results.push(await runRealPhoto(cv, realCardJa, '019/063', 'M1S', 'ja'));

    const ok = results.every(Boolean);
    finish(ok, ok ? undefined : 'Ground-Truth-Fälle fehlgeschlagen — siehe Protokoll');
  } catch (err) {
    finish(false, err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  }
}

void run();
