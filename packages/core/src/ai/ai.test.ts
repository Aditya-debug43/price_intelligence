import { describe, expect, it } from 'vitest';
import {
  AI_SYSTEM_PROMPT, AiLimiter, analyseCatalogue, applyGuards, buildAiDossier, buildRetrievalIndex, buildUserPayload, calibrate, DEFAULT_BATCH_LIMITS, estimateTokens, evaluatePair, isGrounded, pacificDay, parseAiResponse, planBatches,
  retrieveShortlist, toWire, type AiDecision, type DossierInput, type GuardContext, type PayloadGroup,
} from '../index.ts';

let seq = 0;
const input = (siteId: string, title: string, o: Partial<DossierInput> = {}): DossierInput => ({
  variantId: `v${++seq}`, productId: `p${seq}`, siteId, title, variantTitle: null, brand: null, category: null, gtin: null, sku: null, mpn: null, model: null, sizeHints: [], ...o,
});

/** Filler listings so corpus statistics behave as in a real catalogue (vehicle words, codes, common words). */
function filler(): DossierInput[] {
  const out: DossierInput[] = [];
  const makes: [string, string[]][] = [['Toyota', ['Camry', 'Corolla', 'Sienna', 'Tacoma']], ['Honda', ['Civic', 'Accord', 'CRV', 'Pilot']], ['Ford', ['Fusion', 'Focus', 'Escape', 'Explorer']], ['Chevrolet', ['Silverado', 'Equinox', 'Colorado']]];
  let y = 2008;
  for (const [make, models] of makes) for (const model of models) {
    y = 2008 + ((y + 3) % 12);
    out.push(input('lasfit', `Fit for ${y}-${y + 4} ${make} ${model} LED Bulbs Upgrade`, { brand: 'Lasfit' }));
    out.push(input('auxito', `${y + 1}-${y + 5} ${make} ${model} LED Light Bulbs`, { brand: 'AUXITO' }));
    out.push(input('sealight', `SEALIGHT® ${y}-${y + 3} ${make} ${model} LED Bulbs Exterior`, { brand: 'Sealight' }));
  }
  for (const codes of ['H4 HB2 9003', 'H11 H8 H9', '9005 HB3', '7443 7440 T20', '168 194 2825 T10', '3157']) {
    for (const [site, brand] of [['lasfit', 'Lasfit'], ['auxito', 'AUXITO'], ['sealight', 'Sealight']] as const) out.push(input(site, `${codes} LED Bulbs ${brand}`, { brand }));
  }
  return out;
}

describe('the model answer is validated decision by decision', () => {
  const good = { id: '1.1', type: 'close_equivalent', conf: 'medium', for: [{ a: 'socket', s: 'H11', c: 'H11' }], against: [{ a: 'power', s: '30W', c: '80W', r: 'different' }], missing: ['vehicle fit not stated'], why: 'Same socket, different power.', price_ok: false, review: true };

  it('expands the compact format into the readable structure', () => {
    const r = parseAiResponse({ decisions: [good] });
    expect(r.invalid).toBe(0);
    expect(r.decisions[0]).toMatchObject({ candidate_id: '1.1', match_type: 'close_equivalent', confidence_level: 'medium', price_comparable: false, requires_human_review: true, missing_evidence: ['vehicle fit not stated'] });
    expect(r.decisions[0]!.supporting_evidence).toEqual([{ attribute: 'socket', source_value: 'H11', candidate_value: 'H11', result: 'agree' }]);
    expect(r.decisions[0]!.conflicting_evidence[0]).toMatchObject({ attribute: 'power', result: 'different' });
  });
  it('keeps the good decisions when one is malformed, and says how many were not usable', () => {
    const r = parseAiResponse({ decisions: [good, { id: '1.2', type: 'identical', conf: 'sure' }, { ...good, id: '1.3' }] });
    expect(r.decisions.map((d) => d.candidate_id)).toEqual(['1.1', '1.3']);
    expect(r.invalid).toBe(1);
  });
  it('reads "not stated" as unknown (null), and an answer without decisions as empty', () => {
    const r = parseAiResponse({ decisions: [{ ...good, for: [{ a: 'colour', s: 'not stated', c: 'white' }] }] });
    expect(r.decisions[0]!.supporting_evidence[0]).toMatchObject({ source_value: null, candidate_value: 'white' });
    expect(parseAiResponse({}).decisions).toEqual([]);
    expect(parseAiResponse(null).decisions).toEqual([]);
  });
  it('refuses a match type that is not one of the six', () => {
    expect(parseAiResponse({ decisions: [{ ...good, type: 'identical' }] }).decisions).toEqual([]);
  });
});

