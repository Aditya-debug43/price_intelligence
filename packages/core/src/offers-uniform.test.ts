import { describe, expect, it } from 'vitest';
import { detectUniformCompareAt } from './offers.ts';

const item = (price: number, markup: number | null) => ({ price, compareAt: markup === null ? null : Math.round(price * (1 + markup / 100) * 100) / 100 });
const many = (n: number, make: (i: number) => { price: number | null; compareAt: number | null }) => Array.from({ length: n }, (_, i) => make(i));

describe('a "regular price" on every product is a standing display, not a sale', () => {
  it('is recognised when almost every product shows one at nearly the same percentage (the shape seen on a live grocery shop: 2,383 of 2,385 products, 7.4–8.3 % above)', () => {
    const found = detectUniformCompareAt([...many(2383, (i) => item(3 + (i % 90) * 0.37, 7.4 + (i % 10) * 0.1)), ...many(2, () => item(5, null))]);
    expect(found).not.toBeNull();
    expect(found!.share).toBeGreaterThan(0.99);
    expect(found!.medianMarkupPct).toBeGreaterThan(7.3);
    expect(found!.medianMarkupPct).toBeLessThan(8.5);
    expect(found!.spreadPct).toBeLessThanOrEqual(3);
  });

  it('is NOT recognised for a normal shop: a minority of products on sale, at different depths (the other live shop: 144 of 2,126, 5–44 % off)', () => {
    const items = [...many(144, (i) => item(10, 5 + (i % 40))), ...many(1982, () => item(8, null))];
    expect(detectUniformCompareAt(items)).toBeNull();
  });

  it('is NOT recognised when most products show a regular price but at very different depths', () => {
    expect(detectUniformCompareAt(many(100, (i) => item(10, 5 + (i % 50))))).toBeNull();
  });

  it('needs enough products to judge, ignores unpriced products and compare-at prices that are not higher', () => {
    expect(detectUniformCompareAt(many(10, () => item(10, 8)))).toBeNull(); // too few to call a pattern
    expect(detectUniformCompareAt([...many(30, () => item(10, 8)), ...many(500, () => ({ price: null, compareAt: null }))])).not.toBeNull(); // unpriced items are not counted against it
    expect(detectUniformCompareAt(many(100, () => ({ price: 10, compareAt: 10 })))).toBeNull(); // equal is not "higher"
  });
});
