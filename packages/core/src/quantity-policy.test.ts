import { describe, expect, it } from 'vitest';
import { parseQuantity, reinterpretOzForBeverage } from './quantity.ts';
import { INCOMPARABLE_QUANTITY_MISMATCH } from '@ci/shared';
import { assessQuantities, automaticEligible, measureQuantity, measureStored, personConfirmedEligible, type QuantityTexts } from './quantity-policy.ts';

/** What the matcher reads for a product: the same parse it uses for every title, then the policy's own reading. */
const read = (title: string, extra: Omit<QuantityTexts, 'title'> = {}) =>
  measureQuantity(reinterpretOzForBeverage(parseQuantity(title, ...(extra.sizeHints ?? [])), title), { title, ...extra });
const assess = (a: string, b: string) => assessQuantities(read(a), read(b));

describe('quantity policy: different actual quantities are incomparable', () => {
  it('1. the same product, 10 L against 20 L', () => {
    const r = assess('Acme Cooking Oil 10 L', 'Acme Cooking Oil 20 L');
    expect(r.verdict).toBe('different');
    expect(r.exclusion).toBe(INCOMPARABLE_QUANTITY_MISMATCH);
    // the extracted values are kept as evidence
    expect([r.a.total, r.a.unit, r.b.total, r.b.unit]).toEqual([10_000, 'ml', 20_000, 'ml']);
    expect(r.note).toMatch(/volume differs \(10 L vs 20 L\)/);
  });

  it('2. 500 g against 1 kg', () => {
    const r = assess('Acme Flour 500 g', 'Acme Flour 1 kg');
    expect(r).toMatchObject({ verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH });
    expect(r.note).toMatch(/mass differs/);
  });

  it('3. 1 L against 1000 ml is the same quantity', () => {
    const r = assess('Acme Juice 1 L', 'Acme Juice 1000 ml');
    expect(r).toMatchObject({ verdict: 'same', exclusion: null });
  });

  it('4. 1 kg against 1000 g is the same quantity', () => {
    expect(assess('Acme Rice 1 kg', 'Acme Rice 1000 g')).toMatchObject({ verdict: 'same', exclusion: null });
  });

  it('5. a pack of 6 against a pack of 12', () => {
    const r = assess('Acme Napkins pack of 6', 'Acme Napkins pack of 12');
    expect(r).toMatchObject({ verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH });
    expect(r.note).toMatch(/count differs/);
  });

  it('6. 2 × 1 L against 1 × 2 L: the same total, the packaging kept as a separate fact', () => {
    const r = assess('Acme Water 2 x 1 L', 'Acme Water 2 L');
    expect(r.verdict).toBe('same');
    expect(r.exclusion).toBeNull();
    expect(r.a.total).toBe(2000);
    expect(r.b.total).toBe(2000);
    expect(r.packaging).toMatchObject({ differs: true, a: '2 × 1 L', b: null });
    expect(read('Acme Water 2 x 1 L')).toMatchObject({ packCount: 2, unitAmount: 1000 });
  });

  it('7. the same part number with different quantities: the quantity decides', () => {
    // a code in the title is not a quantity, and it cannot make 500 ml the same as 1 L
    const r = assess('Brand 4521 Cleaner 500 ml', 'Brand 4521 Cleaner 1 L');
    expect(r).toMatchObject({ verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH });
    expect(read('Brand 4521 Cleaner 500 ml').total).toBe(500);
  });

  it('8. a quantity missing on one side is unknown, never a match', () => {
    const r = assess('Acme Oil 1 L', 'Acme Oil');
    expect(r.verdict).toBe('unknown');
    expect(r.exclusion).toBeNull();
    expect(r.note).toMatch(/does not state a quantity/);
    expect(assess('Acme Oil', 'Acme Oil').verdict).toBe('unknown');
    expect(automaticEligible(r.verdict)).toBe(false);
  });

  it('9. 1 kg against 1 L is not assumed equal', () => {
    const r = assess('Acme Soap 1 kg', 'Acme Soap 1 L');
    expect(r).toMatchObject({ verdict: 'different', exclusion: INCOMPARABLE_QUANTITY_MISMATCH });
    expect(r.note).toMatch(/measured differently/);
  });

  it('10. model numbers, bulb codes, vehicle years and part ids are not quantities', () => {
    for (const t of ['Philips 9005 HB3 Headlight Bulb', 'Sylvania 7443 LED', '2024 Honda Accord 9005 Fog Light', 'H11 55W 12V Halogen', 'Part 4521-77 Brake Pad', 'iPhone 15 Pro 256 GB']) {
      expect(read(t).dimension, t).toBeNull();
    }
    // the pack count is read, the number beside it is not
    expect(read('Sylvania 7443 LED 2 pack')).toMatchObject({ dimension: 'count', total: 2 });
    expect(assess('Sylvania 7443 LED bulb', 'Sylvania 9005 LED bulb').verdict).toBe('unknown');
  });
});

