import { cardImageUrl } from '../api/tcgdex';
import * as db from '../db';
import type { SetInfo } from '../types';
import { hamming, hashImageSource } from './dhash';

export interface HashEntry {
  localId: string;
  hash: string;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  // Ohne CORS-Freigabe wäre das Canvas "tainted" und getImageData verboten —
  // assets.tcgdex.net liefert Access-Control-Allow-Origin.
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  return img;
}

/**
 * Baut den Bild-Index für ein Set: lädt einmalig alle Kartenbilder (kleine
 * Version) und speichert die Hashes in IndexedDB. Danach offline nutzbar.
 */
export async function buildHashIndex(
  set: SetInfo,
  onProgress?: (done: number, total: number) => void,
): Promise<HashEntry[]> {
  const withImage = set.cards.filter((c) => c.image);
  if (withImage.length === 0) {
    throw new Error(`Für ${set.name} liefert TCGdex keine Kartenbilder – Foto-Abgleich nicht möglich.`);
  }
  const entries: HashEntry[] = [];
  let done = 0;
  let failures = 0;
  const total = withImage.length;
  onProgress?.(0, total);

  const CONCURRENCY = 6;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < withImage.length) {
      const card = withImage[next++];
      try {
        const img = await loadImage(cardImageUrl(card.image!));
        entries.push({ localId: card.localId, hash: hashImageSource(img) });
      } catch {
        failures++;
      }
      done++;
      onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (entries.length === 0 || failures > total / 2) {
    throw new Error(
      `Bild-Index für ${set.name} fehlgeschlagen (${failures}/${total} Bilder nicht ladbar). Bist du online?`,
    );
  }
  await db.putHashIndex(set.id, entries);
  return entries;
}

export async function loadHashIndex(setId: string): Promise<HashEntry[] | undefined> {
  const stored = await db.getHashIndex(setId);
  return stored?.entries;
}

export interface MatchCandidate {
  localId: string;
  distance: number;
}

/** Beste Kandidaten für einen Foto-Hash, kleinste Distanz zuerst. */
export function matchHash(hash: string, entries: HashEntry[], topN = 3): MatchCandidate[] {
  return entries
    .map((e) => ({ localId: e.localId, distance: hamming(hash, e.hash) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topN);
}
