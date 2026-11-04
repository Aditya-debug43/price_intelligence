import { describe, expect, it } from 'vitest';
import { kindOf } from './match/dossier.ts';
import { parseQuantity, reinterpretOzForBeverage } from './quantity.ts';
import { assessQuantities, measureQuantity } from './quantity-policy.ts';

const read = (title: string) => measureQuantity(reinterpretOzForBeverage(parseQuantity(title), title), { title });

describe('facts: a vehicle name is not an accessory, a bulb length is not a quantity', () => {
  it('a Dodge Charger is a vehicle, not an electrical charger', () => {
    expect(kindOf('Fit for 2015-2020 Dodge Charger')).toMatchObject({ companion: false });
    expect(kindOf('Interior LED Map Light Bulbs for 2011-2023 Dodge Charger')).toMatchObject({ companion: false });
    // a real charger is still an accessory
    expect(kindOf('Wireless Phone Charger')).toMatchObject({ companion: true, tail: 'charger' });
    expect(kindOf('Dodge Wireless Phone Charger')).toMatchObject({ companion: true });
    // and a Chevrolet Bolt is not a fastener
    expect(kindOf('Fit for 2017-2022 Chevrolet Bolt')).toMatchObject({ companion: false });
  });

  it('a 42 mm bulb and a 41 mm bulb do not "hold different quantities"', () => {
    const r = assessQuantities(read('42mm LED Festoon Bulb Interior Dome Light'), read('41mm LED Festoon Bulb Interior Dome Light'));
    expect(r.verdict).toBe('unknown');
    expect(r.exclusion).toBeNull();
  });

  it('the number of bulbs is still a quantity', () => {
    expect(assessQuantities(read('42mm LED Festoon Bulb, 2 Pack'), read('41mm LED Festoon Bulb 2-Pack')).verdict).toBe('same');
    expect(assessQuantities(read('42mm LED Festoon Bulb, 2 Pack'), read('42mm LED Festoon Bulb 4-Pack')).verdict).toBe('different');
  });

  it('a length that really is the amount sold still counts', () => {
    expect(assessQuantities(read('USB Charging Cable 2 m'), read('USB Charging Cable 1 m')).verdict).toBe('different');
    expect(assessQuantities(read('Ribbon 5 m'), read('Ribbon 500 cm')).verdict).toBe('same');
  });
});

import { DEFAULT_GATE, evaluateGate, wilson } from './ai/gate.ts';

describe('the release gate for automatic approval', () => {
  const good = { candidateRecall: { hits: 190, total: 200 }, autoPrecision: { hits: 295, total: 300 }, matchRecall: { hits: 185, total: 200 } };
  it('passes only when every line reaches its threshold with enough labelled examples', () => {
    expect(evaluateGate(good).passed).toBe(true);
    expect(evaluateGate({ ...good, autoPrecision: { hits: 290, total: 300 } }).lines[1]!.passed).toBe(false); // 96.7% < 98%
    expect(evaluateGate({ ...good, candidateRecall: { hits: 180, total: 200 } }).passed).toBe(false); // 90% < 95%
  });
  it('a perfect score on a handful of examples is not a pass', () => {
    const r = evaluateGate({ ...good, autoPrecision: { hits: 20, total: 20 } });
    expect(r.passed).toBe(false);
    expect(r.lines[1]!.why).toMatch(/only 20 labelled examples/);
    expect(wilson(20, 20).low).toBeLessThan(0.9);
    expect(DEFAULT_GATE.autoPrecision).toBe(0.98);
  });
  it('no examples at all is never a pass, and says so', () => {
    const r = evaluateGate({ candidateRecall: { hits: 0, total: 0 }, autoPrecision: { hits: 0, total: 0 }, matchRecall: { hits: 0, total: 0 } });
    expect(r.passed).toBe(false);
    expect(r.lines[0]!.interval.estimate).toBeNull();
  });
});

import { extractSpecTable } from './ai/specs.ts';

