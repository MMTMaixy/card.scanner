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
 * Extrahiert "Zähler/Nenner" aus einem OCR-Text, z. B. "025/185" aus "o25/185 REG".
 * Liefert undefined, wenn kein Muster gefunden wurde.
 */
export function parseScanText(text: string): ParsedScan | undefined {
  const m = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (!m) return undefined;
  return { numerator: m[1], denominator: Number(m[2]) };
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
