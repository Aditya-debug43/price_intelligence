import type { Availability, QuantitySource, StockState } from '@ci/shared';

/**
 * Stock classification and alert-transition logic for the customer's OWN site.
 * Invariants (all unit-tested):
 *  - unknown stock is never converted to in_stock;
 *  - an exact quantity is only ever reported when the input carries one from an authorised source or an explicit public claim;
 *  - an alert fires only on a transition, never for a repeated identical state;
 *  - transitions are evaluated against the last KNOWN state, so a transient "unknown" does not cause duplicates.
 */

export interface StockInput {
  availability: Availability;
  quantity: number | null;
  quantitySource: QuantitySource | null;
  /** Authorised inventory only: false => the merchant does not track inventory for this item. */
  tracked: boolean;
}

export interface Classification {
  state: StockState;
  /** How the state was derived, shown to the customer. */
  basis: 'authorised_quantity' | 'public_quantity_claim' | 'public_limited_flag' | 'public_availability' | 'none';
  quantity: number | null;
}

export function classifyStock(input: StockInput, threshold: number): Classification {
  const hasQty = input.quantity !== null && Number.isFinite(input.quantity) && input.tracked;
  if (hasQty) {
    const q = input.quantity as number;
    const basis =
      input.quantitySource === 'authorised_inventory' ? 'authorised_quantity' : 'public_quantity_claim';
    if (q <= 0) return { state: 'out_of_stock', basis, quantity: q };
    if (q <= threshold) return { state: 'low_stock', basis, quantity: q };
    return { state: 'in_stock', basis, quantity: q };
  }
  switch (input.availability) {
    case 'in_stock':
      return { state: 'in_stock', basis: 'public_availability', quantity: null };
    case 'out_of_stock':
      return { state: 'out_of_stock', basis: 'public_availability', quantity: null };
    case 'limited':
      // The retailer itself flags limited availability. No unit count is implied.
      return { state: 'low_stock', basis: 'public_limited_flag', quantity: null };
    case 'low_quantity_claim':
      // Claimed low quantity without a parseable number.
      return { state: 'low_stock', basis: 'public_limited_flag', quantity: null };
    default:
      return { state: 'unknown', basis: 'none', quantity: null };
  }
}

export interface StockMemory {
  /** Most recent state, including "unknown". */
  currentState: StockState;
  /** Most recent state that was not "unknown"; transitions are evaluated against this. */
  lastKnownState: StockState | null;
  /** Increments each time the item enters low_stock or out_of_stock afresh. */
  episode: number;
  quantity: number | null;
}

export type StockEventType = 'low_stock' | 'out_of_stock' | 'restocked';

export interface StockEvent {
  type: StockEventType;
  /** Stable key: the same transition evaluated twice yields the same key, so inserts are idempotent. */
  dedupeSuffix: string;
  from: StockState | null;
  to: StockState;
  quantity: number | null;
  basis: Classification['basis'];
  baseline: boolean;
}

export const FRESH_MEMORY: StockMemory = { currentState: 'unknown', lastKnownState: null, episode: 0, quantity: null };

export function evaluateStock(
  prev: StockMemory | null,
  input: StockInput,
  threshold: number,
): { next: StockMemory; events: StockEvent[]; classification: Classification } {
  const memory = prev ?? FRESH_MEMORY;
  const cls = classifyStock(input, threshold);
  const events: StockEvent[] = [];

  if (cls.state === 'unknown') {
    return {
      next: { ...memory, currentState: 'unknown', quantity: null },
      events,
      classification: cls,
    };
  }

  const from = memory.lastKnownState;
  let episode = memory.episode;
  const baseline = from === null;
  const entering = (s: StockState) => s === 'low_stock' || s === 'out_of_stock';

  if (from !== cls.state) {
    if (entering(cls.state)) episode += 1;
    if (cls.state === 'low_stock') {
      events.push({
        type: 'low_stock',
        dedupeSuffix: `ep${episode}`,
        from,
        to: cls.state,
        quantity: cls.quantity,
        basis: cls.basis,
        baseline,
      });
    } else if (cls.state === 'out_of_stock') {
      // A baseline observation of "already out of stock" is a state, not news; avoid onboarding floods.
      if (!baseline) {
        events.push({
          type: 'out_of_stock',
          dedupeSuffix: `ep${episode}`,
          from,
          to: cls.state,
          quantity: cls.quantity,
          basis: cls.basis,
          baseline,
        });
      }
    } else if (cls.state === 'in_stock' && (from === 'low_stock' || from === 'out_of_stock')) {
      events.push({
        type: 'restocked',
        dedupeSuffix: `ep${episode}`,
        from,
        to: cls.state,
        quantity: cls.quantity,
        basis: cls.basis,
        baseline,
      });
    }
  }

  return {
    next: { currentState: cls.state, lastKnownState: cls.state, episode, quantity: cls.quantity },
    events,
    classification: cls,
  };
}

export interface CollectionHealthMemory {
  failing: boolean;
  episode: number;
}

export function evaluateCollectionHealth(
  prev: CollectionHealthMemory | null,
  outcome: 'ok' | 'failed' | 'blocked',
): { next: CollectionHealthMemory; alert: { dedupeSuffix: string; kind: 'failed' | 'blocked' } | null; recovered: boolean } {
  const memory = prev ?? { failing: false, episode: 0 };
  if (outcome === 'ok') {
    return { next: { failing: false, episode: memory.episode }, alert: null, recovered: memory.failing };
  }
  if (memory.failing) return { next: memory, alert: null, recovered: false };
  const episode = memory.episode + 1;
  return { next: { failing: true, episode }, alert: { dedupeSuffix: `ep${episode}`, kind: outcome }, recovered: false };
}
