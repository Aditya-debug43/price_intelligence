import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { and, eq, inArray } from 'drizzle-orm';
import { aiMatchSuggestions, matchAutoApproval, matchEvalCases, matchEvalReports, matchEvalTruths, matchEvents, productMatches, variants } from '@ci/database';
import { AUTO_POLICY_VERSION } from '@ci/core';
import { equivalentsTable, exportReport, generateReport, runEvaluation } from '@ci/services';
import type { ReportData } from '@ci/shared';
import { createBulbs, imitation, type Bulbs, type Imitation, type Seeded } from '../support/bulbs.ts';

/**
 * The REAL route to automatic approval, with no made-up measurement anywhere: a catalogue is analysed; a sample is selected and split by product family; labels are recorded only through the API
 * (here by the test, about a catalogue the test built, so they are TEST labels and prove the mechanism, not anyone's accuracy); the evaluation is run by the worker and measures the system against
 * those labels; the gate opens or stays shut on that measurement; activating a policy reconciles the stored answers with zero model requests; the comparison shows the result; switching off takes the
 * approvals back. A second workspace whose labels expose mistakes the titles cannot show must fail the same gate, and a third checks the scoring rules (every answer production would approve counts,
 * several correct equivalents are all correct, an unlabelled answer is unjudged).
 */
const FAMILIES = 300;
let b: Bulbs;
let im: Imitation;
const good: { s: Seeded; c: Seeded }[] = [];
let calls = 0;

const status = async (w: Bulbs = b) => (await w.owner.get(`${w.base}/eval/status`)).body;
const evaluate = async (w: Bulbs = b) => {
  w.h.advance(60_000);
  expect((await w.owner.post(`${w.base}/eval/run`, {})).status).toBe(202);
  await w.h.queue.drain();
  const s = await status(w);
  return s.latestReport as { gates: { domain: string; autoClass: string; policyVersion: string; units: { families: number; correct: number; critical: number; unjudgedAnswers: number; incompleteFamilies: number }; needed: { toMinimum: number; toCertainty: number | null }; result: { passed: boolean; lines: { name: string; passed: boolean; why: string; required: boolean }[] } }[]; report: Record<string, any> };
};
const gateOf = (r: Awaited<ReturnType<typeof evaluate>>) => r.gates.find((g) => g.domain === 'automotive' && g.autoClass === 'compatible_equivalent')!;
const sweep = async (w: Bulbs) => {
  const res = await w.owner.post(`${w.base}/ai/runs`, { scope: 'sweep', perSite: 3 });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await w.h.queue.drain();
};
const prepareAll = async (w: Bulbs) => {
  for (let i = 0; i < 6; i++) {
    const r = await w.owner.post(`${w.base}/eval/prepare`, { size: 1000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (r.body.selected === 0) break;
  }
};
const holdoutCases = async (w: Bulbs) => (await w.db.select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, w.org), eq(matchEvalCases.split, 'holdout')))).sort((x, y) => x.id.localeCompare(y.id));
const label = async (w: Bulbs, caseId: string, body: unknown) => {
  const r = await w.owner.post(`${w.base}/eval/cases/${caseId}/label`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

beforeAll(async () => {
  b = await createBulbs({ env: { GEMINI_BATCH_CANDIDATES: '12' } });
  im = imitation();
  b.h.gemini.set(im.handler);
  for (let i = 0; i < FAMILIES; i++) {
    const code = `H${100 + i}`;
    const s = await b.seed('source', `Sealight ${code} LED Headlight Bulb`, { brand: 'Sealight', price: 20 + (i % 7) });
    const c = await b.seed('woo', `Lumex ${code} LED Headlight Bulb`, { brand: 'Lumex', price: 18 + (i % 5) });
    im.verdicts[`${s.title}|${c.title}`] = 'close_equivalent';
    good.push({ s, c });
  }
}, 600_000);

afterAll(async () => b.close());

describe('the gate is closed until it is earned', () => {
  it('without any evaluation, no policy can be switched on, and nothing is labelled by itself', async () => {
    const r = await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/no evaluation yet/);
    expect(await b.db.select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, b.org))).toHaveLength(0);
  });

  it('only policies that exist can be asked for: groceries have no equivalent policy', async () => {
    const r = await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'grocery', autoClass: 'compatible_equivalent', enabled: true });
    expect(r.status).toBe(400);
    const s = await status();
    expect(s.supported).toEqual([{ domain: 'automotive', autoClass: 'exact_item' }, { domain: 'automotive', autoClass: 'compatible_equivalent' }, { domain: 'grocery', autoClass: 'exact_item' }]);
    expect(s.policyVersion).toBe(AUTO_POLICY_VERSION);
  });
});

