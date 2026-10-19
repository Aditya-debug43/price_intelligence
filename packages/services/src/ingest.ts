import { and, eq, inArray } from 'drizzle-orm';
import { detectUniformCompareAt, parseQuantity, reinterpretOzForBeverage, type UniformCompareAt } from '@ci/core';
import type { ConnectorBatch, EvidenceDoc, ExtractedProduct, ExtractedVariant } from '@ci/connectors';
import { offers, priceObservations, products, stockObservations, variants, type DbLike, type Db } from '@ci/database';
import type { Services } from './context.ts';
import { recordEvidence } from './evidence.ts';
import { tagContext } from './matching.ts';
import { trackSalePrice } from './promotions.ts';
import { applyStockObservation, hasFreshAuthorisedStock } from './stock.ts';
import { provenanceFor } from './workspace.ts';

export interface IngestSite {
  id: string;
  orgId: string;
  name: string;
  origin: string;
  role: 'source' | 'competitor';
  currency: string | null;
}

export interface IngestContext {
  svc: Services;
  site: IngestSite;
  scanRunId: string;
  threshold: number;
  /** Alerts created during this scan; emailed as ONE digest when the scan ends. */
  alertIds: string[];
  /** Once one batch of a run shows a standing "regular price" display, the rest of the run is treated the same (a short last batch cannot show the pattern on its own). */
  uniformCompareAt?: UniformCompareAt;
}

export interface IngestResult {
  products: number;
  variants: number;
  newProducts: number;
  evidenceIds: string[];
  /** Set when nearly every product in the batch showed a higher "regular" price at about the same percentage (a standing display, not sales). */
  uniformCompareAt?: UniformCompareAt;
}

const chunk = <T>(arr: T[], n: number): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

/** Merge duplicates (same canonical URL) inside one batch: variants are unioned by key. */
function dedupe(list: ExtractedProduct[]): ExtractedProduct[] {
  const byUrl = new Map<string, ExtractedProduct>();
  for (const p of list) {
    const cur = byUrl.get(p.url);
    if (!cur) {
      byUrl.set(p.url, { ...p, variants: dedupeVariants(p.variants) });
    } else {
      cur.variants = dedupeVariants([...cur.variants, ...p.variants]);
    }
  }
  return [...byUrl.values()];
}
function dedupeVariants(vs: ExtractedVariant[]): ExtractedVariant[] {
  const seen = new Map<string, ExtractedVariant>();
  for (const v of vs) if (!seen.has(v.variantKey)) seen.set(v.variantKey, v);
  return [...seen.values()];
}

