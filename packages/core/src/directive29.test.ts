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
