import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import { extractFlyer, parseFlyerLines, parseValidity } from './flyer.ts';
import { allSocialStatuses, classifyPost, fetchFacebook, fetchInstagram, fetchYouTube, type HttpJson } from './social.ts';
import { ShopifyInventoryProvider, buildShopifyAuthorizeUrl, exchangeShopifyCode, refreshShopifyToken, type ShopifyAppConfig } from './inventory.ts';

function pdf(lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  for (const l of lines) doc.text(l);
  doc.end();
  return done;
}

describe('flyer extraction (text-layer PDFs)', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  it('reads priced items, was/now pairs, conditions and validity dates, with confidence and review flags', async () => {
    const file = await pdf([
      'Weekly Specials',
      'Valid Oct 12 - Oct 18, 2026',
      'Coca-Cola Classic 12 x 355ml Afl. 18.99',
      'Heinz Tomato Ketchup 397g Was 7.99 Now 5.99',
      'Barilla Spaghetti 500g 2 for $5.00 Limit 4 per customer',
    ]);
    const r = await extractFlyer(file, { siteCurrency: 'AWG', now });
    expect(r.status).toBe('extracted');
    expect(r.validFrom?.toISOString().slice(0, 10)).toBe('2026-10-12');
    expect(r.validTo?.toISOString().slice(0, 10)).toBe('2026-10-18');
    const coke = r.items.find((i) => i.name.includes('Coca-Cola'))!;
    expect(coke).toMatchObject({ salePrice: 18.99, originalPrice: null, currency: 'AWG' });
    const heinz = r.items.find((i) => i.name.includes('Heinz'))!;
    expect(heinz).toMatchObject({ originalPrice: 7.99, salePrice: 5.99 });
    expect(heinz.confidence).toBeLessThan(coke.confidence + 0.01);
    const bar = r.items.find((i) => i.name.includes('Barilla'))!;
    expect(bar.conditions.join(' ')).toMatch(/2 for/);
    expect(r.items.every((i) => i.confidence > 0 && i.confidence < 1)).toBe(true);
  });
  it('flags ambiguous lines (name taken from the previous line, many prices) for human review', () => {
    const items = parseFlyerLines('Mystery Product\n12.99\nOther thing 1.00 2.00 3.00 4.00', 1, 'USD');
    expect(items[0]).toMatchObject({ name: 'Mystery Product', needsReview: true });
    expect(items.find((i) => i.name.startsWith('Other'))?.needsReview).toBe(true);
  });
  it('does not read a size such as 1.75L or 2.00 kg as a price', () => {
    const items = parseFlyerLines('Tropicana Orange Juice 1.75L Was 12.98 Now 11.03\nBasmati Rice 2.00 kg Afl. 6.49', 1, 'AWG');
    expect(items[0]).toMatchObject({ originalPrice: 12.98, salePrice: 11.03 });
    expect(items[0]!.name).toContain('1.75L');
    expect(items[1]).toMatchObject({ salePrice: 6.49, originalPrice: null });
  });
  it('reports an image-only PDF as having no text layer instead of guessing', async () => {
    const file = await pdf([]);
    const r = await extractFlyer(file, { siteCurrency: 'USD', now });
    expect(r.status).toBe('no_text_layer');
    expect(r.items).toEqual([]);
    expect(r.message).toMatch(/OCR/);
  });
  it('fails safely on corrupt input', async () => {
    const r = await extractFlyer(Buffer.from('this is not a pdf'), { siteCurrency: 'USD', now });
    expect(r.status).toBe('failed');
  });
  it('parses validity ranges across months and with missing years', () => {
    const v = parseValidity('Valid Dec 28 - Jan 3', new Date('2026-12-29T00:00:00Z'));
    expect(v.from?.toISOString().slice(0, 10)).toBe('2026-12-28');
    expect(v.to?.toISOString().slice(0, 10)).toBe('2027-01-03');
    // read in early January, the same wording refers to the range that just ended
    const jan = parseValidity('Valid Dec 28 - Jan 3', new Date('2027-01-01T00:00:00Z'));
    expect(jan.from?.toISOString().slice(0, 10)).toBe('2026-12-28');
    expect(parseValidity('no dates here', now)).toEqual({ from: null, to: null });
  });
});

