import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { classifyPromoText, discountPct, nextOfferStatus, sha256Hex, verifyDiscount, type PricePoint } from '@ci/core';
import { extractFlyer, type EvidenceDoc, type SafeFetcher } from '@ci/connectors';
import { REVIEWABLE_OFFER_KINDS, type OfferReviewInput, type OfferReviewStatus, type SiteProfileData } from '@ci/shared';
import { auditEvents, flyers, marketingActivities, offers, priceObservations, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { recordEvidence } from './evidence.ts';
import { ActionNotPossibleError, provenanceFor } from './workspace.ts';

type SiteRef = { id: string; orgId: string; origin: string; currency: string | null };

const shortHash = (s: string) => sha256Hex(s.toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 16);

/**
 * Banners, announcement bars, sale pages and flyer links seen on a site's public pages.
 * Observed promotional content is recorded as such — it is not evidence of a paid advertising campaign.
 */
export async function recordSitePromotions(svc: Services, db: DbLike, site: SiteRef, promos: SiteProfileData['promotions'], pageUrl: string, now: Date): Promise<{ offers: number; marketing: number }> {
  let offerCount = 0;
  let marketingCount = 0;
  const seenKeys = new Set<string>();

  for (const text of promos.bannerTexts) {
    const cls = classifyPromoText(text);
    const key = `banner:${shortHash(text)}`;
    seenKeys.add(key);
    const [existing] = await db.select().from(offers).where(and(eq(offers.siteId, site.id), eq(offers.dedupeKey, key)));
    const pct = text.match(/(\d{1,2})\s?%\s?off/i);
    if (existing) {
      await db.update(offers).set({ lastSeenAt: now, status: 'active', missedCompleteScans: 0 }).where(eq(offers.id, existing.id));
    } else {
      await db.insert(offers).values({
      provenance: provenanceFor(),
        orgId: site.orgId, siteId: site.id, kind: cls.kind as never, title: text.slice(0, 200), description: null, conditions: cls.conditions, conditional: cls.conditional,
        code: cls.code, originalPrice: null, salePrice: null, currency: site.currency, claimedDiscountPct: pct ? Number(pct[1]) : null, verification: 'unverified',
        verificationReason: 'Promotional banner: no product price to verify', firstSeenAt: now, lastSeenAt: now, status: 'active', sourceUrl: pageUrl, extractionMethod: 'public_banner',
        confidence: 0.6, needsReview: false, dedupeKey: key,
      });
      offerCount++;
    }
    const mKey = `bar:${shortHash(text)}`;
    const r = await db
      .insert(marketingActivities)
      .values({ provenance: provenanceFor(), orgId: site.orgId, siteId: site.id, platform: 'site', kind: 'announcement_bar', title: text.slice(0, 160), excerpt: text.slice(0, 400), url: pageUrl, firstSeenAt: now, lastSeenAt: now, classification: 'promotion', confidence: 0.6, extractionMethod: 'public_banner', dedupeKey: mKey })
      .onConflictDoUpdate({ target: [marketingActivities.orgId, marketingActivities.siteId, marketingActivities.dedupeKey], set: { lastSeenAt: now } })
      .returning({ first: marketingActivities.firstSeenAt });
    if (r[0] && r[0].first.getTime() === now.getTime()) marketingCount++;
  }

  for (const link of promos.saleLinks) {
    const r = await db
      .insert(marketingActivities)
      .values({ provenance: provenanceFor(), orgId: site.orgId, siteId: site.id, platform: 'site', kind: 'sale_page', title: 'Sale / offers page', excerpt: null, url: link, firstSeenAt: now, lastSeenAt: now, classification: 'promotion', confidence: 0.5, extractionMethod: 'public_banner', dedupeKey: `sale:${shortHash(link)}` })
      .onConflictDoUpdate({ target: [marketingActivities.orgId, marketingActivities.siteId, marketingActivities.dedupeKey], set: { lastSeenAt: now } })
      .returning({ first: marketingActivities.firstSeenAt });
    if (r[0] && r[0].first.getTime() === now.getTime()) marketingCount++;
  }
  for (const link of promos.flyerLinks) {
    const r = await db
      .insert(marketingActivities)
      .values({ provenance: provenanceFor(), orgId: site.orgId, siteId: site.id, platform: 'site', kind: 'flyer', title: 'Promotional flyer (PDF)', excerpt: null, url: link, firstSeenAt: now, lastSeenAt: now, classification: 'promotion', confidence: 0.6, extractionMethod: 'public_banner', dedupeKey: `flyer:${shortHash(link)}` })
      .onConflictDoUpdate({ target: [marketingActivities.orgId, marketingActivities.siteId, marketingActivities.dedupeKey], set: { lastSeenAt: now } })
      .returning({ first: marketingActivities.firstSeenAt });
    if (r[0] && r[0].first.getTime() === now.getTime()) marketingCount++;
  }

  // Banners that were not seen this time: count a miss; end only per the defensible lifecycle policy.
  const active = await db.select().from(offers).where(and(eq(offers.siteId, site.id), eq(offers.extractionMethod, 'public_banner'), inArray(offers.status, ['active', 'presumed_ended'])));
  for (const o of active) {
    if (seenKeys.has(o.dedupeKey)) continue;
    const missed = o.missedCompleteScans + 1;
    const status = nextOfferStatus({ status: o.status, lastSeenAt: o.lastSeenAt, validTo: o.validTo, now, latestScanComplete: true, missedCompleteScans: missed });
    await db.update(offers).set({ missedCompleteScans: missed, status }).where(eq(offers.id, o.id));
  }
  return { offers: offerCount, marketing: marketingCount };
}

// ───────────────────────────────────────────────────────────── per-variant sale prices

export interface SaleObservation {
  variantId: string;
  title: string;
  url: string;
  price: number | null;
  compareAt: number | null;
  currency: string | null;
  observedAt: Date;
  evidenceId: string | null;
  extractionMethod: string;
}

/**
 * Turns "compare-at above selling price" into a tracked offer and checks the claim against the product's OWN price
 * history. The reference price shown beside a sale price is never trusted on its own.
 */
export async function trackSalePrice(db: DbLike, site: SiteRef, o: SaleObservation): Promise<void> {
  const key = `sale:${o.variantId}`;
  const [existing] = await db.select().from(offers).where(and(eq(offers.siteId, site.id), eq(offers.dedupeKey, key)));
  const onSale = o.price !== null && o.compareAt !== null && o.compareAt > o.price;

  if (!onSale) {
    // The sale price disappeared on a direct observation of the product: this is a definite end, not a guess.
    if (existing && (existing.status === 'active' || existing.status === 'presumed_ended')) {
      await db.update(offers).set({ status: 'ended', missedCompleteScans: 0 }).where(eq(offers.id, existing.id));
    }
    return;
  }

  const firstSeenAt = existing && existing.status !== 'ended' ? existing.firstSeenAt : o.observedAt;
  const history = await db
    .select({ price: priceObservations.price, observedAt: priceObservations.observedAt, compareAt: priceObservations.compareAtPrice })
    .from(priceObservations)
    .where(and(eq(priceObservations.variantId, o.variantId), lt(priceObservations.observedAt, firstSeenAt)))
    .orderBy(desc(priceObservations.observedAt))
    .limit(400);
  const points: PricePoint[] = history.filter((h) => h.price !== null).map((h) => ({ price: h.price as number, observedAt: h.observedAt, onSale: h.compareAt !== null && h.compareAt > (h.price as number) }));
  const v = verifyDiscount({ original: o.compareAt, sale: o.price }, points, firstSeenAt);

  const values = {
    title: `Sale: ${o.title}`.slice(0, 200),
    originalPrice: o.compareAt,
    salePrice: o.price,
    currency: o.currency,
    claimedDiscountPct: discountPct(o.compareAt, o.price),
    historicalDiscountPct: v.historicalDiscountPct,
    verification: v.verification,
    verificationReason: v.reason,
    lastSeenAt: o.observedAt,
    status: 'active' as const,
    missedCompleteScans: 0,
    sourceUrl: o.url,
    evidenceId: o.evidenceId,
  };
  if (existing && existing.status !== 'ended') {
    await db.update(offers).set(values).where(eq(offers.id, existing.id));
  } else if (existing) {
    // A new sale episode on the same variant: restart the offer with fresh first-seen.
    await db.update(offers).set({ ...values, firstSeenAt: o.observedAt }).where(eq(offers.id, existing.id));
  } else {
    await db.insert(offers).values({
      provenance: provenanceFor(),
      orgId: site.orgId, siteId: site.id, kind: 'sale_price', description: null, conditions: [], conditional: false, variantId: o.variantId, productTitle: o.title, firstSeenAt: o.observedAt,
      extractionMethod: o.extractionMethod, confidence: 0.9, needsReview: false, dedupeKey: key, ...values,
    });
  }
}

// ───────────────────────────────────────────────────────────── flyers

export async function collectFlyers(svc: Services, db: DbLike, site: SiteRef & { hostname: string }, fetcher: SafeFetcher, links: string[], now: Date): Promise<{ flyers: number; items: number; messages: string[] }> {
  let flyerCount = 0;
  let itemCount = 0;
  const messages: string[] = [];
  for (const link of links.slice(0, 3)) {
    try {
      const res = await fetcher.fetch(link, { kind: 'pdf' });
      if (res.status !== 200) {
        messages.push(`Flyer ${link} returned HTTP ${res.status}`);
        continue;
      }
      const [dup] = await db.select().from(flyers).where(and(eq(flyers.siteId, site.id), eq(flyers.contentHash, res.contentHash)));
      if (dup) continue; // unchanged flyer: nothing new to extract
      const doc: EvidenceDoc = { url: res.url, fetchedAt: res.fetchedAt, httpStatus: res.status, contentType: res.contentType, contentHash: res.contentHash, bytes: res.body.length, snippet: 'Promotional flyer PDF', body: res.body };
      const evId = await recordEvidence(svc, db, { orgId: site.orgId, siteId: site.id, doc, method: 'flyer_pdf', version: '1.0' });
      const ex = await extractFlyer(res.body, { siteCurrency: site.currency, now });
      await db.insert(flyers).values({ orgId: site.orgId, siteId: site.id, url: res.url, contentHash: res.contentHash, title: ex.title, pageCount: ex.pageCount, status: ex.status, itemsFound: ex.items.length, needsReview: ex.items.filter((i) => i.needsReview).length, message: ex.message, evidenceId: evId });
      flyerCount++;
      messages.push(ex.message);
      for (const item of ex.items) {
        const key = `flyer:${shortHash(`${link}|${item.name}|${item.salePrice}|${item.originalPrice}`)}`;
        const pct = discountPct(item.originalPrice, item.salePrice);
        await db
          .insert(offers)
          .values({
            provenance: provenanceFor(),
            orgId: site.orgId, siteId: site.id, kind: 'flyer', title: item.name, description: item.rawLine, conditions: item.conditions, conditional: item.conditions.length > 0,
            productTitle: item.name, originalPrice: item.originalPrice, salePrice: item.salePrice, currency: item.currency, claimedDiscountPct: pct, verification: 'unverified',
            verificationReason: 'Flyer price: no price history is linked yet', validFrom: ex.validFrom, validTo: ex.validTo, firstSeenAt: now, lastSeenAt: now, status: 'active',
            sourceUrl: res.url, evidenceId: evId, extractionMethod: 'flyer_pdf', confidence: item.confidence, needsReview: item.needsReview, dedupeKey: key,
          })
          .onConflictDoUpdate({ target: [offers.orgId, offers.siteId, offers.dedupeKey], set: { lastSeenAt: now } });
        itemCount++;
      }
    } catch (e) {
      messages.push(`Flyer ${link}: ${(e as Error).message}`);
    }
  }
  return { flyers: flyerCount, items: itemCount, messages };
}

/** Expires offers whose stated validity has passed (independent of whether they are still shown). */
export async function expireOffers(db: DbLike, orgId: string, now: Date): Promise<number> {
  const r = await db
    .update(offers)
    .set({ status: 'expired' })
    .where(and(eq(offers.orgId, orgId), eq(offers.status, 'active'), lt(offers.validTo, now)))
    .returning({ id: offers.id });
  return r.length;
}

/** Offers that vanished from a COMPLETE scan accumulate misses; incomplete scans never end an offer. */
export async function sweepMissingSaleOffers(db: DbLike, siteId: string, scanRunId: string, now: Date): Promise<void> {
  const rows = await db.execute<{ id: string }>(sql`
    select o.id from offers o
    join variants v on v.id = o.variant_id
    join products p on p.id = v.product_id
    where o.site_id = ${siteId} and o.kind = 'sale_price' and o.status in ('active','presumed_ended')
      and (p.last_scan_run_id is distinct from ${scanRunId}::uuid)`);
  for (const r of rows.rows) {
    const [o] = await db.select().from(offers).where(eq(offers.id, r.id));
    if (!o) continue;
    const missed = o.missedCompleteScans + 1;
    const status = nextOfferStatus({ status: o.status, lastSeenAt: o.lastSeenAt, validTo: o.validTo, now, latestScanComplete: true, missedCompleteScans: missed });
    await db.update(offers).set({ missedCompleteScans: missed, status }).where(eq(offers.id, o.id));
  }
}

// ───────────────────────────────────────────────────────────── human review of uncertain readings

export interface OfferReviewResult {
  id: string;
  reviewStatus: OfferReviewStatus;
  needsReview: boolean;
}

/**
 * A person's verdict on an offer the machine read from a flyer or page. Confirming keeps the reading; correcting replaces the fields the
 * machine got wrong (the original reading is kept for audit); dismissing says it is not an offer at all. The verdict is permanent: collecting
 * the same flyer again only refreshes "last seen" and never overwrites it. Offers derived from structured product prices are facts about the
 * catalogue rather than readings, so they cannot be edited.
 */
export async function reviewOffer(db: DbLike, orgId: string, userId: string, offerId: string, input: OfferReviewInput, now: Date): Promise<OfferReviewResult> {
  const [o] = await db.select().from(offers).where(and(eq(offers.id, offerId), eq(offers.orgId, orgId)));
  if (!o) throw new ActionNotPossibleError('Offer not found.', 'not_found', {}, 404);
  if (!(REVIEWABLE_OFFER_KINDS as readonly string[]).includes(o.kind)) {
    throw new ActionNotPossibleError('This offer comes from the product’s own price, so there is nothing to review. If the price is wrong, the product page is wrong.', 'not_reviewable', {});
  }
  const base = { reviewedBy: userId, reviewedAt: now, reviewNote: input.note?.trim() || null, needsReview: false };
  if (input.action === 'confirm') {
    await db.update(offers).set({ ...base, reviewStatus: 'confirmed' }).where(eq(offers.id, o.id));
  } else if (input.action === 'dismiss') {
    await db.update(offers).set({ ...base, reviewStatus: 'dismissed' }).where(eq(offers.id, o.id));
  } else {
    const salePrice = input.salePrice ?? o.salePrice;
    const originalPrice = input.originalPrice ?? o.originalPrice;
    if (salePrice !== null && originalPrice !== null && originalPrice <= salePrice) {
      throw new ActionNotPossibleError('The original price must be higher than the sale price. Leave the original price empty if the offer does not state one.', 'invalid_prices', {}, 400);
    }
    const validFrom = input.validFrom === undefined ? o.validFrom : input.validFrom ? new Date(input.validFrom) : null;
    const validTo = input.validTo === undefined ? o.validTo : input.validTo ? new Date(input.validTo) : null;
    if (validFrom && validTo && validTo <= validFrom) throw new ActionNotPossibleError('The end date must be after the start date.', 'invalid_dates', {}, 400);
    const original = o.originalReading ?? { title: o.title, salePrice: o.salePrice, originalPrice: o.originalPrice, currency: o.currency, validFrom: o.validFrom?.toISOString() ?? null, validTo: o.validTo?.toISOString() ?? null };
    await db
      .update(offers)
      .set({
        ...base,
        reviewStatus: 'corrected',
        title: input.title ?? o.title,
        salePrice,
        originalPrice,
        currency: input.currency ?? o.currency,
        claimedDiscountPct: discountPct(originalPrice, salePrice),
        validFrom,
        validTo,
        verification: 'unverified',
        verificationReason: 'Corrected by a person after review; no price history is linked to this offer.',
        originalReading: original,
        confidence: 1,
      })
      .where(eq(offers.id, o.id));
  }
  await db.insert(auditEvents).values({ orgId, userId, action: `offer.${input.action}`, target: o.id, meta: { kind: o.kind, site: o.siteId } });
  const [after] = await db.select({ reviewStatus: offers.reviewStatus, needsReview: offers.needsReview }).from(offers).where(eq(offers.id, o.id));
  return { id: o.id, reviewStatus: after!.reviewStatus, needsReview: after!.needsReview };
}
