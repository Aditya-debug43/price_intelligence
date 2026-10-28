/**
 * What the database can hold. Prices are stored as numeric(14,4): ten digits before the decimal point, so anything of ten billion or more
 * cannot be stored. A shop's own data can contain such a value by mistake (lasfit.com listed a compare-at price of 139982999149929.98 on one variant);
 * it must be recognised and left out BEFORE it reaches the database, instead of making the whole save fail with "numeric field overflow".
 * A left-out amount is "unknown" (null) — never a guessed, clamped or rounded number — and the run says which value was left out.
 */
export const MAX_STORABLE_MONEY = 9_999_999_999;
/** `quantity` and similar counts are 32-bit integers. */
export const MAX_STORABLE_INTEGER = 2_147_483_647;

/** True when the amount is a finite, non-negative number the money columns can hold. */
export function isStorableMoney(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_STORABLE_MONEY;
}

export function isStorableCount(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_STORABLE_INTEGER;
}
