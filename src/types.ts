export type Language = 'de' | 'en' | 'ja' | 'zh-tw' | 'zh-cn';

/** Sprachen, deren Sets/Karten in TCGdex keine englischen Namen haben. */
export const ASIA_LANGS: Language[] = ['ja', 'zh-tw', 'zh-cn'];

export function isAsiaLang(lang: Language): boolean {
  return ASIA_LANGS.includes(lang);
}

export type Finish = 'normal' | 'reverse' | 'holo';

export type Condition = 'NM' | 'EX' | 'GD' | 'LP' | 'PL' | 'PO';

/** TCGdex-Variants: welche Finishes eine Karte laut Datenbank hat. */
export interface Variants {
  normal?: boolean;
  reverse?: boolean;
  holo?: boolean;
  firstEdition?: boolean;
}

export interface CardInfo {
  /** Sammlernummer wie von TCGdex geliefert, z. B. "136" oder "TG12" */
  localId: string;
  /** Name in der gewählten Set-Sprache */
  nameLocal: string;
  /** Englischer Name (Cardmarket-Produktnamen sind englisch) */
  nameEn?: string;
  rarity?: string;
  /** undefined = Finish-Daten unbekannt */
  variants?: Variants;
  /** Bild-Basis-URL (ohne /low.webp-Suffix) für den pHash-Fallback */
  image?: string;
}

export interface SetInfo {
  id: string;
  name: string;
  lang: Language;
  /** Offizielle Kartenzahl (steht als Nenner auf den Karten) */
  officialCount: number;
  /** Gesamtzahl inkl. Secret Rares */
  totalCount: number;
  logo?: string;
  cards: CardInfo[];
  fetchedAt: number;
  /** true, wenn variants pro Karte geladen werden konnten */
  variantsComplete: boolean;
}

export interface SetListEntry {
  id: string;
  /** Name in der Set-Sprache */
  name: string;
  /** Englischer Name (bei Asien-Sets aus der kuratierten Tabelle) */
  nameEn?: string;
  officialCount: number;
  totalCount: number;
  logo?: string;
}

export interface BatchSettings {
  setId: string | null;
  lang: Language;
  finish: Finish;
  condition: Condition;
  /** leerer String = kein Preis in der CSV */
  price: string;
}

export type RowStatus = 'ok' | 'warn';

export interface ScanRow {
  id?: number;
  setId: string;
  setName: string;
  lang: Language;
  localId: string;
  nameLocal: string;
  nameEn?: string;
  finish: Finish;
  condition: Condition;
  price: string;
  quantity: number;
  status: RowStatus;
  warnReason?: string;
  /** laut Datenbank verfügbare Finishes (leer = unbekannt) */
  availableFinishes: Finish[];
  createdAt: number;
  updatedAt: number;
}

export const FINISH_LABELS: Record<Finish, string> = {
  normal: 'Normal',
  reverse: 'Reverse Holo',
  holo: 'Holo',
};

export const CONDITIONS: Condition[] = ['NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'Englisch' },
  { value: 'ja', label: 'Japanisch' },
  { value: 'zh-tw', label: 'Chinesisch (trad.)' },
  { value: 'zh-cn', label: 'Chinesisch (vereinf.)' },
];