describe('the whole catalogue is analysed once, and nothing is approved while the policy is off', () => {
  it('every product is judged, qualifies, and waits', async () => {
    await sweep(b);
    calls = b.h.gemini.calls.length;
    expect(calls).toBeGreaterThan(0);
    const sug = await b.db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, b.org));
    expect(sug.length).toBeGreaterThanOrEqual(FAMILIES);
    expect(sug.filter((x) => x.autoClass === 'compatible_equivalent').length).toBe(FAMILIES);
    expect((await b.db.select().from(productMatches).where(eq(productMatches.orgId, b.org))).filter((m) => m.status === 'accepted')).toHaveLength(0);
    const f = (await b.owner.get(`${b.base}/ai/funnel`)).body;
    expect(f).toMatchObject({ active: FAMILIES, domain: 'all' });
    expect(f.stages.find((x: { key: string }) => x.key === 'eligible').variants).toBe(FAMILIES);
    expect(f.coverage.automatic.variants).toBe(0);
    expect(f.notApproved[0]).toMatchObject({ key: 'policy_not_enabled', variants: FAMILIES });
  });
});

describe('the sample is split by product family', () => {
  let cases: (typeof matchEvalCases.$inferSelect)[];
  it('selects cases that carry their family, and no family is ever on both sides of the split', async () => {
    // a product with several variants, and a duplicate listing of it: one family
    const first = good[0]!;
    const twin = await b.seed('source', first.s.title, { brand: 'Sealight' });
    const [orig] = await b.db.select().from(variants).where(eq(variants.id, first.s.variantId));
    await b.db.insert(variants).values({ ...orig!, id: undefined as unknown as string, variantKey: 'second', title: 'Second', url: `${orig!.url}?v=2` });
    await prepareAll(b);
    cases = await b.db.select().from(matchEvalCases).where(eq(matchEvalCases.orgId, b.org));
    expect(cases.length).toBeGreaterThan(FAMILIES);
    expect(cases.every((c) => !!c.familyKey)).toBe(true);
    const sides = new Map<string, Set<string>>();
    for (const c of cases) (sides.get(c.familyKey!) ?? sides.set(c.familyKey!, new Set()).get(c.familyKey!)!).add(c.split);
    for (const [fam, set] of sides) expect(set.size, `family ${fam}`).toBe(1);
    // the variants and the duplicate listing share one family
    const mine = cases.filter((c) => [first.s.variantId, twin.variantId].includes(c.sourceVariantId));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(new Set(mine.map((c) => c.familyKey)).size).toBe(1);
    expect(new Set(mine.map((c) => c.split)).size).toBe(1);
  });
  it('is stable: preparing again adds nothing that is already there, and never moves a case', async () => {
    const before = new Map(cases.map((c) => [c.id, `${c.split}|${c.familyKey}`]));
    await b.owner.post(`${b.base}/eval/prepare`, { size: 1000 });
    const after = await b.db.select().from(matchEvalCases).where(eq(matchEvalCases.orgId, b.org));
    for (const c of after) if (before.has(c.id)) expect(`${c.split}|${c.familyKey}`).toBe(before.get(c.id));
  });
  it('is large enough to measure: the holdout holds at least 100 independent families', async () => {
    const holdout = await holdoutCases(b);
    expect(new Set(holdout.map((c) => c.familyKey)).size).toBeGreaterThanOrEqual(100);
  });
});

