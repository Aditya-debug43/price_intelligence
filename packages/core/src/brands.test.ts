import { describe, expect, it } from 'vitest';
import { isPlaceholderBrand, placeholderBrandKeys, type BrandUse } from './brands.ts';

const many = (siteId: string, brand: string | null, titles: string[]): BrandUse[] => titles.map((title) => ({ siteId, brand, title }));
const titles = (n: number, prefix = 'Product') => Array.from({ length: n }, (_, i) => `${prefix} ${i} 12oz`);

describe('which brand labels are really the shop’s own label', () => {
  it('a country or shop name on almost every product, absent from the product names, is not a brand (the real vendor values seen on live shops)', () => {
    const rows = [
      ...many('gtg', 'Aruba', [...titles(80, 'Dove Silky Smooth'), ...titles(80, 'Kool-Aid Bursts')]), // vendor "Aruba" on a grocery catalogue
      ...many('gtg', 'GroceriesToGo Aruba', titles(30, 'Gift')),
      ...many('ling', 'Ling & Sons Food Market', titles(60, 'AH Olijf Olie')),
      ...many('ling', 'Ling and Sons Food Market', titles(40, 'Pan Batard')),
    ];
    const p = placeholderBrandKeys(rows);
    expect(isPlaceholderBrand(p, 'gtg', 'Aruba')).toBe(true);
    expect(isPlaceholderBrand(p, 'gtg', 'GroceriesToGo Aruba')).toBe(true);
    expect(isPlaceholderBrand(p, 'ling', 'Ling & Sons Food Market')).toBe(true);
    expect(isPlaceholderBrand(p, 'ling', 'Ling and Sons Food Market')).toBe(true);
  });

  it('a real brand — it appears in the names of its own products — is kept, even when one brand dominates a shop', () => {
    const rows = [
      ...many('s', 'Heinz', Array.from({ length: 40 }, (_, i) => `Heinz Tomato Ketchup ${i}`)),
      ...many('s', 'Dove', Array.from({ length: 30 }, (_, i) => `Dove Body Wash ${i}`)),
      // a brand shop: one brand on every product, and it is in every name
      ...many('nike', 'Nike', Array.from({ length: 50 }, (_, i) => `Nike Air Max ${i}`)),
    ];
    const p = placeholderBrandKeys(rows);
    expect(isPlaceholderBrand(p, 's', 'Heinz')).toBe(false);
    expect(isPlaceholderBrand(p, 's', 'Dove')).toBe(false);
    expect(isPlaceholderBrand(p, 'nike', 'Nike')).toBe(false);
  });

  it('platform placeholders are never brands, however few products carry them', () => {
    const p = placeholderBrandKeys([...many('f', 'Your Brand', ['Corona Bottles', 'Black Beans']), ...many('f', 'FoodStore2Go', titles(50)), ...many('l', 'Acme', ['Example T-Shirt'])]);
    expect(isPlaceholderBrand(p, 'f', 'Your Brand')).toBe(true);
    expect(isPlaceholderBrand(p, 'l', 'Acme')).toBe(true);
    expect(isPlaceholderBrand(p, 'f', 'FoodStore2Go')).toBe(true); // 50 products, none named after it
  });

  it('is decided per shop: the same label can be a placeholder on one shop and a brand on another', () => {
    const rows = [...many('a', 'Aruba', titles(60)), ...many('b', 'Aruba', Array.from({ length: 60 }, (_, i) => `Aruba Aloe Gel ${i}`))];
    const p = placeholderBrandKeys(rows);
    expect(isPlaceholderBrand(p, 'a', 'Aruba')).toBe(true);
    expect(isPlaceholderBrand(p, 'b', 'Aruba')).toBe(false);
  });

  it('leaves missing and empty brands alone and judges small shops cautiously', () => {
    const p = placeholderBrandKeys([...many('x', null, titles(30)), ...many('x', '', titles(5)), ...many('small', 'Maker', ['Maker Soap', 'Maker Candle', 'Other thing'])]);
    expect(isPlaceholderBrand(p, 'x', null)).toBe(false);
    expect(isPlaceholderBrand(p, 'small', 'Maker')).toBe(false);
  });
});