describe('safeguards: the model proposes, the rules decide what may stand', () => {
  const decision = (over: Partial<AiDecision> = {}): AiDecision => ({
    candidate_id: '1.1', match_type: 'exact_item', confidence_level: 'high',
    supporting_evidence: [{ attribute: 'brand', source_value: 'Heinz', candidate_value: 'Heinz', result: 'agree' }, { attribute: 'size', source_value: '500 ml', candidate_value: '500 ml', result: 'agree' }],
    conflicting_evidence: [], missing_evidence: [], explanation: 'Same product.', price_comparable: true, requires_human_review: false, ...over,
  });
  const facts = '{"t":"heinz tomato ketchup 500 ml","brand":"heinz","a":{"quantity":"500 ml (volume)"}}';
  const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
    engine: null, quantity: { verdict: 'same' } as GuardContext['quantity'], bundle: null, sourceBrandKey: 'heinz', candidateBrandKey: 'heinz', gtinEqual: false, gtinDiffer: false, sourceFacts: facts, candidateFacts: facts, ...over,
  });

  it('lets a clean exact item stand, and only that may be price-comparable', () => {
    const g = applyGuards(decision(), ctx());
    expect(g).toMatchObject({ match_type: 'exact_item', price_comparable: true, guards: [] });
    expect(applyGuards(decision({ match_type: 'close_equivalent' }), ctx()).price_comparable).toBe(false);
  });
  it('never lets the AI override a decisive incompatibility found by the rule engine', () => {
    const g = applyGuards(decision({ match_type: 'close_equivalent' }), ctx({ engine: { relationship: 'non_match', conflicts: ['Different part codes (H7 vs 9005)'] } }));
    expect(g.match_type).toBe('related');
    expect(g.ai_match_type).toBe('close_equivalent');
    expect(g.price_comparable).toBe(false);
    expect(g.guards.map((x) => x.code)).toContain('engine_hard_conflict');
    // "no shared identifying evidence" is not a conflict, so the AI may still judge the pair, but it cannot call it a VERIFIED equivalent: that is a substitute
    expect(applyGuards(decision({ match_type: 'close_equivalent' }), ctx({ domain: 'automotive', codesAgree: true, engine: { relationship: 'non_match', conflicts: [] } })).match_type).toBe('substitute');
    expect(applyGuards(decision({ match_type: 'substitute' }), ctx({ engine: { relationship: 'non_match', conflicts: [] } })).match_type).toBe('substitute');
  });
  it('the compatibility gate: a "close equivalent" must be verified, otherwise it is a substitute', () => {
    const eq = (over: Partial<GuardContext>) => applyGuards(decision({ match_type: 'close_equivalent' }), ctx({ domain: 'automotive', codesAgree: true, engine: { relationship: 'substitute', conflicts: [] }, ...over }));
    expect(eq({}).match_type).toBe('close_equivalent'); // the part code is shared, nothing conflicts, nothing is in doubt
    expect(eq({ codesAgree: false })).toMatchObject({ match_type: 'substitute', requires_human_review: true });
    expect(eq({ codesAgree: false }).guards.map((x) => x.code)).toContain('compat_gate');
    expect(eq({ engine: null }).match_type).toBe('substitute');
    expect(eq({ engine: { relationship: 'substitute', conflicts: ['Different lamp position'] } }).match_type).not.toBe('close_equivalent');
    expect(eq({ domain: 'grocery' }).match_type).toBe('substitute'); // a lager of another brand is a substitute, never an "equivalent"
    expect(eq({ domain: undefined }).match_type).toBe('substitute');
    const bundle = (verdict: string) => ({ verdict, note: 'n', exclusion: null }) as unknown as GuardContext['bundle'];
    expect(eq({ bundle: bundle('unknown') }).match_type).not.toBe('close_equivalent');
    expect(eq({ bundle: bundle('equivalent') }).match_type).toBe('close_equivalent');
    expect(eq({ quantity: { verdict: 'different' } as GuardContext['quantity'] }).match_type).toBe('substitute');
    // an equivalent is never an exact item and never price-comparable as one
    expect(eq({}).price_comparable).toBe(false);
  });
  it('keeps the bundle policy: a verified mismatch is at most related; unknown contents are never a match unless a barcode proves it', () => {
    const mismatch = { verdict: 'mismatch', note: 'one has a fog light', exclusion: 'x' } as unknown as GuardContext['bundle'];
    expect(applyGuards(decision({ match_type: 'substitute' }), ctx({ bundle: mismatch })).match_type).toBe('related');
    const unknown = { verdict: 'unknown', note: 'contents not spelled out', exclusion: null } as unknown as GuardContext['bundle'];
    expect(applyGuards(decision({ match_type: 'close_equivalent' }), ctx({ bundle: unknown })).match_type).toBe('no_match_uncertain');
    expect(applyGuards(decision({ match_type: 'exact_item' }), ctx({ bundle: unknown, gtinEqual: true })).match_type).toBe('exact_item');
    expect(applyGuards(decision(), ctx({ bundle: unknown, gtinEqual: true })).price_comparable).toBe(false);
  });
  it('keeps the quantity policy: different quantities are never exact, unknown ones are flagged, and neither is price-comparable', () => {
    const different = applyGuards(decision(), ctx({ quantity: { verdict: 'different' } as GuardContext['quantity'] }));
    expect(different).toMatchObject({ match_type: 'same_product_different_pack', price_comparable: false });
    const unknown = applyGuards(decision(), ctx({ quantity: { verdict: 'unknown' } as GuardContext['quantity'] }));
    expect(unknown).toMatchObject({ match_type: 'exact_item', price_comparable: false, requires_human_review: true, confidence_level: 'medium' });
  });
  it('never assumes two brands are the same maker, and two different barcodes are never the same item', () => {
    expect(applyGuards(decision(), ctx({ candidateBrandKey: 'hellmanns' })).match_type).toBe('close_equivalent');
    expect(applyGuards(decision(), ctx({ candidateBrandKey: 'hellmanns', gtinEqual: true })).match_type).toBe('exact_item');
    expect(applyGuards(decision(), ctx({ gtinDiffer: true })).match_type).toBe('close_equivalent');
    expect(applyGuards(decision(), ctx({ candidateBrandKey: '' })).guards.map((x) => x.code)).toContain('brand_unknown');
  });
  it('does not count a value that is not in the facts that were sent, and demotes an answer with nothing checkable', () => {
    const invented = decision({ match_type: 'close_equivalent', supporting_evidence: [{ attribute: 'power', source_value: '80W', candidate_value: '80W', result: 'agree' }] });
    const g = applyGuards(invented, ctx());
    expect(g.supporting_evidence[0]!.grounded).toBe(false);
    expect(g.match_type).toBe('no_match_uncertain');
    expect(g.guards.map((x) => x.code)).toEqual(expect.arrayContaining(['ungrounded_evidence', 'low_support']));
  });
  it('does not let a stand-in stand when the model itself reports that the part code differs, unless the rule engine found a shared code', () => {
    const different = decision({ match_type: 'substitute', supporting_evidence: [{ attribute: 'vehicle', source_value: 'Heinz', candidate_value: 'Heinz', result: 'agree' }], conflicting_evidence: [{ attribute: 'part_codes', source_value: 'heinz', candidate_value: '500 ml', result: 'different' }] });
    const g = applyGuards(different, ctx());
    expect(g.match_type).toBe('related');
    expect(g.guards.map((x) => x.code)).toContain('identity_conflict');
    expect(applyGuards(different, ctx({ codesAgree: true })).match_type).toBe('substitute');
  });
  it('every suggestion still needs a person in this release', () => {
    expect(applyGuards(decision(), ctx()).requires_human_review).toBe(true);
  });
  it('checks quoted values against the facts, ignoring units', () => {
    expect(isGrounded('30W', '{"power_w":30}')).toBe(true);
    expect(isGrounded('3000 lumens', '{"lumens":3000}')).toBe(true);
    expect(isGrounded('Heinz', '{"brand":"heinz"}')).toBe(true);
    expect(isGrounded('80W', '{"power_w":30}')).toBe(false);
    expect(isGrounded(null, '')).toBe(true);
  });
});