describe('the measurement', () => {
  const truthFor = (sourceVariantId: string) => good.find((p) => p.s.variantId === sourceVariantId)?.c.variantId;

  it('too few labels is never a pass, and it says how many more are needed', async () => {
    const holdout = (await holdoutCases(b)).filter((c) => truthFor(c.sourceVariantId));
    for (const c of holdout.slice(0, 40)) await label(b, c.id, { judgments: [{ variantId: truthFor(c.sourceVariantId)!, relationship: 'equivalent' }], complete: true, expertise: 'knowledgeable' });
    const r = await evaluate();
    const g = gateOf(r);
    expect(g.result.passed).toBe(false);
    expect(g.policyVersion).toBe(AUTO_POLICY_VERSION);
    expect(g.units.families).toBeGreaterThan(0);
    expect(g.units.families).toBeLessThan(100);
    expect(g.needed.toMinimum).toBe(100 - g.units.families);
    expect(g.result.lines.find((l) => l.name === 'automatic approval precision')!.why).toMatch(/independent labelled example/);
    const on = await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true });
    expect(on.status).toBe(409);
    expect(on.body.error.message).toMatch(/not passed the release gate/);
  });

  it('with enough independent labels the measurement passes, on the answers production would approve, for the current rules', async () => {
    const holdout = (await holdoutCases(b)).filter((c) => truthFor(c.sourceVariantId));
    for (const c of holdout.slice(40)) await label(b, c.id, { judgments: [{ variantId: truthFor(c.sourceVariantId)!, relationship: 'equivalent' }], complete: true, expertise: 'knowledgeable' });
    const r = await evaluate();
    const g = gateOf(r);
    expect(g.units.families).toBeGreaterThanOrEqual(100);
    expect(g.units.critical).toBe(0);
    expect(g.units.correct).toBe(g.units.families);
    expect(g.result.passed, JSON.stringify(g.result.lines)).toBe(true);
    // every eligible answer at a labelled case was scored, and none was wrong
    expect(r.report['holdout'].overall.eligibleDecisions).toMatchObject({ wrong: 0 });
    expect(r.report['holdout'].overall.eligibleDecisions.pairs).toBeGreaterThanOrEqual(100);
    // the report is honest about what its sample represents
    expect(r.report['strata'].map((x: { name: string; kind: string }) => [x.name, x.kind]).find(([n]: string[]) => n === 'random')[1]).toBe('uniform');
    expect(r.report['strata'].filter((x: { kind: string }) => x.kind === 'enriched').length).toBeGreaterThan(0);
    expect(r.report['populationEstimate'].basis).toMatch(/uniform/);
    // the other policies stay shut: no labels, no pass
    expect(r.gates.filter((x) => x.domain === 'automotive' && x.autoClass === 'exact_item')[0]!.result.passed).toBe(false);
  });

  it('a label made after the measurement makes it stale until it is run again', async () => {
    b.h.advance(60_000);
    const dev = (await b.db.select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, b.org), eq(matchEvalCases.split, 'development'), eq(matchEvalCases.status, 'pending'))))[0]!;
    await label(b, dev.id, { relationship: 'none', expertise: 'general' });
    const stale = await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/Labels were added after/);
    await evaluate();
  });
});

