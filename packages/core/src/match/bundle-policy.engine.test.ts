import { describe, expect, it } from 'vitest';
import { INCOMPARABLE_BUNDLE_CONTENT_MISMATCH } from '@ci/shared';
import { analyseCatalogue, evaluatePair, type DossierInput, type PairEvaluation } from '../index.ts';

/**
 * The bundle-contents policy inside the matching engine: two automotive bundles (combos, kits) are comparable only when what they actually include is equivalent. Whatever else agrees
 * (the vehicle, the main component, the brand, a part number), a bundle with an extra or a different part is recorded as left out of price comparison, never confirmed
 * automatically and never suggested as an exact match, variant or substitute; contents that cannot be established are insufficient evidence, never assumed equal.
 */
let seq = 0;
const input = (siteId: string, title: string, o: Partial<DossierInput> = {}): DossierInput => ({
  variantId: `b${++seq}`, productId: `bp${seq}`, siteId, title, variantTitle: null, brand: 'Sealight', category: null, gtin: null, sku: null, mpn: null, model: null, sizeHints: [], ...o,
});
const pair = (aTitle: string, bTitle: string, a: Partial<DossierInput> = {}, b: Partial<DossierInput> = {}): PairEvaluation => {
  const x = input('mine', aTitle, a);
  const y = input('rival', bTitle, b);
  const corpus = analyseCatalogue([x, y]);
  return evaluatePair(corpus.byVariant.get(x.variantId)!, corpus.byVariant.get(y.variantId)!, corpus);
};
const FIT = 'Fit for 2015-2020 Ford F-150 LED Bulbs';

describe('bundle policy in the engine: contents that differ', () => {
  it('1. an extra component: incomparable, recorded with the evidence, never exact / variant / substitute, never automatic', () => {
    const e = pair(`${FIT} Headlight + Brake Light Combo`, `${FIT} Headlight + Brake Light + Indicator Lights Combo`);
    expect(e.bundle).toMatchObject({ verdict: 'mismatch', exclusion: INCOMPARABLE_BUNDLE_CONTENT_MISMATCH });
    expect(e.bundle!.onlyB).toEqual(['turn signal']);
    expect(['exact', 'variant', 'substitute']).not.toContain(e.relationship);
    expect(e.auto).toBe(false);
    expect(e.evidence.items.some((i) => i.effect === 'differs' && /bundle/i.test(i.text))).toBe(true);
  });

  it('2. a headlight on its own against headlight + brake light', () => {
    const e = pair('H11 LED Headlight Bulbs', 'H11 LED Headlight + Brake Light Combo');
    expect(e.bundle?.verdict).toBe('mismatch');
    expect(['exact', 'variant', 'substitute']).not.toContain(e.relationship);
    expect(e.auto).toBe(false);
  });

  it('3. the same vehicle fit does not help: different contents are different contents', () => {
    const e = pair(`${FIT} Headlight + Fog Combo`, `${FIT} Headlight + Fog + Turn Signal + Brake Lights Combo`);
    expect(e.bundle?.exclusion).toBe(INCOMPARABLE_BUNDLE_CONTENT_MISMATCH);
    expect(e.auto).toBe(false);
  });

  it('4. the same brand and part number do not make different contents comparable: the contents decide, not the identifier', () => {
    const e = pair(`${FIT} Headlight + Brake Light Combo`, `${FIT} Headlight + Brake Light + Indicator Lights Combo`, { mpn: 'SL-4455' }, { mpn: 'SL-4455' });
    expect(e.bundle?.exclusion).toBe(INCOMPARABLE_BUNDLE_CONTENT_MISMATCH);
    expect(e.auto).toBe(false);
    expect(['exact']).not.toContain(e.relationship);
  });

  it('5. the same barcode on two listings with different contents is still incomparable and never automatic', () => {
    const e = pair('H11 LED Headlight Bulbs Combo', 'H11 LED Headlight + Fog Light Combo', { gtin: '4006381333931' }, { gtin: '4006381333931' });
    expect(e.bundle?.verdict).toBe('mismatch');
    expect(e.auto).toBe(false);
  });

  it('6. two indicators against one', () => {
    const e = pair('Headlight + 2 indicator lights combo H11 LED', 'Headlight + 1 indicator light combo H11 LED');
    expect(e.bundle?.verdict).toBe('mismatch');
    expect(e.auto).toBe(false);
  });

  it('7. headlight + brake light against headlight + unrelated accessories', () => {
    const e = pair('H11 LED Headlight + Brake Light Combo', 'H11 LED Headlight Bulbs + Wiring Harness + Canbus Decoder Kit');
    expect(e.bundle?.verdict).toBe('mismatch');
    expect(e.auto).toBe(false);
  });

  it('the mismatch is decided by the contents alone: swapping which side has the extra part gives the same verdict', () => {
    const a = pair(`${FIT} Headlight + Brake Light Combo`, `${FIT} Headlight + Brake Light + Indicator Lights Combo`);
    const b = pair(`${FIT} Headlight + Brake Light + Indicator Lights Combo`, `${FIT} Headlight + Brake Light Combo`);
    expect(a.bundle?.verdict).toBe('mismatch');
    expect(b.bundle?.verdict).toBe('mismatch');
    expect(b.bundle!.onlyA).toEqual(['turn signal']);
  });
});

