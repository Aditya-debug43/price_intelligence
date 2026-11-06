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

describe('the release gate for a narrow automatic-approval policy', () => {
  const good = { precision: { hits: 118, total: 120 }, criticalViolations: 0, candidateRecall: { hits: 20, total: 200 }, matchRecall: { hits: 30, total: 200 } };
  it('passes on precision alone: whole-domain recall is a product goal and does not block a precise policy', () => {
    const r = evaluateGate(good);
    expect(r.passed).toBe(true);
    expect(r.lines.filter((l) => l.required).map((l) => l.name)).toEqual(['automatic approval precision', 'critical violations']);
    expect(r.lines.find((l) => l.name === 'candidate recall')).toMatchObject({ required: false, passed: false }); // 10%: reported, not blocking
  });
  it('needs 98% precision with a 95% lower bound above 90%, on at least 100 independent units', () => {
    expect(evaluateGate({ ...good, precision: { hits: 115, total: 120 } }).passed).toBe(false); // 95.8% < 98%
    expect(evaluateGate({ ...good, precision: { hits: 98, total: 100 } }).passed).toBe(true); // 98%, lower bound above 90%
    const thin = evaluateGate({ ...good, precision: { hits: 99, total: 100 } });
    expect(thin.passed).toBe(true);
    // a lower bound that is not above 90% is not enough even when the observed figure is high
    const unsure = evaluateGate({ ...good, precision: { hits: 49, total: 50 } }, { ...DEFAULT_GATE, minExamples: 40 });
    expect(unsure.lines[0]!.why).toMatch(/lower bound/);
    expect(unsure.passed).toBe(false);
  });
  it('a perfect score on a handful of examples is not a pass, and no examples is never a pass', () => {
    const r = evaluateGate({ ...good, precision: { hits: 20, total: 20 } });
    expect(r.passed).toBe(false);
    expect(r.lines[0]!.why).toMatch(/only 20 independent labelled examples/);
    expect(wilson(20, 20).low).toBeLessThan(0.9);
    expect(evaluateGate({ ...good, precision: { hits: 0, total: 0 } }).passed).toBe(false);
    expect(DEFAULT_GATE).toMatchObject({ autoPrecision: 0.98, precisionLowerBound: 0.9, minExamples: 100 });
  });
  it('ANY critical compatibility violation blocks the rule even when aggregate precision passes', () => {
    const r = evaluateGate({ ...good, criticalViolations: 1 });
    expect(r.passed).toBe(false);
    expect(r.lines.find((l) => l.name === 'critical violations')!.why).toMatch(/stays blocked until repaired and retested/);
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
import { evaluateBulbPolicy, codeKey, type BulbPolicyResult } from './ai/policy.ts';

const ai = (title: string, attrs: Record<string, unknown> = {}, source = 'title') => ({ domain: 'automotive' as const, title, productType: 'bulb', attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v as never, source }])) });
const eligiblePolicy: BulbPolicyResult = evaluateBulbPolicy(ai('Sealight H11 LED Headlight Bulbs', { part_codes: ['H11'] }), ai('Auxito H11 LED Headlight Bulbs', { part_codes: ['H11'] }));

describe('the deterministic conditions for automatic approval (each is needed)', () => {
  const base: AutoFacts = { matchType: 'exact_item', confidence: 'high', guardCodes: [], domain: 'grocery', gtinEqual: true, sameBrand: true, mpnEqual: false, policy: null, quantity: 'same', bundle: null, engine: { relationship: 'exact', conflicts: [] }, decidedByPerson: false };
  const eq: AutoFacts = { ...base, matchType: 'close_equivalent', domain: 'automotive', gtinEqual: false, policy: eligiblePolicy, quantity: 'unknown' };
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
  it('a compatible equivalent needs the category policy to have established every critical field from sourced evidence', () => {
    expect(autoClassOf(eq)).toBe('compatible_equivalent'); // an unknown pack size only limits the price view
    expect(autoClassOf({ ...eq, policy: null })).toBeNull();
    expect(autoClassOf({ ...eq, domain: 'grocery' })).toBeNull();
    expect(autoClassOf({ ...eq, policy: { ...eligiblePolicy, eligible: false, blocker: 'missing_fitment' } })).toBeNull();
    expect(autoClassOf({ ...eq, quantity: 'different' })).toBeNull();
    expect(autoClassOf({ ...eq, guardCodes: ['compat_gate'] })).toBeNull();
    expect(autoClassOf({ ...eq, matchType: 'substitute' })).toBeNull(); // only the two classes exist
  });
});

