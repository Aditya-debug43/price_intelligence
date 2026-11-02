import { describe, expect, it } from 'vitest';
import { INCOMPARABLE_QUANTITY_MISMATCH } from '@ci/shared';
import { analyseCatalogue, evaluatePair, runEngine, type DossierInput, type PairEvaluation } from '../index.ts';

/**
 * The quantity-compatibility policy inside the matching engine: whatever else agrees (name, brand, a part number, even a barcode), two products that hold
 * different actual quantities are recorded as left out of price comparison, are never confirmed automatically, and keep the reason and the values.
 */
let seq = 0;
const input = (siteId: string, title: string, o: Partial<DossierInput> = {}): DossierInput => ({
  variantId: `q${++seq}`, productId: `qp${seq}`, siteId, title, variantTitle: null, brand: 'Acme', category: null, gtin: null, sku: null, mpn: null, model: null, sizeHints: [], ...o,
});
const pair = (aTitle: string, bTitle: string, a: Partial<DossierInput> = {}, b: Partial<DossierInput> = {}): PairEvaluation => {
  const x = input('mine', aTitle, a);
  const y = input('rival', bTitle, b);
  const corpus = analyseCatalogue([x, y]);
  return evaluatePair(corpus.byVariant.get(x.variantId)!, corpus.byVariant.get(y.variantId)!, corpus);
};

describe('quantity policy in the engine: different actual quantities', () => {
  it('1. the same product, 10 L against 20 L: a variant, recorded as incomparable, never automatic', () => {
    const e = pair('Acme Cooking Oil 10 L', 'Acme Cooking Oil 20 L');
    expect(e.relationship).toBe('variant');
    expect(e.quantity).toMatchObject({ verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH });
    expect([e.quantity.a.label, e.quantity.a.total, e.quantity.b.label, e.quantity.b.total]).toEqual(['10 L', 10_000, '20 L', 20_000]);
    expect(e.auto).toBe(false);
    expect(e.evidence.items.some((i) => i.kind === 'size' && i.effect === 'differs' && /Not compared on price: Actual volume differs \(10 L vs 20 L\)/.test(i.text))).toBe(true);
  });

  it('2. 500 g against 1 kg', () => {
    const e = pair('Acme Flour 500 g', 'Acme Flour 1 kg');
    expect(e.quantity.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
    expect(e.auto).toBe(false);
  });

  it('5. a pack of 6 against a pack of 12', () => {
    const e = pair('Acme Paper Napkins pack of 6', 'Acme Paper Napkins pack of 12');
    expect(e.quantity.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
    expect(e.auto).toBe(false);
  });

  it('7. the same brand and part number with another quantity: the quantity decides, not the identifier', () => {
    const e = pair('Acme Brake Cleaner 500 ml', 'Acme Brake Cleaner 1 L', { mpn: 'BC-4521' }, { mpn: 'BC-4521' });
    expect(e.method).toBe('brand_model');
    expect(e.relationship).toBe('variant');
    expect(e.quantity.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
    expect(e.auto).toBe(false);
  });

  it('the same barcode on two listings with different quantities is still incomparable and never automatic', () => {
    const e = pair('Acme Soda 1 L', 'Acme Soda 2 L', { gtin: '4006381333931' }, { gtin: '4006381333931' });
    expect(e.method).toBe('gtin');
    expect(e.quantity.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
    expect(e.auto).toBe(false);
  });

  it('9. 1 kg against 1 L is not assumed equal', () => {
    const e = pair('Acme Soap 1 kg', 'Acme Soap 1 L');
    expect(e.quantity.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
    expect(e.auto).toBe(false);
  });
});

describe('quantity policy in the engine: equal or unverified quantities', () => {
  it('3. 1 L against 1000 ml is the same quantity: still the same product, and may be confirmed automatically', () => {
    const e = pair('Acme Orange Juice 1 L', 'Acme Orange Juice 1000 ml');
    expect(e.quantity).toMatchObject({ verdict: 'same', exclusion: null });
    expect(e.relationship).toBe('exact');
    expect(e.auto).toBe(true);
  });

  it('4. 1 kg against 1000 g', () => {
    const e = pair('Acme Basmati Rice 1 kg', 'Acme Basmati Rice 1000 g');
    expect(e.quantity).toMatchObject({ verdict: 'same', exclusion: null });
    expect(e.auto).toBe(true);
  });

  it('6. 2 × 1 L against 2 L: the same total, the packaging kept as a separate fact', () => {
    const e = pair('Acme Spring Water 2 x 1 L', 'Acme Spring Water 2 L');
    expect(e.quantity.verdict).toBe('same');
    expect(e.quantity.exclusion).toBeNull();
    expect(e.quantity.packaging.differs).toBe(true);
    expect(e.relationship).toBe('variant');
    expect(e.evidence.items.some((i) => i.kind === 'pack' && /packaged differently/.test(i.text))).toBe(true);
  });

  it('8. a quantity missing on one side is unknown: not left out as a mismatch, and never confirmed automatically', () => {
    const e = pair('Acme Orange Juice 1 L', 'Acme Orange Juice');
    expect(e.quantity).toMatchObject({ verdict: 'unknown', exclusion: null });
    expect(e.auto).toBe(false);
    expect(e.evidence.items.some((i) => i.kind === 'size' && i.effect === 'missing')).toBe(true);
  });

  it('10. a model number is not a quantity: two listings of one bulb with no stated quantity are unverified, not confirmed', () => {
    const e = pair('Acme 9005 HB3 Headlight Bulb', 'Acme 9005 HB3 Headlight Bulb', { mpn: 'AC9005' }, { mpn: 'AC9005' });
    expect(e.relationship).toBe('exact');
    expect(e.quantity.verdict).toBe('unknown');
    expect(e.auto).toBe(false);
    // the number is read as a code; as a quantity only a stated pack counts
    const withPack = pair('Acme 9005 HB3 Headlight Bulb 2 pack', 'Acme 9005 HB3 Headlight Bulb 2 pack', { mpn: 'AC9005' }, { mpn: 'AC9005' });
    expect(withPack.quantity).toMatchObject({ verdict: 'same', exclusion: null });
    expect(withPack.auto).toBe(true);
    const packVsSingle = pair('Acme 9005 HB3 Headlight Bulb 2 pack', 'Acme 9005 HB3 Headlight Bulb 4 pack', { mpn: 'AC9005' }, { mpn: 'AC9005' });
    expect(packVsSingle.quantity.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
  });
});

describe('quantity policy in the engine: what is stored with a suggestion', () => {
  it('a suggestion carries the assessment; a mismatched pair is kept (as a variant) with the reason, not dropped as a non-match', () => {
    const mine = [input('mine', 'Acme Cooking Oil 10 L'), input('mine', 'Acme Flour 1 kg')];
    const rival = [input('rival', 'Acme Cooking Oil 20 L'), input('rival', 'Acme Flour 1000 g')];
    const r = runEngine(mine, rival);
    const oil = r.suggestions.find((s) => s.sourceVariantId === mine[0]!.variantId)!;
    const flour = r.suggestions.find((s) => s.sourceVariantId === mine[1]!.variantId)!;
    expect(oil).toBeTruthy();
    expect(oil.quantity).toMatchObject({ verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH });
    expect(oil.autoEligible).toBe(false);
    expect(flour.quantity).toMatchObject({ verdict: 'same', exclusion: null });
    expect(flour.autoEligible).toBe(true);
  });
});
