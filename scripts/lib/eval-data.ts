import fs from 'node:fs';
import { isPlaceholderBrand, placeholderBrandKeys, sizeHintOf, type DossierInput } from '@ci/core';

export interface Row {
  variantId: string; productId: string; siteId: string; role: 'source' | 'competitor'; site: string; title: string; variantTitle: string | null; brand: string | null; category: string | null; gtin: string | null; sku: string | null;
  mpn: string | null; model: string | null; qtyLabel: string | null; attrs: Record<string, unknown> | null; options?: Record<string, string> | null;
}
export interface Decision { source: string; competitor: string; status: 'accepted' | 'rejected'; matchClass?: string }

const tags = (a: Record<string, unknown> | null | undefined) => (Array.isArray(a?.['tags']) ? (a!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []);

/** Exactly the mapping the matching job does (placeholder vendors are not brands), from an exported dataset. */
export function loadDataset(path: string) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  // product descriptions are exported next to the dataset (dataset-<name>.json -> desc-<name>.json); set NO_DESC=1 to leave them out
  const descPath = path.replace(/dataset-([^/\\]+)\.json$/, 'desc-$1.json');
  const descriptions: Record<string, string> = !process.env['NO_DESC'] && descPath !== path && fs.existsSync(descPath) ? JSON.parse(fs.readFileSync(descPath, 'utf8')) : {};
  const rows: Row[] = Array.isArray(raw) ? raw : raw.rows;
  const decisions: Decision[] = (Array.isArray(raw) ? [] : raw.decisions) ?? [];
  const placeholders = placeholderBrandKeys(rows.map((r) => ({ siteId: r.siteId, brand: r.brand, title: r.title })));
  const inputs: (DossierInput & { role: 'source' | 'competitor' })[] = rows.map((r) => ({
    variantId: r.variantId, productId: r.productId, siteId: r.siteId, role: r.role, title: r.title, variantTitle: r.variantTitle, brand: isPlaceholderBrand(placeholders, r.siteId, r.brand) ? null : r.brand, category: r.category,
    gtin: r.gtin, sku: r.sku, mpn: r.mpn, model: r.model, sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tags(r.attrs).join(' ') || null, options: r.options ?? {}, tags: tags(r.attrs), description: descriptions[r.productId] ?? null,
  }));
  return {
    rows, decisions, inputs,
    sources: inputs.filter((i) => i.role === 'source'), competitors: inputs.filter((i) => i.role === 'competitor'),
    productOf: new Map(rows.map((r) => [r.variantId, r.productId])), siteOf: new Map(rows.map((r) => [r.productId, r.site])),
    sourceProducts: new Set(rows.filter((r) => r.role === 'source').map((r) => r.productId)),
  };
}
