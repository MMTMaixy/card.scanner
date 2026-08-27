import { isAsiaLang } from '../types';
import type { CardInfo, Language, SetInfo, SetListEntry, Variants } from '../types';
import { asiaSetNameEn } from '../data/asiaSetNamesEn';
import speciesEn from '../data/speciesEn.json';

/**
 * TCGdex (api.tcgdex.net) — kostenlos, ohne API-Key, mit deutschen Kartennamen
 * und explizitem variants-Feld (normal/reverse/holo) pro Karte.
 *
 * Wichtig: Der Listen-Endpoint /v2/{lang}/cards?set=… liefert nur eine
 * Kurzform OHNE variants. Deshalb laden wir die Karten eines Sets einzeln
 * (parallel, einmalig pro Set) und cachen alles in IndexedDB.
 */

const API = 'https://api.tcgdex.net/v2';

interface ApiCardBrief {
  id: string;
  localId: string | number;
  name: string;
  image?: string;
}

interface ApiSetDetail {
  id: string;
  name: string;
  logo?: string;
  cardCount: { total: number; official: number };
  cards: ApiCardBrief[];
}

interface ApiCardFull {
  id: string;
  localId: string | number;
  name: string;
  image?: string;
  rarity?: string;
  variants?: Variants;
  category?: string;
  dexId?: number[];
  suffix?: string;
}

/**
 * Asien-Sets haben in TCGdex keine englischen Kartennamen. Für Pokémon-Karten
 * synthetisieren wir einen aus Pokédex-Nummer + Suffix ("Pikachu ex") — das
 * genügt fürs (normalisierte) Namens-Matching der Cardmarket-Extension.
 * Trainer/Energie behalten den Originalnamen.
 */
function synthesizeEnName(card: ApiCardFull | null): string | undefined {
  if (!card || card.category !== 'Pokemon') return undefined;
  const dex = card.dexId?.[0];
  if (!dex) return undefined;
  const species = (speciesEn as Record<string, string>)[String(dex)];
  if (!species) return undefined;
  return card.suffix ? `${species} ${card.suffix}` : species;
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(
      `Netzwerkfehler beim Abruf von TCGdex (${url}). Bist du online? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    throw new Error(`TCGdex antwortet mit Fehler ${res.status} für ${url}`);
  }
  return (await res.json()) as T;
}

/** Liste aller Sets einer Sprache (klein, ~100 KB). Neueste zuerst. */
export async function fetchSetList(lang: Language): Promise<SetListEntry[]> {
  const data = await fetchJson<
    { id: string; name: string; logo?: string; cardCount: { total: number; official: number } }[]
  >(`${API}/${lang}/sets`);
  return data
    .map((s) => ({
      id: s.id,
      name: s.name,
      // Bei ja/zh: englischer Name aus der kuratierten Tabelle (TCGdex hat keine)
      nameEn: isAsiaLang(lang) ? asiaSetNameEn(s.id) : undefined,
      officialCount: s.cardCount?.official ?? 0,
      totalCount: s.cardCount?.total ?? 0,
      logo: s.logo,
    }))
    .reverse();
}

export interface SetDownloadProgress {
  step: 'meta' | 'names-en' | 'cards';
  done: number;
  total: number;
}

/**
 * Lädt nur die Kurzdaten eines Sets: eine Anfrage, liefert Kartennamen und
 * Nummern. Reicht, um eine gescannte Karte sofort in die Liste zu übernehmen.
 * Die Finish-Daten (variants) kommen anschließend über enrichSetVariants
 * nach — die brauchen einen Abruf pro Karte und dürfen das Scannen nicht
 * blockieren.
 */
export async function fetchSetBrief(lang: Language, setId: string): Promise<SetInfo> {
  const detail = await fetchJson<ApiSetDetail>(`${API}/${lang}/sets/${setId}`);
  if (!Array.isArray(detail.cards) || detail.cards.length === 0) {
    throw new Error(`Set ${setId} enthält laut TCGdex keine Karten in dieser Sprache (${lang}).`);
  }

  let namesEn = new Map<string, string>();
  if (lang !== 'en' && !isAsiaLang(lang)) {
    try {
      const en = await fetchJson<ApiSetDetail>(`${API}/en/sets/${setId}`);
      namesEn = new Map(en.cards.map((c) => [String(c.localId), c.name]));
    } catch {
      namesEn = new Map();
    }
  }

  const asia = isAsiaLang(lang);
  const cards: CardInfo[] = detail.cards.map((brief) => {
    const localId = String(brief.localId);
    return {
      apiId: brief.id,
      localId,
      nameLocal: brief.name,
      nameEn: lang === 'en' ? brief.name : asia ? undefined : namesEn.get(localId),
      image: brief.image,
    };
  });

  return {
    id: detail.id,
    name: asia ? (asiaSetNameEn(detail.id) ?? `${detail.id} · ${detail.name}`) : detail.name,
    lang,
    officialCount: detail.cardCount?.official ?? 0,
    totalCount: detail.cardCount?.total ?? cards.length,
    logo: detail.logo,
    cards,
    fetchedAt: Date.now(),
    variantsComplete: false,
  };
}

/**
 * Ergänzt ein Set um die Finish-Daten pro Karte (und bei asiatischen Sets um
 * synthetische englische Namen). Läuft im Hintergrund, 8 Abrufe parallel.
 */
export async function enrichSetVariants(
  lang: Language,
  set: SetInfo,
  onProgress?: (done: number, total: number) => void,
): Promise<SetInfo> {
  const cards = set.cards;
  const results = new Array<ApiCardFull | null>(cards.length).fill(null);
  let done = 0;
  let failures = 0;
  const total = cards.length;
  onProgress?.(0, total);

  const CONCURRENCY = 8;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < cards.length) {
      const index = next++;
      try {
        const apiId = cards[index].apiId ?? `${set.id}-${cards[index].localId}`;
        results[index] = await fetchJson<ApiCardFull>(`${API}/${lang}/cards/${apiId}`);
      } catch {
        failures++;
      }
      done++;
      onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const asia = isAsiaLang(lang);
  const merged: CardInfo[] = cards.map((card, i) => {
    const full = results[i];
    return {
      ...card,
      rarity: full?.rarity ?? card.rarity,
      variants: full?.variants ?? card.variants,
      image: full?.image ?? card.image,
      nameEn: card.nameEn ?? (asia ? synthesizeEnName(full) : undefined),
    };
  });

  return { ...set, cards: merged, variantsComplete: failures === 0, fetchedAt: Date.now() };
}

/**
 * Lädt ein Set komplett (Kurzdaten + Finish-Daten). Für die manuelle
 * Set-Verwaltung; beim Scannen wird stattdessen zuerst nur fetchSetBrief
 * benutzt, damit die Karte sofort in die Liste kann.
 */
export async function downloadSet(
  lang: Language,
  setId: string,
  onProgress?: (p: SetDownloadProgress) => void,
): Promise<SetInfo> {
  onProgress?.({ step: 'meta', done: 0, total: 1 });
  const brief = await fetchSetBrief(lang, setId);
  return enrichSetVariants(lang, brief, (done, total) =>
    onProgress?.({ step: 'cards', done, total }),
  );
}

/** Bild-URL für den pHash-Fallback (kleine Version). */
export function cardImageUrl(image: string): string {
  return `${image}/low.webp`;
}
