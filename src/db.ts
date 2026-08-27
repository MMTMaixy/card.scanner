import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SetIndexFile } from './logic/setIndex';
import type { BatchSettings, Language, ScanRow, SetInfo } from './types';

interface ScannerDB extends DBSchema {
  settings: {
    key: string;
    value: unknown;
  };
  sets: {
    // Key: `${lang}:${setId}`
    key: string;
    value: SetInfo;
  };
  rows: {
    key: number;
    value: ScanRow;
  };
  hashes: {
    // Key: setId
    key: string;
    value: { setId: string; entries: { localId: string; hash: string }[]; builtAt: number };
  };
}

let dbPromise: Promise<IDBPDatabase<ScannerDB>> | null = null;

function db(): Promise<IDBPDatabase<ScannerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ScannerDB>('card-scanner', 1, {
      upgrade(database) {
        database.createObjectStore('settings');
        database.createObjectStore('sets');
        database.createObjectStore('rows', { keyPath: 'id', autoIncrement: true });
        database.createObjectStore('hashes');
      },
    });
  }
  return dbPromise;
}

export function setKey(lang: Language, setId: string): string {
  return `${lang}:${setId}`;
}

// --- Globaler Set-Index (Textdaten, offline) ---

/**
 * Der Index liegt als generierte JSON mit im Bundle, wird aber zusätzlich in
 * IndexedDB gehalten: So sind Nachschlagevorgänge unabhängig vom Bundle und
 * der Index kann später aktualisiert werden, ohne die App neu auszuliefern.
 */
export async function loadSetIndex(): Promise<SetIndexFile | undefined> {
  return (await (await db()).get('settings', 'setIndex')) as SetIndexFile | undefined;
}

export async function saveSetIndex(index: SetIndexFile): Promise<void> {
  await (await db()).put('settings', index, 'setIndex');
}

// --- Zuletzt genutzte Sets ---

const RECENT_MAX = 12;

export async function getRecentSets(): Promise<string[]> {
  return ((await (await db()).get('settings', 'recentSets')) as string[] | undefined) ?? [];
}

/** Schiebt eine Set-Kennung an die Spitze der Liste zuletzt genutzter Sets. */
export async function pushRecentSet(setId: string): Promise<string[]> {
  const current = await getRecentSets();
  const next = [setId, ...current.filter((id) => id !== setId)].slice(0, RECENT_MAX);
  await (await db()).put('settings', next, 'recentSets');
  return next;
}

// --- Settings ---

export async function loadBatchSettings(): Promise<BatchSettings | undefined> {
  return (await (await db()).get('settings', 'batch')) as BatchSettings | undefined;
}

export async function saveBatchSettings(settings: BatchSettings): Promise<void> {
  await (await db()).put('settings', settings, 'batch');
}

// --- Sets ---

export async function getStoredSet(lang: Language, setId: string): Promise<SetInfo | undefined> {
  return (await db()).get('sets', setKey(lang, setId));
}

export async function putStoredSet(set: SetInfo): Promise<void> {
  await (await db()).put('sets', set, setKey(set.lang, set.id));
}

export async function deleteStoredSet(lang: Language, setId: string): Promise<void> {
  await (await db()).delete('sets', setKey(lang, setId));
}

export async function listStoredSets(): Promise<SetInfo[]> {
  return (await db()).getAll('sets');
}

// --- Scan-Zeilen ---

export async function getAllRows(): Promise<ScanRow[]> {
  const rows = await (await db()).getAll('rows');
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addRow(row: Omit<ScanRow, 'id'>): Promise<ScanRow> {
  const id = await (await db()).add('rows', row as ScanRow);
  return { ...row, id: Number(id) };
}

export async function updateRow(row: ScanRow): Promise<void> {
  if (row.id == null) throw new Error('updateRow: Zeile ohne id');
  await (await db()).put('rows', row);
}

export async function deleteRow(id: number): Promise<void> {
  await (await db()).delete('rows', id);
}

export async function clearRows(): Promise<void> {
  await (await db()).clear('rows');
}

// --- pHash-Index (M4) ---

export async function getHashIndex(setId: string) {
  return (await db()).get('hashes', setId);
}

export async function putHashIndex(setId: string, entries: { localId: string; hash: string }[]): Promise<void> {
  await (await db()).put('hashes', { setId, entries, builtAt: Date.now() }, setId);
}

export async function deleteHashIndex(setId: string): Promise<void> {
  await (await db()).delete('hashes', setId);
}
