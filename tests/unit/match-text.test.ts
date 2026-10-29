import { describe, expect, it } from 'vitest';
import { awaitingNote, comparisonEmpty, matchStateMessage, type MatchSummaryView } from '../../apps/web/src/match-text.ts';

const counts = { awaiting: 0, unclear: 0, confirmedSame: 0, confirmedSubstitutes: 0, confirmedRelated: 0, rejected: 0, needLookAgain: 0, setAside: 0 };
const base = (over: Partial<MatchSummaryView>): Pick<MatchSummaryView, 'state' | 'counts' | 'catalogue' | 'withoutCounterpart' | 'lastRun'> => ({
  state: 'ok', counts, catalogue: { yourProducts: 100, competitorProducts: 400, competitorWebsites: 2 }, withoutCounterpart: null, lastRun: null, ...over,
});

describe('what the pages say when there is nothing to show', () => {
  it('never says "everything is reviewed" when nothing was ever suggested', () => {
    for (const state of ['never_run', 'shadow', 'no_candidates', 'no_competitors'] as const) {
      const m = matchStateMessage(base({ state }));
      expect(`${m.title} ${m.body}`).not.toMatch(/every suggestion has been decided|all reviewed/i);
    }
  });
  it('tells "matching has not run" apart from "matching ran and found nothing" and from "the new matcher is only being tested"', () => {
    expect(matchStateMessage(base({ state: 'never_run' })).title).toMatch(/has not run/i);
    expect(matchStateMessage(base({ state: 'shadow' })).title).toMatch(/tested/i);
    const none = matchStateMessage(base({ state: 'no_candidates', withoutCounterpart: 100 }));
    expect(none.title).toMatch(/found nothing/i);
    expect(none.body).toMatch(/100 of your products have no counterpart among the 400 competitor products/);
  });
  it('says "decided" only when something was suggested and decided', () => {
    const done = matchStateMessage(base({ state: 'ok', counts: { ...counts, confirmedSame: 7, rejected: 2 } }));
    expect(done.title).toMatch(/decided/i);
    expect(done.body).toMatch(/confirmed 7 pairs and rejected 2/);
    expect(matchStateMessage(base({ state: 'none_confirmed', counts: { ...counts, awaiting: 12 } })).body).toMatch(/12 suggestions wait/);
  });
  it('the price comparison explains why it is empty, separately for the same-product view and the substitute view', () => {
    const waiting = { state: 'none_confirmed' as const, awaiting: 9, confirmedSame: 0, confirmedSubstitutes: 0, withoutCounterpart: null };
    expect(comparisonEmpty('prices', waiting, true).body).toMatch(/9 suggested pairs wait for your decision/);
    expect(comparisonEmpty('substitutes', waiting, true).title).toMatch(/no confirmed substitutes/i);
    expect(comparisonEmpty('prices', waiting, false).body).toMatch(/nothing to compare yet/i);
    expect(comparisonEmpty('prices', { ...waiting, state: 'no_candidates', awaiting: 0, withoutCounterpart: 30 }, true).body).toMatch(/does not mean everything was reviewed/i);
  });
  it('mentions unconfirmed suggestions above a comparison, and stays silent when there are none', () => {
    expect(awaitingNote(0)).toBeNull();
    expect(awaitingNote(1)).toMatch(/1 suggested pair is waiting.*not shown here/);
    expect(awaitingNote(4)).toMatch(/4 suggested pairs are waiting/);
  });
});
