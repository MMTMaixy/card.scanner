import { describe, expect, it } from 'vitest';
import { buildExportFiles, csvEscape, CONDITION_TO_CSV } from './csv';
import type { ScanRow } from '../types';

function makeRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    id: Math.floor(Math.random() * 1e9),
    setId: 'sv01',
    setName: 'Karmesin & Purpur',
    lang: 'de',
    localId: '1',
    nameLocal: 'Felori',
    nameEn: 'Sprigatito',
    finish: 'normal',
    condition: 'NM',
    price: '',
    quantity: 1,
    status: 'ok',
    availableFinishes: ['normal', 'reverse'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('csvEscape', () => {
  it('quotet Kommas und Anführungszeichen', () => {
    expect(csvEscape('Tezzeret, Cruel Captain')).toBe('"Tezzeret, Cruel Captain"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('normal')).toBe('normal');
  });
});

describe('CONDITION_TO_CSV', () => {
  it('mappt auf die von der Extension erwarteten Werte', () => {
    expect(CONDITION_TO_CSV.NM).toBe('near_mint');
    expect(CONDITION_TO_CSV.EX).toBe('excellent');
    expect(CONDITION_TO_CSV.GD).toBe('good');
    expect(CONDITION_TO_CSV.LP).toBe('light_played');
    expect(CONDITION_TO_CSV.PL).toBe('played');
    expect(CONDITION_TO_CSV.PO).toBe('poor');
  });
});

describe('buildExportFiles', () => {
  it('blockiert gelbe Zeilen und exportiert sie nicht', () => {
    const rows = [makeRow(), makeRow({ status: 'warn', localId: '2' })];
    const result = buildExportFiles(rows);
    expect(result.blockedRows).toHaveLength(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).not.toContain(',2,');
  });

  it('trennt nach Set und Finish', () => {
    const rows = [
      makeRow({ localId: '1' }),
      makeRow({ localId: '2', finish: 'reverse' }),
      makeRow({ localId: '3', setId: 'sv02', setName: 'Entwicklungen in Paldea' }),
    ];
    const result = buildExportFiles(rows);
    expect(result.files).toHaveLength(3);
    const names = result.files.map((f) => f.filename);
    expect(names).toContain('cardmarket_sv01_de_normal.csv');
    expect(names).toContain('cardmarket_sv01_de_reverse.csv');
    expect(names).toContain('cardmarket_sv02_de_normal.csv');
  });

  it('splittet nach 100 Artikeln (Summe der Mengen), nicht nach Zeilen', () => {
    // 60 Zeilen mit Menge 2 = 120 Artikel -> 2 Dateien (100 + 20)
    const rows = Array.from({ length: 60 }, (_, i) =>
      makeRow({ localId: String(i + 1), quantity: 2 }),
    );
    const result = buildExportFiles(rows);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].articleCount).toBe(100);
    expect(result.files[1].articleCount).toBe(20);
    expect(result.files[0].chunkTotal).toBe(2);
    expect(result.files[0].filename).toBe('cardmarket_sv01_de_normal_1von2.csv');
  });

  it('erzeugt Header und korrekte Zeilenwerte', () => {
    const rows = [makeRow({ price: '0.25', quantity: 3, condition: 'EX' })];
    const result = buildExportFiles(rows);
    const lines = result.files[0].content.trim().split('\r\n');
    expect(lines[0]).toBe('Name,Local Name,Number,Set,Finish,Language,Condition,Quantity,Price,Comment');
    expect(lines[1]).toBe('Sprigatito,Felori,1,Karmesin & Purpur,normal,de,excellent,3,0.25,');
  });

  it('nutzt den lokalen Namen, wenn kein englischer vorhanden ist', () => {
    const rows = [makeRow({ nameEn: undefined })];
    const result = buildExportFiles(rows);
    expect(result.files[0].content).toContain('Felori,Felori,');
  });

  it('sortiert Zeilen numerisch nach Nummer', () => {
    const rows = [makeRow({ localId: '10' }), makeRow({ localId: '2' })];
    const result = buildExportFiles(rows);
    const lines = result.files[0].content.trim().split('\r\n');
    expect(lines[1]).toContain(',2,');
    expect(lines[2]).toContain(',10,');
  });
});