describe('quantity policy: units and dimensions', () => {
  it('converts units only to decide equality', () => {
    expect(assess('Acme Tape 2 m', 'Acme Tape 200 cm').verdict).toBe('same');
    expect(assess('Acme Tape 2 m', 'Acme Tape 3 m').verdict).toBe('different');
    expect(assess('Acme Foil 25 sq ft', 'Acme Foil 25 sq. ft.').verdict).toBe('same');
    expect(assess('Acme Foil 25 sq ft', 'Acme Foil 50 sq ft').verdict).toBe('different');
    expect(assess('Acme Mat 2 sq m', 'Acme Mat 20000 cm²').verdict).toBe('same');
    // a US label and a metric label of the same bottle
    expect(assess('Acme Water 16.9 fl oz', 'Acme Water 500 ml').verdict).toBe('same');
    expect(assess('Acme Milk 1 gal', 'Acme Milk 3.785 L').verdict).toBe('same');
  });

  it('reads an area as an area, not as a length', () => {
    expect(read('Acme Foil 25 sq ft')).toMatchObject({ dimension: 'area' });
    expect(read('Acme Cable 25 ft')).toMatchObject({ dimension: 'length', total: 7620 });
  });

  it('never converts between different kinds of measure', () => {
    expect(assess('Acme Foil 25 sq ft', 'Acme Foil 25 ft').verdict).toBe('different');
    expect(assess('Acme Foil 25 sq ft', 'Acme Foil 25 sq ft').verdict).toBe('same');
  });

  it('a count with no size is not compared with a measured quantity (the pack does not say how much one item holds)', () => {
    const r = assess('Acme Soda 6 pack', 'Acme Soda 6 x 355 ml');
    expect(r.verdict).toBe('unknown');
    expect(r.exclusion).toBeNull();
    // but two counts are
    expect(assess('Acme Soda 6 pack', 'Acme Soda 6 pack').verdict).toBe('same');
  });

  it('does not trust a title that states two pack counts, nor ounces that may be weight or volume', () => {
    expect(assess('Acme Soda 24 Pack, 12x12 oz', 'Acme Soda 12 x 12 fl oz').verdict).toBe('unknown');
    expect(assess('Acme Coffee Beans 12 oz', 'Acme Cold Brew 355 ml').verdict).toBe('unknown');
  });

  it('reads a size from an option, a shop size tag or a labelled net-content line, only when the title states none', () => {
    expect(read('Acme Juice', { options: { Size: '1 L' } })).toMatchObject({ dimension: 'volume', total: 1000, source: 'option' });
    expect(read('Acme Juice', { sizeHints: ['Size_500ml'] })).toMatchObject({ dimension: 'volume', total: 500, source: 'size_hint' });
    expect(read('Acme Juice', { netContent: '750 ml' })).toMatchObject({ dimension: 'volume', total: 750, source: 'description' });
    expect(read('Acme Juice 1 L', { netContent: '750 ml' })).toMatchObject({ total: 1000, source: 'title' });
    expect(read('Acme Juice', { options: { Colour: 'Red', Title: 'Default Title' } }).dimension).toBeNull();
  });

  it('reads a count the size parser does not know', () => {
    expect(read('Acme Wipes 60 sheets')).toMatchObject({ dimension: 'count', total: 60 });
    expect(assess('Acme Wipes 60 sheets', 'Acme Wipes 120 sheets').verdict).toBe('different');
  });

  it('falls back to the size stored when a product was collected', () => {
    expect(measureStored('volume', 1000, '1 L')).toMatchObject({ dimension: 'volume', total: 1000 });
    expect(measureStored(null, null, null).dimension).toBeNull();
    expect(measureStored('volume', 0, null).dimension).toBeNull();
    expect(assessQuantities(measureStored('volume', 1000, '1 L'), measureStored('volume', 2000, '2 L')).verdict).toBe('different');
  });

  it('what a person confirmed stands unless the quantities are shown to differ; a machine confirmation needs them shown equal', () => {
    expect(personConfirmedEligible('same')).toBe(true);
    expect(personConfirmedEligible('unknown')).toBe(true);
    expect(personConfirmedEligible('different')).toBe(false);
    expect(automaticEligible('same')).toBe(true);
    expect(automaticEligible('unknown')).toBe(false);
    expect(automaticEligible('different')).toBe(false);
  });
});
