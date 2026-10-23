import { describe, expect, it } from 'vitest';
import { discountPct, fromMinorUnits, parseMachinePrice, parsePrice } from './price.ts';
import { isValidGtin, normalizeGtin } from './gtin.ts';
import { compareQuantities, parseQuantity, reinterpretOzForBeverage, sizeFromTags, sizeHintOf, unitPrice } from './quantity.ts';
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

describe('pack notations seen on real grocery shops', () => {
  it('"N-M unit" is N items of M: a 24-pack of 12 oz cans is not one can (real titles from quickmartaruba.com and shop.lingandsons.com)', () => {
    expect(parseQuantity('Corona Extra Can, 12-12 oz')).toMatchObject({ packCount: 12, kind: 'mass' });
    const twentyFour = parseQuantity('Corona Extra Can, 24-12 oz');
    expect(twentyFour.packCount).toBe(24);
    expect(twentyFour.total).toBeCloseTo(24 * 340.1943, 1);
    expect(parseQuantity('Red Stripe Beer, 6-330 ml')).toMatchObject({ kind: 'volume', packCount: 6, unitAmount: 330, total: 1980 });
    expect(parseQuantity('Pepsi 24-20 oz')).toMatchObject({ packCount: 24 });
    expect(parseQuantity('Corona Extra Can 12oz')).toMatchObject({ packCount: null, total: 340.1943 });
  });

  it('a size range is not a pack, and a number that is not a pack size is not read as one', () => {
    expect(parseQuantity('Protein bar 50-60 g')).toMatchObject({ packCount: null });
    expect(parseQuantity('Seeds 1-2 oz')).toMatchObject({ packCount: null });
    expect(parseQuantity('Tide Pods 3-in-1 42 ct')).toMatchObject({ kind: 'count', total: 42 });
  });

  it('a text that states two different pack counts is marked as conflicting and its size is never "verified"', () => {
    const q = parseQuantity('Coors Light Beer Bottle 24 Pack, 12×12 oz');
    expect(q.conflict).toBe(true);
    expect(compareQuantities(q, parseQuantity('Coors Light Beer Bottle 12oz, 12ct'))).toBe('unknown');
    expect(parseQuantity('Miller Lite Beer Bottle 6 Pack, 6×12 oz').conflict).toBeUndefined(); // the two statements agree
    expect(parseQuantity('Coca-Cola Classic 12 x 355ml').conflict).toBeUndefined();
  });

  it('a single can and a 12- or 24-pack of the same size are different totals, so they cannot be "identical"', () => {
    const one = reinterpretOzForBeverage(parseQuantity('Corona Extra Can 12oz'), 'Corona Extra Can 12oz Beer Beverages');
    const twelve = reinterpretOzForBeverage(parseQuantity('Corona Extra Can, 12-12 oz'), 'Corona Extra Can, 12-12 oz Beer');
    expect(compareQuantities(one, twelve)).toBe('different_total');
  });

  it('plain "oz" on a drink is read as fluid ounces when the shop’s own tags say it is a drink, even if the name does not (Pepsi 20oz, tags "Beverages", "Soft Drinks")', () => {
    expect(reinterpretOzForBeverage(parseQuantity('Pepsi 20oz'), 'Pepsi 20oz').kind).toBe('mass'); // the name alone does not say
    const q = reinterpretOzForBeverage(parseQuantity('Pepsi 20oz'), 'Pepsi 20oz  Beverages Soft Drinks');
    expect(q.kind).toBe('volume');
    expect(q.total).toBeCloseTo(591.47, 1);
    expect(compareQuantities(q, reinterpretOzForBeverage(parseQuantity('Pepsi 20 oz'), 'Pepsi 20 oz Soda'))).toBe('same_total');
  });

  describe('a size kept in the shop’s own tags (real tags from the audited own shop, whose titles state no size)', () => {
    it.each([
      [['Deli', 'Size_9oz'], '9oz', 255.15],
      [['Grocery', 'Meat', 'Size_1kg'], '1kg', 1000],
      [['Chips', 'munchies', 'popular', 'Shop Now', 'Size_1.41oz', 'Snacks', 'weekly sale'], '1.41oz', 39.97],
      [['Dairy', 'Milk', 'popular', 'Size_64oz'], '64oz', null],
      [['Household', 'Size: 64 oz'], '64 oz', null],
    ] as const)('%j → %s', (tags, hint, grams) => {
      expect(sizeFromTags(tags)).toBe(hint);
      if (grams !== null) expect(parseQuantity('Hillshire Farm Ultra Thin Chicken Breast', null, hint).total).toBeCloseTo(grams, 1);
    });
    it('a decimal written without a leading zero is a size (".87 oz", ".5 gal", "Size_.65oz")', () => {
      expect(parseQuantity('McCormick Garlic Butter Shrimp Scampi Seasoning Mix, .87 oz').total).toBeCloseTo(24.66, 1);
      expect(parseQuantity("Dean's Dairy Pure 1% Low-Fat Milk, .5 gal").total).toBeCloseTo(1892.7, 0);
      expect(parseQuantity('McCormick Gourmet Herbes', null, sizeFromTags(['Grocery', 'Size_.65oz'])).total).toBeCloseTo(18.43, 1);
      expect(parseQuantity('Silk Almond Light Almondmilk Vanilla', null, sizeFromTags(['Size_.5gal'])).total).toBeCloseTo(1892.7, 0);
      // ordinary decimals and "1.5L" are unchanged; "Size_0" is no size
      expect(parseQuantity('Cola 1.5L').total).toBe(1500);
      expect(parseQuantity('Cola 2,5 L').total).toBe(2500);
      expect(sizeFromTags(['Size_0'])).toBe('0');
      expect(parseQuantity('Gem Vleugels/Wings', null, '0').total).toBeNull();
    });

    it('a data-entry slip in a tag ("Size_6425.36oz" on a carton of milk) is not used as a size', () => {
      expect(sizeFromTags(['Dairy', 'Milk', 'Size_6425.36oz'])).toBeNull();
      expect(sizeFromTags(['Size_64oz'])).toBe('64oz'); // an ordinary size is untouched
      expect(sizeFromTags(['Size_2.72kg'])).toBe('2.72kg');
    });

    it('the weight a nappy fits ("(15 34 Lbs)", "(22 37 Lbs (10 17 Kg))") is the baby’s, not the pack’s: it is not read as a size', () => {
      const a = parseQuantity('Pampers Baby Dry Ultra Cushiony Diapers, Size 4 (15 34 Lbs), 28 count');
      expect(a).toMatchObject({ kind: 'count', packCount: 28, total: 28 });
      const b = parseQuantity('Huggies Disney Pixar Finding Nemo Disposable Size 4 Swim Pants (22 37 Lbs (10 17 Kg)) 11 Ea, 11 pc');
      expect(b).toMatchObject({ kind: 'count', packCount: 11 });
      expect(parseQuantity('Rice (Basmati) 2 lb').total).toBeCloseTo(907.18, 1); // brackets that are not weight ranges are left alone
    });

    it('a two-part size is kept whole, and tags that are not sizes give nothing', () => {
      expect(sizeFromTags(['Bowls Cups Plates', 'Size_20ct 16oz'])).toBe('20ct 16oz');
      expect(parseQuantity('Dixie Plastic Cups', null, '20ct 16oz').packCount).toBe(20);
      for (const tags of [[], ['weekly sale', 'popular'], ['Sizes', 'size guide', 'Size_Large'], 'Size_9oz', null]) expect(sizeFromTags(tags)).toBeNull();
    });
    it('the title still wins when it states a size; an explicit size attribute wins over a tag', () => {
      expect(parseQuantity('Pringles Original 5.9oz', null, '1.41oz').total).toBeCloseTo(167.26, 1);
      expect(sizeHintOf({ size: '12 oz', tags: ['Size_9oz'] })).toBe('12 oz');
      expect(sizeHintOf({ tags: ['Size_9oz'] })).toBe('9oz');
      expect(sizeHintOf({})).toBeNull();
    });
  });

  describe('plain "oz" stays weight for dry or solid products that merely mention a drink word (real titles from the audited shops)', () => {
    const kind = (title: string, context = '') => reinterpretOzForBeverage(parseQuantity(title), `${title} ${context}`).kind;
    it.each([
      ["Hershey's Milk Chocolate Extra Large Bar 4.4oz", ''],
      ["M&M'S Chocolate Candies Milk Chocolate 11oz", 'Candy'],
      ["Dunkin' Donuts Dunkin' Dark Dark Roast Ground Coffee 11oz", 'Beverages Coffee'],
      ['Starbucks Ground Coffee Breakfast Blend Medium 12oz', 'Beverages'],
      ['Lavazza Espresso Decaf 8.8oz', 'Beverages Coffee'], // the shop files coffee under "Beverages"; the pack is beans or grounds
      ['Nestea Iced Tea Mix Lemon 45oz', 'Beverages'],
      ['Bumble Bee Chunk Light Tuna In Water 5oz', ''],
      ['Dole Pineapple Chunks In 100% Fruit Juice 20oz', 'Beverages Juice'],
    ] as const)('%s → weight', (title, ctx) => expect(kind(title, ctx)).toBe('mass'));

    it.each([
      ["Dean's Dairy Pure 2% Reduced Fat Milk 32oz", ''],
      ['Arizona Green Tea With Ginseng And Honey 23oz', ''],
      ['Starbucks Frappuccino Coffee Drink 9.5oz', ''],
      ['Dunkin Iced Coffee Mocha 13.7oz', ''],
      ['International Delight Gourmet Coffee Creamer French Vanilla 32oz', ''],
      ['Mr & Mrs T Pina Colada Mix 33oz', 'Beverages Mixers'], // a bottled cocktail mixer is a liquid; a powder "drink mix" is not
      ["Daily's Margarita Mix 32oz", 'Beverages'],
      ['Hershey Chocolate Milk 14oz', ''],
      ['Pepsi 20oz', 'Beverages Soft Drinks'],
    ] as const)('%s → fluid ounces', (title, ctx) => expect(kind(title, ctx)).toBe('volume'));
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
