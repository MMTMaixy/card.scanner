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
 * Lädt ein Set komplett: Metadaten, Kartennamen in Set-Sprache und Englisch,
 * und die variants pro Karte (Einzelabrufe mit Parallelität 8).
 */
export async function downloadSet(
  lang: Language,
  setId: string,
  onProgress?: (p: SetDownloadProgress) => void,
): Promise<SetInfo> {
  onProgress?.({ step: 'meta', done: 0, total: 1 });
  const detail = await fetchJson<ApiSetDetail>(`${API}/${lang}/sets/${setId}`);
  if (!Array.isArray(detail.cards) || detail.cards.length === 0) {
    throw new Error(`Set ${setId} enthält laut TCGdex keine Karten in dieser Sprache (${lang}).`);
  }

  // Englische Namen für das Cardmarket-Matching (Produktnamen sind englisch).
  // Asien-Sets existieren nicht im en-Endpoint — dort synthetisieren wir
  // stattdessen unten pro Karte einen Namen aus der Pokédex-Nummer.
  let namesEn = new Map<string, string>();
  if (lang !== 'en' && !isAsiaLang(lang)) {
    onProgress?.({ step: 'names-en', done: 0, total: 1 });
    try {
      const en = await fetchJson<ApiSetDetail>(`${API}/en/sets/${setId}`);
      namesEn = new Map(en.cards.map((c) => [String(c.localId), c.name]));
    } catch {
      // Kein Blocker: dann exportieren wir den lokalen Namen
      namesEn = new Map();
    }
  }

  // Volle Karten (variants, rarity) einzeln laden, 8 parallel
  const briefs = detail.cards;
  const results = new Array<ApiCardFull | null>(briefs.length).fill(null);
  let done = 0;
  let failures = 0;
  const total = briefs.length;
  onProgress?.({ step: 'cards', done: 0, total });

  const CONCURRENCY = 8;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < briefs.length) {
      const index = next++;
      const brief = briefs[index];
      try {
        results[index] = await fetchJson<ApiCardFull>(`${API}/${lang}/cards/${brief.id}`);
      } catch {
        failures++;
      }
      done++;
      onProgress?.({ step: 'cards', done, total });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const asia = isAsiaLang(lang);
  const cards: CardInfo[] = briefs.map((brief, i) => {
    const full = results[i];
    const localId = String(brief.localId);
    return {
      localId,
      nameLocal: brief.name,
      nameEn: lang === 'en' ? brief.name : asia ? synthesizeEnName(full) : namesEn.get(localId),
      rarity: full?.rarity,
      variants: full?.variants,
      image: full?.image ?? brief.image,
    };
  });

  // Anzeigename: bei Asien-Sets englisch aus der Tabelle; sonst Code + Original,
  // damit der Name immer (lateinisch) lesbar bleibt.
  const displayName = asia
    ? (asiaSetNameEn(detail.id) ?? `${detail.id} · ${detail.name}`)
    : detail.name;

  return {
    id: detail.id,
    name: displayName,
    lang,
    officialCount: detail.cardCount?.official ?? 0,
    totalCount: detail.cardCount?.total ?? cards.length,
    logo: detail.logo,
    cards,
    fetchedAt: Date.now(),
    variantsComplete: failures === 0,
  };
}

/** Bild-URL für den pHash-Fallback (kleine Version). */
export function cardImageUrl(image: string): string {
  return `${image}/low.webp`;
}
