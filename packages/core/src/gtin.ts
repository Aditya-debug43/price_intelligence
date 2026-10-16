/** GTIN (UPC-A/EAN-8/EAN-13/GTIN-14) validation and normalisation. */

export function isValidGtin(input: string | null | undefined): boolean {
  if (!input) return false;
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return false;
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  if (/^0+$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  // Weights alternate 3,1,3,1... starting from the digit nearest the check digit.
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

/** Normalise any valid GTIN to its 14-digit form so UPC-A and EAN-13 of the same item compare equal. */
export function normalizeGtin(input: string | null | undefined): string | null {
  if (!input || !isValidGtin(input)) return null;
  return input.replace(/[\s-]/g, '').padStart(14, '0');
}
