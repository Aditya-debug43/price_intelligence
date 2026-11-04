import { and, desc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_GATE,
  ENGINE_VERSION,
  AI_PROMPT_VERSION,
  gateForClass,
  retrieveShortlist,
  scoreEvaluation,
  CLASS_RELATIONSHIP,
  type AutoClass,
  type EvalCase,
  type EvalDomain,
  type EvalPrediction,
  type TruthRelationship,
} from '@ci/core';
import { classOfRelationship, type BundleCheck, type QuantityCheck } from '@ci/shared';
import { auditEvents, matchAutoApproval, matchEvalCases, matchEvalReports, productMatches, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { buildContext, semanticFor } from './ai-match.ts';
import { withHeavyWork } from './heavy.ts';
import { MatchError } from './matching.ts';
import { recordMatchEvents } from './matching-v2.ts';

/**
 * The independent evaluation of matching. A person (not the development process, and not Gemini) labels a stratified sample of your variants against each competitor website: which competitor
 * variant, if any, is the true counterpart, and what the two are. The system is then scored against those labels, separately for the development and the holdout cases, by domain, website and
 * category. Automatic approval of a class can be switched on only when the holdout measurement passes the release gate, and is switched off again if later audits fall below it.
 *
 * Nothing here makes up a label. With no labels the report says so and every gate stays closed.
 */

const AUTO_CLASSES: AutoClass[] = ['exact_item', 'compatible_equivalent'];
const DOMAINS: EvalDomain[] = ['automotive', 'grocery'];
/** Share of products kept for the holdout set, chosen by a fixed rule on the product (so reselecting never moves a case between the sets). */
const HOLDOUT_PERCENT = 40;
const STRENGTH: Record<string, number> = { exact: 5, variant: 4, equivalent: 3, substitute: 2, related: 1 };
const AI_REL: Record<string, EvalPrediction['relationship'] | null> = { exact_item: 'exact', same_product_different_pack: 'variant', close_equivalent: 'equivalent', substitute: 'substitute', related: 'related', no_match_uncertain: null };

const OWN = (orgId: string) => sql`(
  select v.id as vid, p.id as pid, p.category as category,
    case when p.title ~* '(^|[^a-z])(bulbs?|led|leds|headlights?|lamps?|fog|wipers?|mats?|h[0-9]{1,2}|9[0-9]{3}|canbus)([^a-z]|$)' then 'automotive' else 'grocery' end as domain
  from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id
  where v.org_id = ${orgId} and s.role = 'source' and s.active and p.delisted_at is null
)`;
const COMP = (orgId: string) => sql`(select id as site_id from sites where org_id = ${orgId} and role = 'competitor' and active)`;
const LIVE = sql`(m.status = 'accepted' or (m.status in ('needs_review','auto') and m.superseded_at is null))`;

/** The pairs (own variant, competitor website) of each kind of case. */
const STRATA: { name: string; share: number; from: (orgId: string) => ReturnType<typeof sql> }[] = [
  { name: 'confirmed', share: 0.14, from: (o) => sql`select m.source_variant_id as sv, m.competitor_site_id as site from product_matches m where m.org_id = ${o} and m.status = 'accepted' and m.auto_confirmed_at is null` },
  { name: 'suggested', share: 0.2, from: (o) => sql`select m.source_variant_id as sv, m.competitor_site_id as site from product_matches m where m.org_id = ${o} and m.status in ('needs_review','auto') and m.superseded_at is null` },
  { name: 'rejected', share: 0.1, from: (o) => sql`select m.source_variant_id as sv, m.competitor_site_id as site from product_matches m where m.org_id = ${o} and m.status = 'rejected'` },
  { name: 'set_aside', share: 0.1, from: (o) => sql`select m.source_variant_id as sv, m.competitor_site_id as site from product_matches m where m.org_id = ${o} and m.superseded_at is not null and m.status in ('needs_review','auto')` },
  { name: 'ai', share: 0.14, from: (o) => sql`select a.source_variant_id as sv, a.competitor_site_id as site from ai_match_suggestions a where a.org_id = ${o}` },
  { name: 'lookalike', share: 0.1, from: (o) => sql`select m.source_variant_id as sv, m.competitor_site_id as site from product_matches m where m.org_id = ${o} and ${LIVE} group by 1, 2 having count(*) >= 2` },
  { name: 'auto_audit', share: 0.04, from: (o) => sql`select m.source_variant_id as sv, m.competitor_site_id as site from product_matches m where m.org_id = ${o} and m.status = 'accepted' and m.auto_confirmed_at is not null` },
  { name: 'no_counterpart', share: 0.14, from: (o) => sql`select o.vid as sv, (select site_id from ${COMP(o)} c order by md5(o.vid::text || c.site_id::text) limit 1) as site from ${OWN(o)} o where not exists (select 1 from product_matches m where m.source_variant_id = o.vid and ${LIVE})` },
  { name: 'random', share: 0.04, from: (o) => sql`select o.vid as sv, (select site_id from ${COMP(o)} c order by md5(o.vid::text || c.site_id::text || 'r') limit 1) as site from ${OWN(o)} o` },
];

export interface PrepareResult {
  selected: number;
  byStratum: Record<string, number>;
}

/** Selects a stratified sample of cases to label (default about 300 per workspace). Cases already selected are kept; re-running only adds. */
export async function prepareEvalSet(db: DbLike, orgId: string, opts: { size?: number; seed?: string } = {}): Promise<PrepareResult> {
  const size = Math.min(Math.max(opts.size ?? 300, 20), 1000);
  const seed = opts.seed ?? 'shelfwatch-eval-1';
  const byStratum: Record<string, number> = {};
  let selected = 0;
  for (const st of STRATA) {
    const quota = Math.max(1, Math.round(size * st.share));
    const res = await db.execute<{ id: string }>(sql`
      insert into match_eval_cases (org_id, source_variant_id, competitor_site_id, domain, stratum, split)
      select ${orgId}, x.sv, x.site, o.domain, ${st.name},
        case when abs(('x' || substr(md5(x.sv::text), 1, 8))::bit(32)::bigint) % 100 < ${HOLDOUT_PERCENT} then 'holdout' else 'development' end
      from (select distinct sv, site from (${st.from(orgId)}) f where site is not null) x
      join ${OWN(orgId)} o on o.vid = x.sv
      where not exists (select 1 from match_eval_cases e where e.source_variant_id = x.sv and e.competitor_site_id = x.site)
      order by md5(${seed} || x.sv::text || x.site::text)
      limit ${quota}
      on conflict do nothing
      returning id`);
    byStratum[st.name] = res.rows.length;
    selected += res.rows.length;
  }
  return { selected, byStratum };
}

export interface EvalCandidate {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  brand: string | null;
  mpn: string | null;
  sku: string | null;
  size: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
}

export interface EvalCaseView {
  id: string;
  stratum: string;
  split: 'development' | 'holdout';
  domain: string;
  status: 'pending' | 'labelled' | 'skipped';
  source: { variantId: string; productId: string; title: string; variantTitle: string | null; brand: string | null; mpn: string | null; sku: string | null; size: string | null; price: number | null; currency: string | null; url: string | null };
  siteId: string;
  siteName: string;
  /** What the system had at this website, WITHOUT its verdicts: the labeller sees products, not the system's opinion, so it cannot sway them. In an order that does not reveal the ranking. */
  candidates: EvalCandidate[];
  label: { truthVariantId: string | null; relationship: string; expertise: string | null; labelledAt: string | null; note: string | null } | null;
}

export async function listEvalCases(db: DbLike, orgId: string, f: { status?: 'pending' | 'labelled' | 'skipped'; split?: 'development' | 'holdout'; page: number; pageSize: number }): Promise<{ rows: EvalCaseView[]; total: number }> {
  const where = sql`e.org_id = ${orgId} ${f.status ? sql`and e.status = ${f.status}` : sql``} ${f.split ? sql`and e.split = ${f.split}` : sql``}`;
  const limit = Math.min(Math.max(1, f.pageSize), 50);
  const offset = Math.max(0, (f.page - 1) * limit);
  const cases = await db.execute<Record<string, unknown>>(sql`
    select e.id, e.stratum, e.split, e.domain, e.status, e.source_variant_id as "svid", e.competitor_site_id as "siteId", sc.name as "siteName", e.truth_variant_id as "truthVariantId", e.truth_relationship as "truthRelationship", e.expertise, e.labelled_at as "labelledAt", e.note,
      p.id as "pid", p.title, v.title as "variantTitle", p.brand, p.mpn, v.sku, v.qty_label as "size", v.price, v.currency, v.url
    from match_eval_cases e join variants v on v.id = e.source_variant_id join products p on p.id = v.product_id join sites sc on sc.id = e.competitor_site_id
    where ${where} order by md5(e.id::text) limit ${limit} offset ${offset}`);
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n from match_eval_cases e where ${where}`);
  const ids = cases.rows.map((r) => String(r['id']));
  const cand = ids.length
    ? await db.execute<Record<string, unknown>>(sql`
        select * from (
          select distinct on (c.case_id, c.cv) c.case_id, c.cv, vv.id as "variantId", pp.id as "productId", pp.title, vv.title as "variantTitle", pp.brand, pp.mpn, vv.sku, vv.qty_label as "size", vv.price, vv.currency, vv.url
          from (
            select e.id as case_id, m.competitor_variant_id as cv from match_eval_cases e join product_matches m on m.source_variant_id = e.source_variant_id and m.competitor_site_id = e.competitor_site_id where e.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
            union
            select e.id, a.competitor_variant_id from match_eval_cases e join ai_match_suggestions a on a.source_variant_id = e.source_variant_id and a.competitor_site_id = e.competitor_site_id where e.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
            union
            select e.id, e.truth_variant_id from match_eval_cases e where e.truth_variant_id is not null and e.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
          ) c join variants vv on vv.id = c.cv join products pp on pp.id = vv.product_id
          order by c.case_id, c.cv
        ) z order by md5(z.case_id::text || z.cv::text)`)
    : { rows: [] as Record<string, unknown>[] };
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const byCase = new Map<string, EvalCandidate[]>();
  for (const c of cand.rows) {
    const list = byCase.get(String(c['case_id'])) ?? byCase.set(String(c['case_id']), []).get(String(c['case_id']))!;
    if (list.length < 10) list.push({ variantId: String(c['variantId']), productId: String(c['productId']), title: String(c['title']), variantTitle: (c['variantTitle'] as string | null) ?? null, brand: (c['brand'] as string | null) ?? null, mpn: (c['mpn'] as string | null) ?? null, sku: (c['sku'] as string | null) ?? null, size: (c['size'] as string | null) ?? null, price: num(c['price']), currency: (c['currency'] as string | null) ?? null, url: (c['url'] as string | null) ?? null });
  }
  return {
    total: Number(total.rows[0]?.n ?? 0),
    rows: cases.rows.map((r): EvalCaseView => ({
      id: String(r['id']), stratum: String(r['stratum']), split: r['split'] as 'development' | 'holdout', domain: String(r['domain']), status: r['status'] as EvalCaseView['status'], siteId: String(r['siteId']), siteName: String(r['siteName']),
      source: { variantId: String(r['svid']), productId: String(r['pid']), title: String(r['title']), variantTitle: (r['variantTitle'] as string | null) ?? null, brand: (r['brand'] as string | null) ?? null, mpn: (r['mpn'] as string | null) ?? null, sku: (r['sku'] as string | null) ?? null, size: (r['size'] as string | null) ?? null, price: num(r['price']), currency: (r['currency'] as string | null) ?? null, url: (r['url'] as string | null) ?? null },
      candidates: byCase.get(String(r['id'])) ?? [],
      label: r['truthRelationship'] ? { truthVariantId: (r['truthVariantId'] as string | null) ?? null, relationship: String(r['truthRelationship']), expertise: (r['expertise'] as string | null) ?? null, labelledAt: r['labelledAt'] ? new Date(r['labelledAt'] as string | Date).toISOString() : null, note: (r['note'] as string | null) ?? null } : null,
    })),
  };
}

export async function evalProgress(db: DbLike, orgId: string) {
  const rows = await db.select({ split: matchEvalCases.split, status: matchEvalCases.status, n: sql<number>`count(*)::int` }).from(matchEvalCases).where(eq(matchEvalCases.orgId, orgId)).groupBy(matchEvalCases.split, matchEvalCases.status);
  const n = (split: string, status: string) => rows.find((r) => r.split === split && r.status === status)?.n ?? 0;
  const [last] = await db.select().from(matchEvalReports).where(eq(matchEvalReports.orgId, orgId)).orderBy(desc(matchEvalReports.createdAt)).limit(1);
  const flags = await db.select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, orgId));
  return {
    development: { pending: n('development', 'pending'), labelled: n('development', 'labelled'), skipped: n('development', 'skipped') },
    holdout: { pending: n('holdout', 'pending'), labelled: n('holdout', 'labelled'), skipped: n('holdout', 'skipped') },
    target: { minimumLabelled: 300, perClassMinimum: DEFAULT_GATE.minExamples },
    latestReport: last ? { id: last.id, createdAt: last.createdAt.toISOString(), cases: last.cases, report: last.report, gates: last.gates, engineVersion: last.engineVersion, model: last.model } : null,
    autoApproval: flags.map((f) => ({ domain: f.domain, autoClass: f.autoClass, enabled: f.enabled, enabledAt: f.enabledAt?.toISOString() ?? null, disabledReason: f.disabledReason })),
  };
}

const RELATIONSHIPS = ['exact', 'variant', 'equivalent', 'substitute', 'related', 'none'] as const;

/** A person records what is true. Nothing is inferred; "none" says no competitor variant at this website is a counterpart. */
export async function labelEvalCase(db: DbLike, orgId: string, userId: string, caseId: string, p: { truthVariantId?: string | null; relationship: string; expertise: 'knowledgeable' | 'general'; note?: string }, now: Date) {
  const [c] = await db.select().from(matchEvalCases).where(and(eq(matchEvalCases.id, caseId), eq(matchEvalCases.orgId, orgId)));
  if (!c) throw new MatchError('Evaluation case not found');
  if (!(RELATIONSHIPS as readonly string[]).includes(p.relationship)) throw new MatchError('Choose what the two products are, or "none".', 400);
  let truth: string | null = null;
  if (p.relationship !== 'none') {
    if (!p.truthVariantId) throw new MatchError('Choose which competitor product it is.', 400);
    const ok = await db.execute<{ id: string }>(sql`select v.id from variants v join products pr on pr.id = v.product_id where v.id = ${p.truthVariantId}::uuid and v.org_id = ${orgId} and pr.site_id = ${c.competitorSiteId}::uuid`);
    if (!ok.rows.length) throw new MatchError('That product is not at this competitor website.', 400);
    truth = p.truthVariantId;
  }
  const [row] = await db.update(matchEvalCases).set({ status: 'labelled', truthVariantId: truth, truthRelationship: p.relationship, expertise: p.expertise, labelledBy: userId, labelledAt: now, note: p.note?.trim().slice(0, 500) || null }).where(eq(matchEvalCases.id, caseId)).returning();
  await db.insert(auditEvents).values({ orgId, userId, action: 'match_eval.label', target: caseId, meta: { relationship: p.relationship, split: c.split, expertise: p.expertise } });
  return row!;
}

export async function skipEvalCase(db: DbLike, orgId: string, userId: string, caseId: string, note: string | undefined, now: Date) {
  const [row] = await db.update(matchEvalCases).set({ status: 'skipped', labelledBy: userId, labelledAt: now, note: note?.slice(0, 500) ?? null }).where(and(eq(matchEvalCases.id, caseId), eq(matchEvalCases.orgId, orgId), eq(matchEvalCases.status, 'pending'))).returning();
  if (!row) throw new MatchError('Only a case that has not been labelled can be skipped.', 409);
  return row;
}

const pick = (a: EvalPrediction | null, b: EvalPrediction | null): EvalPrediction | null => (STRENGTH[a?.relationship ?? ''] ?? 0) >= (STRENGTH[b?.relationship ?? ''] ?? 0) ? a : b;

/**
 * Measures the system against the labelled cases and stores the report. Candidate recall is measured by running retrieval for each labelled source variant: the case is a hit only when the TRUE
 * VARIANT (not merely its parent product) is among the candidates, at the internal pool depth and at the depth the AI actually judges.
 */
export async function runEvaluation(svc: Services, orgId: string, userId: string | null): Promise<{ reportId: string; cases: number }> {
  const db = svc.db as DbLike;
  const labelled = await db.select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, orgId), eq(matchEvalCases.status, 'labelled')));
  const sources = [...new Set(labelled.map((c) => c.sourceVariantId))];
  const ctx = labelled.length ? await withHeavyWork(() => buildContext(db, orgId, svc.config.GEMINI_EMBEDDING_MODEL)) : null;
  const hits = new Map<string, { pool: boolean; shortlist: boolean }>();
  if (ctx) {
    for (const sv of sources) {
      const src = ctx.corpus.byVariant.get(sv);
      if (!src) continue;
      const found = retrieveShortlist(ctx.index, src, { perSiteProducts: 25, poolPerSite: 60 }, await semanticFor(ctx, sv));
      for (const c of found) {
        const k = `${sv}|${c.variantId}`;
        hits.set(k, { pool: true, shortlist: c.siteRank <= 3 });
      }
    }
  }
  // what the system said at each (variant, website): pairs of the matcher, answers of the AI, confirmations by the matcher itself
  const idList = sources.length ? sql.join(sources.map((s) => sql`${s}::uuid`), sql`, `) : sql`null::uuid`;
  const pairs = await db.execute<Record<string, unknown>>(sql`
    select m.source_variant_id as sv, m.competitor_site_id as site, m.competitor_variant_id as cv, m.status, m.superseded_at as sup, m.auto_confirmed_at as auto, m.decided_by as by, m.method, m.confidence,
      coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end) as rel, ev.rel as suggested
    from product_matches m
    left join lateral (select e.relationship as rel from match_events e where e.match_id = m.id and e.kind in ('suggested','changed','reinstated') order by e.created_at desc limit 1) ev on true
    where m.org_id = ${orgId} and m.source_variant_id in (${idList}) and m.status <> 'rejected'`);
  const ai = await db.execute<Record<string, unknown>>(sql`select source_variant_id as sv, competitor_site_id as site, competitor_variant_id as cv, match_type, auto_class, status from ai_match_suggestions where org_id = ${orgId} and source_variant_id in (${idList})`);
  const cats = await db.execute<{ vid: string; category: string | null }>(sql`select v.id as vid, p.category from variants v join products p on p.id = v.product_id where v.id in (${idList})`);
  const category = new Map(cats.rows.map((r) => [r.vid, r.category]));
  const siteNames = await db.execute<{ id: string; name: string }>(sql`select id, name from sites where org_id = ${orgId}`);
  const siteName = new Map(siteNames.rows.map((r) => [r.id, r.name]));

  const cases: EvalCase[] = labelled.map((c) => {
    const key = (r: Record<string, unknown>) => String(r['sv']) === c.sourceVariantId && String(r['site']) === c.competitorSiteId;
    const here = pairs.rows.filter(key);
    const live = here.filter((r) => r['status'] === 'accepted' || r['sup'] === null);
    // a pair a person decided shows the relationship the SYSTEM suggested, not the person's own answer
    const asSuggested = (r: Record<string, unknown>) => String((r['by'] && r['suggested']) ? r['suggested'] : r['rel']);
    const ruleRows = live.filter((r) => r['method'] !== 'manual' && r['method'] !== 'ai_auto' && (STRENGTH[asSuggested(r)] ?? 0) > 0).sort((a, b) => (STRENGTH[asSuggested(b)] ?? 0) - (STRENGTH[asSuggested(a)] ?? 0) || Number(b['confidence']) - Number(a['confidence']));
    const rule: EvalPrediction | null = ruleRows[0] ? { variantId: String(ruleRows[0]['cv']), relationship: asSuggested(ruleRows[0]) as EvalPrediction['relationship'], autoClass: null } : null;
    const aiRows = ai.rows.filter(key).filter((r) => AI_REL[String(r['match_type'])]).sort((a, b) => (STRENGTH[AI_REL[String(b['match_type'])]!] ?? 0) - (STRENGTH[AI_REL[String(a['match_type'])]!] ?? 0));
    const aiPred: EvalPrediction | null = aiRows[0] ? { variantId: String(aiRows[0]['cv']), relationship: AI_REL[String(aiRows[0]['match_type'])]!, autoClass: (aiRows[0]['auto_class'] as AutoClass | null) ?? null } : null;
    const autoRow = live.find((r) => r['status'] === 'accepted' && r['auto'] !== null);
    const autoPred: EvalPrediction | null = autoRow ? { variantId: String(autoRow['cv']), relationship: String(autoRow['rel']) as EvalPrediction['relationship'], autoClass: null } : null;
    const combined = autoPred ?? pick(aiPred, rule);
    const waiting = live.some((r) => r['status'] !== 'accepted' && (STRENGTH[String(r['rel'])] ?? 0) >= 2) || aiRows.some((r) => r['status'] === 'pending' && (STRENGTH[AI_REL[String(r['match_type'])]!] ?? 0) >= 2);
    const hit = hits.get(`${c.sourceVariantId}|${c.truthVariantId}`);
    const measurable = !!ctx?.corpus.byVariant.get(c.sourceVariantId) && c.truthVariantId !== null && c.truthRelationship !== 'none' && c.truthRelationship !== 'related';
    return {
      id: c.id, domain: (c.domain as EvalDomain) ?? 'general', siteId: c.competitorSiteId, siteName: siteName.get(c.competitorSiteId) ?? 'Competitor', category: category.get(c.sourceVariantId) ?? null, split: c.split, stratum: c.stratum,
      truthVariantId: c.truthVariantId, truthRelationship: (c.truthRelationship ?? 'none') as TruthRelationship, candidateHit: measurable ? !!hit?.pool : null,
      rule, ai: aiPred, combined, autoApproved: !!autoRow, needsHuman: !autoRow && waiting, expertise: c.expertise ?? 'general',
    };
  });

  const all = scoreEvaluation(cases, 'all');
  const holdout = scoreEvaluation(cases, 'holdout');
  const development = scoreEvaluation(cases, 'development');
  const shortlistMeasured = cases.filter((c) => c.candidateHit !== null);
  const shortlistHits = shortlistMeasured.filter((c) => hits.get(`${labelled.find((l) => l.id === c.id)!.sourceVariantId}|${c.truthVariantId}`)?.shortlist).length;
  const gates = DOMAINS.flatMap((d) => AUTO_CLASSES.map((cl) => gateForClass(cases, d, cl)));
  const [report] = await db
    .insert(matchEvalReports)
    .values({
      orgId, split: 'all', cases: cases.length, createdBy: userId, createdAt: svc.clock(), engineVersion: ENGINE_VERSION, model: svc.config.GEMINI_MODEL, promptVersion: AI_PROMPT_VERSION,
      report: { all, holdout, development, poolDepthPerSite: 25, shortlistDepthPerSite: 3, shortlistRecall: { hits: shortlistHits, total: shortlistMeasured.length }, note: 'Scored against labels made by people; the system\'s own answers are never used as truth.' } as unknown as Record<string, unknown>,
      gates: gates as unknown as Record<string, unknown>[],
    })
    .returning();
  // a class that is on is switched off again when its measurement no longer passes, or when audits of what it approved fall below the gate
  const audited = cases.filter((c) => c.stratum === 'auto_audit');
  const auditCorrect = audited.filter((c) => c.autoApproved && c.truthVariantId === c.combined?.variantId && c.truthRelationship === c.combined?.relationship).length;
  const auditFails = audited.length >= 30 && auditCorrect / audited.length < DEFAULT_GATE.autoPrecision;
  for (const g of gates) {
    const enough = g.result.lines.every((l) => l.examples >= DEFAULT_GATE.minExamples);
    if (!g.result.passed && (enough || auditFails)) {
      await db.update(matchAutoApproval).set({ enabled: false, disabledReason: auditFails ? 'Audits of automatically approved pairs fell below the gate.' : 'The latest measurement no longer passes the release gate.', updatedAt: new Date() }).where(and(eq(matchAutoApproval.orgId, orgId), eq(matchAutoApproval.domain, g.domain), eq(matchAutoApproval.autoClass, g.autoClass), eq(matchAutoApproval.enabled, true)));
    }
  }
  return { reportId: report!.id, cases: cases.length };
}

/** A person switches a class on (only when the latest measurement, made after the last label, passed the gate) or off. */
export async function setAutoApproval(db: DbLike, orgId: string, userId: string, p: { domain: EvalDomain; autoClass: AutoClass; enabled: boolean }, now: Date) {
  if (p.enabled) {
    const [rep] = await db.select().from(matchEvalReports).where(eq(matchEvalReports.orgId, orgId)).orderBy(desc(matchEvalReports.createdAt)).limit(1);
    const [lastLabel] = await db.select({ at: sql<Date | null>`max(${matchEvalCases.labelledAt})` }).from(matchEvalCases).where(and(eq(matchEvalCases.orgId, orgId), eq(matchEvalCases.status, 'labelled')));
    if (!rep) throw new MatchError('There is no evaluation yet: label a sample and run the evaluation first.', 409);
    if (lastLabel?.at && new Date(lastLabel.at) > rep.createdAt) throw new MatchError('Labels were added after the last evaluation: run the evaluation again.', 409);
    const gate = (rep.gates as unknown as { domain: string; autoClass: string; result: { passed: boolean } }[]).find((g) => g.domain === p.domain && g.autoClass === p.autoClass);
    if (!gate?.result.passed) throw new MatchError('This class has not passed the release gate (candidate recall, precision and recall on independently labelled holdout cases), so it cannot be switched on.', 409);
    await db.insert(matchAutoApproval).values({ orgId, domain: p.domain, autoClass: p.autoClass, enabled: true, enabledBy: userId, enabledAt: now, gateAtEnable: gate as unknown as Record<string, unknown>, disabledReason: null, updatedAt: now })
      .onConflictDoUpdate({ target: [matchAutoApproval.orgId, matchAutoApproval.domain, matchAutoApproval.autoClass], set: { enabled: true, enabledBy: userId, enabledAt: now, gateAtEnable: gate as unknown as Record<string, unknown>, disabledReason: null, updatedAt: now } });
  } else {
    await db.update(matchAutoApproval).set({ enabled: false, disabledReason: 'Switched off by a person.', updatedAt: now }).where(and(eq(matchAutoApproval.orgId, orgId), eq(matchAutoApproval.domain, p.domain), eq(matchAutoApproval.autoClass, p.autoClass)));
  }
  await db.insert(auditEvents).values({ orgId, userId, action: p.enabled ? 'match_auto.enable' : 'match_auto.disable', target: `${p.domain}:${p.autoClass}`, meta: {} });
}

/** The classes switched on for a workspace. */
export async function enabledAutoClasses(db: DbLike, orgId: string): Promise<Set<string>> {
  const rows = await db.select().from(matchAutoApproval).where(and(eq(matchAutoApproval.orgId, orgId), eq(matchAutoApproval.enabled, true)));
  return new Set(rows.map((r) => `${r.domain}:${r.autoClass}`));
}


/**
 * Confirms a pair from an AI answer whose class a person switched on after it passed the measured gate. Only when no person has decided the pair; the confirmation carries the automatic marker
 * (a person's later decision clears it and is final), is recorded in the pair's history and the audit log, and is exactly as strict about quantity and bundle contents as any automatic confirmation.
 */
export async function autoApprovePair(
  db: DbLike,
  orgId: string,
  p: { sourceVariantId: string; competitorVariantId: string; competitorSiteId: string; autoClass: AutoClass; quantity: QuantityCheck | null; bundle: BundleCheck | null },
  now: Date,
): Promise<'approved' | 'skipped'> {
  const [existing] = await db.select().from(productMatches).where(and(eq(productMatches.sourceVariantId, p.sourceVariantId), eq(productMatches.competitorVariantId, p.competitorVariantId)));
  if (existing && (existing.decidedBy !== null || existing.status === 'accepted' || existing.status === 'rejected')) return 'skipped';
  const relationship = CLASS_RELATIONSHIP[p.autoClass];
  const exclusion = p.quantity?.exclusion ?? p.bundle?.exclusion ?? null;
  const values = {
    matchClass: classOfRelationship(relationship), confidence: 0.99, status: 'accepted' as const, method: 'ai_auto', relationship, tier: 'strong' as const,
    reasons: [`Approved automatically from an AI answer: the class "${p.autoClass}" passed the measured release gate`], supersededAt: null, needsReevaluation: false, autoConfirmedAt: now, decidedAt: now,
    decisionNote: 'Confirmed automatically from an AI answer that met the measured release gate. You can overrule it in Match review.', priceExclusion: exclusion, priceExcludedAt: exclusion ? now : null, quantityCheck: p.quantity, bundleCheck: p.bundle, updatedAt: now,
  };
  const row = existing
    ? (await db.update(productMatches).set(values).where(eq(productMatches.id, existing.id)).returning())[0]!
    : (await db.insert(productMatches).values({ orgId, sourceVariantId: p.sourceVariantId, competitorVariantId: p.competitorVariantId, competitorSiteId: p.competitorSiteId, components: {}, ...values }).returning())[0]!;
  await recordMatchEvents(db, orgId, [row.id], 'auto_confirmed', { note: `AI answer approved automatically (${p.autoClass}); the class passed the measured release gate.` });
  await db.insert(auditEvents).values({ orgId, userId: null, action: 'match_auto.approve', target: row.id, meta: { autoClass: p.autoClass } });
  return 'approved';
}
