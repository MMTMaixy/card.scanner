import { describe, expect, it } from 'vitest';
import { bitsToHex, grayToBits, hamming } from './dhash';

describe('bitsToHex', () => {
  it('kodiert 64 Bits als 16 Hex-Zeichen', () => {
    expect(bitsToHex(new Array(64).fill(false))).toBe('0000000000000000');
    expect(bitsToHex(new Array(64).fill(true))).toBe('ffffffffffffffff');
    const bits = new Array(64).fill(false);
    bits[0] = true; // höchstes Bit des ersten Nibbles
    expect(bitsToHex(bits)).toBe('8000000000000000');
  });
});

describe('hamming', () => {
  it('zählt unterschiedliche Bits', () => {
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0);
    expect(hamming('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hamming('f000000000000000', '0000000000000000')).toBe(4);
  });
  it('ungleiche Länge = maximal verschieden', () => {
    expect(hamming('abc', 'abcd')).toBe(64);
  });
});

describe('grayToBits', () => {
  it('vergleicht horizontale Nachbarn (9x8 -> 64 Bits)', () => {
    // Gradient von hell nach dunkel: jedes Pixel heller als der rechte Nachbar
    const gray: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) gray.push(255 - x * 10);
    const bits = grayToBits(gray);
    expect(bits).toHaveLength(64);
    expect(bits.every(Boolean)).toBe(true);
  });
});
