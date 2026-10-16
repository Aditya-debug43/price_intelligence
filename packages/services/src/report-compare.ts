import { roundMoney } from '@ci/core';
import type { ReportData, ReportKpis } from '@ci/shared';

export interface ReportComparison {
  a: { periodDate: string; generatedAt: string; isPartial: boolean };
  b: { periodDate: string; generatedAt: string; isPartial: boolean };
  kpiDelta: { key: keyof ReportKpis; a: number | null; b: number | null; delta: number | null }[];
  priceChanges: { title: string; site: string; role: 'source' | 'competitor'; a: number | null; b: number | null; currency: string; changePct: number | null }[];
  offers: { new: string[]; ended: string[] };
  insights: { new: { title: string; score: number }[]; resolved: { title: string; score: number }[] };
  notes: string[];
}

/** Compares two saved snapshots. Only snapshot content is used, so the result is reproducible. */
export function compareReports(a: ReportData, b: ReportData): ReportComparison {
  const kpiKeys = Object.keys(a.kpis) as (keyof ReportKpis)[];
  const kpiDelta = kpiKeys.map((key) => {
    const av = a.kpis[key];
    const bv = b.kpis[key];
    return { key, a: av, b: bv, delta: av !== null && bv !== null ? roundMoney(bv - av, 2) : null };
  });

  // Normalised (reporting-currency) prices keyed by product + site so differing currencies still compare.
  const priceMap = (d: ReportData) => {
    const m = new Map<string, { title: string; site: string; role: 'source' | 'competitor'; price: number | null }>();
    for (const r of d.comparisons) {
      m.set(`${r.sourceVariantId}|source`, { title: r.title, site: d.sites.find((s) => s.role === 'source')?.name ?? 'Your shop', role: 'source', price: r.sourcePrice.normalized });
      for (const c of r.cells) m.set(`${c.variantId}|c`, { title: c.title, site: c.siteName, role: 'competitor', price: c.price.normalized });
    }
    return m;
  };
  const pa = priceMap(a);
  const pb = priceMap(b);
  const priceChanges: ReportComparison['priceChanges'] = [];
  for (const [k, vb] of pb) {
    const va = pa.get(k);
    if (!va || va.price === null || vb.price === null || va.price === vb.price) continue;
    priceChanges.push({ title: vb.title, site: vb.site, role: vb.role, a: va.price, b: vb.price, currency: b.meta.reportingCurrency, changePct: va.price > 0 ? roundMoney(((vb.price - va.price) / va.price) * 100, 2) : null });
  }
  priceChanges.sort((x, y) => Math.abs(y.changePct ?? 0) - Math.abs(x.changePct ?? 0));

  const offerKey = (o: ReportData['offers'][number]) => `${o.siteId}|${o.kind}|${o.title}`;
  const activeA = new Set(a.offers.filter((o) => o.status === 'active').map(offerKey));
  const activeB = new Set(b.offers.filter((o) => o.status === 'active').map(offerKey));
  const titleOf = (key: string) => key.split('|').slice(2).join('|');

  const ia = new Map(a.insights.map((i) => [i.id, i]));
  const ib = new Map(b.insights.map((i) => [i.id, i]));
  const notes: string[] = [];
  if (a.meta.isPartial || b.meta.isPartial) notes.push('At least one of the reports is partial; differences may reflect missing data rather than real changes.');
  if (a.meta.reportingCurrency !== b.meta.reportingCurrency) notes.push('The reports use different reporting currencies; price changes are not comparable.');

  return {
    a: { periodDate: a.meta.periodDate, generatedAt: a.meta.generatedAt, isPartial: a.meta.isPartial },
    b: { periodDate: b.meta.periodDate, generatedAt: b.meta.generatedAt, isPartial: b.meta.isPartial },
    kpiDelta,
    priceChanges: priceChanges.slice(0, 200),
    offers: { new: [...activeB].filter((k) => !activeA.has(k)).map(titleOf).slice(0, 50), ended: [...activeA].filter((k) => !activeB.has(k)).map(titleOf).slice(0, 50) },
    insights: {
      new: [...ib.values()].filter((i) => !ia.has(i.id)).slice(0, 30).map((i) => ({ title: i.title, score: i.score })),
      resolved: [...ia.values()].filter((i) => !ib.has(i.id)).slice(0, 30).map((i) => ({ title: i.title, score: i.score })),
    },
    notes,
  };
}