describe('social providers (official APIs, mocked HTTP)', () => {
  const ok = (json: unknown, status = 200): HttpJson => async () => ({ status, json });
  it('reports clear statuses with requirements when not configured — never a fake connection', () => {
    const s = allSocialStatuses({});
    expect(s.map((x) => x.state)).toEqual(['not_configured', 'not_configured', 'not_configured']);
    expect(s.every((x) => x.requirements.length > 0 && x.limits.length > 0)).toBe(true);
    expect(s[2]!.requirements.join(' ')).toMatch(/Page Public Content Access/);
    expect(allSocialStatuses({ metaAccessToken: 't' })[2]!.state).toBe('requires_approval');
  });
  it('YouTube: resolves a handle, then reads the uploads playlist', async () => {
    const calls: string[] = [];
    const http: HttpJson = async (url) => {
      calls.push(url);
      if (url.includes('/channels?')) return { status: 200, json: { items: [{ id: 'UCabc', contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] } };
      return { status: 200, json: { items: [
        { snippet: { title: 'Weekend sale up to 30% off', description: 'Great deals', publishedAt: '2026-10-10T10:00:00Z', resourceId: { videoId: 'v1' } }, contentDetails: { videoId: 'v1', videoPublishedAt: '2026-10-10T10:00:00Z' } },
        { snippet: { title: 'Private video', resourceId: { videoId: 'v2' } }, contentDetails: { videoId: 'v2' } },
      ] } };
    };
    const r = await fetchYouTube({ youtubeApiKey: 'KEY' }, { handle: '@mystore' }, http);
    expect(r.ok).toBe(true);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=v1', kind: 'video' });
    expect(calls[0]).toContain('forHandle=%40mystore');
  });
  it('YouTube: explains quota and key problems', async () => {
    const quota = await fetchYouTube({ youtubeApiKey: 'K' }, { handle: '@x' }, ok({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403));
    expect(quota).toMatchObject({ ok: false, state: 'error' });
    expect(quota.message).toMatch(/quota/i);
    expect((await fetchYouTube({}, { handle: '@x' })).state).toBe('not_configured');
  });
  it('Instagram: Business Discovery media; and a permission error becomes "requires approval"', async () => {
    const cfg = { metaAccessToken: 'T', metaInstagramBusinessAccountId: '1789' };
    const good = await fetchInstagram(cfg, { handle: '@rival' }, ok({ business_discovery: { username: 'rival', media: { data: [{ id: '1', caption: 'New arrivals!\nShop now', permalink: 'https://www.instagram.com/p/x/', timestamp: '2026-10-11T00:00:00+0000' }] } } }));
    expect(good.ok).toBe(true);
    expect(good.posts[0]).toMatchObject({ title: 'New arrivals!', kind: 'social_post' });
    const denied = await fetchInstagram(cfg, { handle: '@rival' }, ok({ error: { code: 10, message: 'Application does not have permission' } }, 400));
    expect(denied).toMatchObject({ ok: false, state: 'requires_approval' });
    expect((await fetchInstagram({}, { handle: '@r' })).state).toBe('not_configured');
  });
  it('Facebook: public Page posts; missing feature → requires_approval; bad token → error', async () => {
    const cfg = { metaAccessToken: 'T' };
    expect((await fetchFacebook(cfg, { handle: 'rivalpage' }, ok({ data: [{ id: '1_2', message: 'Sale this weekend', created_time: '2026-10-12T10:00:00+0000', permalink_url: 'https://facebook.com/rival/posts/2' }] }))).posts).toHaveLength(1);
    expect((await fetchFacebook(cfg, { handle: 'p' }, ok({ error: { code: 10, message: 'needs Page Public Content Access' } }, 403))).state).toBe('requires_approval');
    expect((await fetchFacebook(cfg, { handle: 'p' }, ok({ error: { code: 190, message: 'expired' } }, 401))).state).toBe('error');
    expect((await fetchFacebook({}, { handle: 'p' })).state).toBe('not_configured');
  });
  it('network failures become an error result, not an exception', async () => {
    const r = await fetchYouTube({ youtubeApiKey: 'K' }, { handle: '@x' }, async () => { throw new Error('socket hang up'); });
    expect(r).toMatchObject({ ok: false, state: 'error' });
  });
  it('classifies posts with modest, explainable confidence', () => {
    expect(classifyPost('Weekend sale: 20% off everything')).toMatchObject({ classification: 'promotion' });
    expect(classifyPost('Introducing our new store brand')).toMatchObject({ classification: 'product_launch' });
    expect(classifyPost('Happy Easter from all of us')).toMatchObject({ classification: 'seasonal' });
    expect(classifyPost('Our team at work')).toMatchObject({ classification: 'brand_content' });
    expect(classifyPost('').classification).toBe('unclassified');
    expect(classifyPost('sale').confidence).toBeLessThanOrEqual(0.7);
  });
});

describe('Shopify authorised inventory (read-only)', () => {
  const cfg: ShopifyAppConfig = { clientId: 'cid', clientSecret: 'secret', scopes: 'read_products,read_inventory,read_locations', redirectUri: 'https://app.example.com/cb', apiVersion: '2026-07' };

  it('requests only read scopes in the authorise URL and rejects hostile shop domains', () => {
    const u = new URL(buildShopifyAuthorizeUrl(cfg, 'demo.myshopify.com', 'st4te'));
    expect(u.hostname).toBe('demo.myshopify.com');
    expect(u.searchParams.get('scope')).toBe('read_products,read_inventory,read_locations');
    expect(u.searchParams.get('scope')).not.toMatch(/write_/);
    expect(u.searchParams.get('state')).toBe('st4te');
    expect(() => buildShopifyAuthorizeUrl(cfg, 'evil.com/x.myshopify.com', 's')).toThrow();
    expect(() => buildShopifyAuthorizeUrl(cfg, 'demo.myshopify.com.evil.com', 's')).toThrow();
  });
  it('exchanges the code for an EXPIRING token with a refresh token, and refreshes it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const post = async (_u: string, body: unknown) => {
      bodies.push(body as Record<string, unknown>);
      return { status: 200, json: { access_token: 'shpat_new', scope: 'read_products', expires_in: 3600, refresh_token: 'shprt_new', refresh_token_expires_in: 7_776_000 } };
    };
    const now = new Date('2026-10-14T00:00:00Z');
    const t = await exchangeShopifyCode(cfg, 'demo.myshopify.com', 'code123', post, now);
    expect(bodies[0]).toMatchObject({ code: 'code123', expiring: 1 });
    expect(t.accessTokenExpiresAt?.toISOString()).toBe('2026-10-14T01:00:00.000Z');
    expect(t.refreshTokenExpiresAt?.getTime()).toBe(now.getTime() + 7_776_000_000);
    const r = await refreshShopifyToken(cfg, 'demo.myshopify.com', 'shprt_old', post, now);
    expect(bodies[1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'shprt_old' });
    expect(r.refreshToken).toBe('shprt_new');
  });
  it('asks the owner to reconnect when the refresh token is no longer valid', async () => {
    const post = async () => ({ status: 400, json: { error: 'invalid_grant' } });
    await expect(refreshShopifyToken(cfg, 'demo.myshopify.com', 'old', post)).rejects.toMatchObject({ code: 'reauthorize' });
    await expect(exchangeShopifyCode(cfg, 'demo.myshopify.com', 'bad', async () => ({ status: 400, json: {} }))).rejects.toThrow(/rejected/);
  });

  it('reads variants with location-level quantities; untracked items have NO quantity (not zero)', async () => {
    const pages = [
      { data: { productVariants: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [
        { id: 'gid://shopify/ProductVariant/1', sku: 'COKE-1', title: 'Default Title', product: { title: 'Coke' }, inventoryItem: { tracked: true, inventoryLevels: { nodes: [
          { location: { id: 'L1', name: 'Main' }, quantities: [{ name: 'available', quantity: 4 }] },
          { location: { id: 'L2', name: 'Annex' }, quantities: [{ name: 'available', quantity: 2 }] },
        ] } } },
      ] } } },
      { data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { id: 'gid://shopify/ProductVariant/2', sku: 'SVC-1', title: 'Service', product: { title: 'Gift wrap' }, inventoryItem: { tracked: false, inventoryLevels: { nodes: [{ location: { id: 'L1', name: 'Main' }, quantities: [{ name: 'available', quantity: 0 }] }] } } },
      ] } } },
    ];
    let i = 0;
    const provider = new ShopifyInventoryProvider('demo.myshopify.com', '2026-07', async () => 'tok', async () => ({ status: 200, json: pages[i++]! as unknown as Record<string, unknown> }));
    const items = await provider.listInventory();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sku: 'COKE-1', tracked: true, levels: [{ locationId: 'L1', available: 4 }, { locationId: 'L2', available: 2 }] });
    expect(items[1]).toMatchObject({ sku: 'SVC-1', tracked: false });
    expect(items[1]!.levels[0]!.available).toBeNull();
  });
  it('backs off when throttled and surfaces revoked tokens as unauthorized', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const gql = async () => {
      calls++;
      if (calls < 3) return { status: 200, json: { errors: [{ extensions: { code: 'THROTTLED' } }] } };
      return { status: 200, json: { data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } as unknown as Record<string, unknown> };
    };
    const p = new ShopifyInventoryProvider('demo.myshopify.com', '2026-07', async () => 't', gql, async (ms) => void sleeps.push(ms));
    await p.listInventory();
    expect(sleeps).toEqual([1000, 2000]);
    const revoked = new ShopifyInventoryProvider('demo.myshopify.com', '2026-07', async () => 't', async () => ({ status: 401, json: {} }));
    await expect(revoked.listInventory()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(() => new ShopifyInventoryProvider('x.evil.com', '2026-07', async () => 't')).toThrow();
  });
});
