import { enrichSetVariants, fetchSetBrief } from '../api/tcgdex';
import * as db from '../db';
import type { Language, SetInfo } from '../types';
import type { SetIndexEntry } from './setIndex';
import { setName } from './setIndex';

/**
 * Hält die Kartendaten der Sets bereit, die beim Scannen auftauchen.
 *
 * Zweistufig, damit ein neues Set das Scannen nicht ausbremst:
 *  1. Kurzdaten (eine Anfrage) -> Kartennamen, Karte kann sofort in die Liste
 *  2. Finish-Daten (ein Abruf pro Karte) laufen danach im Hintergrund; sobald
 *     sie da sind, wird die Plausibilitätsprüfung der betroffenen Zeilen
 *     nachgeholt.
 */

const memory = new Map<string, SetInfo>();
const inFlight = new Map<string, Promise<SetInfo>>();
const enriching = new Set<string>();

type Listener = (set: SetInfo) => void;
const listeners = new Set<Listener>();

/** Meldet fertig angereicherte Sets (Finish-Daten vollständig). */
export function onSetEnriched(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function key(lang: Language, setId: string): string {
  return `${lang}:${setId}`;
}

export function cachedSet(lang: Language, setId: string): SetInfo | undefined {
  return memory.get(key(lang, setId));
}

/** Stößt das Nachladen der Finish-Daten an (höchstens einmal pro Set). */
function startEnrichment(lang: Language, set: SetInfo): void {
  const k = key(lang, set.id);
  if (set.variantsComplete || enriching.has(k)) return;
  enriching.add(k);
  enrichSetVariants(lang, set)
    .then(async (full) => {
      memory.set(k, full);
      await db.putStoredSet(full);
      listeners.forEach((l) => l(full));
    })
    .catch(() => {
      // Kein Blocker: ohne Finish-Daten wird nur nicht auf Plausibilität geprüft
    })
    .finally(() => enriching.delete(k));
}

/**
 * Liefert die Kartendaten eines Sets — aus dem Speicher, aus IndexedDB oder
 * frisch von TCGdex. Mehrfachaufrufe für dasselbe Set teilen sich eine Anfrage.
 */
export async function ensureSet(lang: Language, entry: SetIndexEntry): Promise<SetInfo> {
  const k = key(lang, entry.id);

  const inMemory = memory.get(k);
  if (inMemory) {
    startEnrichment(lang, inMemory);
    return inMemory;
  }

  const running = inFlight.get(k);
  if (running) return running;

  const task = (async () => {
    const stored = await db.getStoredSet(lang, entry.id);
    if (stored) {
      memory.set(k, stored);
      startEnrichment(lang, stored);
      return stored;
    }
    const brief = await fetchSetBrief(lang, entry.id);
    // Anzeigename aus dem Index: bei asiatischen Sets ist der englische
    // Name gepflegt, den die API dort nicht liefert.
    const named: SetInfo = { ...brief, name: setName(entry, lang) };
    memory.set(k, named);
    await db.putStoredSet(named);
    startEnrichment(lang, named);
    return named;
  })();

  inFlight.set(k, task);
  try {
    return await task;
  } finally {
    inFlight.delete(k);
  }
}

/** Für Tests und Sprachwechsel: Speicher leeren (IndexedDB bleibt bestehen). */
export function clearMemory(): void {
  memory.clear();
  inFlight.clear();
  enriching.clear();
}
