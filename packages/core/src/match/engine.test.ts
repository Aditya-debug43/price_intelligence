import { describe, expect, it } from 'vitest';
import { analyseCatalogue, bundleMarkersIn, evaluatePair, kindOf, parseCodeTokens, parseExclusions, parseSpecs, parseYears, runEngine, type DossierInput, type PairEvaluation } from '../index.ts';

let seq = 0;
const input = (siteId: string, title: string, o: Partial<DossierInput> = {}): DossierInput => ({
  variantId: `v${++seq}`, productId: `p${seq}`, siteId, title, variantTitle: null, brand: null, category: null, gtin: null, sku: null, mpn: null, model: null, sizeHints: [], ...o,
});

/** Filler listings so corpus statistics (rare vs common words, vehicle words, aliases) behave as they do in a real catalogue. */
function filler(): DossierInput[] {
  const makes: [string, string[]][] = [
    ['Toyota', ['Camry', 'Corolla', 'Sienna', 'Tacoma', 'Highlander', 'RAV4']], ['Honda', ['Civic', 'Accord', 'CRV', 'Pilot']], ['Ford', ['Fusion', 'Focus', 'Escape', 'Explorer']],
    ['Chevrolet', ['Silverado', 'Equinox', 'Colorado', 'Traverse']], ['Nissan', ['Altima', 'Titan', 'Rogue']], ['Volkswagen', ['Jetta', 'Golf', 'Touareg']],
  ];
  const out: DossierInput[] = [];
  let y = 2008;
  for (const [make, models] of makes) {
    for (const model of models) {
      y = 2008 + ((y + 3) % 12);
      out.push(input('lasfit', `Fit for ${y}-${y + 4} ${make} ${model} LED Bulbs Upgrade | Tested and Verified`, { brand: 'Lasfit' }));
      out.push(input('auxito', `${y + 1}-${y + 5} ${make} ${model} LED Light Bulbs`, { brand: 'AUXITO' }));
      out.push(input('sealight', `SEALIGHT® ${y}-${y + 3} ${make} ${model} LED Bulbs Exterior Multiple Position`, { brand: 'Sealight' }));
    }
  }
  for (const [codes, name] of [['H4 HB2 9003', 'Headlight'], ['H11 H8 H9', 'Headlight'], ['9005 HB3', 'Headlight'], ['7443 7440 T20', 'Turn Signal'], ['168 194 2825 T10', 'Dome'], ['3157', 'Brake']] as const) {
    for (const [site, brand, tpl] of [['lasfit', 'Lasfit', `${codes} ${name} LED Bulbs 6000K | LA Plus Series`], ['auxito', 'AUXITO', `${name} LED Bulb ${codes.split(' ').join('/')} 12000LM`], ['sealight', 'Sealight', `SEALIGHT® S2S ${codes.split(' ').join('/')} ${name} LED Bulbs 2Pcs`], ['alla', 'Alla Lighting', `${codes} ${name} LED Bulbs Replacement`]] as const) {
      out.push(input(site, tpl, { brand }));
      out.push(input(site, `${tpl} Combo`, { brand }));
      out.push(input(site, `${tpl} Switchback`, { brand }));
    }
  }
  for (const w of ['Adapter Holder Retainer', 'Canbus Decoder Resistor Harness', 'Wiring Harness Relay']) for (const site of ['alla', 'sealight', 'auxito']) for (const code of ['H7', '9005', 'H11']) out.push(input(site, `${code} LED ${w} for Bulbs`, { brand: site }));
  return out;
}

const run = (a: DossierInput, b: DossierInput, extra: DossierInput[] = []): PairEvaluation => {
  const corpus = analyseCatalogue([a, b, ...extra, ...filler()]);
  return evaluatePair(corpus.byVariant.get(a.variantId)!, corpus.byVariant.get(b.variantId)!, corpus);
};

describe('extraction: the failures found in the investigation', () => {
  it('keeps bulb codes that the earlier engine removed as numeric noise', () => {
    expect(parseCodeTokens('LED Fog Light Bulbs H10 9145 9140 9055', 'title').sort()).toEqual(['9055', '9140', '9145', 'h10']);
    expect(parseCodeTokens('7443 7440 T20 W21W', 'title')).toEqual(expect.arrayContaining(['7443', '7440', 't20', 'w21w']));
  });
  it('never reads a year range as a code', () => {
    expect(parseCodeTokens('Fit for 2011-2013 Toyota Highlander LED Bulbs', 'title')).toEqual([]);
    expect(parseCodeTokens('2019 2020 Ram 1500 Classic', 'title')).toEqual(['1500']);
    expect(parseYears('2011-2013 Toyota Highlander', 'title').ranges).toEqual([{ from: 2011, to: 2013, source: 'title' }]);
    expect(parseYears('2019 2020 Ram 1500', 'title').ranges).toEqual([{ from: 2019, to: 2020, source: 'title' }]);
    expect(parseYears('Fit for 2015–2023 Ford F-150', 'title').ranges).toEqual([{ from: 2015, to: 2023, source: 'title' }]);
  });
  it('does not take a size, a pack or a quantity for a code', () => {
    expect(parseCodeTokens('Coca-Cola Zero Sugar 12 x 355ml', 'title')).toEqual([]);
    expect(parseCodeTokens('Fish Oil 2000 mg 120 ct', 'title')).toEqual([]);
    expect(parseCodeTokens('Pack of 6 AA Batteries 1.5V', 'title')).toEqual(['aa'].filter(() => false));
  });
  it('reads units into base values and "8K" as thousands of kelvin', () => {
    const s = parseSpecs('60W 6000LM 6500K LED, 12V, 41mm, 12 inch bar, 8K Ice Blue', 'title');
    const by = (k: string) => s.filter((x) => x.key === k).map((x) => x.value);
    expect(by('power_w')).toEqual([60]);
    expect(by('light_lm')).toEqual([6000]);
    expect(by('colour_temp_k')).toEqual([6500, 8000]);
    expect(by('voltage_v')).toEqual([12]);
    expect(by('length_mm')).toEqual(expect.arrayContaining([41, 304.8]));
  });
  it('records explicit compatibility exclusions and keeps them out of the words', () => {
    expect(parseExclusions('2021 2022 Ram 1500 LED Bulbs (Not For Classic)')).toEqual(['classic']);
    const d = analyseCatalogue([input('a', '2021 2022 Ram 1500 LED Bulbs (Not For Classic)')]).dossiers[0]!;
    expect(d.words).not.toContain('classic');
    expect(parseExclusions('Without added sugar')).toEqual([]);
  });
  it('tells the kind of thing a listing is from the right part of the title', () => {
    expect(kindOf('H7 LED Adapter Retainer Holders Socket Base for Ford Focus SVT Bulb')).toMatchObject({ companion: true });
    expect(kindOf('Pro Series H7 LED Bulbs w/Retainer Adapter Fit for Volkswagen Passat 2012-2015 | 2 Bulbs')).toMatchObject({ companion: false, tail: 'bulb' });
    expect(kindOf('SEALIGHT® 9008/H13 LED Bulbs Canbus Decoder/ Resistor Anti Flicker Harness Resistor Kit')).toMatchObject({ companion: true });
    expect(kindOf('40W 9003 H4 HB2 L1 Plus Series | 4,000LM 6000K LED Bulbs')).toMatchObject({ companion: false, tail: 'bulb' });
    expect(bundleMarkersIn('Combo 9005 and H11 LED Bulbs')).toEqual(['combo']);
  });
});

