import type { CardInfo, SetInfo } from '../types';

/**
 * Normalisiert eine Sammlernummer für den Vergleich:
 * Whitespace weg, Großbuchstaben, führende Nullen vor Ziffern entfernen
 * ("025" -> "25", "TG09" -> "TG9", "swsh136" -> "SWSH136").
 */
export function normalizeLocalId(input: string): string {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  return s.replace(/(^|(?<=\D))0+(?=\d)/g, '');
}

/** Sucht eine Karte im Set anhand der (normalisierten) Sammlernummer. */
export function findCardByNumber(set: SetInfo, input: string): CardInfo | undefined {
  const wanted = normalizeLocalId(input);
  if (!wanted) return undefined;
  return set.cards.find((c) => normalizeLocalId(c.localId) === wanted);
}

export interface ParsedScan {
  numerator: string;
  denominator: number;
}

/**
 * Typische OCR-Verwechslungen bei Ziffern in kleiner Schrift.
 * Gemessen an echten Lesungen, z. B. „oosi0a4“ für „005/084“.
 *
 * Das ist ungefährlich, weil jede Lesung danach noch zwei harte Prüfungen
 * bestehen muss: Der Nenner muss exakt der Kartenzahl des gewählten Sets
 * entsprechen, und zwei aufeinanderfolgende Frames müssen dasselbe ergeben.
 * Eine falsch „korrigierte“ Lesung fällt dadurch praktisch immer durch.
 */
const CONFUSIONS: Record<string, string> = {
  o: '0', O: '0', Q: '0', D: '0',
  i: '/', I: '/', l: '/', '|': '/', '\\': '/',
  s: '5', S: '5',
  a: '8', B: '8',
  b: '6', G: '6',
  g: '9', q: '9',
  t: '7', T: '7',
  z: '2', Z: '2',
  e: '8',
};

/** Wendet die Verwechslungstabelle an, damit „oosi0a4“ als „005/084“ lesbar wird. */
export function normalizeOcrDigits(text: string): string {
  return text.replace(/[a-zA-Z|\\]/g, (ch) => CONFUSIONS[ch] ?? ch);
}

/**
 * Extrahiert "Zähler/Nenner" aus einem OCR-Text, z. B. "025/185" aus "o25/185 REG".
 * Liefert undefined, wenn kein Muster gefunden wurde.
 */
export function parseScanText(text: string): ParsedScan | undefined {
  const direct = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (direct) return { numerator: direct[1], denominator: Number(direct[2]) };
  // Zweiter Versuch mit korrigierten Zeichenverwechslungen. Hier bewusst OHNE
  // erlaubte Leerzeichen: Sonst wird aus Rauschen wie „5 I ee“ ein scheinbar
  // gültiges „5/88“. Auf der Karte steht die Nummer immer zusammenhängend.
  const fixed = normalizeOcrDigits(text).match(/(\d{1,3})\/(\d{1,3})/);
  if (!fixed) return undefined;
  return { numerator: fixed[1], denominator: Number(fixed[2]) };
}

/**
 * Prüft, ob eine OCR-Lesung zum gewählten Set passt.
 * Der Nenner auf der Karte ist die offizielle Kartenzahl des Sets —
 * das ist unser stärkster Filter gegen Fehl-Lesungen.
 * Secret Rares haben Zähler > Nenner, das ist erlaubt.
 */
export function scanMatchesSet(scan: ParsedScan, set: SetInfo): boolean {
  if (scan.denominator !== set.officialCount) return false;
  const num = Number(scan.numerator);
  if (!Number.isFinite(num) || num < 1) return false;
  // Zähler darf bis zur Gesamtzahl (inkl. Secrets) gehen, mit etwas Luft
  const max = Math.max(set.totalCount, set.officialCount) + 20;
  return num <= max;
}
