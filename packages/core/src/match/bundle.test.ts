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

  it('bulb codes decide too: the same parts with different bulbs, or one more bulb, are different contents', () => {
    const a = read('60W H11 9005 Series Combo Pack | LED Bulbs');
    const b = read('Combo 9005 and H11 LED Forward Lightings Bulbs');
    expect(check(a, b, codes(['9005', 'h11'], ['9005', 'h11']))!.verdict).toBe('equivalent');
    const c = read('SEALIGHT 9005/HB3 H11 LED Headlight Bulbs H10 Fog Light Bulbs Combo');
    const r = check(a, c, codes(['9005', 'h11'], ['9005', 'h11', 'h10']))!;
    expect(r.verdict).toBe('mismatch');
    // the first names no positions, so only the bulbs can be compared: and they show the extra H10
    expect(r.onlyB).toEqual(['bulb H10']);
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
