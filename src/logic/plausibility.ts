import type { CardInfo, Finish, RowStatus } from '../types';
import { FINISH_LABELS } from '../types';

/** Liest aus den TCGdex-Variants die Liste verfügbarer Finishes. Leer = unbekannt. */
export function availableFinishes(card: CardInfo): Finish[] {
  const v = card.variants;
  if (!v) return [];
  const result: Finish[] = [];
  if (v.normal) result.push('normal');
  if (v.reverse) result.push('reverse');
  if (v.holo) result.push('holo');
  return result;
}

export interface PlausibilityResult {
  status: RowStatus;
  available: Finish[];
  reason?: string;
}

/**
 * Die wichtigste Prüfung der App: existiert die Karte im eingestellten Finish?
 * - Finish laut Datenbank vorhanden -> ok
 * - Finish laut Datenbank NICHT vorhanden -> warn (gelb), mit Hinweis was es gibt
 * - Keine Finish-Daten vorhanden -> ok, aber ohne Bestätigung (kein falscher Alarm)
 */
export function checkFinish(card: CardInfo, finish: Finish): PlausibilityResult {
  const available = availableFinishes(card);
  if (available.length === 0) {
    return { status: 'ok', available };
  }
  if (available.includes(finish)) {
    return { status: 'ok', available };
  }
  const list = available.map((f) => FINISH_LABELS[f]).join(', ');
  return {
    status: 'warn',
    available,
    reason: `Gibt es laut Datenbank nicht als ${FINISH_LABELS[finish]} – nur als: ${list}`,
  };
}
