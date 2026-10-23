/**
 * Deterministic FIXTURE data. Everything produced from here is fictional test data and is flagged as a fixture
 * everywhere it appears (sites.is_fixture, evidence.is_fixture, report banners). It must never be presented as live.
 */

export interface MasterItem {
  id: number;
  brand: string;
  name: string;
  size: string;
  category: string;
  usd: number;
}

// brand, name, size, category, base USD price
const RAW: [string, string, string, string, number][] = [
  ['Coca-Cola', 'Classic', '355ml can', 'Beverages > Soda', 1.1],
  ['Coca-Cola', 'Classic', '12 x 355ml', 'Beverages > Soda', 11.9],
  ['Coca-Cola', 'Zero Sugar', '2L', 'Beverages > Soda', 3.2],
  ['Sprite', 'Lemon-Lime', '2L', 'Beverages > Soda', 3.1],
  ['Fanta', 'Orange', '355ml can', 'Beverages > Soda', 1.05],
  ['Heineken', 'Lager Beer', '6 x 330ml', 'Beverages > Beer', 9.5],
  ['Balashi', 'Aruban Beer', '6 x 355ml', 'Beverages > Beer', 8.4],
  ['Tropicana', 'Orange Juice', '1.75L', 'Beverages > Juice', 5.6],
  ['Dole', 'Pineapple Juice', '1L', 'Beverages > Juice', 3.4],
  ['Heinz', 'Tomato Ketchup', '397g', 'Pantry > Condiments', 3.3],
  ['Heinz', 'Tomato Ketchup', '1.25kg', 'Pantry > Condiments', 7.9],
  ['Kraft', 'Real Mayonnaise', '473ml', 'Pantry > Condiments', 4.6],
  ['Hellmann\'s', 'Real Mayonnaise', '444ml', 'Pantry > Condiments', 4.9],
  ['Barilla', 'Spaghetti', '500g', 'Pantry > Pasta', 2.4],
  ['Barilla', 'Penne Rigate', '500g', 'Pantry > Pasta', 2.4],
  ['Goya', 'Black Beans', '425g', 'Pantry > Canned', 1.7],
  ['Goya', 'Adobo All-Purpose Seasoning', '226g', 'Pantry > Spices', 3.0],
  ['Pringles', 'Original', '165g', 'Snacks > Chips', 3.2],
  ['Lay\'s', 'Classic Potato Chips', '184g', 'Snacks > Chips', 4.1],
  ['Oreo', 'Original Cookies', '154g', 'Snacks > Cookies', 2.9],
  ['Nutella', 'Hazelnut Spread', '350g', 'Pantry > Spreads', 4.8],
  ['Kellogg\'s', 'Corn Flakes', '340g', 'Breakfast > Cereal', 4.3],
  ['Quaker', 'Old Fashioned Oats', '510g', 'Breakfast > Cereal', 4.6],
  ['Land O Lakes', 'Salted Butter', '454g', 'Dairy > Butter', 6.2],
  ['Horizon', 'Whole Milk', '1.89L', 'Dairy > Milk', 6.9],
  ['Horizon', 'Chocolate Whole Milk', '1.89L', 'Dairy > Milk', 7.4],
  ['Folgers', 'Classic Roast Coffee', '326g', 'Beverages > Coffee', 7.8],
  ['Nescafe', 'Classic Instant Coffee', '200g', 'Beverages > Coffee', 9.4],
  ['Dove', 'Body Wash', '500ml', 'Household > Personal Care', 7.5],
  ['Colgate', 'Total Toothpaste', '120g', 'Household > Personal Care', 3.7],
  ['Clorox', 'Regular Bleach', '1.89L', 'Household > Cleaning', 4.2],
  ['Tide', 'Laundry Detergent', '2.72kg', 'Household > Laundry', 17.5],
  ['Dawn', 'Dish Soap', '709ml', 'Household > Cleaning', 4.4],
  ['Bounty', 'Paper Towels', '6 rolls', 'Household > Paper', 11.2],
  ['Domino', 'Granulated Sugar', '1.81kg', 'Pantry > Baking', 5.1],
  ['Morton', 'Iodized Salt', '737g', 'Pantry > Baking', 1.9],
  ['Wesson', 'Vegetable Oil', '1.42L', 'Pantry > Oils', 6.3],
  ['Mazola', 'Corn Oil', '1.18L', 'Pantry > Oils', 5.9],
  ['Pepsi', 'Cola', '2L', 'Beverages > Soda', 3.0],
  ['Gatorade', 'Fruit Punch', '946ml', 'Beverages > Sports Drinks', 3.1],
];

export const MASTER: MasterItem[] = RAW.map(([brand, name, size, category, usd], id) => ({ id, brand, name, size, category, usd }));

