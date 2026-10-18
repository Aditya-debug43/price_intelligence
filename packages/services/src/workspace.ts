import type { Provenance, QuantitySource } from '@ci/shared';

/**
 * An action the user asked for cannot do anything useful yet (nothing to refresh, nothing to report on…). The API answers 409 with the reason
 * instead of a misleading 202 "accepted", so a control never appears to have worked when it did nothing.
 */
export class ActionNotPossibleError extends Error {
  constructor(
    message: string,
    readonly code: string = 'not_possible',
    readonly details?: unknown,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'ActionNotPossibleError';
  }
}

/**
 * Where a stored observation came from. Quantities from a store owner's authorised connection are 'authorised_api'; answers from an
 * official platform API are 'official_api'; everything read from a public page, feed or document is 'public_web'.
 */
export function provenanceFor(p: { quantitySource?: QuantitySource | null; official?: boolean } = {}): Provenance {
  if (p.quantitySource === 'authorised_inventory') return 'authorised_api';
  if (p.official) return 'official_api';
  return 'public_web';
}
