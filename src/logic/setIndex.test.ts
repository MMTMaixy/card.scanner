import { describe, expect, it } from 'vitest';
import {
  codeTokens,
  editDistance,
  identifySet,
  normalizeSetCode,
  searchSets,
  setName,
  type SetIndexEntry,
} from './setIndex';

const sets: SetIndexEntry[] = [
  { id: 'me05', serie: 'Mega', official: 84, total: 120, names: { de: 'Dunkelnacht', en: 'Pitch Black' }, code: 'PBL', released: '2026-07-17' },
  { id: 'sv01', serie: 'SV', official: 198, total: 258, names: { de: 'Karmesin & Purpur', en: 'Scarlet & Violet' }, code: 'SVI', released: '2023-03-31' },
  { id: 'sv02', serie: 'SV', official: 193, total: 279, names: { de: 'Paldea Evolved', en: 'Paldea Evolved' }, code: 'PAL', released: '2023-06-09' },
  // Zwei Sets mit gleichem Nenner -> Kandidatenfall
  { id: 'swsh1', serie: 'SWSH', official: 202, total: 216, names: { de: 'Schwert & Schild' }, code: 'SSH', released: '2020-02-07' },
  { id: 'other', serie: 'X', official: 202, total: 210, names: { de: 'Anderes Set' }, code: 'OTH', released: '2019-01-01' },
  // Nur japanisch
  { id: 'SV2a', serie: 'SV', official: 165, total: 207, names: { ja: 'ポケモンカード151' }, code: 'SV2a', codeFromId: true, released: '2023-06-16' },
];

describe('normalizeSetCode', () => {
  it('vereinheitlicht Schreibweisen', () => {
    expect(normalizeSetCode('sv 4a')).toBe('SV4A');
    expect(normalizeSetCode('[PBL]')).toBe('PBL');
    expect(normalizeSetCode('sv9.5')).toBe('SV9.5');
  });
});

describe('codeTokens', () => {
  it('findet Code-Kandidaten im Kleingedruckten', () => {
    expect(codeTokens('J PBL 005/084 ©2026 Pokemon')).toContain('PBL');
  });
  it('ignoriert reine Zahlen', () => {
    expect(codeTokens('005 084 2026')).toEqual([]);
  });
});

describe('editDistance', () => {
  it('misst kurze Abstände', () => {
    expect(editDistance('PBL', 'PBL')).toBe(0);
    expect(editDistance('PBL', 'P8L')).toBe(1);
    expect(editDistance('PBL', 'XYZ')).toBe(3);
  });
});

describe('identifySet', () => {
  it('(a) bestimmt das Set direkt über den gelesenen Code', () => {
    const r = identifySet({ sets, lang: 'de', denominator: 84, codeText: 'J PBL 005/084 ©2026' });
    expect(r.mode).toBe('code');
    expect(r.set?.id).toBe('me05');
  });

  it('(a) toleriert einen Lesefehler im Code, wenn der Nenner passt', () => {
    const r = identifySet({ sets, lang: 'de', denominator: 84, codeText: 'P8L 005/084' });
    expect(r.mode).toBe('code');
    expect(r.set?.id).toBe('me05');
  });

  it('toleriert KEINEN Lesefehler ohne Nenner-Eingrenzung', () => {
    const r = identifySet({ sets, lang: 'de', codeText: 'P8L' });
    expect(r.set).toBeUndefined();
  });

  it('(b) bestimmt das Set über einen eindeutigen Nenner', () => {
    const r = identifySet({ sets, lang: 'de', denominator: 198 });
    expect(r.mode).toBe('denominator');
    expect(r.set?.id).toBe('sv01');
  });

  it('(b) liefert Kandidaten bei mehrdeutigem Nenner', () => {
    const r = identifySet({ sets, lang: 'de', denominator: 202 });
    expect(r.mode).toBe('candidates');
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['other', 'swsh1']);
  });

  it('sortiert zuletzt genutzte Sets nach oben', () => {
    const r = identifySet({ sets, lang: 'de', denominator: 202, recent: ['other'] });
    expect(r.candidates[0].id).toBe('other');
  });

  it('(c) meldet nichts, wenn weder Code noch Nenner passen', () => {
    expect(identifySet({ sets, lang: 'de', denominator: 999 }).mode).toBe('none');
    expect(identifySet({ sets, lang: 'de' }).mode).toBe('none');
  });

  it('beachtet die Sprache', () => {
    // Das japanische Set ist auf Deutsch nicht wählbar
    expect(identifySet({ sets, lang: 'de', denominator: 165 }).mode).toBe('none');
    expect(identifySet({ sets, lang: 'ja', denominator: 165 }).set?.id).toBe('SV2a');
  });

  it('nutzt den Nenner, um einen mehrdeutigen Code aufzulösen', () => {
    // 'SSH' und 'OTH' haben denselben Nenner; der Code entscheidet
    const r = identifySet({ sets, lang: 'de', denominator: 202, codeText: 'OTH 010/202' });
    expect(r.mode).toBe('code');
    expect(r.set?.id).toBe('other');
  });
});

describe('searchSets', () => {
  it('findet über Name, Kennung und Code', () => {
    expect(searchSets(sets, 'de', 'dunkel').map((s) => s.id)).toEqual(['me05']);
    expect(searchSets(sets, 'de', 'SVI').map((s) => s.id)).toEqual(['sv01']);
    expect(searchSets(sets, 'de', 'sv02').map((s) => s.id)).toEqual(['sv02']);
  });
  it('stellt zuletzt genutzte nach oben', () => {
    expect(searchSets(sets, 'de', '', ['swsh1'])[0].id).toBe('swsh1');
  });
});

describe('setName', () => {
  it('faellt auf eine vorhandene Sprache zurueck', () => {
    expect(setName(sets[5], 'de')).toBe('ポケモンカード151');
  });
});