describe('activation reconciles every stored answer without asking the model anything', () => {
  let pricesBefore = '';
  let rejected: typeof productMatches.$inferSelect;
  it('a person’s earlier decision and the prices are untouched by it', async () => {
    // a person rejected one of these pairs before the policy existed
    const p = good[3]!;
    const [m] = await b.db.insert(productMatches).values({ orgId: b.org, sourceVariantId: p.s.variantId, competitorVariantId: p.c.variantId, competitorSiteId: b.sites.woo, matchClass: 'comparable', confidence: 0.6, status: 'needs_review', method: 'name_similarity', reasons: ['x'], relationship: 'substitute', tier: 'medium' }).returning();
    expect((await b.owner.post(`${b.base}/matches/${m!.id}/decision`, { decision: 'reject', note: 'Checked by hand: not suitable' })).status).toBe(200);
    rejected = (await b.db.select().from(productMatches).where(eq(productMatches.id, m!.id)))[0]!;
    pricesBefore = JSON.stringify((await b.db.select({ id: variants.id, price: variants.price, currency: variants.currency }).from(variants).where(eq(variants.orgId, b.org))).sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('switching the passed policy on queues the reconciliation and approves from the stored answers: zero Gemini requests', async () => {
    const on = await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(b.h.queue.pending.some((p) => p.name === 'ai-match' && (p.data as { task?: string }).task === 'reconcile')).toBe(true);
    await b.h.queue.drain();
    expect(b.h.gemini.calls.length).toBe(calls);
    const [row] = await b.db.select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, b.org));
    expect(row).toMatchObject({ enabled: true, policyVersion: AUTO_POLICY_VERSION, autoClass: 'compatible_equivalent' });
    const ok = (await b.db.select().from(productMatches).where(eq(productMatches.orgId, b.org))).filter((m) => m.status === 'accepted' && m.method === 'ai_auto');
    expect(ok.length).toBe(FAMILIES - 1); // every family but the one a person rejected
    for (const m of ok) expect(m).toMatchObject({ relationship: 'equivalent', decidedBy: null, confidence: 0 });
  });

  it('the person’s rejection and every price are exactly as they were', async () => {
    expect((await b.db.select().from(productMatches).where(eq(productMatches.id, rejected.id)))[0]).toMatchObject({ status: 'rejected', decidedBy: rejected.decidedBy, decisionNote: 'Checked by hand: not suitable' });
    expect(JSON.stringify((await b.db.select({ id: variants.id, price: variants.price, currency: variants.currency }).from(variants).where(eq(variants.orgId, b.org))).sort((x, y) => x.id.localeCompare(y.id)))).toBe(pricesBefore);
  });

  it('the approved overview shows them, labelled as equivalents approved by the policy; the identical-item view and its counts stay empty', async () => {
    const approved = (await b.owner.get(`${b.base}/comparison?view=approved&pageSize=500`)).body;
    expect(approved.total).toBe(FAMILIES - 1);
    expect(approved.rows[0].cells[0]).toMatchObject({ relationship: 'equivalent', confirmation: 'automatic', approval: { by: 'policy', policyVersion: AUTO_POLICY_VERSION }, directlyComparable: false });
    expect((await b.owner.get(`${b.base}/comparison?pageSize=500`)).body.total).toBe(0);
    const counts = (await b.owner.get(`${b.base}/matches/counts`)).body;
    expect(counts.confirmedPairs.equivalent).toBe(FAMILIES - 1);
    expect(counts.directlyComparableOwnVariants).toBe(0);
  });

  it('reports carry them as their own benchmark: never an identical item, labelled as approved by the policy, with no invented score', async () => {
    const report = await generateReport(b.h.svc, b.db, b.org, { kind: 'manual', deadlineAt: null, createdBy: b.userId });
    const data = report.data as ReportData;
    expect(data.comparisons).toHaveLength(0);
    expect(data.kpis.identicalMatches).toBe(0);
    expect(data.equivalents).toHaveLength(FAMILIES - 1);
    expect(data.kpis.equivalentBenchmark?.pairs).toBe(FAMILIES - 1);
    const t = equivalentsTable(data);
    expect(t.rows.length).toBe(FAMILIES - 1);
    expect(String(t.rows[0]![7])).toBe(`approved by policy ${AUTO_POLICY_VERSION}`);
    // the Excel workbook has the benchmark on its own sheet, labelled, and no score is printed anywhere
    const xlsx = await exportReport(b.h.svc, b.db, b.org, report.id, 'xlsx', 'comparison');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    const sheet = wb.worksheets.find((s) => /equivalents/i.test(s.name))!;
    expect(sheet, wb.worksheets.map((s) => s.name).join(', ')).toBeDefined();
    const header = (sheet.getRow(sheet.rowCount > 2 ? 2 : 1).values as unknown[]).map(String);
    const flat = JSON.stringify(sheet.getSheetValues());
    expect(flat).toContain(`approved by policy ${AUTO_POLICY_VERSION}`);
    expect(header.length).toBeGreaterThan(5);
    const csv = await exportReport(b.h.svc, b.db, b.org, report.id, 'csv', 'comparison');
    expect(Buffer.from(csv.body).toString('utf8')).not.toMatch(/0\.99/);
  });

  it('the funnel counts distinct products through every stage and reports the coverage against the targets', async () => {
    const f = (await b.owner.get(`${b.base}/ai/funnel`)).body;
    expect(f.coverage.automatic.variants).toBe(FAMILIES - 1);
    expect(f.coverage.automatic.share).toBeCloseTo((FAMILIES - 1) / f.active, 3);
    expect(f.stages.find((x: { key: string }) => x.key === 'visible').variants).toBe(FAMILIES - 1);
    expect(f.targets.floor).toMatchObject({ share: 0.5, met: true, shortfall: 0 });
    expect(f.precision.find((p: { autoClass: string }) => p.autoClass === 'compatible_equivalent')).toMatchObject({ passed: true, enabled: true, critical: 0 });
    expect(f.attribution).toBeNull(); // the floor is met, so there is no shortfall to explain
  });

  it('reconciling again records nothing twice', async () => {
    const events = (await b.db.select().from(matchEvents).where(eq(matchEvents.orgId, b.org))).length;
    expect((await b.owner.post(`${b.base}/ai/reconcile`, {})).status).toBe(202);
    await b.h.queue.drain();
    expect((await b.db.select().from(matchEvents).where(eq(matchEvents.orgId, b.org))).length).toBe(events);
    expect(b.h.gemini.calls.length).toBe(calls);
  });

  it('switching it off takes the system’s approvals back, reversibly, and the person’s decision still stands', async () => {
    expect((await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: false })).status).toBe(200);
    await b.h.queue.drain();
    const all = await b.db.select().from(productMatches).where(eq(productMatches.orgId, b.org));
    expect(all.filter((m) => m.status === 'accepted')).toHaveLength(0);
    expect(all.filter((m) => m.method === 'ai_auto' && m.autoConfirmedAt !== null)).toHaveLength(0);
    expect(all.find((m) => m.id === rejected.id)).toMatchObject({ status: 'rejected' });
    expect(b.h.gemini.calls.length).toBe(calls);
    expect((await b.owner.get(`${b.base}/comparison?view=approved&pageSize=500`)).body.total).toBe(0);
    // and it can be switched on again while its measurement is still current
    expect((await b.owner.post(`${b.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true })).status).toBe(200);
    await b.h.queue.drain();
    expect((await b.owner.get(`${b.base}/comparison?view=approved&pageSize=500`)).body.total).toBe(FAMILIES - 1);
  });
});

describe('a policy whose mistakes only the labels can see does not pass', () => {
  let w: Bulbs;
  let wim: Imitation;
  it('fails the same gate: precision below the line and critical mistakes, so it cannot be switched on', async () => {
    w = await b.workspace('Flawed');
    wim = im; // one imitation serves every workspace
    const flawed: { s: Seeded; c: Seeded; bad: boolean }[] = [];
    for (let i = 0; i < FAMILIES; i++) {
      const code = `H${100 + i}`;
      const s = await w.seed('source', `Sealight ${code} LED Headlight Bulb`, { brand: 'Sealight' });
      const c = await w.seed('woo', `Lumex ${code} LED Headlight Bulb`, { brand: 'Lumex' });
      flawed.push({ s, c, bad: i % 5 === 0 }); // one in five is, in truth, a lamp for another voltage: the listings do not say so
    }
    await sweep(w);
    await prepareAll(w);
    const hold = await holdoutCases(w);
    for (const c of hold) {
      const f = flawed.find((x) => x.s.variantId === c.sourceVariantId);
      if (!f) continue;
      await label(w, c.id, f.bad ? { judgments: [{ variantId: f.c.variantId, relationship: 'incorrect', critical: true }], complete: true, expertise: 'knowledgeable' } : { judgments: [{ variantId: f.c.variantId, relationship: 'equivalent' }], complete: true, expertise: 'knowledgeable' });
    }
    const r = await evaluate(w);
    const g = gateOf(r);
    expect(g.units.families).toBeGreaterThanOrEqual(100);
    expect(g.units.critical).toBeGreaterThan(0);
    expect(g.result.passed).toBe(false);
    const why = g.result.lines.filter((l) => l.required && !l.passed).map((l) => l.name);
    expect(why).toContain('critical violations');
    expect(why).toContain('automatic approval precision');
    const on = await w.owner.post(`${w.base}/eval/auto-approval`, { domain: 'automotive', autoClass: 'compatible_equivalent', enabled: true });
    expect(on.status).toBe(409);
    expect((await w.db.select().from(productMatches).where(eq(productMatches.orgId, w.org))).filter((m) => m.status === 'accepted')).toHaveLength(0);
    void wim;
  });
});

describe('the scoring rules', () => {
  let w: Bulbs;
  const ids: Record<string, Seeded> = {};
  it('score every answer production would approve, all correct equivalents, and treat an unlabelled answer as unjudged', async () => {
    w = await b.workspace('Scoring');
    const mk = async (name: string, src: string, cands: [string, string][]) => {
      ids[name] = await w.seed('source', src, { brand: 'Sealight' });
      for (const [k, t] of cands) { ids[k] = await w.seed('woo', t, { brand: t.split(' ')[0]! }); im.verdicts[`${src}|${t}`] = 'close_equivalent'; }
    };
    // S1: a right candidate and a wrong second one; S2: two right candidates; S3: a right one and one nobody judged
    await mk('S1', 'Sealight H11 LED Headlight Bulb', [['C1', 'Lumex H11 LED Headlight Bulb'], ['C2', 'Zenith H11 LED Headlight Bulb']]);
    await mk('S2', 'Sealight H7 LED Headlight Bulb', [['C3', 'Lumex H7 LED Headlight Bulb'], ['C4', 'Zenith H7 LED Headlight Bulb']]);
    await mk('S3', 'Sealight H4 LED Headlight Bulb', [['C5', 'Lumex H4 LED Headlight Bulb'], ['C6', 'Zenith H4 LED Headlight Bulb']]);
    await sweep(w);
    for (const [name, fam] of [['S1', 'fam-1'], ['S2', 'fam-2'], ['S3', 'fam-3']] as const) {
      await w.db.insert(matchEvalCases).values({ orgId: w.org, sourceVariantId: ids[name]!.variantId, competitorSiteId: w.sites.woo, domain: 'automotive', stratum: 'ai', split: 'holdout', familyKey: fam });
    }
    const caseOf = async (n: string) => (await w.db.select().from(matchEvalCases).where(eq(matchEvalCases.sourceVariantId, ids[n]!.variantId)))[0]!;
    await label(w, (await caseOf('S1')).id, { judgments: [{ variantId: ids.C1!.variantId, relationship: 'equivalent' }, { variantId: ids.C2!.variantId, relationship: 'incorrect', critical: true }], complete: true, expertise: 'knowledgeable' });
    await label(w, (await caseOf('S2')).id, { judgments: [{ variantId: ids.C3!.variantId, relationship: 'equivalent' }, { variantId: ids.C4!.variantId, relationship: 'equivalent' }], complete: true, expertise: 'knowledgeable' });
    await label(w, (await caseOf('S3')).id, { judgments: [{ variantId: ids.C5!.variantId, relationship: 'equivalent' }], complete: false, expertise: 'knowledgeable' });
    w.h.advance(60_000);
    await runEvaluation(w.h.svc, w.org, w.userId);
    const [rep] = await w.db.select().from(matchEvalReports).where(eq(matchEvalReports.orgId, w.org));
    const g = (rep!.gates as unknown as { domain: string; autoClass: string; units: Record<string, number> }[]).find((x) => x.domain === 'automotive' && x.autoClass === 'compatible_equivalent')!;
    const overall = (rep!.report as { holdout: { overall: { eligibleDecisions: Record<string, number> } } }).holdout.overall.eligibleDecisions;
    // six answers production would approve: C1 right, C2 wrong, C3 right, C4 right, C5 right, C6 not judged
    expect(overall).toEqual({ pairs: 6, correct: 4, wrong: 1, unjudged: 1 });
    // the wrong second candidate counts against its family (and is a critical mistake); the family with two right answers counts once; the unfinished one is held out, not counted as right
    expect(g.units).toMatchObject({ families: 2, correct: 1, critical: 1, unjudgedAnswers: 1, incompleteFamilies: 1 });
  });

  it('judgments are stored per candidate and a case can be relabelled without leaving old judgments behind', async () => {
    const c = (await w.db.select().from(matchEvalCases).where(eq(matchEvalCases.sourceVariantId, ids.S1!.variantId)))[0]!;
    expect(await w.db.select().from(matchEvalTruths).where(eq(matchEvalTruths.caseId, c.id))).toHaveLength(2);
    await label(w, c.id, { judgments: [{ variantId: ids.C1!.variantId, relationship: 'equivalent' }], complete: false, expertise: 'knowledgeable' });
    expect(await w.db.select().from(matchEvalTruths).where(eq(matchEvalTruths.caseId, c.id))).toHaveLength(1);
  });

  it('refuses a judgment about a product that is not at that website, or a critical flag on a counterpart', async () => {
    const c = (await w.db.select().from(matchEvalCases).where(eq(matchEvalCases.sourceVariantId, ids.S2!.variantId)))[0]!;
    const own = await w.owner.post(`${w.base}/eval/cases/${c.id}/label`, { judgments: [{ variantId: ids.S1!.variantId, relationship: 'equivalent' }], complete: true, expertise: 'general' });
    expect(own.status).toBe(400);
    const crit = await w.owner.post(`${w.base}/eval/cases/${c.id}/label`, { judgments: [{ variantId: ids.C3!.variantId, relationship: 'equivalent', critical: true }], complete: true, expertise: 'general' });
    expect(crit.status).toBe(400);
    const empty = await w.owner.post(`${w.base}/eval/cases/${c.id}/label`, { judgments: [], complete: false, expertise: 'general' });
    expect(empty.status).toBe(400);
  });
});

void inArray;
