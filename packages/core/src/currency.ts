import type { PriceView, FxRateUsed } from '@ci/shared';
import { roundMoney } from './price.ts';

/** 1 `base` = `rate` `quote`. */
export interface FxRate {
  base: string;
  quote: string;
  rate: number;
  source: string;
  fetchedAt: string;
  /** True when the rate is a contractual/fixed peg rather than a market quote. */
  isFixed: boolean;
}

export interface Conversion {
  amount: number;
  rate: number;
  source: string;
  fetchedAt: string;
  isFixed: boolean;
  path: string[];
}

/**
 * Looks up rates between currencies directly, inversely, or through a USD pivot.
 * It NEVER falls back to 1.0: if no rate is known the conversion is `null` and callers must say so.
 */
export class FxTable {
  private readonly direct = new Map<string, FxRate>();
  readonly used = new Map<string, FxRateUsed>();

  constructor(rates: FxRate[]) {
    // Newest rate wins for a given pair.
    for (const r of [...rates].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
      if (r.rate > 0 && Number.isFinite(r.rate)) this.direct.set(`${r.base}>${r.quote}`, r);
    }
  }

  private leg(from: string, to: string): { rate: number; src: FxRate; inverted: boolean } | null {
    const d = this.direct.get(`${from}>${to}`);
    if (d) return { rate: d.rate, src: d, inverted: false };
    const i = this.direct.get(`${to}>${from}`);
    if (i) return { rate: 1 / i.rate, src: i, inverted: true };
    return null;
  }

  convert(amount: number, from: string | null, to: string): Conversion | null {
    if (!from) return null;
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) {
      return { amount, rate: 1, source: 'identity', fetchedAt: new Date(0).toISOString(), isFixed: true, path: [f] };
    }
    const one = this.leg(f, t);
    if (one) {
      this.record(f, t, one.rate, [one.src]);
      return this.build(amount, one.rate, [one.src], [f, t]);
    }
    const a = this.leg(f, 'USD');
    const b = this.leg('USD', t);
    if (a && b) {
      const rate = a.rate * b.rate;
      this.record(f, t, rate, [a.src, b.src]);
      return this.build(amount, rate, [a.src, b.src], [f, 'USD', t]);
    }
    return null;
  }

  private build(amount: number, rate: number, srcs: FxRate[], path: string[]): Conversion {
    const oldest = srcs.map((s) => s.fetchedAt).sort()[0]!;
    return {
      amount: roundMoney(amount * rate, 4),
      rate,
      source: [...new Set(srcs.map((s) => s.source))].join('+'),
      fetchedAt: oldest,
      isFixed: srcs.every((s) => s.isFixed),
      path,
    };
  }

  private record(from: string, to: string, rate: number, srcs: FxRate[]) {
    this.used.set(`${from}>${to}`, {
      from,
      to,
      rate,
      source: [...new Set(srcs.map((s) => s.source))].join('+'),
      fetchedAt: srcs.map((s) => s.fetchedAt).sort()[0]!,
      isFixed: srcs.every((s) => s.isFixed),
    });
  }

  usedRates(): FxRateUsed[] {
    return [...this.used.values()];
  }
}

export function isStale(observedAt: string | Date | null | undefined, now: Date, staleAfterHours: number): boolean {
  if (!observedAt) return true;
  const t = new Date(observedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > staleAfterHours * 3_600_000;
}

export interface PriceViewInput {
  amount: number | null;
  compareAt: number | null;
  currency: string | null;
  observedAt: string | Date | null;
  sourceUrl: string | null;
  observationId: string | null;
}

/** Build the audit-friendly price view: original values preserved, normalised value + FX provenance added. */
export function buildPriceView(
  input: PriceViewInput,
  reportingCurrency: string,
  fx: FxTable,
  now: Date,
  staleAfterHours: number,
): PriceView {
  const observedAtIso = input.observedAt ? new Date(input.observedAt).toISOString() : null;
  let normalized: number | null = null;
  let fxRate: number | null = null;
  let fxSource: string | null = null;
  let fxAt: string | null = null;
  if (input.amount !== null) {
    const c = fx.convert(input.amount, input.currency, reportingCurrency);
    if (c) {
      normalized = roundMoney(c.amount, 4);
      fxRate = c.rate;
      fxSource = c.source;
      fxAt = c.fetchedAt;
    }
  }
  return {
    amount: input.amount,
    currency: input.currency,
    compareAt: input.compareAt,
    normalized,
    normalizedCurrency: reportingCurrency,
    fxRate,
    fxSource,
    fxAt,
    observedAt: observedAtIso,
    stale: isStale(observedAtIso, now, staleAfterHours),
    sourceUrl: input.sourceUrl,
    observationId: input.observationId,
  };
}

/** Official Aruban florin peg (Centrale Bank van Aruba): 1 USD = 1.79 AWG since 1986. Explicit, timestamped, overridable. */
export const AWG_PEG_PER_USD = 1.79;

export function pegRates(now: Date = new Date()): FxRate[] {
  return [
    {
      base: 'USD',
      quote: 'AWG',
      rate: AWG_PEG_PER_USD,
      source: 'Central Bank of Aruba official peg',
      fetchedAt: now.toISOString(),
      isFixed: true,
    },
  ];
}