describe('the bulb policy: sourced evidence per critical field, learned families never count', () => {
  const policy = (a: ReturnType<typeof ai>, b: ReturnType<typeof ai>) => evaluateBulbPolicy(a, b);
  it('the same raw code and the same stated function establish an equivalent', () => {
    const r = policy(ai('Sealight H11 LED Headlight Bulbs', { part_codes: ['H11'] }), ai('Auxito H11 Fog Light Bulbs', { part_codes: ['H11'] }));
    expect(r.fields).toMatchObject({ code: 'established', function: 'conflicting' }); // headlight against fog on one code
    expect(r.eligible).toBe(false);
    expect(r.blocker).toBe('conflicting_fitment');
    expect(eligiblePolicy).toMatchObject({ eligible: true, sharedCode: 'H11', fields: { code: 'established', function: 'established' } });
  });
  it('H8, H9 and H11 only co-occur in the catalogue: they are not the same lamp', () => {
    const r = policy(ai('Sealight H11 LED Headlight Bulbs', { part_codes: ['H11'] }), ai('Auxito H8 LED Headlight Bulbs', { part_codes: ['H8'], same_part_also_written_as: ['H11', 'H9'] }));
    expect(r.fields.code).toBe('conflicting'); // the learned "also written as" list is ignored
    expect(r.eligible).toBe(false);
  });
  it('standard designations that name one lamp are verified aliases (H4 = 9003 = HB2; 9005 = HB3)', () => {
    expect(codeKey('H4')).toBe(codeKey('9003'));
    expect(codeKey('HB2')).toBe(codeKey('h4'));
    expect(codeKey('9005')).toBe(codeKey('HB3'));
    expect(codeKey('H11')).not.toBe(codeKey('H8'));
    expect(policy(ai('A H4 LED Headlight Bulb', { part_codes: ['H4'] }), ai('B 9003 LED Headlight Bulb', { part_codes: ['9003'] })).eligible).toBe(true);
  });
  it('a listing that names many codes without a selected option is an ambiguous variant; a selected option makes it exact', () => {
    const many = ai('Sealight LED Headlight Bulbs fits H4 H7 H11 9005', { part_codes: ['H4', 'H7', 'H11', '9005'] });
    expect(policy(many, eligiblePolicy.sharedCode ? ai('Auxito H11 LED Headlight Bulbs', { part_codes: ['H11'] }) : many).blocker).toBe('ambiguous_variant');
    const selected = ai('Sealight LED Headlight Bulbs', { part_codes: ['H11'] }, 'variant option');
    expect(policy(selected, ai('Auxito H11 LED Headlight Bulbs', { part_codes: ['H11'] })).eligible).toBe(true);
  });
  it('unknown critical fitment is not guessed: no code, or no stated function, needs enrichment or a person', () => {
    expect(policy(ai('Sealight LED Headlight Bulbs'), ai('Auxito H11 LED Headlight Bulbs', { part_codes: ['H11'] }))).toMatchObject({ eligible: false, blocker: 'missing_fitment', fields: { code: 'unknown' } });
    expect(policy(ai('Sealight H11 LED Bulbs', { part_codes: ['H11'] }), ai('Auxito H11 LED Bulbs', { part_codes: ['H11'] }))).toMatchObject({ eligible: false, fields: { function: 'unknown' } });
  });
  it('kits, assemblies and other products are outside this policy; marketing figures never block', () => {
    expect(policy(ai('Sealight H11 LED Headlight Bulbs Combo Kit', { part_codes: ['H11'] }), eligiblePolicy && ai('Auxito H11 LED Headlight Bulbs', { part_codes: ['H11'] })).blocker).toBe('kit');
    expect(policy(ai('Sealight H11 Projector Headlight Assembly', { part_codes: ['H11'] }), ai('Auxito H11 LED Headlight Bulbs', { part_codes: ['H11'] })).blocker).toBe('unsupported_category');
    expect(policy({ ...ai('Acme floor mat'), domain: 'grocery' as never }, ai('Auxito H11 LED Headlight Bulbs')).blocker).toBe('unsupported_category');
    // different power and brightness do not stop an equivalent
    expect(policy(ai('Sealight H11 LED Headlight Bulbs 55W', { part_codes: ['H11'], power_w: 55, lumens: 9000 }), ai('Auxito H11 LED Headlight Bulbs 70W', { part_codes: ['H11'], power_w: 70, lumens: 12000 })).eligible).toBe(true);
  });
  it('an amber against a white signal lamp is a conflict; an unstated colour on a signal lamp is critical', () => {
    const a = ai('Sealight 7440 LED Turn Signal Bulb', { part_codes: ['7440'], colour: ['amber'] });
    expect(policy(a, ai('Auxito 7440 LED Turn Signal Bulb', { part_codes: ['7440'], colour: ['white'] })).fields.colour).toBe('conflicting');
    expect(policy(a, ai('Auxito 7440 LED Turn Signal Bulb', { part_codes: ['7440'] })).blocker).toBe('missing_fitment');
    expect(policy(a, ai('Auxito W21W LED Turn Signal Bulb', { part_codes: ['W21W'], colour: ['amber'] })).eligible).toBe(true);
  });
});
