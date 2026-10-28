import { describe, expect, it } from 'vitest';
import { MAX_STORABLE_INTEGER, MAX_STORABLE_MONEY, isStorableCount, isStorableMoney } from '@ci/core';
import { describeDatabaseError } from '@ci/services';

/**
 * Directive 13 (lasfit.com): an amount of 139982999149929.98 in the shop's own feed made the database refuse a whole catalogue. These pin what can be stored
 * (prices are numeric(14,4); counts are 32-bit integers) and how a database refusal is described.
 */
describe('amounts and counts the database can hold', () => {
  it('accepts ordinary prices, zero and the largest storable amount', () => {
    for (const x of [0, 0.01, 317.94, 477.92, 1_999_999.99, MAX_STORABLE_MONEY]) expect(isStorableMoney(x), String(x)).toBe(true);
  });

  it('refuses the real value from lasfit.com, anything above the limit, and anything that is not a usable number', () => {
    for (const x of [139982999149929.98, 10_000_000_000, 1e12, -1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined]) {
      expect(isStorableMoney(x as number | null | undefined), String(x)).toBe(false);
    }
  });

  it('accepts whole counts up to a 32-bit integer and refuses the rest', () => {
    for (const x of [0, 1, 25, MAX_STORABLE_INTEGER]) expect(isStorableCount(x), String(x)).toBe(true);
    for (const x of [MAX_STORABLE_INTEGER + 1, -1, 2.5, Number.NaN, null]) expect(isStorableCount(x as number | null), String(x)).toBe(false);
  });
});

describe('describing a database refusal', () => {
  const wrapped = (pg: object) => Object.assign(new Error('Failed query: insert into "variants" (...) values ($1) params: 1,2,317.94,139982999149929.98'), { cause: Object.assign(new Error('db'), pg) });

  it('says what the database said for the common refusals, never the statement or the shop’s values', () => {
    const cases: [string, RegExp][] = [
      ['22003', /too large/],
      ['22001', /too long/],
      ['22021', /character the database cannot store/],
      ['22P02', /format the database does not accept/],
      ['23502', /required value is missing/],
      ['23505', /duplicates a record/],
    ];
    for (const [code, re] of cases) {
      const d = describeDatabaseError(wrapped({ code, message: 'whatever' }))!;
      expect(d.message, code).toMatch(re);
      expect(d.message, code).not.toMatch(/Failed query|params|insert into|317\.94|139982999149929/);
      expect(d.rowData, code).toBe(true);
    }
  });

  it('names the column when the database does', () => {
    const d = describeDatabaseError(wrapped({ code: '22001', message: 'value too long for type character varying(10)', column: 'sku', table: 'variants' }))!;
    expect(d.message).toContain('“sku” of variants');
    expect(d).toMatchObject({ column: 'sku', table: 'variants' });
  });

  it('treats only data and constraint refusals (SQLSTATE class 22 and 23) as "this product’s data"', () => {
    expect(describeDatabaseError(wrapped({ code: '23514', message: 'check failed' }))!.rowData).toBe(true);
    for (const code of ['08006', '53100', '57P01', '40001', '42P01', '42703']) expect(describeDatabaseError(wrapped({ code, message: 'x' }))!.rowData, code).toBe(false);
  });

  it('still hides the statement when the database’s reason is missing, and stays silent about errors that are not the database’s', () => {
    const noCause = describeDatabaseError(new Error('Failed query: select 1 params: secret-looking-value'))!;
    expect(noCause.message).toBe('The database could not save the collected data.');
    expect(noCause.rowData).toBe(false);
    expect(describeDatabaseError(new Error('fetch failed'))).toBeNull();
    expect(describeDatabaseError('text')).toBeNull();
    expect(describeDatabaseError(null)).toBeNull();
  });
});