describe('reading the specification lines of a product page', () => {
  const page = 'Product Details\nWattage: 55W\nVoltage: 12V DC\nBrightness: 10000LM\nColor Temperature: 6000K\nBulb Size: H11 / H8 / H9\nPosition: Low beam\nCANBUS: Built-in decoder\nLength: 42mm\nPackage includes: 2 x LED bulbs\nFitment: 2011-2023 Dodge Charger';
  it('reads what the page states, with the unit it was written with', () => {
    const f = Object.fromEntries(extractSpecTable(page).map((x) => [x.key, x.value]));
    expect(f).toMatchObject({ power_w: 55, voltage_v: 12, lumens: 10000, colour_temperature_k: 6000, part_codes: 'H11 / H8 / H9', lamp_position: 'Low beam', canbus: true, dimensions: '42mm', package_contents: '2 x LED bulbs', fitment_text: '2011-2023 Dodge Charger' });
  });
  it('keeps a 42 mm length as a dimension and a vehicle name as fitment text, never as a quantity or an accessory', () => {
    const keys = extractSpecTable(page).map((x) => x.key);
    expect(keys).toContain('dimensions');
    expect(keys).not.toContain('quantity' as never);
  });
  it('reads a run-on line and stops each value where the next label starts', () => {
    const f = Object.fromEntries(extractSpecTable('Wattage: 55W Voltage: 12V Socket: 9005').map((x) => [x.key, x.value]));
    expect(f).toMatchObject({ power_w: 55, voltage_v: 12, part_codes: '9005' });
  });
  it('invents nothing: an empty value, "N/A" or a unit-less number yields no fact', () => {
    expect(extractSpecTable('Wattage: N/A\nVoltage:\nLumens: \nBrightness: very bright')).toEqual([]);
    expect(extractSpecTable(null)).toEqual([]);
    expect(extractSpecTable('Power: high')).toEqual([]);
  });
  it('reads alcohol content for drinks, and "alcohol free" as zero', () => {
    expect(extractSpecTable('Alcohol: 5.2%')[0]).toMatchObject({ key: 'alcohol_percent', value: 5.2 });
    expect(extractSpecTable('Alcohol content: alcohol free')[0]).toMatchObject({ key: 'alcohol_percent', value: 0 });
  });
});

import { autoClassOf, type AutoFacts } from './ai/evaluation.ts';

describe('the deterministic conditions for automatic approval (each is needed)', () => {
  const base: AutoFacts = { matchType: 'exact_item', confidence: 'high', guardCodes: [], domain: 'grocery', gtinEqual: true, sameBrand: true, mpnEqual: false, codesAgree: false, quantity: 'same', bundle: null, engine: { relationship: 'exact', conflicts: [] }, decidedByPerson: false };
  const eq: AutoFacts = { ...base, matchType: 'close_equivalent', domain: 'automotive', gtinEqual: false, codesAgree: true, quantity: 'unknown' };
  it('an identical item needs an equal barcode, or the same maker and part number, AND a verified same quantity', () => {
    expect(autoClassOf(base)).toBe('exact_item');
    expect(autoClassOf({ ...base, gtinEqual: false })).toBeNull(); // the name alone is not identity
    expect(autoClassOf({ ...base, gtinEqual: false, sameBrand: true, mpnEqual: true })).toBe('exact_item');
    expect(autoClassOf({ ...base, gtinEqual: false, sameBrand: false, mpnEqual: true })).toBeNull(); // a part number of another maker proves nothing
    expect(autoClassOf({ ...base, quantity: 'unknown' })).toBeNull();
    expect(autoClassOf({ ...base, quantity: 'different' })).toBeNull();
  });
  it('anything in doubt stops it: bundle contents, a safeguard, low confidence, a decisive difference, a person’s decision', () => {
    expect(autoClassOf({ ...base, bundle: 'equivalent' })).toBe('exact_item');
    expect(autoClassOf({ ...base, bundle: 'unknown' })).toBeNull();
    expect(autoClassOf({ ...base, bundle: 'mismatch' })).toBeNull();
    for (const g of ['ungrounded_evidence', 'identity_conflict', 'bundle_unknown', 'quantity_unknown', 'brand_unknown', 'compat_gate', 'different_barcodes']) expect(autoClassOf({ ...base, guardCodes: [g] }), g).toBeNull();
    expect(autoClassOf({ ...base, confidence: 'low' })).toBeNull();
    expect(autoClassOf({ ...base, confidence: 'medium' })).toBe('exact_item');
    expect(autoClassOf({ ...base, engine: { relationship: 'non_match', conflicts: [] } })).toBeNull();
    expect(autoClassOf({ ...base, engine: { relationship: 'exact', conflicts: ['Different part codes'] } })).toBeNull();
    expect(autoClassOf({ ...base, decidedByPerson: true })).toBeNull();
  });
  it('a compatible equivalent is for automotive parts only, with the same bulb code and quantity not shown to differ', () => {
    expect(autoClassOf(eq)).toBe('compatible_equivalent');
    expect(autoClassOf({ ...eq, domain: 'grocery' })).toBeNull();
    expect(autoClassOf({ ...eq, codesAgree: false })).toBeNull();
    expect(autoClassOf({ ...eq, quantity: 'different' })).toBeNull();
    expect(autoClassOf({ ...eq, guardCodes: ['compat_gate'] })).toBeNull();
    expect(autoClassOf({ ...eq, matchType: 'substitute' })).toBeNull(); // only the two classes exist
  });
});
