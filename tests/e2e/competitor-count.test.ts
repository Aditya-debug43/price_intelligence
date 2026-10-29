import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { sites } from '@ci/database';
import { SiteError, addSite, ensureFxRates, generateReport, loadComparison, loadFxTable, loadJourney, removeSite, runMatching, startScan } from '@ci/services';
import type { ReportData } from '@ci/shared';
import { createHarness, type Harness, type Tenant } from '../support/harness.ts';
import { confirmSuggestions } from '../support/confirm.ts';

/**
 * Directive 12: Shelfwatch must work from ONE competitor. The minimum of three lived in the shared limits (`DEFAULTS.minCompetitors`, also sent to the
 * website by the API) and in the getting-started journey, which stayed on "Add 3–5 competitors" and never moved on or finished with fewer; the
 * Setup page also pre-filled three empty rows and said "Add at least 3". Nothing in the database or the collection, matching, comparison and report
 * code needed more than one competitor; these tests pin that down with real collections.
 */
let h: Harness;
const db = () => h.db.worker;

const journeyOf = (t: Tenant) => loadJourney(h.svc, db(), t.orgId);
const stepOf = async (t: Tenant, id: string) => (await journeyOf(t)).steps.find((s) => s.id === id)!;
const scan = async (t: Tenant, siteId: string) => {
  await t.tx((tx) => startScan(h.svc, tx, t.orgId, siteId, { kind: 'discovery', trigger: 'manual' }));
  await h.queue.drain();
};
const compare = async (t: Tenant) => {
  await ensureFxRates(h.svc);
  return loadComparison(db(), { orgId: t.orgId, reportingCurrency: 'USD', fx: await loadFxTable(db()), now: h.svc.clock(), staleAfterHours: 36 });
};
const competitorCount = async (t: Tenant) => (await db().select().from(sites).where(and(eq(sites.orgId, t.orgId), eq(sites.role, 'competitor')))).length;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);
afterAll(async () => {
  await h.close();
});

describe('exactly one competitor', () => {
  let t: Tenant;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    t = await h.newTenant('OneCompetitor');
    ids.source = await t.addFixtureSite('source', 'source');
    ids.woo = await t.addFixtureSite('woo', 'competitor');
  });

  it('counts as having added competitors: the getting-started step is done and the guide moves on', async () => {
    const step = await stepOf(t, 'competitors');
    expect(step.state).toBe('done');
    expect(step.action).toBeNull();
    expect(step.detail).toMatch(/1 competitor added/i);
    expect(step.title).not.toMatch(/\b3\b/);
    const j = await journeyOf(t);
    expect(j.next?.id).not.toBe('competitors');
    expect(j.next?.id).toBe('capabilities'); // the very next real step, not "add two more"
  });

  it('collects, matches, compares and reports with only that competitor', async () => {
    await scan(t, ids.source!);
    await scan(t, ids.woo!);
    const match = await runMatching(h.svc, db(), t.orgId);
    await confirmSuggestions(db(), t.orgId);
    expect(match.byClass.identical).toBeGreaterThan(10);
    const cmp = await compare(t);
    expect(cmp.length).toBeGreaterThan(15);
    for (const row of cmp) {
      expect(row.cells).toHaveLength(1);
      expect(row.cells[0]!.siteName).toMatch(/Mart/);
      expect(['cheapest', 'middle', 'highest', 'tied', 'no_data']).toContain(row.position);
    }
    const report = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
    const data = report.data as ReportData;
    expect(report.status).toBe('ready'); // complete: nothing is "partial" merely because only one competitor exists
    expect(data.comparisons.length).toBe(cmp.length);
    expect(data.meta.isPartial).toBe(false);
    expect(data.kpis.matchedProducts).toBeGreaterThan(10);
    expect(data.sites.filter((s) => s.role === 'competitor')).toHaveLength(1);
    expect(data.basket).toHaveLength(1);
  });

  it('shows the whole path as done up to the reports, never asking for more competitors', async () => {
    const j = await journeyOf(t);
    expect(j.steps.find((s) => s.id === 'competitors')!.state).toBe('done');
    expect(j.steps.find((s) => s.id === 'collection')!.state).toBe('done');
    expect(j.steps.find((s) => s.id === 'report')!.state).toBe('done');
    expect(JSON.stringify(j)).not.toMatch(/at least 3|3–5|three/i);
  });
});

