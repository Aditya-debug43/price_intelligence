import { describe, expect, it } from 'vitest';
import { INCOMPARABLE_BUNDLE_CONTENT_MISMATCH } from '@ci/shared';
import { assessBundles, readBundle } from './bundle.ts';
import { plain } from './dossier.ts';

/** What the matcher reads: the product title and the variant's own option values, normalised the way every title is. */
const read = (title: string, options: Record<string, string> = {}, hasCode = true) =>
  readBundle({ title: plain(title), variantText: plain(Object.values(options).join(' | ')), hasCode });
const codes = (a: string[] = [], b: string[] = []) => ({ a, b, shared: a.filter((x) => b.includes(x)) });
const check = (a: ReturnType<typeof read>, b: ReturnType<typeof read>, c = codes()) => assessBundles(a, b, c);

describe('reading what a bundle contains', () => {
  it('reads lamp positions from a title, whatever the wording', () => {
    expect(read('Headlight + brake light combo').parts.map((p) => p.id)).toEqual(['headlight', 'brake']);
    expect(read('Combo: Head Lamp and Brake Lamp').parts.map((p) => p.id).sort()).toEqual(['brake', 'headlight']);
    expect(read('SEALIGHT 2014 Chevrolet Silverado LED Bulbs 9005+H11 Headlight 5202 Fog Turn Signal Brake Lights Combo').parts.map((p) => p.id).sort()).toEqual(['brake', 'fog', 'headlight', 'turn']);
    expect(read('SEALIGHT Essential Tail & Backup Light Combo: 3157 & T15/921 LED Light Bulbs 4pcs').parts.map((p) => p.id).sort()).toEqual(['backup', 'tail']);
  });

  it('reads counts written before or after a component', () => {
    expect(read('Headlight + 2 indicator lights combo').parts.find((p) => p.id === 'turn')?.count).toBe(2);
    expect(read('Headlight + 1 indicator light combo').parts.find((p) => p.id === 'turn')?.count).toBe(1);
    expect(read('', { Location: 'Inner Tail Light(4PCS)' }).parts[0]).toMatchObject({ id: 'tail', count: 4 });
  });

  it('a bulb code is not a count', () => {
    const counts = (t: string) => read(t).parts.map((p) => [p.id, p.count]);
    expect(counts('H11 Headlight + Fog Light Combo')).toEqual([['headlight', null], ['fog', null]]);
    expect(counts('9005 Headlight + 5202 Fog Light Combo')).toEqual([['headlight', null], ['fog', null]]);
    expect(counts('T10 Tail Light + 3157 Brake Light Combo')).toEqual([['brake', null], ['tail', null]]);
    // a real count next to a code still counts
    expect(counts('H11 Headlight + 2 Fog Light Combo')).toEqual([['headlight', null], ['fog', 2]]);
    expect(counts('Combo: 2pcs Headlight + Fog Light')).toEqual([['headlight', 2], ['fog', null]]);
    // a count separated from its component by a code is not guessed at: not stated is "not established", never a number made up
    expect(counts('Combo: 2pcs H11 Headlight + Fog Light')).toEqual([['headlight', null], ['fog', null]]);
  });

  it('words that are not bundles in the shops’ own listings: a rate, a trim, a conversion kit, a beam pattern', () => {
    // "per set" and "lm/set" are rates
    expect(read('9145/9140/H10 LED Fog Light Bulb Fanless, 6000LM Per Set, CSP LED Chips').bundle).toBe(false);
    expect(read('2015-2017 Ford F150 LED Light Bulbs Upgrade', { Option: 'H11 LED Headlight Bulbs Low Beam, 16000lm/set' }).bundle).toBe(false);
    // "Eyesight Package" is a vehicle trim; "Combo Package" and "Whole Package" are bundles
    const trim = read('Fit for 2012-2017 Subaru Crosstrek LED Bulbs Upgrade', { Trim: 'Premium/Limited(With Eyesight Package)', Position: 'Low Beam' });
    expect(trim).toMatchObject({ bundle: false, single: true });
    expect(read('Fit for 2012-2017 Subaru Crosstrek LED Bulbs Upgrade', { Trim: 'Premium', Position: 'Combo Package' }).bundle).toBe(true);
    expect(read('Ford Explorer Led Bulbs (2016-2019)', { Option: 'Whole Package(not include Fog Light)' })).toMatchObject({ bundle: true, without: ['fog'] });
    // "Conversion Kit" is how an LED bulb pair is called
    expect(read('Brightest H11 LED Forward Lightings Conversion Kit Bulbs H8 H9, White').bundle).toBe(false);
    // a flood / spot "combo" is a beam pattern
    expect(read('3 Inch LED Pod Off-Road Light Fog Spot Flood Combo Driving Beam 36W').bundle).toBe(false);
  });

  it('a plus sign joins two items only where a component stands on each side', () => {
    // trims: "SLT+", "SXT Plus/Limited", "LE Plus"
    expect(read('Fit for 2023-2025 Ram ProMaster LED Bulbs', { Trim: 'SLT/SLT+', Position: 'Rear Side Marker Light' })).toMatchObject({ bundle: false, single: true });
    expect(read('Fit for 2011-2020 Dodge Journey LED Bulbs', { Trim: 'SXT/SXT Plus/Limited', Position: 'Backup Light' }).bundle).toBe(false);
    // a colour option
    expect(read('LED Third 3rd Brake Light for 09-18 Dodge Ram 1500 (Black+ Smoke Lens)').bundle).toBe(false);
    // real ones
    expect(read('Fit for 2015-2022 Chevrolet Colorado LED Bulbs', { Trim: 'Z71', Position: 'Low Beam+High Beam' }).bundle).toBe(true);
    expect(read('52 Inch Off-Road LED Light Bars', { Option: '52 Light Bar + Wiring Harness' })).toMatchObject({ bundle: true });
    expect(read('Fit for 2015-2018 Nissan Murano LED bulbs', { Position: 'License Plate+Front Side Marker Lights' }).parts.map((p) => p.id).sort()).toEqual(['license', 'marker']);
  });

  it('reads a variant’s own option before the title', () => {
    const single = read('Fit for 2015-2017 Ford F-150 LED Bulbs | Full Exterior & Interior LED Upgrade', { Location: 'Low Beam' });
    expect(single).toMatchObject({ bundle: false, single: true, basis: 'variant' });
    const combo = read('Fit for 2015-2017 Ford F-150 LED Bulbs', { Location: 'Headlight Combo' });
    expect(combo).toMatchObject({ bundle: true, basis: 'variant' });
  });

  it('a list of positions in a vehicle-specific title is what the product can be used for, not what is in the box', () => {
    const t = read('Fit for 2015 Ford F-150 LED Bulbs Headlight Fog Turn Signal Lights H11 9005');
    expect(t.bundle).toBe(false);
    expect(t.single).toBe(false);
    expect(t.parts).toEqual([]);
  });

  it('a negation covers the list that follows it, and stops where another option begins', () => {
    const ex = read('Fit for 2021-2023 Hyundai Santa Fe 1157 1156 921 LED Exterior Interior Lights', { Trim: 'SE/SEL/XRT', Package: 'Combo Package(Excludes Rear Turn Signal/Brake/Tail Light)' });
    expect(ex.without.sort()).toEqual(['brake', 'tail', 'turn']);
    expect(ex.parts).toEqual([]);
    expect(read('Fit for 2010-2015 Chevrolet Equinox LED Bulbs', { Package: 'Combo Package (Not Include Rear Turn Signal+Brake+Tail Light)' }).without.sort()).toEqual(['brake', 'tail', 'turn']);
    // another option, or a positive word, ends it: the truck has no fog light (its trim), the package holds the rear lights
    const tacoma = read('Fit for 2016-2023 Toyota Tacoma LED Bulbs', { Fog: 'Without Halogen Fog Light', Package: 'Backup+Rear Turn Signal/Brake/Tail Light' });
    expect(tacoma.without).toEqual(['fog']);
    expect(tacoma.parts.map((p) => p.id).sort()).toEqual(['backup', 'brake', 'tail', 'turn']);
    expect(read('Combo Package(Without Fog Light, With Backup Light)').parts.map((p) => p.id)).toEqual(['backup']);
  });

  it('a negation is a component left out, not one included', () => {
    const k = read('', { Location: 'All-in-One Lighting Kit (W/o Fog Lights)' });
    expect(k).toMatchObject({ bundle: true, without: ['fog'] });
    expect(k.parts.map((p) => p.id)).not.toContain('fog');
  });

  it('colour and other ordinary options are not components', () => {
    const c = read('Headlight + brake light combo', { Color: 'Red', Tier: 'Premium', 'Does your vehicle come with fog lights?': 'No' });
    expect(c.parts.map((p) => p.id)).toEqual(['headlight', 'brake']);
    expect(c.without).toEqual([]);
  });

  it('accessories count only where the listing says they are included', () => {
    expect(read('Headlight + wiring harness kit').parts.map((p) => p.id)).toEqual(['headlight', 'harness']);
    // a feature of the bulb, or an accessory sold on its own, is not a component of a bundle
    expect(read('H7 LED Headlight Bulbs Canbus Decoder Free, Built-in Resistor').parts.map((p) => p.id)).toEqual(['headlight']);
    expect(read('', { Location: 'Harness Only' }).parts.map((p) => p.id)).toEqual(['harness']);
  });
});

