import { describe, expect, it } from 'vitest';
import { isPlausibleCard, maxCornerDelta, orderCorners, polygonArea, type Pt } from './quad';

const upright: [Pt, Pt, Pt, Pt] = [
  { x: 100, y: 50 },
  { x: 240, y: 50 },
  { x: 240, y: 246 },
  { x: 100, y: 246 },
]; // 140 x 196 -> Verhältnis 1,4

describe('orderCorners', () => {
  it('sortiert in TL, TR, BR, BL unabhängig von der Eingabereihenfolge', () => {
    const shuffled = [upright[2], upright[0], upright[3], upright[1]];
    expect(orderCorners(shuffled)).toEqual(upright);
  });
  it('funktioniert auch bei gedrehtem Viereck', () => {
    // ~30° gedrehte Karte
    const rot: Pt[] = [
      { x: 200, y: 40 },
      { x: 320, y: 110 },
      { x: 220, y: 280 },
      { x: 100, y: 210 },
    ];
    const [tl, tr, br, bl] = orderCorners(rot);
    expect(tl).toEqual({ x: 200, y: 40 });
    expect(tr).toEqual({ x: 320, y: 110 });
    expect(br).toEqual({ x: 220, y: 280 });
    expect(bl).toEqual({ x: 100, y: 210 });
  });
});

describe('polygonArea', () => {
  it('berechnet Rechteckfläche', () => {
    expect(polygonArea(upright)).toBe(140 * 196);
  });
});

describe('isPlausibleCard', () => {
  it('akzeptiert ein Karten-Rechteck', () => {
    expect(isPlausibleCard(upright, 480, 640).ok).toBe(true);
  });
  it('lehnt zu kleine Vierecke ab', () => {
    const tiny = upright.map((p) => ({ x: p.x / 6, y: p.y / 6 })) as [Pt, Pt, Pt, Pt];
    expect(isPlausibleCard(tiny, 480, 640)).toMatchObject({ ok: false, reason: 'zu klein' });
  });
  it('lehnt Querformat (falsches Seitenverhältnis) ab', () => {
    const landscape: [Pt, Pt, Pt, Pt] = [
      { x: 50, y: 100 },
      { x: 246, y: 100 },
      { x: 246, y: 240 },
      { x: 50, y: 240 },
    ];
    const result = isPlausibleCard(landscape, 480, 640);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Seitenverhältnis');
  });
});

describe('maxCornerDelta', () => {
  it('misst die größte Eckverschiebung', () => {
    const moved = upright.map((p, i) => (i === 2 ? { x: p.x + 3, y: p.y + 4 } : p)) as [Pt, Pt, Pt, Pt];
    expect(maxCornerDelta(upright, moved)).toBe(5);
  });
});
