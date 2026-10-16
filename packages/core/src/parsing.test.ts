import { describe, expect, it } from 'vitest';
import { discountPct, fromMinorUnits, parseMachinePrice, parsePrice } from './price.ts';
import { isValidGtin, normalizeGtin } from './gtin.ts';
import { compareQuantities, parseQuantity, reinterpretOzForBeverage, unitPrice } from './quantity.ts';
import { coreNameTokens, normalizeText, nameSimilarity } from './text.ts';
import { FxTable, buildPriceView, isStale, pegRates } from './currency.ts';

describe('parsePrice', () => {
  it('never turns missing prices into zero', () => {
    expect(parsePrice('').amount).toBeNull();
    expect(parsePrice(null).amount).toBeNull();
    expect(parsePrice('Call for price').amount).toBeNull();
    expect(parseMachinePrice('')).toBeNull();
    expect(parseMachinePrice(undefined)).toBeNull();
    expect(parseMachinePrice('abc')).toBeNull();
    expect(parseMachinePrice(-3)).toBeNull();
  });
  it('parses Aruban florin and US formats', () => {
    expect(parsePrice('Afl. 12.50')).toMatchObject({ amount: 12.5, currency: 'AWG' });
    expect(parsePrice('ƒ 1,299.00')).toMatchObject({ amount: 1299, currency: 'AWG' });
    expect(parsePrice('US$ 4.99')).toMatchObject({ amount: 4.99, currency: 'USD' });
    expect(parsePrice('€ 3,49')).toMatchObject({ amount: 3.49, currency: 'EUR' });
    expect(parsePrice('1.299,50 AWG')).toMatchObject({ amount: 1299.5, currency: 'AWG' });
    expect(parsePrice('12,50')).toMatchObject({ amount: 12.5 });
  });
  it('treats a bare $ as ambiguous rather than guessing USD', () => {
    const p = parsePrice('$9.99');
    expect(p.amount).toBe(9.99);
    expect(p.currency).toBeNull();
    expect(p.ambiguousSymbol).toBe('$');
    expect(parsePrice('$9.99', 'AWG').currency).toBe('AWG');
  });
  it('refuses to guess ambiguous thousand/decimal forms', () => {
    const p = parsePrice('1.299');
    expect(p.amount).toBeNull();
    expect(p.ambiguous).toBe(true);
    expect(parsePrice('1,299').amount).toBe(1299);
  });
  it('minor units and discount math', () => {
    expect(fromMinorUnits('1250', 2)).toBe(12.5);
    expect(fromMinorUnits(null, 2)).toBeNull();
    expect(discountPct(10, 7.5)).toBe(25);
    expect(discountPct(5, 10)).toBeNull();
    expect(discountPct(null, 3)).toBeNull();
  });
});

describe('GTIN', () => {
  it('validates check digits', () => {
    expect(isValidGtin('5449000000996')).toBe(true); // Coca-Cola 330ml EAN-13
    expect(isValidGtin('5449000000997')).toBe(false);
    expect(isValidGtin('012345678905')).toBe(true); // UPC-A
    expect(isValidGtin('0000000000000')).toBe(false);
    expect(isValidGtin('abc')).toBe(false);
    expect(isValidGtin(null)).toBe(false);
  });
  it('normalises UPC-A and EAN-13 of the same item to one key', () => {
    expect(normalizeGtin('012345678905')).toBe(normalizeGtin('0012345678905'));
  });
});

