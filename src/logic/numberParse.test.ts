import { describe, expect, it } from 'vitest';
import {
  findCardByNumber,
  normalizeLocalId,
  normalizeOcrDigits,
  parseScanText,
  scanMatchesSet,
} from './numberParse';
import type { SetInfo } from '../types';

const set: SetInfo = {
  id: 'swsh3',
  name: 'Flammende Finsternis',
  lang: 'de',
  officialCount: 189,
  totalCount: 201,
  cards: [
    { localId: '25', nameLocal: 'Pikachu' },
    { localId: '136', nameLocal: 'Glurak' },
    { localId: '201', nameLocal: 'Geheime Karte' },
    { localId: 'TG12', nameLocal: 'Trainer-Galerie' },
  ],
  fetchedAt: 0,
  variantsComplete: true,
};

describe('normalizeLocalId', () => {
  it('entfernt führende Nullen', () => {
    expect(normalizeLocalId('025')).toBe('25');
    expect(normalizeLocalId('001')).toBe('1');
    expect(normalizeLocalId('136')).toBe('136');
  });
  it('behandelt alphanumerische Promos', () => {
    expect(normalizeLocalId('tg09')).toBe('TG9');
    expect(normalizeLocalId(' TG12 ')).toBe('TG12');
  });
});

describe('findCardByNumber', () => {
  it('findet mit und ohne führende Nullen', () => {
    expect(findCardByNumber(set, '25')?.nameLocal).toBe('Pikachu');
    expect(findCardByNumber(set, '025')?.nameLocal).toBe('Pikachu');
    expect(findCardByNumber(set, 'tg12')?.nameLocal).toBe('Trainer-Galerie');
  });
  it('liefert undefined für unbekannte Nummern', () => {
    expect(findCardByNumber(set, '999')).toBeUndefined();
    expect(findCardByNumber(set, '')).toBeUndefined();
  });
});

describe('parseScanText', () => {
  it('extrahiert Zähler/Nenner aus OCR-Text', () => {
    expect(parseScanText('025/185')).toEqual({ numerator: '025', denominator: 185 });
    expect(parseScanText('xx 136 / 189 yy')).toEqual({ numerator: '136', denominator: 189 });
  });
  it('liefert undefined ohne Muster', () => {
    expect(parseScanText('PIKACHU')).toBeUndefined();
  });
});

describe('parseScanText mit OCR-Verwechslungen', () => {
  it('korrigiert echte Fehllesungen (im Browser-Selftest gemessen)', () => {
    // "005/084" wurde als "oosi0a4" bzw. "oosi084" gelesen
    expect(parseScanText('oosi0a4 wer28 Pom')).toEqual({ numerator: '005', denominator: 84 });
    expect(parseScanText('oosi084 wales Pom')).toEqual({ numerator: '005', denominator: 84 });
  });

  it('erfindet keine Nummer aus verstreutem Rauschen', () => {
    // Genau dieser Text erzeugte mit Leerzeichen-Toleranz ein falsches "5/88"
    expect(parseScanText('Le — ae Goer 5 I ee <_<’ so 5% rs J')).toBeUndefined();
    expect(parseScanText('PT jak i gt SY” ees aii')).toBeUndefined();
  });

  it('bevorzugt eine saubere Lesung gegenüber der Korrektur', () => {
    expect(parseScanText('136/189')).toEqual({ numerator: '136', denominator: 189 });
  });
});

describe('normalizeOcrDigits', () => {
  it('bildet nur bekannte Verwechslungen ab', () => {
    expect(normalizeOcrDigits('oOsSiI')).toBe('0055//');
    expect(normalizeOcrDigits('136/189')).toBe('136/189');
  });
});

describe('scanMatchesSet', () => {
  it('akzeptiert nur den passenden Nenner', () => {
    expect(scanMatchesSet({ numerator: '136', denominator: 189 }, set)).toBe(true);
    expect(scanMatchesSet({ numerator: '136', denominator: 198 }, set)).toBe(false);
  });
  it('erlaubt Secret Rares über der offiziellen Zahl', () => {
    expect(scanMatchesSet({ numerator: '201', denominator: 189 }, set)).toBe(true);
  });
  it('lehnt absurde Zähler ab', () => {
    expect(scanMatchesSet({ numerator: '0', denominator: 189 }, set)).toBe(false);
    expect(scanMatchesSet({ numerator: '999', denominator: 189 }, set)).toBe(false);
  });
});