/** Valid EAN-13 (GTIN-13) for item index. */
export function fixtureGtin(id: number): string {
  const body = `49000${String(1000 + id).padStart(4, '0')}${String(id * 7 + 13).padStart(3, '0')}`.slice(0, 12).padEnd(12, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

export type SiteKind = 'shopify' | 'woocommerce' | 'jsonld' | 'html' | 'listing' | 'homegrid' | 'catblocked' | 'blocked' | 'challenge' | 'failing' | 'jsrender' | 'login' | 'flaky';

export interface FixtureProduct {
  itemId: number;
  handle: string;
  title: string;
  brand: string | null;
  category: string;
  size: string;
  price: number;
  compareAt: number | null;
  currency: string;
  available: boolean;
  /** Exact public claim ("Only N left") — null when the site doesn't publish one. */
  claimedLeft: number | null;
  gtin: string | null;
  sku: string;
  limited?: boolean;
  /** Variable-product variants (WooCommerce). */
  variants?: { id: number; label: string; price: number; available: boolean }[];
  /** Hidden from the catalogue (simulates a delisting). */
  removed?: boolean;
}

export interface SiteSpec {
  key: string;
  kind: SiteKind;
  label: string;
  currency: string;
  /** Price multiplier relative to the base USD price, expressed in the site's currency. */
  factor: number;
  items: number[];
  /** How the site writes titles. */
  titleStyle: 'full' | 'brand_last' | 'no_brand' | 'upper' | 'size_in_tag';
  exposeGtin: number[];
  outOfStock: number[];
  claimedLeft?: Record<number, number>;
  limited?: number[];
  onSale?: Record<number, number>;
  hasFlyer?: boolean;
  /** What the shop puts in the platform's vendor field instead of the maker's name ("Aruba", its own name…). */
  vendorLabel?: string;
  /** A "regular price" shown above EVERY selling price by this factor — a standing display, not a sale. */
  uniformCompareAt?: number;
  /** Items listed at 0.00 (a gift card whose amount the buyer chooses). */
  zeroPriceItems?: number[];
  /** The site's terms-of-use page: forbids automated collection, restricts copying, or says nothing about either. Omitted = the site has no terms page. */
  terms?: 'forbid_automation' | 'restrict_copying' | 'neutral';
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const SITE_SPECS: SiteSpec[] = [
  {
    key: 'source', kind: 'shopify', label: 'Fixture Grocery (own shop, AWG)', currency: 'AWG', factor: 1.79 * 1.04,
    items: range(0, 31), titleStyle: 'full', exposeGtin: [], outOfStock: [4, 18, 33], onSale: { 3: 0.8, 21: 0.85 },
  },
  {
    key: 'woo', kind: 'woocommerce', label: 'Fixture Mart (WooCommerce, USD)', currency: 'USD', factor: 0.98,
    items: [...range(0, 12), ...range(14, 19), ...range(22, 30), ...range(34, 39)], titleStyle: 'no_brand', exposeGtin: [], outOfStock: [8],
    claimedLeft: { 5: 3, 29: 2 }, onSale: { 0: 0.9, 12: 0.88 },
  },
  {
    key: 'jsonld', kind: 'jsonld', label: 'Fixture Superstore (JSON-LD, AWG)', currency: 'AWG', factor: 1.79 * 1.1,
    items: [...range(0, 11), ...range(13, 17), ...range(19, 29), ...range(31, 36)], titleStyle: 'brand_last',
    exposeGtin: [0, 1, 2, 3, 5, 6, 9, 10, 13, 14, 17, 20, 23, 28, 31, 35], outOfStock: [6, 25], limited: [20], hasFlyer: true,
    onSale: { 9: 0.82 },
  },
  {
    key: 'html', kind: 'html', label: 'Fixture Express (plain HTML, USD)', currency: 'USD', factor: 1.06,
    items: [0, 1, 2, 3, 10, 13, 14, 17, 19, 20, 23, 28, 29, 31], titleStyle: 'upper', exposeGtin: [], outOfStock: [], claimedLeft: { 17: 4 },
  },
  {
    key: 'listing', kind: 'listing', label: 'Fixture Listing Shop (no feed, sitemap or structured data)', currency: 'GBP', factor: 0.79,
    items: range(0, 25), titleStyle: 'full', exposeGtin: [], outOfStock: [3, 12],
  },
  {
    key: 'homegrid', kind: 'homegrid', label: 'Fixture Storefront (home page is page 1 of the whole catalogue)', currency: 'GBP', factor: 0.74,
    items: range(0, 27), titleStyle: 'full', exposeGtin: [], outOfStock: [5],
  },
  {
    key: 'vendorshop', kind: 'shopify', label: 'Fixture Vendor-Label Shop (vendor field holds the country, every item shows a regular price 8% higher)', currency: 'USD', factor: 1,
    items: [...range(0, 24), 30], titleStyle: 'full', exposeGtin: [], outOfStock: [], vendorLabel: 'Aruba', uniformCompareAt: 1.08, zeroPriceItems: [30],
  },
  {
    key: 'termsban', kind: 'shopify', label: 'Fixture Terms-Forbidden Shop (its terms of use forbid robots and scraping)', currency: 'USD', factor: 1,
    items: range(0, 11), titleStyle: 'full', exposeGtin: [], outOfStock: [], terms: 'forbid_automation',
  },
  {
    key: 'termscopy', kind: 'shopify', label: 'Fixture Terms-Restricted Shop (its terms restrict copying content without consent)', currency: 'USD', factor: 1,
    items: range(0, 11), titleStyle: 'full', exposeGtin: [], outOfStock: [], terms: 'restrict_copying',
  },
  {
    key: 'tagsize', kind: 'shopify', label: 'Fixture Tag-Size Shop (the title has no size; a Size_ tag does)', currency: 'USD', factor: 1,
    items: range(0, 15), titleStyle: 'size_in_tag', exposeGtin: [], outOfStock: [],
  },
  { key: 'catblocked', kind: 'catblocked', label: 'Fixture Closed Catalogue (robots.txt forbids the shop pages)', currency: 'USD', factor: 1, items: range(0, 8), titleStyle: 'full', exposeGtin: [], outOfStock: [] },
  { key: 'blocked', kind: 'blocked', label: 'Fixture Blocked (robots.txt disallows)', currency: 'USD', factor: 1, items: [0, 1], titleStyle: 'full', exposeGtin: [], outOfStock: [] },
  { key: 'challenge', kind: 'challenge', label: 'Fixture Protected (bot challenge)', currency: 'USD', factor: 1, items: [0, 1], titleStyle: 'full', exposeGtin: [], outOfStock: [] },
  { key: 'failing', kind: 'failing', label: 'Fixture Down (HTTP 500)', currency: 'USD', factor: 1, items: [0, 1], titleStyle: 'full', exposeGtin: [], outOfStock: [] },
  { key: 'jsrender', kind: 'jsrender', label: 'Fixture SPA (JavaScript only)', currency: 'USD', factor: 1, items: [0, 1], titleStyle: 'full', exposeGtin: [], outOfStock: [] },
  { key: 'login', kind: 'login', label: 'Fixture Members (login required)', currency: 'USD', factor: 1, items: [0, 1], titleStyle: 'full', exposeGtin: [], outOfStock: [] },
  {
    key: 'flaky', kind: 'flaky', label: 'Fixture Flaky (feed breaks mid-catalogue)', currency: 'AWG', factor: 1.79 * 1.02,
    items: range(0, 39), titleStyle: 'full', exposeGtin: [], outOfStock: [],
  },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

function titleFor(item: MasterItem, style: SiteSpec['titleStyle']): { title: string; brand: string | null } {
  switch (style) {
    case 'full':
      return { title: `${item.brand} ${item.name} ${item.size}`, brand: item.brand };
    case 'brand_last':
      return { title: `${item.name} ${item.size} - ${item.brand}`, brand: item.brand };
    case 'no_brand':
      // The brand is only part of the title text; the structured field is empty (tests brand inference).
      return { title: `${item.brand} ${item.name}, ${item.size}`, brand: null };
    case 'upper':
      return { title: `${item.brand} ${item.name} ${item.size}`.toUpperCase(), brand: item.brand };
    case 'size_in_tag':
      // like the audited own shop: the title states no size at all; the size lives in a "Size_9oz" tag
      return { title: `${item.brand} ${item.name}`, brand: item.brand };
  }
}

export function buildCatalogue(spec: SiteSpec): FixtureProduct[] {
  return spec.items.map((id) => {
    const item = MASTER[id]!;
    const { title, brand } = titleFor(item, spec.titleStyle);
    const regular = round2(item.usd * spec.factor);
    const saleFactor = spec.onSale?.[id];
    const price = spec.zeroPriceItems?.includes(id) ? 0 : saleFactor ? round2(regular * saleFactor) : regular;
    return {
      itemId: id,
      handle: `${item.brand}-${item.name}-${item.size}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title,
      brand,
      category: item.category,
      size: item.size,
      price,
      compareAt: saleFactor ? regular : spec.uniformCompareAt && price > 0 ? round2(price * spec.uniformCompareAt) : null,
      currency: spec.currency,
      available: !spec.outOfStock.includes(id),
      claimedLeft: spec.claimedLeft?.[id] ?? null,
      gtin: spec.exposeGtin.includes(id) ? fixtureGtin(id) : null,
      sku: `${spec.key.toUpperCase()}-${String(id).padStart(3, '0')}`,
      limited: spec.limited?.includes(id) ?? false,
      ...(spec.kind === 'woocommerce' && id === 1
        ? { variants: [{ id: 9001, label: '12 x 355ml', price, available: true }, { id: 9002, label: '24 x 355ml', price: round2(price * 1.9), available: true }] }
        : {}),
    };
  });
}
