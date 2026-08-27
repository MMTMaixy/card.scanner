import type { Language } from '../types';

/**
 * Globaler Set-Index: Set-Code und Nenner (offizielle Kartenzahl) -> Set.
 * Reine Textdaten, generiert aus dem TCGdex-Datenbestand
 * (scripts/build-set-index.mjs) und mitgeliefert, damit weder App noch Build
 * dafür Netz brauchen.
 */

export interface SetIndexEntry {
  id: string;
  serie: string;
  /** Offizielle Kartenzahl = der Nenner, der auf der Karte steht */
  official: number;
  /** Gesamtzahl inkl. Secret Rares */
  total: number;
  names: Partial<Record<Language, string>>;
  /** Aufgedruckter Set-Code, z. B. "PBL", "SVI", "SV2a" */
  code?: string;
  /** true, wenn der Code aus der Set-Kennung abgeleitet ist (ja/zh) */
  codeFromId?: boolean;
  localCodes?: Partial<Record<Language, string>>;
  released: string;
}

export interface SetIndexFile {
  generated: string;
  sets: SetIndexEntry[];
}

/** Name in der gewählten Sprache, sonst irgendein vorhandener. */
export function setName(entry: SetIndexEntry, lang: Language): string {
  return entry.names[lang] ?? entry.names.en ?? Object.values(entry.names)[0] ?? entry.id;
}

export function setsForLang(sets: SetIndexEntry[], lang: Language): SetIndexEntry[] {
  return sets.filter((s) => s.names[lang]);
}

/**
 * Vereinheitlicht einen Set-Code für den Vergleich: Großbuchstaben, alles
 * außer Buchstaben/Ziffern/Punkt entfernt. "sv 4a" und "SV4A" werden gleich.
 */
export function normalizeSetCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

/** Levenshtein-Distanz, begrenzt auf kurze Codes. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Zieht mögliche Set-Code-Kandidaten aus einem OCR-Text.
 * Der Code steht auf der Karte in einem kleinen Kästchen, meist neben der
 * Nummer; die OCR liefert ihn zwischen anderem Kleingedruckten.
 */
export function codeTokens(text: string): string[] {
  const tokens = text.split(/[^A-Za-z0-9.]+/).filter(Boolean);
  const out: string[] = [];
  for (const raw of tokens) {
    const t = normalizeSetCode(raw);
    if (t.length < 2 || t.length > 8) continue;
    if (!/[A-Z]/.test(t)) continue; // reine Zahlen sind Nummern, keine Codes
    if (/^\d+\.\d+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

export interface Identification {
  /** 'code' = eindeutig bestimmt, 'candidates' = Auswahl nötig, 'none' = nichts */
  mode: 'code' | 'denominator' | 'candidates' | 'none';
  set?: SetIndexEntry;
  candidates: SetIndexEntry[];
  /** Der Code-Token, der zum Treffer geführt hat (für die Anzeige) */
  matchedCode?: string;
}

export interface IdentifyInput {
  sets: SetIndexEntry[];
  lang: Language;
  /** Auf der Karte gelesener Nenner, falls vorhanden */
  denominator?: number;
  /** Roher OCR-Text der Code-Passe */
  codeText?: string;
  /** Zuletzt genutzte Set-Kennungen, neueste zuerst */
  recent?: string[];
}

function sortCandidates(list: SetIndexEntry[], recent: string[]): SetIndexEntry[] {
  return [...list].sort((a, b) => {
    const ra = recent.indexOf(a.id);
    const rb = recent.indexOf(b.id);
    if (ra !== rb) {
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    }
    return String(b.released).localeCompare(String(a.released));
  });
}

/**
 * Bestimmt das Set einer gescannten Karte.
 *
 * Reihenfolge:
 *  a) Set-Code gelesen  -> Set direkt bestimmen
 *  b) kein Code, aber Nenner -> Kandidaten (eindeutig = direkt übernehmen)
 *  c) nichts erkannt -> manuelle Auswahl
 */
export function identifySet({ sets, lang, denominator, codeText, recent = [] }: IdentifyInput): Identification {
  const inLang = setsForLang(sets, lang);
  const byDenominator = denominator
    ? inLang.filter((s) => s.official === denominator)
    : [];

  // (a) Set-Code
  if (codeText) {
    const tokens = codeTokens(codeText);
    // Bevorzugt gegen die Sets prüfen, die zum Nenner passen: Das ist die
    // strengste Kombination und verhindert Fehlgriffe durch OCR-Rauschen.
    const pools: SetIndexEntry[][] = byDenominator.length > 0 ? [byDenominator, inLang] : [inLang];
    for (const pool of pools) {
      const codes = pool.filter((s) => s.code);
      for (const token of tokens) {
        const exact = codes.filter((s) => normalizeSetCode(s.code!) === token);
        if (exact.length === 1) {
          return { mode: 'code', set: exact[0], candidates: exact, matchedCode: token };
        }
        if (exact.length > 1) {
          return { mode: 'candidates', candidates: sortCandidates(exact, recent), matchedCode: token };
        }
      }
      // Ein Zeichen Toleranz — aber nur im engen, durch den Nenner
      // eingegrenzten Pool, sonst würde Rauschen zufällige Treffer erzeugen.
      if (pool === byDenominator) {
        for (const token of tokens) {
          if (token.length < 3) continue;
          const near = codes.filter((s) => editDistance(normalizeSetCode(s.code!), token) <= 1);
          if (near.length === 1) {
            return { mode: 'code', set: near[0], candidates: near, matchedCode: token };
          }
        }
      }
    }
  }

  // (b) Nenner
  if (byDenominator.length === 1) {
    return { mode: 'denominator', set: byDenominator[0], candidates: byDenominator };
  }
  if (byDenominator.length > 1) {
    return { mode: 'candidates', candidates: sortCandidates(byDenominator, recent) };
  }

  // (c) nichts
  return { mode: 'none', candidates: [] };
}

/** Suche für die manuelle Auswahl: Name, Kennung oder Code, zuletzt genutzte zuerst. */
export function searchSets(
  sets: SetIndexEntry[],
  lang: Language,
  query: string,
  recent: string[] = [],
): SetIndexEntry[] {
  const q = query.trim().toLowerCase();
  const inLang = setsForLang(sets, lang);
  const hits = q
    ? inLang.filter(
        (s) =>
          setName(s, lang).toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.code?.toLowerCase().includes(q) ?? false),
      )
    : inLang;
  return sortCandidates(hits, recent);
}
