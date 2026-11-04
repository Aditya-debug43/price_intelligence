import { describe, expect, it } from 'vitest';
import { matchesSearch } from './matching.ts';

const row = (over: Partial<Parameters<typeof matchesSearch>[0]> = {}) => ({ title: 'Sealight LED Headlight Bulbs', variantTitle: 'Low Beam', brand: 'Sealight', sku: 'SL-9001', gtin: null, mpn: 'SLH8-55', model: null, ...over });
const corpus = { alias: new Map([['h11', 'h8'], ['h9', 'h8']]) };
const dossier = { codes: ['h8'], subject: ['ford', 'f-150'] };

describe('searching the whole competitor catalogue for the right product', () => {
  it('finds a product by the words of its name, its brand, its SKU or its barcode (as before)', () => {
    expect(matchesSearch(row(), dossier, corpus, 'headlight')).toBe(true);
    expect(matchesSearch(row(), dossier, corpus, 'sealight')).toBe(true);
    expect(matchesSearch(row(), dossier, corpus, 'sl-9001')).toBe(true);
    expect(matchesSearch(row({ gtin: '0123456789012' }), dossier, corpus, '0123456789012')).toBe(true);
  });
  it('finds it by the manufacturer part number and the model', () => {
    expect(matchesSearch(row(), dossier, corpus, 'slh8-55')).toBe(true);
    expect(matchesSearch(row({ model: 'Pro Series X2' }), dossier, corpus, 'pro series')).toBe(true);
  });
  it('finds it by the bulb code under any of its names: searching "H11" finds the listing that says "H8"', () => {
    expect(matchesSearch(row({ title: 'LED Fog Light Bulbs' }), dossier, corpus, 'h11')).toBe(true);
    expect(matchesSearch(row({ title: 'LED Fog Light Bulbs' }), dossier, corpus, 'h9')).toBe(true);
    expect(matchesSearch(row({ title: 'LED Fog Light Bulbs' }), { codes: ['9005'], subject: [] }, corpus, 'h11')).toBe(false);
  });
  it('finds it by the vehicle it names, and every word of a longer search must be found', () => {
    expect(matchesSearch(row({ title: 'LED Fog Light Bulbs' }), dossier, corpus, 'ford f-150')).toBe(true);
    expect(matchesSearch(row({ title: 'LED Fog Light Bulbs' }), dossier, corpus, 'ford h11')).toBe(true);
    expect(matchesSearch(row({ title: 'LED Fog Light Bulbs' }), dossier, corpus, 'toyota h11')).toBe(false);
  });
  it('does not match unrelated products', () => {
    expect(matchesSearch(row(), dossier, corpus, 'floor mat')).toBe(false);
    expect(matchesSearch(row(), undefined, corpus, 'h11')).toBe(false);
  });
});
