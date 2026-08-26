import { describe, expect, it } from 'vitest';
import { availableFinishes, checkFinish } from './plausibility';
import type { CardInfo } from '../types';

const commonCard: CardInfo = {
  localId: '1',
  nameLocal: 'Felori',
  variants: { normal: true, reverse: true, holo: false },
};

const secretRare: CardInfo = {
  localId: '201',
  nameLocal: 'Geheime Karte',
  variants: { normal: false, reverse: false, holo: true },
};

const unknownCard: CardInfo = {
  localId: '5',
  nameLocal: 'Unbekannt',
};

describe('availableFinishes', () => {
  it('liest die Variants korrekt', () => {
    expect(availableFinishes(commonCard)).toEqual(['normal', 'reverse']);
    expect(availableFinishes(secretRare)).toEqual(['holo']);
  });
  it('leer bei fehlenden Daten', () => {
    expect(availableFinishes(unknownCard)).toEqual([]);
  });
});

describe('checkFinish', () => {
  it('ok, wenn das Finish existiert', () => {
    expect(checkFinish(commonCard, 'reverse').status).toBe('ok');
  });
  it('warnt, wenn das Finish laut Datenbank nicht existiert (Kernfall: Secret Rare als Reverse)', () => {
    const result = checkFinish(secretRare, 'reverse');
    expect(result.status).toBe('warn');
    expect(result.reason).toContain('Reverse Holo');
    expect(result.reason).toContain('Holo');
    expect(result.available).toEqual(['holo']);
  });
  it('warnt nicht bei unbekannten Finish-Daten (kein falscher Alarm)', () => {
    expect(checkFinish(unknownCard, 'reverse').status).toBe('ok');
  });
});
