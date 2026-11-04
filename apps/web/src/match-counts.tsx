import type { MatchCounts } from '@ci/shared';

const KINDS = [
  ['exact', 'The same product'],
  ['variant', 'Same product, different pack'],
  ['equivalent', 'Compatible equivalent'],
  ['substitute', 'Substitute'],
  ['related', 'Related only'],
] as const;

const n = (v: number) => v.toLocaleString();

/**
 * What the matching numbers count, side by side and never added together. A PAIR is one of your variants against one competitor variant, so a variant with three candidates is three pairs but one
 * variant; a parent product can hold several variants. Every figure says which of these it counts.
 */
export function MatchCountsPanel({ counts: c }: { counts: MatchCounts }) {
  return (
    <details className="ev" open>
      <summary><b>What these numbers count</b></summary>
      <p className="small muted" style={{ margin: '6px 0' }}>
        You sell <b>{n(c.ownParentProducts)} parent products</b> in <b>{n(c.ownVariants)} sellable variants</b>. A <b>pair</b> is one of your variants set against one competitor variant, so the pair columns can add up to far more than the variants: they must not be added together or read as “products”.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Kind of relationship</th><th className="r">Confirmed pairs</th><th className="r">Suggested pairs</th><th className="r">Your variants with a confirmed one</th><th className="r">Your variants with a suggested one</th></tr></thead>
          <tbody>
            {KINDS.map(([k, label]) => (
              <tr key={k}><td>{label}</td><td className="r num">{n(c.confirmedPairs[k])}</td><td className="r num">{n(c.suggestedPairs[k])}</td><td className="r num">{n(c.confirmedOwnVariants[k])}</td><td className="r num">{n(c.suggestedOwnVariants[k])}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        <li><b>{n(c.ownVariantsWithConfirmed)}</b> of your variants ({n(c.ownProductsWithConfirmed)} parent products) have a confirmed relationship of some kind.</li>
        <li><b>{n(c.directlyComparableOwnVariants)}</b> of your variants ({n(c.directlyComparableOwnProducts)} parent products) have a confirmed identical-item pair whose packs are verified: these can enter the headline price position.</li>
        <li><b>{n(c.uncertainOwnVariants)}</b> of your variants have only related or unclear pairs; <b>{n(c.noCounterpartOwnVariants)}</b> have no counterpart found at all (this is not a finding that none exists).</li>
      </ul>
    </details>
  );
}
