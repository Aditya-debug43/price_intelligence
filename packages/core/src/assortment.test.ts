import { describe, expect, it } from 'vitest';
import type { SiteCoverage } from '@ci/shared';
import { assortmentBasis, assortmentNote } from './assortment.ts';

const site = (over: Partial<SiteCoverage> & Pick<SiteCoverage, 'siteId' | 'name' | 'role'>): SiteCoverage =>
  ({ hostname: `${over.siteId}.example`, capability: 'full', connector: null, lastScanStatus: 'succeeded', lastScanAt: null, productsKnown: 10, productsObservedFresh: 10, productsStale: 0, estimatedCatalogue: 10, coveragePct: 100, newestObservation: null, oldestObservation: null, complete: true, warnings: [], failureReason: null, ...over }) as SiteCoverage;

describe('what "no equivalent found" can honestly mean', () => {
  it('is a strong statement only when every competitor was read completely', () => {
    const b = assortmentBasis([site({ siteId: 's', name: 'Mine', role: 'source' }), site({ siteId: 'a', name: 'Rival A', role: 'competitor' }), site({ siteId: 'b', name: 'Rival B', role: 'competitor' })]);
    expect(b).toMatchObject({ competitorsComplete: true, competitorGaps: [], sourceComplete: true, sourceGap: null });
    expect(assortmentNote(b, 2)).toMatch(/Every competitor catalogue was read completely/);
  });

  it('names each competitor that was blocked, never collected or only partly read, with its reason, and weakens the claim', () => {
    const b = assortmentBasis([
      site({ siteId: 's', name: 'Mine', role: 'source' }),
      site({ siteId: 'a', name: 'Rival A', role: 'competitor' }),
      site({ siteId: 'b', name: 'Rival B', role: 'competitor', complete: false, productsKnown: 0, failureReason: 'robots.txt does not permit automated collection' }),
      site({ siteId: 'c', name: 'Rival C', role: 'competitor', complete: false, status: { state: 'partial', label: 'Partly collected', detail: 'Only 40 of about 1000 products have been collected.', severity: 'warn', nextAction: null } }),
      site({ siteId: 'd', name: 'Rival D', role: 'competitor', complete: false, productsKnown: 0 }),
    ]);
    expect(b.competitorsComplete).toBe(false);
    expect(b.competitorGaps.map((g) => [g.name, g.reason])).toEqual([
      ['Rival B', 'robots.txt does not permit automated collection'],
      ['Rival C', 'Only 40 of about 1000 products have been collected.'],
      ['Rival D', 'nothing has been collected from it'],
    ]);
    const note = assortmentNote(b, 4);
    expect(note).toMatch(/Not every competitor catalogue was read completely/);
    expect(note).toMatch(/Rival B \(robots\.txt does not permit automated collection\)/);
    expect(note).toMatch(/not “nobody sells it”/);
    expect(note).not.toMatch(/Every competitor catalogue was read completely/);
  });

  it('says so when your own catalogue was not read completely, because then "missing from your shop" is unproven', () => {
    const b = assortmentBasis([site({ siteId: 's', name: 'Mine', role: 'source', complete: false, productsKnown: 40, failureReason: null }), site({ siteId: 'a', name: 'Rival A', role: 'competitor' })]);
    expect(b.sourceComplete).toBe(false);
    expect(assortmentNote(b, 1)).toMatch(/Your own catalogue was not read completely/);
  });

  it('with no competitor (or no source) there is nothing to claim', () => {
    expect(assortmentBasis([site({ siteId: 's', name: 'Mine', role: 'source' })]).competitorsComplete).toBe(false);
    expect(assortmentNote(assortmentBasis([site({ siteId: 's', name: 'Mine', role: 'source' })]), 0)).toMatch(/No competitor website is being compared yet/);
    expect(assortmentBasis([site({ siteId: 'a', name: 'Rival A', role: 'competitor' })])).toMatchObject({ sourceComplete: false, sourceGap: 'there is no source website' });
  });
});