describe('comparing two bundles', () => {
  it('1. the same contents, worded differently: verified equivalent', () => {
    const r = check(read('Headlight + brake light combo'), read('Combo: Brake Lamp and Head Lamp'))!;
    expect(r.verdict).toBe('equivalent');
    expect(r.exclusion).toBeNull();
  });

  it('2. the competitor’s bundle has one extra component: incomparable, and the evidence says which', () => {
    const r = check(read('Headlight + brake light combo'), read('Headlight + brake light + indicator lights combo'))!;
    expect(r).toMatchObject({ verdict: 'mismatch', exclusion: INCOMPARABLE_BUNDLE_CONTENT_MISMATCH });
    expect(r.onlyB).toEqual(['turn signal']);
    expect(r.onlyA).toEqual([]);
    expect(r.note).toMatch(/competitor’s includes turn signal that yours does not/);
    expect(r.a.items).toEqual(['headlight', 'brake light']);
    expect([...r.b.items].sort()).toEqual(['brake light', 'headlight', 'turn signal']);
  });

  it('3. the competitor’s bundle is missing a component: incomparable', () => {
    const r = check(read('Headlight + brake light + indicator lights combo'), read('Headlight + brake light combo'))!;
    expect(r).toMatchObject({ verdict: 'mismatch' });
    expect(r.onlyA).toEqual(['turn signal']);
  });

  it('4. the same main product with different accessories: incomparable', () => {
    const r = check(read('Headlight + brake light combo'), read('Headlight Bulbs + Wiring Harness + Canbus Decoder Kit'))!;
    expect(r.verdict).toBe('mismatch');
    expect(r.onlyB).toEqual(expect.arrayContaining(['wiring harness', 'canbus decoder']));
    expect(r.onlyA).toEqual(['brake light']);
  });

  it('5. the same vehicle fit does not make different contents the same', () => {
    const fit = 'Fit for 2015-2020 Ford F-150';
    const r = check(read(`${fit} LED Bulbs Headlight + Fog Combo`), read(`${fit} LED Bulbs Headlight + Fog + Turn Signal + Brake Lights Combo`))!;
    expect(r.verdict).toBe('mismatch');
    expect(r.onlyB).toEqual(['turn signal', 'brake light']);
  });

  it('6. one is a single item, the other a combo: incomparable', () => {
    const single = read('Fit for 2015-2017 Ford F-150 LED Bulbs', { Location: 'Low Beam' });
    const combo = read('SEALIGHT 2015-2020 Ford F-150 LED Bulbs 9005+H11 Headlight Turn Signal Brake Lights Combo');
    const r = check(single, combo)!;
    expect(r.verdict).toBe('mismatch');
    expect(r.onlyB).toEqual(['turn signal', 'brake light']);
    expect(r.note).toMatch(/competitor’s bundle holds/);
    // the other way round, the same
    expect(check(combo, single)!.verdict).toBe('mismatch');
    // a headlight on its own against headlight + brake light
    expect(check(read('H11 LED Headlight Bulbs'), read('Headlight + brake light combo'))!.verdict).toBe('mismatch');
  });

  it('7. contents that cannot be established are unknown, never assumed equal', () => {
    const kit = read('Fit for 2015-2017 Ford F-150 LED Bulbs', { Location: 'All-in-One Lighting Kit' });
    const named = read('SEALIGHT 2015-2020 Ford F-150 LED Bulbs 9005+H11 Headlight Turn Signal Brake Lights Combo');
    const r = check(kit, named)!;
    expect(r.verdict).toBe('unknown');
    expect(r.exclusion).toBeNull();
    // two combos that name no more than one position each are not established as the same; a headlight combo against a fog-light combo is plainly different
    expect(check(read('LED Headlight Bulbs Combo Pack'), read('LED Headlight Bulbs Combo Kit'))!.verdict).toBe('unknown');
    expect(check(read('LED Headlight Bulbs Combo Pack'), read('Fog Light Combo Kit'))!.verdict).toBe('mismatch');
    // a combo against a listing whose own contents are not stated
    expect(check(read('Fit for 2014 Mazda Mazda3 LED Bulbs H11 Exterior Interior Lights'), named)!.verdict).toBe('unknown');
  });

  it('8. a different brand with verified equal contents is not rejected for its brand', () => {
    // brands are not an input at all
    const r = check(read('AUXITO Headlight + Fog Light Combo'), read('SEALIGHT Fog Light and Headlight Bulbs Combo'))!;
    expect(r.verdict).toBe('equivalent');
  });

  it('counts: one indicator against two is a different bundle', () => {
    const r = check(read('Headlight + 2 indicator lights combo'), read('Headlight + 1 indicator light combo'))!;
    expect(r.verdict).toBe('mismatch');
    expect(r.onlyA).toEqual(['2 × turn signal']);
    expect(r.onlyB).toEqual(['1 × turn signal']);
    // the same count on both sides is the same
    expect(check(read('Headlight + 2 indicator lights combo'), read('Combo: headlight and 2 turn signal lights'))!.verdict).toBe('equivalent');
    // a count on one side only is not verified
    expect(check(read('Headlight + 2 indicator lights combo'), read('Headlight + indicator lights combo'))!.verdict).toBe('unknown');
  });

  it('a component one bundle leaves out is not in it', () => {
    const noFog = read('', { Location: 'All-in-One Lighting Kit (W/o Fog Lights)' });
    const withFog = read('Headlight + fog light combo');
    expect(check(noFog, withFog)!.verdict).toBe('mismatch');
  });

  it('bulb codes can show two bundles are the same, never that they differ: alternative fits are listed together', () => {
    const a = read('60W H11 9005 Series Combo Pack | LED Bulbs');
    const b = read('Combo 9005 and H11 LED Forward Lightings Bulbs');
    expect(check(a, b, codes(['9005', 'h11'], ['9005', 'h11']))!.verdict).toBe('equivalent');
    // the first names no components, so only the bulbs can be compared; an extra code (H10) may be an alternative fit, so it is "not established", not "different"
    const c = read('SEALIGHT 9005/HB3 H11 LED Headlight Bulbs H10 Fog Light Bulbs Combo');
    const r = check(a, c, codes(['9005', 'h11'], ['9005', 'h11', 'h10']))!;
    expect(r.verdict).toBe('unknown');
    expect(r.exclusion).toBeNull();
    expect(r.note).toMatch(/bulb codes differ \(H10\)/);
    // both name their components: the components decide, and an alternative fit in the title does not make the same combo different
    const same = check(read('Headlight + Fog Light Combo'), read('SEALIGHT Headlight H11 Fog Light H11/H16/H8 Combo'), codes(['h11'], ['h11', 'h16']))!;
    expect(same.verdict).toBe('equivalent');
  });

  it('a "Combo Package" names its contents only in part: what it lists counts, what it does not list cannot be claimed missing', () => {
    // the seller's options mix the vehicle ("W/ H10 Fog Lights") with the package; only the package option says what is in the box
    const pkg = read('Fit for 2009-2010 Dodge Journey The Brightest LED Bulbs Upgrade', { Fog: 'W/ H10 Fog Lights', Package: 'Combo Package' });
    expect(pkg).toMatchObject({ bundle: true, implicit: true, basis: 'variant' });
    expect(pkg.parts).toEqual([]);
    const withFog = read('Fit for 2009-2010 Dodge Journey The Brightest LED Bulbs Upgrade', { Trim: 'W/ HID Headlights', Package: 'Combo Package(W/ Fog Lights)' });
    expect(withFog).toMatchObject({ implicit: true });
    expect(withFog.parts.map((p) => p.id)).toEqual(['fog']);
    // a package that names its parts outright is spelled out
    expect(read('Fit for 2015-2017 Ford F-150 LED Bulbs', { Package: 'Headlight Combo' }).implicit).toBe(false);
    // so a fog-only listing is not said to be missing the headlight of a headlight + fog combo; it is simply not established
    const r = check(withFog, read('SEALIGHT S2S 9008/H13 LED Headlight H10/9140/9145 Fog Light Bulbs Combo 2Pairs'))!;
    expect(r.verdict).not.toBe('mismatch');
    // what it does list is evidence: a package that lists a tail light is not one that leaves the tail lights out
    const tail = read('Fit for 2021-2023 Hyundai Santa Fe', { Package: 'Combo Package(W/ LED Tail Lights)' });
    expect(check(tail, read('SEALIGHT Headlight Fog Light Combo'))!.verdict).not.toBe('equivalent');
  });

  it('two beam sets are two items when the listing joins them, one when it says "or"', () => {
    expect(read('Fit for 2015-2022 Chevrolet Colorado LED Bulbs', { Position: 'Low Beam+High Beam' }).beams).toEqual(['low', 'high']);
    expect(read('AUXITO 9005 HB3 High Beam and H11 Low Beam LED Bulbs Combo Kit').beams).toEqual(['low', 'high']);
    expect(read('H8 H9 H11 LED Forward Lightings Bulbs, High Beam or Low Beam').beams).toEqual([]);
    expect(read('Fit for 2014-2020 Toyota 4Runner LED Bulbs', { Position: 'Low Beam' }).beams).toEqual(['low']);
    // a kit of both beams against a single beam bulb is a different thing to buy, even where no bulb code is given
    const kit = read('Fit for 2014-2020 Toyota 4Runner LED Bulbs', { Position: 'Low Beam+High Beam' });
    const single = read('(16-21) Toyota Tacoma LED Bulbs', { Position: 'H8/H11 Low Beam' });
    const r = check(kit, single)!;
    expect(r.verdict).toBe('mismatch');
    expect(r.onlyA).toEqual(['high beam set']);
    // the same kit against a bulb that fits either beam: the contents are still two sets against one
    expect(check(kit, read('H8 H9 H11 LED Forward Lightings Bulbs, High Beam or Low Beam'))!.verdict).toBe('mismatch');
  });

  it('a bundle against a single item is a mismatch only where something shows what the single item lacks', () => {
    // "Combo Pack" with one position and no second code: nothing to compare
    expect(check(read('LED Headlight Bulbs Combo Pack'), read('H11 LED Headlight Bulbs'))!.verdict).toBe('unknown');
  });

  it('what a package is FOR is not what is in it', () => {
    expect(read('Fit for 2013-2015 Ram 1500 LED Bulbs', { Trim: 'With Projector Assembly', Package: 'Combo Package For w/Horizontal Fog Light' }).parts).toEqual([]);
    expect(read('Fit for 2013-2015 Ram 1500 LED Bulbs', { Package: 'Combo Package (W/ Fog Lights)' }).parts.map((p) => p.id)).toEqual(['fog']);
  });

  it('pairs: two pairs against three pairs is a different bundle', () => {
    expect(check(read('H11 Headlight Fog Light Combo 2Pairs'), read('H11 Headlight Fog Light Combo 3Pairs'))!.verdict).toBe('mismatch');
  });
});

describe('what the policy leaves alone', () => {
  it('says nothing when neither listing is a bundle', () => {
    expect(check(read('H11 LED Headlight Bulbs'), read('H11 LED Headlight Bulbs 6000K'))).toBeNull();
    expect(check(read('', { Location: 'Low Beam' }), read('', { Location: 'Fog Light' }))).toBeNull();
  });

  it('says nothing about products that are not lighting: grocery combos, variety packs, switch knob kits', () => {
    expect(check(read('Lays Variety Pack of Chips', {}, false), read('Assortment of chips combo', {}, false))).toBeNull();
    expect(check(read('Coca-Cola Mini Can 12 Pack Variety', {}, false), read('Soda Value Pack 12 cans', {}, false))).toBeNull();
    expect(check(read('AC Control Switch Knob Kit Fits 1995-2005 Chevy Blazer'), read('Audio & AC Switch Knob Ring Kit Set for 15-21 Dodge Challenger'))).toBeNull();
  });
});