describe('token-aware batching', () => {
  const group = (n: number, size = 5): PayloadGroup => ({ ref: 's1', source: { t: 'source product with a title' }, candidates: Array.from({ length: n }, (_, i) => ({ id: `x${i}`, ref: `r${i}`, wire: { t: `candidate ${i} ${'word '.repeat(size)}` }, chk: { q: 'unknown' as const } })) });

  it('packs small shortlists together and never exceeds the candidates per request', () => {
    const plan = planBatches([group(3), group(3), group(3), group(3)], { ...DEFAULT_BATCH_LIMITS, maxCandidates: 8 });
    expect(plan.map((p) => p.candidates)).toEqual([6, 6]);
    expect(plan.flatMap((p) => p.groups).every((g) => g.candidates.length <= 8)).toBe(true);
  });
  it('cuts a large shortlist into several requests of the same source', () => {
    const plan = planBatches([group(25)], { ...DEFAULT_BATCH_LIMITS, maxCandidates: 10 });
    expect(plan.map((p) => p.candidates)).toEqual([10, 10, 5]);
  });
  it('splits on the input token ceiling too, and gives every candidate a unique id inside its request', () => {
    const plan = planBatches([group(6, 300), group(6, 300)], { ...DEFAULT_BATCH_LIMITS, maxCandidates: 30, maxInputTokens: 2500 });
    expect(plan.length).toBeGreaterThan(1);
    for (const p of plan) {
      expect(p.estimatedInputTokens).toBeLessThanOrEqual(2500 + 1500); // a single oversized group may exceed the ceiling by itself, never by more
      const ids = p.groups.flatMap((g) => g.candidates.map((c) => c.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it('estimates output so that an answer cannot outgrow its ceiling', () => {
    const [p] = planBatches([group(20)], { ...DEFAULT_BATCH_LIMITS, maxCandidates: 20, maxOutputTokens: 1000, tokensPerDecision: 190 });
    expect(p!.candidates * 190).toBeLessThanOrEqual(1000);
  });
  it('learns the real characters per token from what Google reports', () => {
    expect(estimateTokens('a'.repeat(330))).toBe(100);
    const c = calibrate(3.3, 100, 150);
    expect(c).toBeLessThan(3.3);
    expect(calibrate(3.3, 0, 150)).toBe(3.3);
    expect(buildUserPayload(plan1().groups)).toContain('"g":1');
    function plan1() { return planBatches([group(2)])[0]!; }
    expect(AI_SYSTEM_PROMPT).toMatch(/never invent/i);
  });
});

describe('the shared rate limiter', () => {
  const make = (over: Partial<ConstructorParameters<typeof AiLimiter>[0]> = {}, t = { now: Date.UTC(2026, 10, 4, 18, 0, 0) }) => ({ t, lim: new AiLimiter({ rpm: 5, tpm: 10_000, dailyRequests: 100, maxConcurrency: 3, ...over }, () => t.now, () => 0.5) });
  const run = (lim: AiLimiter, tokens = 100) => { lim.start(tokens); lim.finish(tokens, tokens); };

  it('allows at most the configured requests a minute and says how long to wait', () => {
    const { t, lim } = make({ maxConcurrency: 8 });
    for (let i = 0; i < 5; i++) { expect(lim.check(100)).toEqual({ ok: true }); run(lim); }
    const blocked = lim.check(100);
    expect(blocked).toMatchObject({ ok: false, reason: 'rpm' });
    t.now += 61_000;
    expect(lim.check(100)).toEqual({ ok: true });
  });
  it('limits tokens a minute', () => {
    const { lim } = make({ tpm: 1000, rpm: 50 });
    run(lim, 900);
    expect(lim.check(500)).toMatchObject({ ok: false, reason: 'tpm' });
    expect(lim.check(50)).toEqual({ ok: true });
  });
  it('keeps to a daily budget that survives a restart, and resets at the next Pacific day', () => {
    const { t, lim } = make({ dailyRequests: 3, rpm: 50 });
    lim.setToday(pacificDay(t.now), 3);
    expect(lim.check(10)).toMatchObject({ ok: false, reason: 'daily' });
    t.now += 24 * 3_600_000;
    expect(lim.check(10)).toEqual({ ok: true });
    expect(lim.snapshot().requestsToday).toBe(0);
  });
  it('bounds concurrency, grows it slowly while requests succeed and halves it after a rate-limit answer', () => {
    const { lim } = make({ maxConcurrency: 4, rpm: 100 });
    lim.start(10);
    lim.start(10);
    expect(lim.check(10)).toMatchObject({ ok: false, reason: 'concurrency' });
    lim.finish(10, 10);
    lim.finish(10, 10);
    for (let i = 0; i < 8; i++) lim.success();
    expect(lim.concurrency).toBe(3);
    lim.signal({ kind: 'quota_minute', retryAfterSeconds: 18, quotaValue: 15 });
    expect(lim.concurrency).toBe(1);
  });
  it('waits as long as Google asked after a 429, learns the limit it named, and keeps under it', () => {
    const { t, lim } = make({ rpm: 15 });
    lim.signal({ kind: 'quota_minute', retryAfterSeconds: 18, quotaValue: 10 });
    const c = lim.check(10);
    expect(c).toMatchObject({ ok: false, reason: 'paused' });
    expect((c as { waitMs: number }).waitMs).toBeGreaterThanOrEqual(15_000);
    expect(lim.effective().rpm).toBe(8); // 85 % of the limit Google named, never above the configured one
    t.now += 40_000;
    expect(lim.check(10)).toEqual({ ok: true });
  });
  it('pauses until the daily quota resets after a daily 429', () => {
    const { t, lim } = make();
    lim.signal({ kind: 'quota_day', quotaValue: 250 });
    const snap = lim.snapshot();
    expect(snap.pauseReason).toBe('daily');
    expect(snap.pausedUntil! - t.now).toBeGreaterThan(60_000);
    expect(snap.learned.rpd).toBe(250);
    expect(lim.effective().daily).toBe(100); // the configured budget is lower than 90 % of Google's, so it stays
  });
  it('stops completely when Google names a quota that is not a free-tier quota', () => {
    const { lim } = make();
    lim.signal({ kind: 'paid_tier' });
    expect(lim.check(10)).toMatchObject({ ok: false, reason: 'stopped' });
    expect(lim.snapshot().stopped).toMatch(/billed/);
  });
  it('backs off exponentially after overloads and recovers after a success', () => {
    const { t, lim } = make();
    lim.signal({ kind: 'overloaded' });
    const first = (lim.check(10) as { waitMs: number }).waitMs;
    t.now += first + 1;
    lim.signal({ kind: 'overloaded' });
    const second = (lim.check(10) as { waitMs: number }).waitMs;
    expect(second).toBeGreaterThan(first);
    lim.success();
    t.now += second + 1;
    lim.signal({ kind: 'overloaded' });
    expect((lim.check(10) as { waitMs: number }).waitMs).toBeLessThanOrEqual(first + 1000);
  });
});

describe('candidate discovery: the whole competitor catalogue, a small diverse shortlist per website', () => {
  const sourceMain = input('mine', 'Fit for 2013-2015 Toyota Camry LED Bulbs Upgrade', { variantTitle: 'High Beam / H11', options: { Location: 'High Beam / H11' }, brand: 'Lasfit' });
  const rightCode = input('auxito', 'AUXITO H11 H8 H9 LED Headlight Bulbs 6500K', { brand: 'AUXITO' });
  const otherCode = input('auxito', 'AUXITO 9005 HB3 LED Headlight Bulbs 6500K', { brand: 'AUXITO' });
  const nearDuplicates = Array.from({ length: 12 }, (_, i) => input('alla', `Alla Lighting H11 LED Fog Light Bulbs series ${i}`, { variantTitle: `Colour ${i}` }));
  const accessory = input('alla', 'H11 LED Adapter Holder Retainer Clip', { brand: 'Alla' });
  const fill = filler();
  const all = [sourceMain, rightCode, otherCode, ...nearDuplicates, accessory, ...fill];
  const corpus = analyseCatalogue(all);
  const competitors = [rightCode, otherCode, ...nearDuplicates, accessory, ...fill.filter((f) => f.siteId !== 'lasfit')].map((c) => corpus.byVariant.get(c.variantId)!);
  const ix = buildRetrievalIndex(competitors, corpus);
  const src = corpus.byVariant.get(sourceMain.variantId)!;

  it('finds the product that shares the part code, and says which methods found it', () => {
    const list = retrieveShortlist(ix, src);
    const hit = list.find((c) => c.variantId === rightCode.variantId)!;
    expect(hit).toBeDefined();
    expect(hit.foundBy.map((f) => f.method)).toEqual(expect.arrayContaining(['code']));
    expect(hit.foundBy.find((f) => f.method === 'code')!.detail).toMatch(/H11|H8|H9/i);
  });
  it('drops a candidate the rule engine finds decisively incompatible (a different part code), and keeps the evidence on the rest', () => {
    const list = retrieveShortlist(ix, src);
    expect(list.map((c) => c.variantId)).not.toContain(otherCode.variantId);
    expect(retrieveShortlist(ix, src, { dropHardConflicts: false, perSiteProducts: 30 }).map((c) => c.variantId)).toContain(otherCode.variantId);
    expect(retrieveShortlist(ix, src, { perSiteProducts: 30 }).map((c) => c.variantId)).not.toContain(otherCode.variantId);
    expect(list.every((c) => c.engine !== null)).toBe(true);
  });
  it('keeps one variant per competitor product and at most the configured products per website, so near-identical listings cannot crowd the shortlist', () => {
    const list = retrieveShortlist(ix, src, { perSiteProducts: 3 });
    const bySite = new Map<string, number>();
    for (const c of list) bySite.set(c.siteId, (bySite.get(c.siteId) ?? 0) + 1);
    expect([...bySite.values()].every((n) => n <= 3)).toBe(true);
    expect(new Set(list.map((c) => c.productId)).size).toBe(list.length);
    expect(list.filter((c) => c.siteId === 'alla').length).toBeLessThanOrEqual(3);
  });
  it('never returns a candidate from the source product\'s own website', () => {
    expect(retrieveShortlist(ix, src).every((c) => c.siteId !== 'mine')).toBe(true);
  });
  it('is the same every time (no hidden randomness)', () => {
    expect(retrieveShortlist(ix, src).map((c) => c.variantId)).toEqual(retrieveShortlist(ix, src).map((c) => c.variantId));
  });
});

describe('the AI dossier: every attribute keeps its source and unknown stays unknown', () => {
  const all = [
    input('lasfit', 'Fit for 2013-2015 Toyota Camry LED Bulbs Upgrade', { variantTitle: 'Low Beam / H11', options: { Location: 'Low Beam / H11' }, brand: 'Lasfit' }),
    input('shop', 'Poland Spring Natural Spring Water 24 x 16.9 fl oz', { brand: 'Poland Spring', gtin: '012345678905' }),
    input('shop', 'Mystery Item', {}),
    ...filler(),
  ];
  const corpus = analyseCatalogue(all);

  it('reads an automotive listing into codes, vehicle, years and position, each with its source', () => {
    const d = buildAiDossier(corpus.byVariant.get(all[0]!.variantId)!, { url: 'https://example.test/p/1', alias: corpus.alias });
    expect(d.domain).toBe('automotive');
    expect(d.attributes['part_codes']).toMatchObject({ value: expect.arrayContaining(['H11']) }); // as the listing writes it, not the folded alias
    expect(d.attributes['same_part_also_written_as']).toBeDefined();
    expect(['title', 'variant title', 'variant option']).toContain(d.attributes['part_codes']!.source);
    expect(d.attributes['model_years']).toMatchObject({ value: expect.stringContaining('2013') });
    expect(d.unknown).toEqual(expect.arrayContaining(['power_w', 'lumens']));
    expect(d.url).toBe('https://example.test/p/1');
  });
  it('reads a grocery listing into quantity and pack, and does not take every number for a quantity', () => {
    const d = buildAiDossier(corpus.byVariant.get(all[1]!.variantId)!);
    expect(d.domain).toBe('grocery');
    expect(d.attributes['quantity']).toBeDefined();
    expect(d.brand).toMatchObject({ value: 'Poland Spring', source: 'vendor field' });
  });
  it('says what is not stated instead of inventing it', () => {
    const d = buildAiDossier(corpus.byVariant.get(all[2]!.variantId)!);
    expect(d.unknown).toEqual(expect.arrayContaining(['brand']));
    expect(d.attributes['quantity']).toBeUndefined();
  });
  it('is compact (no URLs) and its fingerprint changes only when what is sent changes', () => {
    const a = buildAiDossier(corpus.byVariant.get(all[0]!.variantId)!, { url: 'https://example.test/a' });
    const b = buildAiDossier(corpus.byVariant.get(all[0]!.variantId)!, { url: 'https://example.test/b' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(JSON.stringify(toWire(a))).not.toContain('example.test');
    const c = buildAiDossier(corpus.byVariant.get(all[0]!.variantId)!, { description: 'Bulb Size Chart: Low Beam H11 65W 6500LM, a long description that adds facts' });
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
  it('evaluates the same pair the rule engine would (the dossier does not change the engine)', () => {
    const e = evaluatePair(corpus.byVariant.get(all[0]!.variantId)!, corpus.byVariant.get(all[0]!.variantId)!, corpus);
    expect(e.relationship).toBeDefined();
  });
});
