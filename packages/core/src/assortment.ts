import type { AssortmentBasis, SiteCoverage } from '@ci/shared';

/**
 * What "no equivalent found" can honestly be taken to mean. A product with no counterpart is only evidence that nobody else sells it when
 * the other catalogues were read completely and recently. When a competitor's catalogue is blocked, failed, never collected, or only
 * partly read, the same list says something much weaker — "not found in the part we could see" — and the report must say which.
 */
export function assortmentBasis(coverage: SiteCoverage[]): AssortmentBasis {
  const reason = (c: SiteCoverage): string => c.status?.detail || c.failureReason || (c.productsKnown === 0 ? 'nothing has been collected from it' : 'its catalogue was not read completely');
  const competitors = coverage.filter((c) => c.role === 'competitor');
  const source = coverage.find((c) => c.role === 'source') ?? null;
  const competitorGaps = competitors.filter((c) => !c.complete).map((c) => ({ siteId: c.siteId, name: c.name, reason: reason(c) }));
  return {
    competitorsComplete: competitors.length > 0 && competitorGaps.length === 0,
    competitorGaps,
    sourceComplete: !!source && !!source.complete,
    sourceGap: !source ? 'there is no source website' : source.complete ? null : reason(source),
  };
}

/** The sentence(s) shown with the "no equivalent" lists: the strongest claim the data supports, and no stronger. */
export function assortmentNote(b: AssortmentBasis, competitorCount: number): string {
  const parts: string[] = [];
  if (competitorCount === 0) parts.push('No competitor website is being compared yet, so nothing can be said about products with no equivalent.');
  else if (b.competitorsComplete) {
    parts.push('Every competitor catalogue was read completely, so a product of yours listed as having no equivalent was not found in any of them. Matching compares brand, name and size: a product listed under a very different name can still be missed.');
  } else {
    const who = b.competitorGaps.map((g) => `${g.name} (${g.reason.replace(/[.\s]+$/, '')})`).join('; ');
    parts.push(`Not every competitor catalogue was read completely — ${who}. A product of yours listed as having no equivalent may well be sold there: “no equivalent found” means “not found in what could be read”, not “nobody sells it”.`);
  }
  if (!b.sourceComplete) parts.push(`Your own catalogue was not read completely (${(b.sourceGap ?? '').replace(/[.\s]+$/, '')}), so a competitor product listed as missing from your shop may be one you do sell.`);
  return parts.join(' ');
}