describe('bundle policy in the engine: contents that agree', () => {
  it('1. the same contents worded differently is verified equivalent: still eligible, nothing excluded', () => {
    const e = pair(`${FIT} Headlight + Brake Light Combo`, `${FIT} Combo: Brake Lamp and Head Lamp`);
    expect(e.bundle).toMatchObject({ verdict: 'equivalent', exclusion: null });
  });

  it('a different brand with verified equal contents is not rejected for its brand', () => {
    const e = pair('AUXITO H11 Headlight + Fog Light Combo', 'SEALIGHT H11 Fog Light and Headlight Bulbs Combo', { brand: 'Auxito' }, { brand: 'Sealight' });
    expect(e.bundle).toMatchObject({ verdict: 'equivalent', exclusion: null });
    expect(e.relationship).not.toBe('non_match');
  });
});

describe('bundle policy in the engine: contents that are not established', () => {
  it('a bundle whose contents the listing does not state is insufficient evidence, not equal and not different', () => {
    // everything else agrees (name, brand, fit), so without the policy this would be the same product: it is held back, not rejected
    const e = pair('LED Headlight Bulbs Combo Pack H11', 'LED Headlight Bulbs Combo Kit H11');
    expect(e.bundle).toMatchObject({ verdict: 'unknown', exclusion: null });
    expect(e.relationship).toBe('insufficient');
    expect(e.tier).toBe('insufficient');
    expect(e.auto).toBe(false);
    expect(e.evidence.items.some((i) => i.kind === 'bundle' && i.effect === 'missing')).toBe(true);
  });

  it('a pair that was never comparable stays what it was: an unknown bundle does not promote it', () => {
    const e = pair(`${FIT} All-in-One Lighting Kit`, `${FIT} Headlight + Turn Signal + Brake Light Combo`);
    expect(e.bundle).toMatchObject({ verdict: 'unknown', exclusion: null });
    expect(['exact', 'variant', 'substitute']).not.toContain(e.relationship);
    expect(e.auto).toBe(false);
  });

  it('a barcode on both listings still proves the same item: the pair is kept, not auto-confirmed', () => {
    const e = pair('LED Headlight Bulbs Combo Pack H11', 'LED Headlight Bulbs Combo Kit H11', { gtin: '4006381333931' }, { gtin: '4006381333931' });
    expect(e.bundle?.verdict).toBe('unknown');
    expect(e.relationship).not.toBe('insufficient');
    expect(e.auto).toBe(false);
  });

  it('is never confirmed automatically unless the contents are verified equal', () => {
    const unknown = pair('LED Headlight Bulbs Combo Pack H11', 'LED Headlight Bulbs Combo Kit H11', { gtin: '4006381333931' }, { gtin: '4006381333931' });
    expect(unknown.bundle?.verdict).toBe('unknown');
    expect(unknown.auto).toBe(false);
  });
});

describe('bundle policy in the engine: what it leaves alone', () => {
  it('colour and other options are not components', () => {
    const red = pair('H11 LED Headlight Bulbs', 'H11 LED Headlight Bulbs', {}, {}, );
    expect(red.bundle).toBeNull();
    const withColour = pair('H11 LED Headlight Bulbs', 'H11 LED Headlight Bulbs', { variantTitle: 'Color: Red' }, { variantTitle: 'Color: Blue' });
    expect(withColour.bundle).toBeNull();
  });

  it('grocery combos and variety packs are not assessed', () => {
    const e = pair('Lays Variety Pack of Chips', 'Lays Assortment of Chips combo', { brand: 'Lays' }, { brand: 'Lays' });
    expect(e.bundle).toBeNull();
    const soda = pair('Coca-Cola Mini Can 12 Pack Variety', 'Coca-Cola Value Pack 12 cans', { brand: 'Coca-Cola' }, { brand: 'Coca-Cola' });
    expect(soda.bundle).toBeNull();
  });

  it('two single products are not assessed', () => {
    expect(pair('H11 LED Headlight Bulbs', 'H11 LED Headlight Bulbs 6000K').bundle).toBeNull();
  });
});
