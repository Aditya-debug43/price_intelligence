import { desc } from 'drizzle-orm';
import { FxTable, pegRates, type FxRate } from '@ci/core';
import { fetchOpenErApiRates } from '@ci/connectors';
import { exchangeRates, type DbLike } from '@ci/database';
import type { Services } from './context.ts';

const PEG_SOURCE = 'Central Bank of Aruba official peg (1 USD = 1.79 AWG since 1986)';

/** Seeds the explicit, fixed AWG/USD peg once. It is a documented constant, never a silent assumption in calculations. */
export async function ensureFxRates(svc: Pick<Services, 'db' | 'clock'>): Promise<void> {
  const existing = await svc.db.select().from(exchangeRates).limit(1);
  if (existing.length) return;
  const peg = pegRates(svc.clock())[0]!;
  await svc.db.insert(exchangeRates).values({ base: peg.base, quote: peg.quote, rate: peg.rate, source: PEG_SOURCE, isFixed: true, provenance: 'configuration', fetchedAt: svc.clock() });
}

/** Optional market rates (FX_PROVIDER=open-er-api). The AWG peg stays authoritative for AWG. */
export async function refreshMarketRates(svc: Pick<Services, 'db' | 'clock' | 'config' | 'log'>): Promise<number> {
  if (svc.config.FX_PROVIDER !== 'open-er-api') return 0;
  const rates = await fetchOpenErApiRates(svc.clock());
  const rows = rates.filter((r) => r.quote !== 'AWG').map((r) => ({ base: r.base, quote: r.quote, rate: r.rate, source: r.source, isFixed: false, provenance: 'exchange_rate_service' as const, fetchedAt: new Date(r.fetchedAt) }));
  if (rows.length) await svc.db.insert(exchangeRates).values(rows);
  svc.log.info('market exchange rates refreshed', { count: rows.length });
  return rows.length;
}

/** Newest rate per currency pair. The returned table never invents a rate; unknown pairs convert to null. */
export async function loadFxTable(db: DbLike, _now: Date = new Date()): Promise<FxTable> {
  const rows = await db.select().from(exchangeRates).orderBy(desc(exchangeRates.fetchedAt)).limit(2000);
  const seen = new Set<string>();
  const rates: FxRate[] = [];
  for (const r of rows) {
    const key = `${r.base}>${r.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rates.push({ base: r.base, quote: r.quote, rate: r.rate, source: r.source, fetchedAt: r.fetchedAt.toISOString(), isFixed: r.isFixed });
  }
  return new FxTable(rates);
}