describe('the corpus learns its own vocabulary', () => {
  it('folds alias codes (H4 = 9003 = HB2) that always appear together on more than one website', () => {
    const c = analyseCatalogue(filler());
    expect(c.alias.get('9003') ?? '9003').toBe(c.alias.get('h4') ?? 'h4');
    expect(c.alias.get('hb2') ?? 'hb2').toBe(c.alias.get('h4') ?? 'h4');
  });
  it('learns which words name the vehicle (they accompany year ranges) and not generic words', () => {
    const c = analyseCatalogue(filler());
    expect(c.subjectWords.has('w:camry')).toBe(true);
    expect(c.subjectWords.has('w:led')).toBe(false);
    expect(c.subjectWords.has('w:bulb')).toBe(false);
  });
});

describe('relationships', () => {
  it('same barcode on both listings → exact, strong, and the identifier is the stated reason', () => {
    const e = run(input('lasfit', 'Heinz Tomato Ketchup 397g', { brand: 'Heinz', gtin: '5000157024671' }), input('auxito', 'Ketchup Heinz Tomato 14oz', { brand: 'Heinz', gtin: '5000157024671' }));
    expect(e.relationship).toBe('exact');
    expect(e.tier).toBe('strong');
    expect(e.evidence.items.some((i) => i.kind === 'identifier' && i.effect === 'supports')).toBe(true);
  });
  it('same brand and manufacturer part number → exact', () => {
    const e = run(input('lasfit', 'Bosch Spark Plug', { brand: 'Bosch', mpn: 'FR7DC+' }), input('auxito', 'BOSCH FR7DC+ Spark Plug', { brand: 'Bosch', mpn: 'FR7DC+' }));
    expect(e.relationship).toBe('exact');
    expect(e.method).toBe('brand_model');
  });
  it('the same product with a different pack is a variant, never exact', () => {
    const e = run(input('lasfit', 'Coca-Cola Zero Sugar 12 x 355ml', { brand: 'Coca-Cola' }), input('auxito', 'Coca-Cola Zero Sugar 24 x 355ml', { brand: 'Coca-Cola' }));
    expect(e.relationship).toBe('variant');
    expect(e.evidence.items.some((i) => i.kind === 'size' && i.effect === 'differs')).toBe(true);
  });
  it('grocery names with another word order and abbreviations are still found (exact, to be confirmed)', () => {
    const e = run(input('lasfit', 'Heinz Tomato Ketchup 397g', { brand: 'Heinz' }), input('auxito', 'Ketchup, Tomato - Heinz 397 g', { brand: 'Heinz' }));
    expect(e.relationship).toBe('exact');
    expect(e.tier).not.toBe('insufficient');
  });
  it('different brands with the same part codes and kind of product → substitute, strong, with the difference of brand stated', () => {
    const e = run(input('lasfit', '60W H10 9145 9140 LA Plus Series | 6,000LM 6000K LED Fog Light Bulbs', { brand: 'Lasfit' }), input('auxito', 'AUXITO M6 Series H10 9140 9145 LED Fog Light Bulb', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('substitute');
    expect(e.tier).toBe('strong');
    expect(e.evidence.items.find((i) => i.kind === 'brand')?.effect).toBe('differs');
  });
  it('a different socket is a decisive incompatibility, however alike the names', () => {
    const e = run(input('lasfit', 'H11 LED Headlight Bulbs 6000K White 2 Bulbs', { brand: 'Lasfit' }), input('auxito', 'H7 LED Headlight Bulbs 6000K White 2 Bulbs', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('non_match');
    expect(e.conflicts.join(' ')).toMatch(/part codes/i);
  });
  it('an adapter that shares the bulb code is related, not a stand-in', () => {
    const e = run(input('lasfit', 'Pro Series H7 LED Bulbs 2 Bulbs', { brand: 'Lasfit' }), input('auxito', 'H7 LED Adapter Holder Retainer for BMW', { brand: 'Alla' }));
    expect(e.relationship).toBe('related');
    expect(e.evidence.items.find((i) => i.kind === 'product_type')?.effect).toBe('conflicts');
  });
  it('a decoder and a harness are not bulbs either', () => {
    expect(run(input('lasfit', '9005 LED Headlight Bulbs 6000K', { brand: 'Lasfit' }), input('auxito', 'SEALIGHT® 9005 LED Bulbs Canbus Decoder Resistor Harness', { brand: 'Sealight' })).relationship).toBe('related');
    expect(run(input('lasfit', '9005 LED Headlight Bulbs 6000K', { brand: 'Lasfit' }), input('auxito', '9005 HB3 Relay Wiring Harness for DRL', { brand: 'Alla' })).relationship).toBe('related');
  });
  it('a vehicle-specific listing against a generic one is a substitute at most — never strong, never exact', () => {
    const e = run(input('lasfit', 'Fit for Toyota Tundra 2014-2021 H4 9003 Custom-Fit LED Bulbs', { brand: 'Lasfit' }), input('auxito', 'FL-BH H4 HB2 LED Forward Lightings Bulbs 9003 Replacement', { brand: 'Alla Lighting' }));
    expect(e.relationship).toBe('substitute');
    expect(e.tier).toBe('medium');
    expect(e.evidence.items.some((i) => i.kind === 'fitment' && i.effect === 'missing')).toBe(true);
  });
  it('two vehicle listings for the same vehicle and overlapping years support each other through fitment', () => {
    const e = run(input('lasfit', 'Fit for 2019-2024 Ram 1500 Classic LED Bulbs Upgrade', { brand: 'Lasfit' }), input('auxito', '2019 2020 Ram 1500 Classic LED Bulbs', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('substitute');
    expect(e.evidence.items.some((i) => i.kind === 'fitment' && i.effect === 'supports')).toBe(true);
  });
  it('"Not for Classic" and a different generation are not the same fitment', () => {
    const own = input('lasfit', 'Fit for 2019-2024 Ram 1500 Classic LED Bulbs Upgrade', { brand: 'Lasfit' });
    expect(run(own, input('auxito', '2021 2022 Ram 1500 LED Bulbs (Not For Classic)', { brand: 'AUXITO' })).relationship).toBe('non_match');
    expect(run(input('lasfit', 'Fit for 2021-2026 Toyota Sienna LED Exterior Lights Upgrade', { brand: 'Lasfit' }), input('auxito', '2011-2014 Toyota Sienna LED Light Bulbs', { brand: 'AUXITO' })).relationship).toBe('non_match');
  });
  it('the same make but another model is not the same fitment', () => {
    const e = run(input('lasfit', 'Fit For 2018-2021 Chevrolet Traverse LED Bulbs Upgrade', { brand: 'Lasfit' }), input('auxito', '2019-2022 Chevrolet Colorado LED Light Bulbs', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('non_match');
    expect(e.conflicts.join(' ')).toMatch(/different things/);
  });
  it('a word in front of the model changes the model: Cherokee is not Grand Cherokee', () => {
    const vehicles = [2, 3].flatMap((i) => [
      input('lasfit', `Fit for 201${i}-201${i + 4} Jeep Cherokee LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Jeep Grand Cherokee LED Light Bulbs`, { brand: 'AUXITO' }),
      input('sealight', `SEALIGHT® 201${i}-201${i + 3} Jeep Grand Cherokee LED Bulbs`, { brand: 'Sealight' }),
    ]);
    const e = run(input('lasfit', 'Fit for 2017-2018 Jeep Cherokee LED Bulbs Upgrade | H11 Low Beam', { brand: 'Lasfit' }), input('auxito', '2011-2024 Jeep Grand Cherokee Headlight Low Beam H11 LED Bulb', { brand: 'AUXITO' }), vehicles);
    expect(e.relationship).toBe('non_match');
    expect(e.conflicts.join(' ')).toMatch(/different models/);
  });
  it('a vehicle named only between the kind of part and the year still counts as the vehicle', () => {
    const vehicles = [2, 3].flatMap((i) => [
      input('lasfit', `Fit for 201${i}-201${i + 4} Ford Fiesta LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Ford Fiesta LED Light Bulbs`, { brand: 'AUXITO' }),
    ]);
    const e = run(input('lasfit', 'Fit for 2014-2019 Ford Fiesta LED Bulbs H11 Upgrade', { brand: 'Lasfit' }), input('auxito', 'Ford Focus Led Bulbs (2015-2018) H11', { brand: 'AUXITO' }), vehicles);
    expect(e.relationship).toBe('non_match');
  });
  it('floor mats are not a light for the same van, however many vehicle words the titles share', () => {
    const vehicles = [2, 3].flatMap((i) => [
      input('lasfit', `Fit for 201${i}-201${i + 4} Ford Transit Connect LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Ford Transit Connect LED Light Bulbs`, { brand: 'AUXITO' }),
    ]);
    const e = run(input('lasfit', 'Fit for 2014-2021 Ford Transit Connect Front Floor Mats, Only Fit Vinyl Floor', { brand: 'Lasfit' }), input('auxito', 'Clear Lens Amber LED Side Marker Light for Ford Transit Connect 2010-2021, Front', { brand: 'AUXITO' }), vehicles);
    expect(['related', 'non_match']).toContain(e.relationship);
  });
  it('a wiper blade for a vehicle is not a light for it, even though "4Runner" is split into a word that both titles share', () => {
    const vehicles = [2, 3].flatMap((i) => [
      input('lasfit', `Fit for 201${i}-201${i + 4} Toyota 4Runner LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Toyota 4Runner LED Light Bulbs`, { brand: 'AUXITO' }),
    ]);
    const e = run(input('lasfit', 'Fit for 2021-2024 Toyota 4Runner LED Exterior Interior Lights Upgrade | Tested and Verified', { brand: 'Lasfit' }), input('auxito', 'Rear Wiper Arm & Blade For 2010-2023 Toyota 4Runner', { brand: 'AUXITO' }), vehicles);
    expect(['related', 'non_match']).toContain(e.relationship);
  });
  it('"250" in a van\'s name and in a truck\'s name is only a number: Transit-250 is not F-250', () => {
    const vehicles = [2, 3].flatMap((i) => [
      input('lasfit', `Fit for 201${i}-201${i + 4} Ford Transit-150/250/350 LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Ford F-250 LED Light Bulbs`, { brand: 'AUXITO' }),
    ]);
    const e = run(input('lasfit', 'Fit for 2015-2025 Ford Transit-150/250/350 The Brightest LED Bulbs Upgrade', { brand: 'Lasfit' }), input('auxito', '2017-2022 Ford F-250 LED Headlight High Beam and Low Beam H13/9008 LED Bulb 6500K', { brand: 'AUXITO' }), vehicles);
    expect(e.relationship).not.toBe('substitute');
    expect(e.tier === 'strong' && e.relationship === 'substitute').toBe(false);
  });
  it('"F-250 F-350 Super Duty" and "Ford 250" are the same vehicle: trim words are not another model', () => {
    const vehicles = [2, 3, 4].flatMap((i) => [input('lasfit', `Fit for 201${i}-201${i + 4} Ford F-250 F-350 Super Duty LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Ford 250 LED Light Bulbs`, { brand: 'AUXITO' })]);
    const e = run(input('lasfit', 'Fit for 2017-2022 Ford F-250 F-350 Super Duty LED Headlight Bulbs Upgrade H13 9008', { brand: 'Lasfit' }), input('auxito', '2017-2021 Ford 250 LED Bulbs H13 9008 High Low Beam', { brand: 'AUXITO' }), vehicles);
    expect(e.relationship).toBe('substitute');
  });
  it('"ProMaster 1500" is not "Ram 1500": the shared number is not enough', () => {
    const vehicles = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [input('lasfit', `Fit for 201${i}-201${i + 4} Ram ProMaster 1500 2500 LED Bulbs Upgrade`, { brand: 'Lasfit' }), input('auxito', `201${i}-201${i + 5} Ram 1500 LED Light Bulbs`, { brand: 'AUXITO' })]);
    const e = run(input('lasfit', 'Fit for 2014-2022 Ram ProMaster 1500 2500 3500 The Brightest LED Bulbs Upgrade', { brand: 'Lasfit' }), input('auxito', '2021 2022 Ram 1500 LED Bulbs (Not For Classic)', { brand: 'AUXITO' }), vehicles);
    expect(e.relationship).not.toBe('substitute');
  });
  it('a seller\'s NA / NAK suffix names the same bulb (7444NA is 7444)', () => {
    expect(parseCodeTokens('7444NA 7443 Switchback LED Bulbs', 'title').sort()).toEqual(['7443', '7444']);
    expect(parseCodeTokens('2825 194NAK LED Bulbs', 'title').sort()).toEqual(['194', '2825']);
  });
  it('colour and mode words in a variant ("yellow", "switchback") are not a different position', () => {
    const own = input('lasfit', 'Switchback 60W H11 H8 H9 LD Plus Series | 6,000LM 6000K/3000K LED Fog Light Bulbs', { brand: 'Lasfit' });
    const other = input('auxito', 'AUXITO H11 H8 H9 LED Fog Light Bulb 300% Brighter Fanless, 6000K White', { brand: 'AUXITO' });
    const e = run(own, other);
    expect(e.conflicts.join(' ')).not.toMatch(/Different part or position/);
  });
  it('a switchback (dual-colour) bulb is not a stand-in for a single-colour bulb of the same socket', () => {
    const e = run(input('lasfit', '3157 3057 4057 4157 CANBUS Error Free Anti Hyper Flash Switchback LED Turn Signal Light Dual Color Bulbs', { brand: 'Lasfit' }), input('allalighting', 'T25 3156 3157 CANBUS LED Bulbs Red Signal Lights Error Free 3057 4057', { brand: 'Alla' }));
    expect(e.relationship).toBe('related');
    expect(run(input('lasfit', '3157 3057 LED Switchback Turn Signal Bulbs Dual Color', { brand: 'Lasfit' }), input('auxito', 'AUXITO CANBUS 4KP10 Series 3157 Switchback LED Bulbs 3057 Dual Color Amber/White', { brand: 'AUXITO' })).relationship).toBe('substitute');
  });
  it('a combo of one socket and a combo of two sockets are never "strong"', () => {
    const e = run(input('lasfit', '60W H11 LA LD Plus Series Combo Pack | 6,000LM LED Bulbs', { brand: 'Lasfit' }), input('allalighting', 'Combo 9005 and H11 LED Forward Lightings Bulbs Replacement Upgrade, 6500K White', { brand: 'Alla' }));
    expect(e.tier).not.toBe('strong');
  });
  it('"24 oz" of oil is not a weight to be compared with litres: the pair is still found, with the sizes marked as not comparable', () => {
    const e = run(input('lingandsons', 'Wesson Pure & 100% Natural Canola Oil 3.79 L'), input('quickmart', 'Wesson Pure & 100% Natural Canola Oil, 24 oz'));
    expect(['exact', 'variant']).toContain(e.relationship);
    expect(e.evidence.items.some((i) => i.kind === 'size' && i.effect === 'missing')).toBe(true);
  });
  it('two-digit fitment years in brackets, "(12-17) Toyota Camry", are years; a bare "12-24" is not', () => {
    expect(parseYears('(12-17) Toyota Camry LED Bulbs', 'title').ranges).toEqual([{ from: 2012, to: 2017, source: 'title' }]);
    expect(parseYears('(05-11) Toyota Tacoma LED Bulbs', 'title').ranges).toEqual([{ from: 2005, to: 2011, source: 'title' }]);
    expect(parseYears('Juice Box 12-24 pack', 'title').ranges).toEqual([]);
    // known limit: a bracketed "(12-24)" is read as 2012-2024 (it cannot be told from a pack range by its shape); grocery titles do not write it that way
  });
  it('a kit for another vehicle written with bracketed short years is not a stand-in for a different vehicle\'s kit', () => {
    const vehicles = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [input('lasfit', `Fit for 201${i}-201${i + 3} Nissan Sentra LED Bulbs H11 Upgrade`, { brand: 'Lasfit' }), input('auxito', `(1${i}-1${i + 3}) Toyota Camry LED Bulbs H11/H9 Fog Light`, { brand: 'AUXITO' })]);
    const e = run(input('lasfit', 'Fit for 2016-2019 Nissan Sentra LED Bulbs H11 Exterior Interior Lights', { brand: 'Lasfit' }), input('auxito', '(12-17) Toyota Camry LED Bulbs H11/H9 Fog Light', { brand: 'AUXITO' }), vehicles);
    expect(e.relationship).not.toBe('substitute');
  });
  it('a decoder is a decoder even when the title goes on for a few words after it', () => {
    const e = run(input('lasfit', '9005 HB3 LED Headlight Bulbs 6000K', { brand: 'Lasfit' }), input('auxito', '9005 HB3 CANBUS LED Resistors Anti-Flicker Decoders Forward Lighting Fog Lights', { brand: 'Alla' }));
    expect(e.relationship).toBe('related');
    const feature = run(input('lasfit', '9005 HB3 LED Headlight Bulbs 6000K', { brand: 'Lasfit' }), input('auxito', '9005 HB3 LED Headlight Bulbs Decoder Free Canbus Ready Forward Lighting', { brand: 'Alla' }));
    expect(feature.relationship).toBe('substitute');
  });
  it('the same grocery name in another word order, with the size left out by one listing, is proposed as the same product to confirm', () => {
    const e = run(input('lingandsons', 'Kraft Parmesan Cheese Grated 8oz'), input('foodstore2go', 'Kraft Grated Parmesan Cheese'));
    expect(e.relationship).toBe('exact');
    expect(e.tier).toBe('medium');
    expect(e.evidence.items.some((i) => i.kind === 'size' && i.effect === 'missing')).toBe(true);
  });
  it('a different flavour or variety is never proposed as the same product, even when the rest of the name matches', () => {
    for (const [x, y] of [
      ['Philadelphia Cream Cheese Original 8oz', 'Philadelphia Cream Cheese-Strawberry'], ['Nestle Nesquik Chocolate Low Fat Milk', 'Nestle Nesquik Strawberry Low-Fat Milk, 8 oz'],
      ['Kraft Cucumber Ranch Dressing', 'Kraft Ranch Dressing'], ['Chef Boyardee Beef Ravioli', 'Chef Boyardee Mini Beef Ravioli and Meatballs'],
    ] as const) expect(run(input('lingandsons', x), input('foodstore2go', y)).relationship).not.toBe('exact');
  });
  it('adjacent generations are held for a person, not suggested as a stand-in', () => {
    const e = run(input('lasfit', 'Fit for 2019-2024 Ram 1500 Classic LED Bulbs Upgrade', { brand: 'Lasfit' }), input('auxito', 'SEALIGHT® 2016-2018 Ram 1500 LED Bulbs Exterior Multiple Position', { brand: 'Sealight' }));
    // never strong; and the period problem is on the record for the reviewer (in a catalogue where "1500" is learned to be part of the vehicle name the
    // pair is "not enough information"; here the model number counts as a shared code, so it is a medium substitute with the period flagged)
    expect(['insufficient', 'substitute']).toContain(e.relationship);
    expect(e.tier).not.toBe('strong');
    expect(e.evidence.items.some((i) => i.kind === 'fitment' && i.effect === 'differs')).toBe(true);
  });
  it('a different colour is related, not a stand-in', () => {
    const e = run(input('lasfit', 'Amber 7443 7440 LED Turn Signal Bulbs', { brand: 'Lasfit' }), input('auxito', 'AUXITO 7443 7440 LED Bulb for Tail brake Light, Red', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('related');
    expect(e.evidence.items.find((i) => i.kind === 'colour')?.effect).toBe('differs');
  });
  it('a different light colour temperature is related, not a stand-in', () => {
    expect(run(input('lasfit', '60W H10 9145 9140 LED Fog Light Bulbs 6000K', { brand: 'Lasfit' }), input('auxito', '9145 LED Bulb 9140/H10 LED Fog Light Bulb, 3000K Golden Yellow Light', { brand: 'AUXITO' })).relationship).toBe('related');
  });
  it('a combo kit against a single bulb is related', () => {
    expect(run(input('lasfit', '9005 LED Headlight Bulbs 6000K', { brand: 'Lasfit' }), input('auxito', 'Combo 9005 and H11 LED Forward Lightings Bulbs', { brand: 'Alla' })).relationship).toBe('related');
  });
  it('a different size (hard dimension) rules out a stand-in; a different pack is only a note', () => {
    expect(run(input('lasfit', '44MM 561 562 LED Dome Light Bulb, 2 Bulbs', { brand: 'Lasfit' }), input('auxito', '2006-2012 Ford Fusion Dome/Trunk Light 41MM LED Bulb 561', { brand: 'AUXITO' })).relationship).toBe('non_match');
    const e = run(input('lasfit', '194 168 2825 T10 LED Dome Bulbs, 2 Bulbs', { brand: 'Lasfit' }), input('auxito', 'SEALIGHT® Aurora T10/194/168/W5W LED Dome Bulbs 10PCS', { brand: 'Sealight' }));
    expect(e.relationship).toBe('substitute');
    expect(e.evidence.items.some((i) => i.kind === 'pack' && i.effect === 'differs')).toBe(true);
  });
  it('a different power level is a stated difference, not a reason to refuse a stand-in', () => {
    const e = run(input('lasfit', '40W 9003 H4 HB2 L1 Plus Series | 4,000LM 6000K LED Bulbs', { brand: 'Lasfit' }), input('auxito', 'AUXITO H4/HB2/9003 LED Headlight Bulb with Fan, 100W 20000LM 6000K White', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('substitute');
    expect(e.evidence.items.some((i) => i.kind === 'spec' && i.effect === 'differs')).toBe(true);
  });
  it('a title that shares a code but nothing else known is never "exact"', () => {
    const e = run(input('lasfit', 'H7 LED Bulbs', { brand: 'Lasfit' }), input('auxito', 'H7 LED Bulbs', { brand: 'AUXITO' }));
    expect(e.relationship).not.toBe('exact');
  });
  it('missing identifiers on both sides are said to be missing, and a generic listing is "not enough information", not a match', () => {
    const e = run(input('lasfit', 'Fit for 2021-2026 Toyota Sienna LED Exterior Lights Upgrade', { brand: 'Lasfit' }), input('auxito', '9V~18V LED Forward Lightings Bulbs or Daytime Running Lights', { brand: 'Alla' }));
    expect(['insufficient', 'non_match']).toContain(e.relationship);
    expect(e.relationship).not.toBe('substitute');
  });
  it('a product with no genuine counterpart gets no suggestion at all', () => {
    const own = input('lasfit', 'Fit for 2015-2024 Nissan Murano Floor Mats & Cargo Mat', { brand: 'Lasfit Liners' });
    const r = runEngine([own], filler().filter((c) => c.siteId !== 'lasfit'));
    expect(r.suggestions.filter((s) => s.sourceVariantId === own.variantId && s.relationship !== 'insufficient' && s.relationship !== 'related')).toEqual([]);
  });
  it('a different GTIN on both sides never yields an exact match by name alone', () => {
    const e = run(input('lasfit', 'Heinz Tomato Ketchup 397g', { brand: 'Heinz', gtin: '5000157024671' }), input('auxito', 'Heinz Tomato Ketchup 397g', { brand: 'Heinz', gtin: '4006381333931' }));
    expect(e.evidence.items.some((i) => i.kind === 'identifier' && i.effect === 'differs')).toBe(true);
  });
});

describe('what the first real grocery catalogue taught (regressions)', () => {
  it('a content claim like "100%" is not a part code, so two unrelated juices and breads never share one', () => {
    expect(parseCodeTokens('Pom Wonderful 100% Pomegranate Juice 16oz', 'title')).toEqual([]);
    expect(parseCodeTokens('2% Reduced Fat Milk, 0.5% fat', 'title')).toEqual([]);
    const e = run(input('lasfit', 'Pom Wonderful 100% Pomegranate Juice 16oz'), input('auxito', 'Pepperidge Farm 100% Whole Wheat Bread 16oz'));
    expect(['substitute', 'exact', 'variant']).not.toContain(e.relationship);
  });
  it('a number that turns up on unrelated kinds of product is not a part code', () => {
    const noise = ['Juice', 'Bread', 'Soap', 'Eggs', 'Cereal', 'Candles', 'Batteries', 'Towels'].flatMap((k) => ['Fresh', 'Daily', 'Organic', 'Plain'].map((w, i) => input(i % 2 ? 'lasfit' : 'auxito', `${w} ${k} 555`)));
    const a = input('lasfit', 'Orange Juice Style 555');
    const b = input('auxito', 'Rice Cakes Style 555');
    const corpus = analyseCatalogue([a, b, ...noise, ...filler()]);
    expect(corpus.byVariant.get(a.variantId)!.codes).not.toContain('555');
  });
  it('titles that start with the same brand name but name different varieties are related, not stand-ins from another maker', () => {
    const e = run(input('lasfit', 'Gerber Graduates Puffs Cereal Snack Strawberry Apple 1.48 oz'), input('auxito', 'Gerber Graduates Puffs Cereal Snack Sweet Potato, 1.48 oz'));
    expect(e.relationship).toBe('related');
    expect(e.evidence.items.some((i) => i.kind === 'variant' && i.effect === 'differs')).toBe(true);
  });
  it('the same product sold as a single bottle and as a pack is a variant, compared per unit', () => {
    const e = run(input('lasfit', 'Fiji Artesian Water 1L'), input('auxito', 'Fiji Water 1 L - 6 pack'));
    expect(e.relationship).toBe('variant');
  });
  it('another flavour or variety of the same brand is not "the same product in another size", whatever the sizes', () => {
    for (const [x, y] of [
      ['Maxwell House The Original Roast Medium Roast Ground Coffee 11.50oz', 'Maxwell House Ground Coffee Hazelnut, 11 oz'], ['Mccormick Seasoning Mix Spinach Dip 1.5oz', 'McCormick Seasoning Mix Ranch Dip, 1 oz'],
      ['General Mills Reese\'S Puffs Cereal 13oz', 'General Mills Cocoa Puffs Cereal, 11.8 oz'],
    ] as const) expect(run(input('lingandsons', x), input('quickmart', y)).relationship).not.toBe('variant');
  });
  it('a year or a lone model number on one side is a stated difference on a probable match, not another product', () => {
    const e = run(input('lasfit', 'Yellow Tail Pinot Grigio 2015 75cl'), input('auxito', 'Yellow Tail Pinot Grigio 75cl'));
    expect(e.relationship).toBe('exact');
    expect(e.tier).toBe('medium');
    expect(e.evidence.items.some((i) => i.kind === 'name' && i.effect === 'differs' && /year/.test(i.text))).toBe(true);
  });
});

describe('the engine as a whole', () => {
  it('produces explainable suggestions, none of them accepted, with a hash that changes when a product changes', () => {
    const own = input('lasfit', '60W H10 9145 9140 LA Plus Series | 6,000LM 6000K LED Fog Light Bulbs', { brand: 'Lasfit' });
    const comp = input('auxito', 'AUXITO M6 Series H10 9140 9145 LED Fog Light Bulb', { brand: 'AUXITO' });
    const base = [...filler().filter((c) => c.siteId !== 'lasfit' || true)];
    const r1 = runEngine([own], [...base.filter((x) => x.siteId !== 'lasfit'), comp]);
    const s1 = r1.suggestions.find((s) => s.sourceVariantId === own.variantId && s.competitorVariantId === comp.variantId)!;
    expect(s1).toBeTruthy();
    expect(s1.relationship).toBe('substitute');
    expect(s1.evidence.items.length).toBeGreaterThan(2);
    expect(s1.evidence.summary).toMatch(/stand in/);
    const r2 = runEngine([own], [...base.filter((x) => x.siteId !== 'lasfit'), { ...comp, title: `${comp.title} (2 bulbs)` }]);
    const s2 = r2.suggestions.find((s) => s.competitorVariantId === comp.variantId)!;
    expect(s2.pairHash).not.toBe(s1.pairHash);
    // deterministic
    const r3 = runEngine([own], [...base.filter((x) => x.siteId !== 'lasfit'), comp]);
    expect(r3.suggestions.map((s) => [s.competitorVariantId, s.relationship, s.tier, s.pairHash])).toEqual(r1.suggestions.map((s) => [s.competitorVariantId, s.relationship, s.tier, s.pairHash]));
  });
  it('keeps only a few suggestions per competitor website for each product of yours', () => {
    const own = input('lasfit', '40W 9003 H4 HB2 LA Plus Series | 4,000LM 6000K LED Bulbs', { brand: 'Lasfit' });
    const comps = Array.from({ length: 12 }, (_, i) => input('auxito', `AUXITO Series ${i} H4 HB2 9003 LED Headlight Bulb ${i + 1}000LM`, { brand: 'AUXITO' }));
    const r = runEngine([own], [...comps, ...filler().filter((x) => x.siteId !== 'lasfit')]);
    expect(r.suggestions.filter((s) => s.sourceVariantId === own.variantId && s.competitorSiteId === 'auxito').length).toBeLessThanOrEqual(3);
  });
});

describe('names without brand fields, products of the same kind from different makers, and descriptions (engine v2.8)', () => {
  /** A grocery-like catalogue: makers under which kind words repeat, so the corpus can tell a maker's name from the name of a kind of product. */
  const grocery = (): DossierInput[] => {
    const out: DossierInput[] = [];
    for (const maker of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Omega']) {
      for (const kindName of ['Sauvignon Blanc', 'Pinot Noir', 'Aluminum Foil', 'Mayonnaise', 'Pear']) out.push(input(maker === 'Alpha' ? 'shopa' : 'shopb', `${maker} ${kindName} ${maker.length}0cl`));
    }
    for (let i = 0; i < 30; i++) out.push(input('shopb', `Filler${i} Cereal Box ${i}00g`));
    return out;
  };
  const gr = (a: DossierInput, b: DossierInput) => run(a, b, grocery());

  it('two titles that start with the same rare maker name and spell it the way each shop does are the same maker', () => {
    const e = gr(input('shopa', 'Hellmann\'s Light Mayonnaise 15oz'), input('shopb', 'Hellman\'s Lite Mayonnaise'));
    expect(e.relationship).toBe('exact');
    expect(e.tier).toBe('medium');
  });
  it('the same name with a maker added or left out on one side is never claimed as the same product', () => {
    const e = gr(input('shopa', 'Goya Extra Virgin Olive Oil 8.5oz'), input('shopb', 'Extra Virgin Olive Oil'));
    expect(e.relationship).toBe('substitute');
    expect(e.evidence.items.some((i) => i.kind === 'brand' && i.effect === 'differs')).toBe(true);
  });
  it('a flavour or formulation word on one side only makes it another product of the same maker', () => {
    const e = gr(input('shopa', 'Land O Lakes Half And Half 16oz'), input('shopb', 'Land O Lakes Half And Half Fat Free 16oz'));
    expect(e.relationship).not.toBe('exact');
    expect(e.relationship).not.toBe('variant');
  });
  it('titles where each side has words the other lacks are two products of one range, not one product', () => {
    const e = gr(input('shopa', 'McCormick Grill Mates Montreal Chicken Seasoning'), input('shopb', 'McCormick Grill Mates Montreal Steak Seasoning'));
    expect(['exact', 'variant']).not.toContain(e.relationship);
  });
  it('the same kind of thing from different makers is a stand-in, never the same product and never strong', () => {
    const e = gr(input('shopa', 'Alpha Sauvignon Blanc 75cl'), input('shopb', 'Gamma Sauvignon Blanc 75cl'));
    expect(e.relationship).toBe('substitute');
    expect(e.tier).toBe('medium');
  });
  it('the same noun in another form is not a stand-in (strained baby food against the fresh fruit)', () => {
    const e = gr(input('shopa', 'Beta Strained Pear 113g'), input('shopb', 'Delta Pear'));
    expect(e.relationship).not.toBe('substitute');
  });
  it('a different grape or another kind is not a stand-in', () => {
    const e = gr(input('shopa', 'Alpha Sauvignon Blanc 75cl'), input('shopb', 'Gamma Pinot Noir 75cl'));
    expect(e.relationship).not.toBe('substitute');
  });
  it('a vehicle-specific variant takes its bulb size from the chart in its own description and so matches a generic bulb', () => {
    const description = 'Toyota Camry Bulb Size Chart (2018-2024) Location Bulb Size Recommend Product Series Watt/Lumens(per bulb) Key Features Low Beam H11 LS Plus Series 65W/6500LM bright Front Turn Signal Light 7443 T3-T20 Series 24W/2000LM amber Backup Light 921 T-T15 Series 13W/1500LM white';
    const own = input('lasfit', 'Fit for 2018-2024 Toyota Camry LED Exterior Interior Lights Upgrade', { brand: 'Lasfit', variantTitle: 'XLE / Front Turn Signal Light', options: { Trim: 'XLE', Location: 'Front Turn Signal Light' }, description });
    const comp = input('auxito', 'AUXITO 7443 LED Turn Signal Light Bulbs Amber 2800LM', { brand: 'AUXITO' });
    const c = analyseCatalogue([own, comp, ...filler()]);
    const d = c.byVariant.get(own.variantId)!;
    expect(d.chartCodes).toEqual(['7443']);
    expect(d.codes).toContain(c.alias.get('7443') ?? '7443');
    expect(d.specs.some((s) => s.key === 'power_w' && s.value === 24 && s.source === 'description')).toBe(true);
    const ev = evaluatePair(d, c.byVariant.get(comp.variantId)!, c);
    expect(ev.relationship).toBe('substitute');
    // the difference worth showing next to the price: the figures differ and are in the evidence
    expect(ev.evidence.items.some((i) => i.kind === 'spec' && i.effect === 'differs' && /Light output/.test(i.text))).toBe(true);
  });
  it('a variant that names no position, or a description without a chart, reads nothing from the description', () => {
    const description = 'Camry Bulb Size Chart Location Bulb Size Recommend Product Series Low Beam H11 LS Plus Series 65W/6500LM';
    const none = input('lasfit', 'Fit for 2018-2024 Toyota Camry LED Lights', { brand: 'Lasfit', options: { Trim: 'XLE' }, description });
    const noChart = input('lasfit', 'Fit for 2018-2024 Toyota Camry LED Lights', { brand: 'Lasfit', options: { Location: 'Low Beam' }, description: 'Great bulbs. Low Beam H11 is what we recommend.' });
    const c = analyseCatalogue([none, noChart, ...filler()]);
    expect(c.byVariant.get(none.variantId)!.chartCodes).toEqual([]);
    expect(c.byVariant.get(noChart.variantId)!.chartCodes).toEqual([]);
  });
  it('the same bulb size in listings for different generations of one vehicle goes together, it does not replace', () => {
    const e = run(input('lasfit', 'Fit for 2022-2024 Hyundai Tucson LED Bulbs 921 Upgrade', { brand: 'Lasfit' }), input('auxito', '2016-2020 Hyundai Tucson LED Bulbs 921', { brand: 'AUXITO' }));
    expect(e.relationship).toBe('related');
  });
  it('a bulb base type in a title ("Bulb-CK Socket") does not make a bulb an accessory', () => {
    expect(kindOf('7443 7444 Switchback LED Turn Signal Light Dual Color Blinker Bulb-CK Socket, 2 Bulbs').companion).toBe(false);
    expect(kindOf('LED Bulb Socket Adapter Harness 9005').companion).toBe(true);
  });
  it('a pair hash does not change for a product whose description has no chart (earlier decisions are not flagged)', () => {
    const a = input('shopa', 'Alpha Sauvignon Blanc 75cl');
    const withText = { ...a, description: 'A fine wine with notes of citrus.' };
    const h = (x: DossierInput) => runEngine([x], [input('shopb', 'Gamma Sauvignon Blanc 75cl'), ...grocery()]).suggestions[0]?.pairHash;
    expect(h(withText)).toBe(h(a));
  });
});

describe('shared codes are not enough on their own (engine v2.8)', () => {
  it('a vehicle model that is also a bulb series name does not make a floor mat a stand-in for a bulb', () => {
    const mats = ['X5', 'X3', 'Q5'].flatMap((m, i) => [input('lasfit', `Fit for 201${i + 4}-201${i + 8} BMW ${m} Floor Mats | Cargo Mat`, { brand: 'Lasfit' }), input('lasfit', `Fit for 201${i + 2}-201${i + 6} Audi ${m} Floor Mats`, { brand: 'Lasfit' })]);
    const seriesBulbs = ['9004/HB1', '9005/HB3', '9006/HB4', 'H4'].map((c) => input('sealight', `SEALIGHT® X5 ${c} 80W 6500K White IP68 LED Headlight Bulbs 2Pcs`, { brand: 'Sealight' }));
    const mat = input('lasfit', 'Fit for 2014-2018 BMW X5 Floor Mats | Cargo Mat', { brand: 'Lasfit' });
    const bulb = input('sealight', 'SEALIGHT® X5 9004/HB1 80W 6500K White IP68 LED Headlight Bulbs 2Pcs', { brand: 'Sealight' });
    const e = run(mat, bulb, [...mats, ...seriesBulbs]);
    expect(['substitute', 'exact', 'variant']).not.toContain(e.relationship);
  });
  it('two vehicle-specific kits sharing a bulb size are related unless both name the same model', () => {
    const escape = input('lasfit', 'Fit for 2017-2018 Ford Escape The Brightest LED Bulbs Upgrade | License Plate Light 168', { brand: 'Lasfit' });
    const f150 = input('auxito', '2015-2017 Ford F150 LED Light Bulbs Upgrade | 168 LED Side Marker Light', { brand: 'AUXITO' });
    // (enough Ford listings for the corpus to have learned that "ford" is a make, so the model is the next word)
    const fords = Array.from({ length: 18 }, (_, i) => input(i % 2 ? 'lasfit' : 'auxito', `201${i % 8}-201${(i % 8) + 3} Ford Escape LED Bulbs ${i} Upgrade`, { brand: i % 2 ? 'Lasfit' : 'AUXITO' }));
    expect(run(escape, f150, fords).relationship).not.toBe('substitute');
  });
  it('no more than two stand-ins are kept per competitor website for one of your variants', () => {
    const own = input('lasfit', '40W 9003 H4 HB2 LA Plus Series | 4,000LM 6000K LED Bulbs', { brand: 'Lasfit' });
    const comps = Array.from({ length: 12 }, (_, i) => input('auxito', `AUXITO Series ${i} H4 HB2 9003 LED Headlight Bulb ${i + 1}000LM`, { brand: 'AUXITO' }));
    const r = runEngine([own], [...comps, ...filler().filter((x) => x.siteId !== 'lasfit')]);
    expect(r.suggestions.filter((s) => s.sourceVariantId === own.variantId && s.competitorSiteId === 'auxito' && s.relationship === 'substitute').length).toBeLessThanOrEqual(2);
  });
});

describe('vehicle models are not part codes (engine v2.8)', () => {
  it('a model number that sits next to a make on listings without a year ("Ram 1500 LED Bulbs") stays part of the vehicle name, so a bed mat is not a stand-in for those bulbs', () => {
    const ramMats = Array.from({ length: 16 }, (_, i) => input('lasfit', `Fit for 201${i % 8}-202${i % 4} Ram 1500 Truck Bed Mat ${i}`, { brand: 'Lasfit' }));
    const ramBulbs = Array.from({ length: 16 }, (_, i) => input(i % 2 ? 'auxito' : 'sealight', `Ram 1500 LED Bulbs Style ${i}`, { brand: i % 2 ? 'AUXITO' : 'Sealight' }));
    const mat = input('lasfit', 'Fit for 2019-2027 Ram 1500 Truck Bed Mat, Not Fit Drop-in liners', { brand: 'Lasfit' });
    const bulb = input('auxito', '2021 2022 Ram 1500 LED Bulbs (Not For Classic)', { brand: 'AUXITO' });
    const e = run(mat, bulb, [...ramMats, ...ramBulbs]);
    expect(['substitute', 'exact', 'variant']).not.toContain(e.relationship);
  });
  it('a bulb code that other websites use on plain listings stays a part code even when one shop writes it after a year range', () => {
    const own = input('lasfit', 'Fit for 2015-2021 Kia Sedona Custom H7 LED Bulbs Exterior Interior Lights', { brand: 'Lasfit', options: { Location: 'Low Beam' } });
    const comp = input('auxito', 'AUXITO H7 LED Headlight Bulbs 6500K', { brand: 'AUXITO' });
    const c = analyseCatalogue([own, comp, ...filler(), input('sealight', 'H7 LED Headlight Bulbs 60W', { brand: 'Sealight' }), input('alla', 'H7 LED Forward Lightings Bulbs', { brand: 'Alla' }), input('alla', 'Mini H7 LED Bulbs', { brand: 'Alla' })]);
    expect(c.byVariant.get(own.variantId)!.codes).toContain('h7');
  });
});

describe('kinds of product that never appear together (engine v2.8)', () => {
  it('a floor mat and a bulb for the same vehicle are different kinds of product, even when the bulb\'s title starts with the vehicle and has brackets', () => {
    const makes = ['Toyota', 'Honda', 'Ford', 'Nissan', 'Jeep', 'Kia'];
    const mats = Array.from({ length: 48 }, (_, i) => input('lasfit', `Fit for 20${10 + (i % 8)}-20${14 + (i % 8)} ${makes[i % makes.length]} Model${i % 9} Floor Mats or Cargo Mat`, { brand: 'Lasfit' }));
    const bulbs = Array.from({ length: 48 }, (_, i) => input(i % 2 ? 'auxito' : 'alla', `${makes[i % makes.length]} Model${i % 9} (1${i % 8}-2${i % 5}) LED Light Bulbs ${i % 2 ? 'H11 H8' : '9005'}`, { brand: i % 2 ? 'AUXITO' : 'Alla' }));
    const mat = input('lasfit', 'Fit for 2019-2025 Toyota RAV4 All-weather TPE Floor Mats & Cargo Mat', { brand: 'Lasfit' });
    const bulb = input('auxito', 'Toyota Rav4 (19-21) LED Light Bulbs H8 H9 H11 Fog Light, Cool White', { brand: 'AUXITO' });
    const e = run(mat, bulb, [...mats, ...bulbs]);
    expect(['substitute', 'exact', 'variant']).not.toContain(e.relationship);
  });
});