export async function ingestBatch(ic: IngestContext, batch: ConnectorBatch): Promise<IngestResult> {
  const { svc, site } = ic;
  const list = dedupe(batch.products);
  // A price of 0 is not a price: it is how a shop lists a gift card whose amount the buyer chooses, or an item that is not for sale. Stored as "no price".
  for (const p of list) for (const v of p.variants) if (v.price !== null && v.price <= 0) { v.price = null; v.compareAtPrice = null; }
  const uniformCompareAt = detectUniformCompareAt(list.flatMap((p) => p.variants.map((v) => ({ price: v.price, compareAt: v.compareAtPrice })))) ?? ic.uniformCompareAt;
  if (uniformCompareAt) ic.uniformCompareAt = uniformCompareAt;
  const evidenceIds: string[] = [];
  for (const doc of batch.evidence) {
    // Evidence is recorded outside the batch transaction: a retry must not lose the fact that a page was fetched.
    const method = list.find((p) => batch.evidence[p.evidenceIndex] === doc)?.method ?? null;
    evidenceIds.push(await recordEvidence(svc, svc.db, { orgId: site.orgId, siteId: site.id, doc: doc as EvidenceDoc, method, version: list[0]?.methodVersion ?? null }));
  }
  if (!list.length) return { products: 0, variants: 0, newProducts: 0, evidenceIds };
  const result = (r: IngestResult): IngestResult => ({ ...r, ...(uniformCompareAt ? { uniformCompareAt } : {}) });

  return svc.db.transaction(async (tx) => {
    const db = tx as unknown as DbLike;
    let newProducts = 0;
    let variantCount = 0;

    // existing products by canonical URL
    const existingProducts = new Map<string, typeof products.$inferSelect>();
    for (const part of chunk(list.map((p) => p.url), 400)) {
      const rows = await db.select().from(products).where(and(eq(products.siteId, site.id), inArray(products.canonicalUrl, part)));
      for (const r of rows) existingProducts.set(r.canonicalUrl, r);
    }

    const productIds = new Map<string, string>();
    for (const p of list) {
      const ex = existingProducts.get(p.url);
      const attrs = { ...p.attrs, quality: p.quality };
      if (ex) {
        await db
          .update(products)
          .set({
            title: p.title,
            brand: p.brand ?? ex.brand,
            manufacturer: p.manufacturer ?? ex.manufacturer,
            model: p.model ?? ex.model,
            mpn: p.mpn ?? ex.mpn,
            description: p.description ?? ex.description,
            category: p.category ?? ex.category,
            imageUrl: p.imageUrl ?? ex.imageUrl,
            externalId: p.externalId ?? ex.externalId,
            attrs,
            extractionMethod: p.method,
            extractionVersion: p.methodVersion,
            lastSeenAt: p.observedAt,
            lastScanRunId: ic.scanRunId,
            missedCompleteScans: 0,
            delistedAt: null,
          })
          .where(eq(products.id, ex.id));
        productIds.set(p.url, ex.id);
      } else {
        const [row] = await db
          .insert(products)
          .values({
            orgId: site.orgId, siteId: site.id, canonicalUrl: p.url, externalId: p.externalId, title: p.title, brand: p.brand, manufacturer: p.manufacturer, model: p.model, mpn: p.mpn,
            description: p.description, category: p.category, imageUrl: p.imageUrl, attrs, extractionMethod: p.method, extractionVersion: p.methodVersion,
            firstSeenAt: p.observedAt, lastSeenAt: p.observedAt, lastScanRunId: ic.scanRunId,
          })
          .returning({ id: products.id });
        productIds.set(p.url, row!.id);
        newProducts++;
      }
    }

    // existing variants for these products
    const existingVariants = new Map<string, typeof variants.$inferSelect>();
    for (const part of chunk([...productIds.values()], 400)) {
      const rows = await db.select().from(variants).where(inArray(variants.productId, part));
      for (const r of rows) existingVariants.set(`${r.productId}|${r.variantKey}`, r);
    }

    const touched: { variantId: string; product: ExtractedProduct; v: ExtractedVariant; evidenceId: string | null; fresh: boolean }[] = [];
    for (const p of list) {
      const productId = productIds.get(p.url)!;
      const evidenceId = evidenceIds[p.evidenceIndex] ?? null;
      for (const v of p.variants) {
        const qty = reinterpretOzForBeverage(parseQuantity(p.title, v.title, typeof p.attrs['size'] === 'string' ? (p.attrs['size'] as string) : null), `${p.title} ${p.category ?? ''} ${tagContext(p.attrs) ?? ''}`);
        const ex = existingVariants.get(`${productId}|${v.variantKey}`);
        const currency = v.currency ?? site.currency ?? ex?.currency ?? null;
        const priceChanged = !ex || ex.price !== v.price || ex.currency !== currency;
        const base = {
          sku: v.sku ?? ex?.sku ?? null,
          gtin: v.gtin ?? ex?.gtin ?? null,
          title: v.title,
          options: v.options,
          qtyKind: qty.kind === 'unknown' ? null : qty.kind,
          qtyTotal: qty.total,
          qtyLabel: qty.label,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          currency,
          shippingCost: v.shippingCost,
          availability: v.availability,
          observedAt: p.observedAt,
          lastSeenAt: p.observedAt,
          url: v.url,
          ...(priceChanged ? { lastPriceChangeAt: p.observedAt } : {}),
        };
        let variantId: string;
        if (ex) {
          // An exact public quantity claim is only stored when the site actually states one; otherwise keep what authorised sync set.
          const quantityPatch = v.quantity !== null ? { quantity: v.quantity, quantitySource: v.quantitySource } : ex.quantitySource === 'public_claim' ? { quantity: null, quantitySource: null } : {};
          await db.update(variants).set({ ...base, ...quantityPatch }).where(eq(variants.id, ex.id));
          variantId = ex.id;
        } else {
          const [row] = await db
            .insert(variants)
            .values({ orgId: site.orgId, siteId: site.id, productId, variantKey: v.variantKey, firstSeenAt: p.observedAt, quantity: v.quantity, quantitySource: v.quantitySource, ...base })
            .returning({ id: variants.id });
          variantId = row!.id;
        }
        variantCount++;

        const [obs] = await db
          .insert(priceObservations)
          .values({
            orgId: site.orgId, siteId: site.id, variantId, observedAt: p.observedAt, price: v.price, compareAtPrice: v.compareAtPrice, currency, shippingCost: v.shippingCost,
            availability: v.availability, sourceUrl: v.url, evidenceId, scanRunId: ic.scanRunId, extractionMethod: p.method, extractionVersion: p.methodVersion,
            provenance: provenanceFor(),
          })
          .returning({ id: priceObservations.id });
        await db.update(variants).set({ currentPriceObservationId: obs!.id }).where(eq(variants.id, variantId));

        // Competitor stock rows are stored for comparison reports; they never raise customer alerts.
        if (site.role === 'competitor') {
          await db.insert(stockObservations).values({
            orgId: site.orgId, siteId: site.id, variantId, observedAt: p.observedAt, availability: v.availability, quantity: v.quantity, quantitySource: v.quantitySource, tracked: true, evidenceId, scanRunId: ic.scanRunId,
            provenance: provenanceFor({ quantitySource: v.quantitySource }),
          });
        }
        touched.push({ variantId, product: p, v: { ...v, currency }, evidenceId, fresh: false });
      }
    }

    // Sale / compare-at tracking (any site), verified against the product's own history.
    if (uniformCompareAt) {
      // Not promotions: stop tracking any sale that an earlier look recorded for these variants, and do not start new ones.
      const keys = touched.map((t) => `sale:${t.variantId}`);
      for (const part of chunk(keys, 400)) await db.update(offers).set({ status: 'ended', missedCompleteScans: 0 }).where(and(eq(offers.siteId, site.id), inArray(offers.dedupeKey, part), inArray(offers.status, ['active', 'presumed_ended'])));
    }
    for (const t of uniformCompareAt ? [] : touched) {
      await trackSalePrice(db, site, {
        variantId: t.variantId, title: t.product.title, url: t.v.url, price: t.v.price, compareAt: t.v.compareAtPrice, currency: t.v.currency, observedAt: t.product.observedAt, evidenceId: t.evidenceId, extractionMethod: t.product.method,
      });
    }

    // Own-site stock: public availability mode, with alert transitions (never for competitors).
    if (site.role === 'source') {
      const skip = await hasFreshAuthorisedStock(db, touched.map((t) => t.variantId), svc.clock());
      const vrows = await db.select({ id: variants.id, threshold: variants.lowStockThreshold }).from(variants).where(inArray(variants.id, touched.map((t) => t.variantId)));
      const thresholdBy = new Map(vrows.map((r) => [r.id, r.threshold]));
      for (const t of touched) {
        if (skip.has(t.variantId)) continue;
        const title = t.v.title && t.v.title !== t.product.title ? `${t.product.title} (${t.v.title})` : t.product.title;
        const r = await applyStockObservation(db, {
          orgId: site.orgId, siteId: site.id, variantId: t.variantId, title, availability: t.v.availability, quantity: t.v.quantity, quantitySource: t.v.quantitySource, tracked: true,
          threshold: thresholdBy.get(t.variantId) ?? ic.threshold, observedAt: t.product.observedAt, evidenceId: t.evidenceId, scanRunId: ic.scanRunId,
        });
        ic.alertIds.push(...r.alertIds);
      }
    }
    return result({ products: list.length, variants: variantCount, newProducts, evidenceIds });
  });
}

export type { Db };