describe('parseQuantity', () => {
  it('parses simple measures into base units', () => {
    expect(parseQuantity('Heinz Ketchup 397g')).toMatchObject({ kind: 'mass', total: 397 });
    expect(parseQuantity('Milk 1.5 L')).toMatchObject({ kind: 'volume', total: 1500 });
    expect(parseQuantity('Rice 2 lb')).toMatchObject({ kind: 'mass', total: 907.1847 });
    expect(parseQuantity('Water 500ml')).toMatchObject({ kind: 'volume', total: 500 });
    expect(parseQuantity('Oil 1 gal').total).toBeCloseTo(3785.41, 1);
  });
  it('parses multipacks', () => {
    expect(parseQuantity('Coca-Cola 12 x 355ml')).toMatchObject({ kind: 'volume', packCount: 12, unitAmount: 355, total: 4260 });
    expect(parseQuantity('Coke 355ml x 6')).toMatchObject({ packCount: 6, total: 2130 });
    expect(parseQuantity('Soda 355 ml 24 pack')).toMatchObject({ packCount: 24, total: 8520 });
    expect(parseQuantity('Eggs dozen')).toMatchObject({ kind: 'count', total: 12 });
    expect(parseQuantity('Paper towels, pack of 8')).toMatchObject({ kind: 'count', total: 8 });
  });
  it('does not mistake words for units', () => {
    expect(parseQuantity('Large red apples').kind).toBe('unknown');
    expect(parseQuantity('Gold Label 2 Large').kind).toBe('unknown');
  });
  it('compares totals with tolerance and detects incompatibility', () => {
    expect(compareQuantities(parseQuantity('1 L'), parseQuantity('1000 ml'))).toBe('same_total');
    expect(compareQuantities(parseQuantity('1 L'), parseQuantity('2 L'))).toBe('different_total');
    expect(compareQuantities(parseQuantity('500 g'), parseQuantity('500 ml'))).toBe('incompatible');
    expect(compareQuantities(parseQuantity('Bread'), parseQuantity('500 g'))).toBe('unknown');
  });
  it('computes unit prices', () => {
    expect(unitPrice(2, parseQuantity('500 g'))).toEqual({ value: 0.4, unit: 'per 100 g' });
    expect(unitPrice(3, parseQuantity('1.5 L'))).toEqual({ value: 2, unit: 'per L' });
    expect(unitPrice(null, parseQuantity('1 L'))).toBeNull();
    expect(unitPrice(5, parseQuantity('Bread'))).toBeNull();
  });
  it('reinterprets plain oz as fluid ounces only for beverages', () => {
    const coke = reinterpretOzForBeverage(parseQuantity('Coca-Cola Soda 12 oz'), 'Coca-Cola Soda 12 oz');
    expect(coke.kind).toBe('volume');
    expect(coke.total).toBeCloseTo(354.9, 0);
    const flour = reinterpretOzForBeverage(parseQuantity('Flour 12 oz'), 'Flour 12 oz');
    expect(flour.kind).toBe('mass');
  });
});

describe('text helpers', () => {
  it('normalises diacritics and punctuation', () => {
    expect(normalizeText("Café  Crème — Nature's")).toBe('cafe creme natures');
  });
  it('strips brand and sizes from core tokens', () => {
    expect(coreNameTokens('Coca-Cola Zero Sugar 12 x 355ml', 'Coca-Cola')).toEqual(['zero', 'sugar']);
  });
  it('gives high similarity to reordered/pluralised names', () => {
    const a = coreNameTokens('Whole Milk Gallon', 'Horizon');
    const b = coreNameTokens('Milk Whole', 'Horizon');
    expect(nameSimilarity(a, b)).toBeGreaterThan(0.6);
  });
});

describe('currency conversion', () => {
  const fx = new FxTable(pegRates(new Date('2026-10-01T00:00:00Z')));
  it('converts both ways through the explicit peg and records provenance', () => {
    const awg = fx.convert(179, 'AWG', 'USD')!;
    expect(awg.amount).toBeCloseTo(100, 2);
    expect(awg.source).toContain('Central Bank of Aruba');
    expect(awg.isFixed).toBe(true);
    expect(fx.convert(10, 'USD', 'AWG')!.amount).toBeCloseTo(17.9, 3);
  });
  it('never assumes a rate for unknown currencies', () => {
    expect(fx.convert(10, 'EUR', 'USD')).toBeNull();
    expect(fx.convert(10, null, 'USD')).toBeNull();
  });
  it('uses a USD pivot when needed', () => {
    const t = new FxTable([
      { base: 'USD', quote: 'AWG', rate: 1.79, source: 'peg', fetchedAt: '2026-10-01T00:00:00Z', isFixed: true },
      { base: 'USD', quote: 'EUR', rate: 0.9, source: 'api', fetchedAt: '2026-10-02T00:00:00Z', isFixed: false },
    ]);
    const c = t.convert(1.79, 'AWG', 'EUR')!;
    expect(c.amount).toBeCloseTo(0.9, 3);
    expect(c.isFixed).toBe(false);
    expect(c.path).toEqual(['AWG', 'USD', 'EUR']);
  });
  it('keeps original values in the price view and flags unconvertible prices', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    const v = buildPriceView({ amount: 17.9, compareAt: null, currency: 'AWG', observedAt: '2026-10-01T12:00:00Z', sourceUrl: 'https://x/p', observationId: 'o1' }, 'USD', fx, now, 36);
    expect(v.amount).toBe(17.9);
    expect(v.currency).toBe('AWG');
    expect(v.normalized).toBeCloseTo(10, 3);
    expect(v.stale).toBe(false);
    const unknown = buildPriceView({ amount: 5, compareAt: null, currency: null, observedAt: now, sourceUrl: null, observationId: null }, 'USD', fx, now, 36);
    expect(unknown.normalized).toBeNull();
  });
  it('flags stale observations rather than calling them fresh', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(isStale('2026-10-01T00:00:00Z', now, 36)).toBe(true);
    expect(isStale('2026-10-09T20:00:00Z', now, 36)).toBe(false);
    expect(isStale(null, now, 36)).toBe(true);
  });
});
