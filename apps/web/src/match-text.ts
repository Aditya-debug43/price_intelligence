/**
 * What the Match review and Price comparison pages say when there is nothing to show. The wording separates three different situations that look
 * the same on screen — and must never be confused: nothing was suggested, things were suggested but none is confirmed, and products that have no
 * reliable counterpart. "Everything is reviewed" is only ever said when something was suggested and has been decided.
 */
export interface MatchSummaryView {
  engine: 'v1' | 'v2_shadow' | 'v2';
  lastRun: { id: string; engine: string; engineVersion: string | null; startedAt: string; finishedAt: string | null; error: string | null; stats: Record<string, unknown> } | null;
  counts: { awaiting: number; awaitingProductPairs?: number; unclear: number; confirmedSame: number; confirmedSubstitutes: number; confirmedRelated: number; rejected: number; needLookAgain: number; setAside: number };
  catalogue: { yourProducts: number; competitorProducts: number; competitorWebsites: number };
  state: 'no_competitors' | 'never_run' | 'shadow' | 'no_candidates' | 'none_confirmed' | 'ok';
  withoutCounterpart: number | null;
}

export function matchStateMessage(s: Pick<MatchSummaryView, 'state' | 'counts' | 'catalogue' | 'withoutCounterpart' | 'lastRun'>): { title: string; body: string } {
  switch (s.state) {
    case 'no_competitors':
      return { title: 'No competitor products to match yet', body: 'No competitor website has been collected, so there is nothing to compare your products with. This says nothing about your prices.' };
    case 'never_run':
      return { title: 'Matching has not run yet', body: 'Nothing has been suggested because matching has not been run on this workspace. Use “Run matching again” to look for the same or similar products at your competitors.' };
    case 'shadow':
      return { title: 'The new matcher is being tested', body: 'It records what it would suggest but changes nothing you see here, so this list is empty on purpose. Nothing is wrong with your data.' };
    case 'no_candidates': {
      const without = s.withoutCounterpart !== null ? ` ${s.withoutCounterpart} of your products have no counterpart among the ${s.catalogue.competitorProducts} competitor products collected.` : '';
      return {
        title: 'Matching ran but found nothing to suggest',
        body: `This is not “everything reviewed”: no pair was proposed. Either your competitors do not sell comparable products, or their listings say too little to compare (no barcode, brand, size or part number).${without}`,
      };
    }
    case 'none_confirmed':
      return s.counts.awaiting > 0
        ? { title: 'Suggestions are waiting for you', body: `${s.counts.awaiting} suggestions wait for your decision. None is confirmed yet, so nothing is compared.` }
        : { title: 'Nothing is waiting, and nothing is confirmed', body: 'Every suggestion was rejected or set aside. No product pair is confirmed, so no comparison is shown.' };
    default:
      return s.counts.awaiting > 0
        ? { title: 'Suggestions are waiting for you', body: `${s.counts.awaiting} suggestions wait for your decision.` }
        : { title: 'Every suggestion has been decided', body: `You have confirmed ${s.counts.confirmedSame + s.counts.confirmedSubstitutes} pairs and rejected ${s.counts.rejected}. New suggestions appear here after the next matching run.` };
  }
}

/** The line shown above the price comparison when suggestions exist that are not in it. */
export function awaitingNote(awaiting: number): string | null {
  if (awaiting <= 0) return null;
  return `${awaiting} suggested pair${awaiting === 1 ? '' : 's'} ${awaiting === 1 ? 'is' : 'are'} waiting for your decision in Match review and ${awaiting === 1 ? 'is' : 'are'} not shown here. Only pairs you have confirmed are compared.`;
}

/** Why a comparison view is empty, for the two views. */
export function comparisonEmpty(view: 'prices' | 'substitutes', m: { state: MatchSummaryView['state']; awaiting: number; confirmedSame: number; confirmedSubstitutes: number; withoutCounterpart: number | null }, collected: boolean): { title: string; body: string } {
  if (!collected) return { title: 'No comparisons yet', body: 'No competitor website has been collected, so there is nothing to compare yet. This is not a result about your prices.' };
  if (view === 'substitutes') {
    if (m.confirmedSubstitutes === 0 && m.awaiting > 0) return { title: 'No confirmed substitutes yet', body: `${m.awaiting} suggestions wait for your decision in Match review. A substitute appears here only after you confirm it as one.` };
    return { title: 'No confirmed substitutes', body: 'A substitute is a different product that can stand in for yours. None has been confirmed. Substitutes are never shown as the same product.' };
  }
  switch (m.state) {
    case 'never_run': return { title: 'No comparisons yet', body: 'Matching has not run, so no products have been paired. Run it from Match review.' };
    case 'shadow': return { title: 'No comparisons yet', body: 'The new matcher is being tested and has not been switched on, so nothing new is paired.' };
    case 'no_candidates': return { title: 'No comparisons yet', body: `Matching ran but proposed no pairs${m.withoutCounterpart !== null ? ` (${m.withoutCounterpart} of your products have no counterpart among the collected competitor products)` : ''}. This does not mean everything was reviewed.` };
    default:
      return m.awaiting > 0
        ? { title: 'Nothing confirmed yet', body: `${m.awaiting} suggested pairs wait for your decision in Match review. Only pairs you have confirmed as the same product are compared.` }
        : { title: 'No comparisons yet', body: 'No pair is confirmed as the same product. Confirmed substitutes have their own tab.' };
  }
}