describe('a competitor with no collected data yet', () => {
  it('is reported as waiting, without errors, and the rest of the workspace still works', async () => {
    const t = await h.newTenant('NotCollectedYet');
    const source = await t.addFixtureSite('source', 'source');
    await t.addFixtureSite('woo', 'competitor');
    await scan(t, source);
    expect((await stepOf(t, 'competitors')).state).toBe('done');
    expect((await stepOf(t, 'collection')).detail).toMatch(/not collected yet/i);
    expect(await compare(t)).toEqual([]); // nothing to compare yet is an empty list, not an error
    const report = await generateReport(h.svc, db(), t.orgId, { kind: 'manual', deadlineAt: null, createdBy: t.userId });
    const data = report.data as ReportData;
    expect(report.status).toBe('partial'); // honestly partial: that competitor was never collected
    expect(data.comparisons).toEqual([]);
    expect(data.sites.find((s) => s.role === 'competitor')).toMatchObject({ productsKnown: 0 });
  });
});

describe('two, three, four and five competitors, added and removed one at a time', () => {
  it('accepts every count from 1 to 5, keeps the maximum, and follows removals back to none', async () => {
    const t = await h.newTenant('GrowAndShrink');
    await t.addFixtureSite('source', 'source');
    expect((await stepOf(t, 'competitors')).state).toBe('current'); // none yet: this is the step to do next
    expect((await stepOf(t, 'competitors')).detail).toMatch(/at least one|add the websites/i);

    const added: string[] = [];
    for (const [i, key] of ['woo', 'jsonld', 'html', 'listing', 'homegrid'].entries()) {
      added.push(await t.addFixtureSite(key, 'competitor'));
      expect(await competitorCount(t), `after adding ${i + 1}`).toBe(i + 1);
      const step = await stepOf(t, 'competitors');
      expect(step.state, `with ${i + 1} competitor(s)`).toBe('done');
      expect(step.detail).toMatch(new RegExp(`^${i + 1} competitors? added`));
    }
    // the upper limit is unchanged: a sixth is refused with the existing explanation
    await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: h.fixtures.origin('challenge'), role: 'competitor' }))).rejects.toMatchObject({ code: 'limit', status: 409 });
    await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url: h.fixtures.origin('challenge'), role: 'competitor' }))).rejects.toBeInstanceOf(SiteError);

    // removing with the existing control, one by one: the count follows, down to one (still fine) and then none (back to "add")
    for (const [n, id] of added.entries()) {
      await t.tx((tx) => removeSite(tx, t.orgId, t.userId, id));
      const left = added.length - n - 1;
      expect(await competitorCount(t)).toBe(left);
      expect((await stepOf(t, 'competitors')).state).toBe(left >= 1 ? 'done' : 'current');
    }
    // and a freshly added single competitor works again
    await t.addFixtureSite('woo', 'competitor');
    expect((await stepOf(t, 'competitors')).state).toBe('done');
  });

  it('still validates every address it is given (only the count restriction is gone)', async () => {
    const t = await h.newTenant('StillValidates');
    await t.addFixtureSite('source', 'source');
    for (const url of ['javascript:alert(1)', 'ftp://shop.example.test', 'http://169.254.169.254/', 'http://10.0.0.5/', 'not a web address']) {
      await expect(t.tx((tx) => addSite(h.svc, tx, t.orgId, t.userId, { url, role: 'competitor' })), url).rejects.toBeInstanceOf(SiteError);
    }
    expect(await competitorCount(t)).toBe(0);
  });
});

describe('workspaces that already have several competitors', () => {
  it('keep working exactly as before (three competitors collected, matched and compared)', async () => {
    const t = await h.newTenant('ThreeCompetitors');
    const source = await t.addFixtureSite('source', 'source');
    const others = [await t.addFixtureSite('woo', 'competitor'), await t.addFixtureSite('jsonld', 'competitor'), await t.addFixtureSite('html', 'competitor')];
    for (const id of [source, ...others]) await scan(t, id);
    await runMatching(h.svc, db(), t.orgId);
    await confirmSuggestions(db(), t.orgId);
    const cmp = await compare(t);
    expect(Math.max(...cmp.map((r) => r.cells.length))).toBe(3);
    expect((await stepOf(t, 'competitors')).state).toBe('done');
    expect((await stepOf(t, 'competitors')).detail).toMatch(/^3 competitors added/);
  });
});
