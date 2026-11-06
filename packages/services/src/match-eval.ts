import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AI_PROMPT_VERSION,
  AUTO_POLICY_VERSION,
  CLASS_RELATIONSHIP,
  DEFAULT_GATE,
  ENGINE_VERSION,
  SUPPORTED_POLICIES,
  gateForClass,
  isPositive,
  neededFamilies,
  retrieveShortlist,
  scoreEvaluation,
  type AutoClass,
  type EvalCase,
  type EvalDomain,
  type EvalPrediction,
  type PositiveRelationship,
} from '@ci/core';
import { auditEvents, matchAutoApproval, matchEvalCases, matchEvalReports, matchEvalTruths, type DbLike } from '@ci/database';
import type { JobQueue, Services } from './context.ts';
import { buildContext, currentFingerprints, semanticFor } from './ai-match.ts';
import { withHeavyWork } from './heavy.ts';
import { MatchError } from './matching.ts';

/**
 * The independent evaluation of matching. A person (not the development process, and not Gemini) judges the candidates at each competitor website for a stratified sample of your variants:
 * which are acceptable counterparts (and what each one is: several can be valid), which are NOT counterparts, and whether that list is complete. A candidate nobody judged is "unjudged", never
 * wrong and never right. The system is then scored against those judgments, separately for the development and the holdout cases, by domain, website and category.
 *
 *  - The scoring unit is the PRODUCT FAMILY (sibling variants and duplicate listings count once), and a family is held out as a whole, so a tuned rule never sees its own test.
 *  - The gate scores EXACTLY what production would approve: every answer at a case that meets a class's deterministic conditions under the CURRENT policy version and the CURRENT facts, not the
 *    strongest one only. A deliberately wrong second candidate counts against precision like any other.
 *  - A narrow policy is switched on only when its own measurement passes (precision, interval, no critical violation); whole-domain recall is reported beside it and does not block it. Switching
 *    one on queues the reconciliation of every stored answer; switching it off (or a failing audit) takes the system's approvals back.
 *
 * Nothing here makes up a label. With no labels the report says so and every gate stays closed.
 */

/** Share of product families kept for the holdout set, chosen by a fixed rule on the family (so reselecting never moves a case between the sets). */
const HOLDOUT_PERCENT = 40;
const STRENGTH: Record<string, number> = { exact: 5, variant: 4, equivalent: 3, substitute: 2, related: 1 };
const AI_REL: Record<string, EvalPrediction['relationship'] | null> = { exact_item: 'exact', same_product_different_pack: 'variant', close_equivalent: 'equivalent', substitute: 'substitute', related: 'related', no_match_uncertain: null };
/** What a person may say about one candidate. "incorrect" = judged, and not a counterpart; "related" is judged and also not a counterpart for approval. */
export const JUDGMENTS = ['exact', 'variant', 'equivalent', 'substitute', 'related', 'incorrect'] as const;
export type Judgment = (typeof JUDGMENTS)[number];

/** A normalised parent title: sibling variants and duplicate listings of one product share it, and so share a split and a vote. */
const FAMILY = sql`md5(lower(regexp_replace(p.title, '[^a-zA-Z0-9]+', '', 'g')))`;
export const OWN = (orgId: string) => sql`(
  select v.id as vid, p.id as pid, p.category as category, ${FAMILY} as fam,
    case when p.title ~* '(^|[^a-z])(bulbs?|led|leds|headlights?|lamps?|fog|wipers?|mats?|h[0-9]{1,2}|9[0-9]{3}|canbus)([^a-z]|$)' then 'automotive' else 'grocery' end as domain
  from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id
  where v.org_id = ${orgId} and s.role = 'source' and s.active and p.delisted_at is null
)`;
const COMP = (orgId: string) => sql`(select id as site_id from sites where org_id = ${orgId} and role = 'competitor' and active)`;
const LIVE = sql`(m.status = 'accepted' or (m.status in ('needs_review','auto') and m.superseded_at is null))`;

/** The pairs (own variant, competitor website) of each kind of case. Only "random" is a uniform sample: the others are ENRICHED (chosen because they are interesting) and say nothing about the population. */
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
const UNIFORM_STRATUM = 'random';

export interface PrepareResult {
  selected: number;
  byStratum: Record<string, number>;
}

/** Selects a stratified sample of cases to label (default about 300 per workspace). Cases already selected are kept; re-running only adds. Each case records its product family; the split follows the family. */
export async function prepareEvalSet(db: DbLike, orgId: string, opts: { size?: number; seed?: string } = {}): Promise<PrepareResult> {
  const size = Math.min(Math.max(opts.size ?? 300, 20), 1000);
  const seed = opts.seed ?? 'shelfwatch-eval-1';
  const byStratum: Record<string, number> = {};
  let selected = 0;
  for (const st of STRATA) {
    const quota = Math.max(1, Math.round(size * st.share));
    const res = await db.execute<{ id: string }>(sql`
      insert into match_eval_cases (org_id, source_variant_id, competitor_site_id, domain, stratum, split, family_key)
      select ${orgId}, x.sv, x.site, o.domain, ${st.name},
        case when abs(('x' || substr(o.fam, 1, 8))::bit(32)::bigint) % 100 < ${HOLDOUT_PERCENT} then 'holdout' else 'development' end, o.fam
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

/** How many cases each kind could draw on (its population), so the report can say what a sample does and does not represent. */
export async function stratumPopulations(db: DbLike, orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const st of STRATA) {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from (select distinct sv, site from (${st.from(orgId)}) f where site is not null) x join ${OWN(orgId)} o on o.vid = x.sv`);
    out[st.name] = r.rows[0]?.n ?? 0;
  }
  return out;
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

export interface EvalJudgmentView {
  variantId: string;
  relationship: Judgment;
  critical: boolean;
}

export interface EvalCaseView {
  id: string;
  stratum: string;
  split: 'development' | 'holdout';
  domain: string;
  familyKey: string | null;
  status: 'pending' | 'labelled' | 'skipped';
  source: { variantId: string; productId: string; title: string; variantTitle: string | null; brand: string | null; mpn: string | null; sku: string | null; size: string | null; price: number | null; currency: string | null; url: string | null };
  siteId: string;
  siteName: string;
  /** What the system had at this website, WITHOUT its verdicts: the labeller sees products, not the system's opinion, so it cannot sway them. In an order that does not reveal the ranking. */
  candidates: EvalCandidate[];
  label: { relationship: string; truthVariantId: string | null; judgments: EvalJudgmentView[]; complete: boolean; expertise: string | null; labelledAt: string | null; note: string | null } | null;
}

export async function listEvalCases(db: DbLike, orgId: string, f: { status?: 'pending' | 'labelled' | 'skipped'; split?: 'development' | 'holdout'; page: number; pageSize: number }): Promise<{ rows: EvalCaseView[]; total: number }> {
  const where = sql`e.org_id = ${orgId} ${f.status ? sql`and e.status = ${f.status}` : sql``} ${f.split ? sql`and e.split = ${f.split}` : sql``}`;
  const limit = Math.min(Math.max(1, f.pageSize), 50);
  const offset = Math.max(0, (f.page - 1) * limit);
  const cases = await db.execute<Record<string, unknown>>(sql`
    select e.id, e.stratum, e.split, e.domain, e.family_key as "familyKey", e.status, e.source_variant_id as "svid", e.competitor_site_id as "siteId", sc.name as "siteName", e.truth_variant_id as "truthVariantId", e.truth_relationship as "truthRelationship", e.truth_complete as "truthComplete", e.expertise, e.labelled_at as "labelledAt", e.note,
      p.id as "pid", p.title, v.title as "variantTitle", p.brand, p.mpn, v.sku, v.qty_label as "size", v.price, v.currency, v.url
    from match_eval_cases e join variants v on v.id = e.source_variant_id join products p on p.id = v.product_id join sites sc on sc.id = e.competitor_site_id
    where ${where} order by md5(e.id::text) limit ${limit} offset ${offset}`);
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n from match_eval_cases e where ${where}`);
  const ids = cases.rows.map((r) => String(r['id']));
  const idSql = ids.length ? sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `) : sql`null::uuid`;
  const cand = ids.length
    ? await db.execute<Record<string, unknown>>(sql`
        select * from (
          select distinct on (c.case_id, c.cv) c.case_id, c.cv, vv.id as "variantId", pp.id as "productId", pp.title, vv.title as "variantTitle", pp.brand, pp.mpn, vv.sku, vv.qty_label as "size", vv.price, vv.currency, vv.url
          from (
            select e.id as case_id, m.competitor_variant_id as cv from match_eval_cases e join product_matches m on m.source_variant_id = e.source_variant_id and m.competitor_site_id = e.competitor_site_id where e.id in (${idSql})
            union
            select e.id, a.competitor_variant_id from match_eval_cases e join ai_match_suggestions a on a.source_variant_id = e.source_variant_id and a.competitor_site_id = e.competitor_site_id where e.id in (${idSql})
            union
            select t.case_id, t.variant_id from match_eval_truths t where t.case_id in (${idSql})
            union
            select e.id, e.truth_variant_id from match_eval_cases e where e.truth_variant_id is not null and e.id in (${idSql})
          ) c join variants vv on vv.id = c.cv join products pp on pp.id = vv.product_id
          order by c.case_id, c.cv
        ) z order by md5(z.case_id::text || z.cv::text)`)
    : { rows: [] as Record<string, unknown>[] };
  const truths = ids.length ? await db.select().from(matchEvalTruths).where(and(eq(matchEvalTruths.orgId, orgId), inArray(matchEvalTruths.caseId, ids))) : [];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const byCase = new Map<string, EvalCandidate[]>();
  for (const c of cand.rows) {
    const list = byCase.get(String(c['case_id'])) ?? byCase.set(String(c['case_id']), []).get(String(c['case_id']))!;
    if (list.length < 16) list.push({ variantId: String(c['variantId']), productId: String(c['productId']), title: String(c['title']), variantTitle: (c['variantTitle'] as string | null) ?? null, brand: (c['brand'] as string | null) ?? null, mpn: (c['mpn'] as string | null) ?? null, sku: (c['sku'] as string | null) ?? null, size: (c['size'] as string | null) ?? null, price: num(c['price']), currency: (c['currency'] as string | null) ?? null, url: (c['url'] as string | null) ?? null });
  }
  return {
    total: Number(total.rows[0]?.n ?? 0),
    rows: cases.rows.map((r): EvalCaseView => {
      const mine = truths.filter((t) => t.caseId === String(r['id'])).map((t): EvalJudgmentView => ({ variantId: t.variantId, relationship: t.relationship as Judgment, critical: t.critical }));
      // a label made before judgments existed names one counterpart: shown as a single judgment
      const legacy = !mine.length && r['truthVariantId'] && JUDGMENTS.includes(String(r['truthRelationship']) as Judgment) ? [{ variantId: String(r['truthVariantId']), relationship: String(r['truthRelationship']) as Judgment, critical: false }] : [];
      return {
        id: String(r['id']), stratum: String(r['stratum']), split: r['split'] as 'development' | 'holdout', domain: String(r['domain']), familyKey: (r['familyKey'] as string | null) ?? null, status: r['status'] as EvalCaseView['status'], siteId: String(r['siteId']), siteName: String(r['siteName']),
        source: { variantId: String(r['svid']), productId: String(r['pid']), title: String(r['title']), variantTitle: (r['variantTitle'] as string | null) ?? null, brand: (r['brand'] as string | null) ?? null, mpn: (r['mpn'] as string | null) ?? null, sku: (r['sku'] as string | null) ?? null, size: (r['size'] as string | null) ?? null, price: num(r['price']), currency: (r['currency'] as string | null) ?? null, url: (r['url'] as string | null) ?? null },
        candidates: byCase.get(String(r['id'])) ?? [],
        label: r['status'] === 'labelled' && (r['truthRelationship'] || mine.length) ? { relationship: String(r['truthRelationship'] ?? 'partial'), truthVariantId: (r['truthVariantId'] as string | null) ?? null, judgments: mine.length ? mine : legacy, complete: !!r['truthComplete'], expertise: (r['expertise'] as string | null) ?? null, labelledAt: r['labelledAt'] ? new Date(r['labelledAt'] as string | Date).toISOString() : null, note: (r['note'] as string | null) ?? null } : null,
      };
    }),
  };
}

export async function evalProgress(db: DbLike, orgId: string) {
  const rows = await db.select({ split: matchEvalCases.split, status: matchEvalCases.status, n: sql<number>`count(*)::int`, families: sql<number>`count(distinct ${matchEvalCases.familyKey})::int` }).from(matchEvalCases).where(eq(matchEvalCases.orgId, orgId)).groupBy(matchEvalCases.split, matchEvalCases.status);
  const n = (split: string, status: string) => rows.find((r) => r.split === split && r.status === status)?.n ?? 0;
  const fam = (split: string, status: string) => rows.find((r) => r.split === split && r.status === status)?.families ?? 0;
  const [last] = await db.select().from(matchEvalReports).where(eq(matchEvalReports.orgId, orgId)).orderBy(desc(matchEvalReports.createdAt)).limit(1);
  const flags = await db.select().from(matchAutoApproval).where(eq(matchAutoApproval.orgId, orgId));
  return {
    development: { pending: n('development', 'pending'), labelled: n('development', 'labelled'), skipped: n('development', 'skipped'), families: fam('development', 'labelled') },
    holdout: { pending: n('holdout', 'pending'), labelled: n('holdout', 'labelled'), skipped: n('holdout', 'skipped'), families: fam('holdout', 'labelled') },
    target: { minimumLabelled: 300, perClassMinimum: DEFAULT_GATE.minExamples, unit: 'independent product families' },
    policyVersion: AUTO_POLICY_VERSION,
    supported: SUPPORTED_POLICIES.map((p) => ({ domain: p.domain, autoClass: p.autoClass })),
    latestReport: last ? { id: last.id, createdAt: last.createdAt.toISOString(), cases: last.cases, report: last.report, gates: last.gates, engineVersion: last.engineVersion, model: last.model } : null,
    autoApproval: flags.map((f) => ({ domain: f.domain, autoClass: f.autoClass, enabled: f.enabled, enabledAt: f.enabledAt?.toISOString() ?? null, disabledReason: f.disabledReason, policyVersion: f.policyVersion ?? null })),
  };
}

const RELATIONSHIPS = ['exact', 'variant', 'equivalent', 'substitute', 'related', 'none'] as const;

export interface LabelInput {
  /** The candidates the person judged. */
  judgments?: { variantId: string; relationship: Judgment; critical?: boolean }[];
  /** "The judged candidates are all there is": any other candidate here is not a counterpart. With no counterpart judged this says "none". */
  complete?: boolean;
  /** The older single-counterpart form: one competitor variant and what it is, or relationship "none". */
  truthVariantId?: string | null;
  relationship?: string;
  expertise: 'knowledgeable' | 'general';
  note?: string;
}

/** A person records what is true. Nothing is inferred; a candidate they do not judge stays unjudged. */
export async function labelEvalCase(db: DbLike, orgId: string, userId: string, caseId: string, p: LabelInput, now: Date) {
  const [c] = await db.select().from(matchEvalCases).where(and(eq(matchEvalCases.id, caseId), eq(matchEvalCases.orgId, orgId)));
  if (!c) throw new MatchError('Evaluation case not found');
  let judgments = (p.judgments ?? []).map((j) => ({ variantId: j.variantId, relationship: j.relationship, critical: !!j.critical }));
  let complete = !!p.complete;
  if (!p.judgments) {
    if (!p.relationship || !(RELATIONSHIPS as readonly string[]).includes(p.relationship)) throw new MatchError('Choose what the two products are, or "none".', 400);
    if (p.relationship === 'none') complete = true;
    else {
      if (!p.truthVariantId) throw new MatchError('Choose which competitor product it is.', 400);
      judgments = [{ variantId: p.truthVariantId, relationship: p.relationship as Judgment, critical: false }];
    }
  }
  for (const j of judgments) {
    if (!(JUDGMENTS as readonly string[]).includes(j.relationship)) throw new MatchError('Choose what each judged product is: an identical item, a pack variant, an equivalent, a substitute, related, or not a counterpart.', 400);
    if (j.critical && j.relationship !== 'incorrect') throw new MatchError('Only a product that is not a counterpart can be marked as a critical mistake if approved.', 400);
  }
  if (new Set(judgments.map((j) => j.variantId)).size !== judgments.length) throw new MatchError('Each product can be judged once.', 400);
  if (!judgments.length && !complete) throw new MatchError('Judge at least one product here, or say there is no counterpart.', 400);
  if (judgments.length) {
    const ok = await db.execute<{ id: string }>(sql`select v.id from variants v join products pr on pr.id = v.product_id where v.org_id = ${orgId} and pr.site_id = ${c.competitorSiteId}::uuid and v.id in (${sql.join(judgments.map((j) => sql`${j.variantId}::uuid`), sql`, `)})`);
    if (ok.rows.length !== judgments.length) throw new MatchError('Every judged product must be at this competitor website.', 400);
  }
  const positives = judgments.filter((j) => (STRENGTH[j.relationship] ?? 0) >= 2).sort((a, b) => (STRENGTH[b.relationship] ?? 0) - (STRENGTH[a.relationship] ?? 0));
  const best = positives[0] ?? null;
  const summary = best ? best.relationship : complete ? 'none' : 'partial';
  const row = await db.transaction(async (tx) => {
    const t = tx as unknown as DbLike;
    await t.delete(matchEvalTruths).where(eq(matchEvalTruths.caseId, caseId));
    if (judgments.length) await t.insert(matchEvalTruths).values(judgments.map((j) => ({ orgId, caseId, variantId: j.variantId, relationship: j.relationship, critical: j.critical })));
    const [r] = await t.update(matchEvalCases).set({ status: 'labelled', truthVariantId: best?.variantId ?? null, truthRelationship: summary, truthComplete: complete, expertise: p.expertise, labelledBy: userId, labelledAt: now, note: p.note?.trim().slice(0, 500) || null }).where(eq(matchEvalCases.id, caseId)).returning();
    await t.insert(auditEvents).values({ orgId, userId, action: 'match_eval.label', target: caseId, meta: { relationship: summary, judged: judgments.length, complete, split: c.split, expertise: p.expertise } });
    return r!;
  });
  return row;
}

export async function skipEvalCase(db: DbLike, orgId: string, userId: string, caseId: string, note: string | undefined, now: Date) {
  const [row] = await db.update(matchEvalCases).set({ status: 'skipped', labelledBy: userId, labelledAt: now, note: note?.slice(0, 500) ?? null }).where(and(eq(matchEvalCases.id, caseId), eq(matchEvalCases.orgId, orgId), eq(matchEvalCases.status, 'pending'))).returning();
  if (!row) throw new MatchError('Only a case that has not been labelled can be skipped.', 409);
  return row;
}

const pick = (a: EvalPrediction | null, b: EvalPrediction | null): EvalPrediction | null => (STRENGTH[a?.relationship ?? ''] ?? 0) >= (STRENGTH[b?.relationship ?? ''] ?? 0) ? a : b;

/** What a person said about a case, as the scoring needs it. Cases labelled before judgments existed are read as a single acceptable counterpart (or "none", a complete answer). */
function truthOf(c: typeof matchEvalCases.$inferSelect, rows: (typeof matchEvalTruths.$inferSelect)[]): Pick<EvalCase, 'acceptable' | 'incorrect' | 'critical' | 'complete'> {
  if (rows.length || c.truthComplete) {
    return {
      acceptable: rows.filter((r) => isPositive(r.relationship)).map((r) => ({ variantId: r.variantId, relationship: r.relationship as PositiveRelationship })),
      incorrect: rows.filter((r) => r.relationship === 'incorrect' || r.relationship === 'related').map((r) => r.variantId),
      critical: rows.filter((r) => r.critical).map((r) => r.variantId),
      complete: c.truthComplete,
    };
  }
  if (c.truthRelationship && c.truthVariantId) {
    return isPositive(c.truthRelationship)
      ? { acceptable: [{ variantId: c.truthVariantId, relationship: c.truthRelationship }], incorrect: [], critical: [], complete: false }
      : { acceptable: [], incorrect: [c.truthVariantId], critical: [], complete: false };
  }
  return { acceptable: [], incorrect: [], critical: [], complete: c.truthRelationship === 'none' };
}

/**
 * Measures the system against the labelled cases and stores the report. Candidate recall is measured by running retrieval for each labelled source variant: a case is a hit only when an acceptable
 * VARIANT (not merely its parent product) is among the candidates. The decision set scored is every answer production would approve now: the policy version and the products' facts must be current.
 */
export async function runEvaluation(svc: Services, orgId: string, userId: string | null): Promise<{ reportId: string; cases: number }> {
  const db = svc.db as DbLike;
  const labelled = await db.select().from(matchEvalCases).where(and(eq(matchEvalCases.orgId, orgId), eq(matchEvalCases.status, 'labelled')));
  const truthRows = await db.select().from(matchEvalTruths).where(eq(matchEvalTruths.orgId, orgId));
  const truthsByCase = new Map<string, (typeof matchEvalTruths.$inferSelect)[]>();
  for (const t of truthRows) (truthsByCase.get(t.caseId) ?? truthsByCase.set(t.caseId, []).get(t.caseId)!).push(t);
  const sources = [...new Set(labelled.map((c) => c.sourceVariantId))];
  const ctx = labelled.length ? await withHeavyWork(() => buildContext(db, orgId, svc.config.GEMINI_EMBEDDING_MODEL)) : null;
  const hits = new Map<string, { pool: boolean; shortlist: boolean }>();
  if (ctx) {
    for (const sv of sources) {
      const src = ctx.corpus.byVariant.get(sv);
      if (!src) continue;
      const found = retrieveShortlist(ctx.index, src, { perSiteProducts: 25, poolPerSite: 60 }, await semanticFor(ctx, sv));
      for (const c of found) hits.set(`${sv}|${c.variantId}`, { pool: true, shortlist: c.siteRank <= 3 });
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
  const ai = await db.execute<Record<string, unknown>>(sql`select source_variant_id as sv, competitor_site_id as site, competitor_variant_id as cv, match_type, auto_class, auto_policy_version as pv, source_fingerprint as sfp, candidate_fingerprint as cfp, status from ai_match_suggestions where org_id = ${orgId} and source_variant_id in (${idList})`);
  const current = ctx ? await currentFingerprints(db, ctx, [...sources, ...ai.rows.map((r) => String(r['cv']))]) : new Map<string, string>();
  const cats = await db.execute<{ vid: string; category: string | null }>(sql`select v.id as vid, p.category from variants v join products p on p.id = v.product_id where v.id in (${idList})`);
  const category = new Map(cats.rows.map((r) => [r.vid, r.category]));
  const siteNames = await db.execute<{ id: string; name: string }>(sql`select id, name from sites where org_id = ${orgId}`);
  const siteName = new Map(siteNames.rows.map((r) => [r.id, r.name]));

  const cases: EvalCase[] = labelled.map((c) => {
    const key = (r: Record<string, unknown>) => String(r['sv']) === c.sourceVariantId && String(r['site']) === c.competitorSiteId;
    const truth = truthOf(c, truthsByCase.get(c.id) ?? []);
    const here = pairs.rows.filter(key);
    const live = here.filter((r) => r['status'] === 'accepted' || r['sup'] === null);
    // a pair a person decided shows the relationship the SYSTEM suggested, not the person's own answer
    const asSuggested = (r: Record<string, unknown>) => String((r['by'] && r['suggested']) ? r['suggested'] : r['rel']);
    const ruleRows = live.filter((r) => r['method'] !== 'manual' && r['method'] !== 'ai_auto' && (STRENGTH[asSuggested(r)] ?? 0) > 0).sort((a, b) => (STRENGTH[asSuggested(b)] ?? 0) - (STRENGTH[asSuggested(a)] ?? 0) || Number(b['confidence']) - Number(a['confidence']));
    const rule: EvalPrediction | null = ruleRows[0] ? { variantId: String(ruleRows[0]['cv']), relationship: asSuggested(ruleRows[0]) as EvalPrediction['relationship'], autoClass: null } : null;
    const aiAll = ai.rows.filter(key);
    // EVERY answer production would approve: a class assigned under the current policy version, from facts that are still the products' facts
    const eligibleRows = aiAll.filter((r) => !!r['auto_class'] && r['pv'] === AUTO_POLICY_VERSION && current.get(c.sourceVariantId) === r['sfp'] && current.get(String(r['cv'])) === r['cfp']);
    const eligibleClass = new Map(eligibleRows.map((r) => [String(r['cv']), r['auto_class'] as AutoClass]));
    const eligible: EvalPrediction[] = [...eligibleClass].map(([variantId, autoClass]) => ({ variantId, relationship: CLASS_RELATIONSHIP[autoClass], autoClass }));
    const aiRows = aiAll.filter((r) => AI_REL[String(r['match_type'])]).sort((a, b) => (STRENGTH[AI_REL[String(b['match_type'])]!] ?? 0) - (STRENGTH[AI_REL[String(a['match_type'])]!] ?? 0));
    const aiPred: EvalPrediction | null = aiRows[0] ? { variantId: String(aiRows[0]['cv']), relationship: AI_REL[String(aiRows[0]['match_type'])]!, autoClass: eligibleClass.get(String(aiRows[0]['cv'])) ?? null } : null;
    const autoRows = live.filter((r) => r['status'] === 'accepted' && r['auto'] !== null);
    const autoRow = autoRows[0];
    const autoPred: EvalPrediction | null = autoRow ? { variantId: String(autoRow['cv']), relationship: String(autoRow['rel']) as EvalPrediction['relationship'], autoClass: null } : null;
    const combined = autoPred ?? pick(aiPred, rule);
    const waiting = live.some((r) => r['status'] !== 'accepted' && (STRENGTH[String(r['rel'])] ?? 0) >= 2) || aiRows.some((r) => r['status'] === 'pending' && (STRENGTH[AI_REL[String(r['match_type'])]!] ?? 0) >= 2);
    const measurable = !!ctx?.corpus.byVariant.get(c.sourceVariantId) && truth.acceptable.length > 0;
    return {
      id: c.id, domain: (c.domain as EvalDomain) ?? 'general', siteId: c.competitorSiteId, siteName: siteName.get(c.competitorSiteId) ?? 'Competitor', category: category.get(c.sourceVariantId) ?? null, split: c.split, stratum: c.stratum,
      familyKey: c.familyKey ?? c.sourceVariantId, ...truth, candidateHit: measurable ? truth.acceptable.some((a) => hits.get(`${c.sourceVariantId}|${a.variantId}`)?.pool) : null,
      rule, ai: aiPred, combined, eligible, autoApproved: !!autoRow, needsHuman: !autoRow && waiting, expertise: c.expertise ?? 'general',
    };
  });

  const all = scoreEvaluation(cases, 'all');
  const holdout = scoreEvaluation(cases, 'holdout');
  const development = scoreEvaluation(cases, 'development');
  const uniform = scoreEvaluation(cases.filter((c) => c.stratum === UNIFORM_STRATUM), 'all');
  const shortlistMeasured = cases.filter((c) => c.candidateHit !== null);
  const shortlistHits = shortlistMeasured.filter((c) => c.acceptable.some((a) => hits.get(`${labelled.find((l) => l.id === c.id)!.sourceVariantId}|${a.variantId}`)?.shortlist)).length;
  const gates = SUPPORTED_POLICIES.map((p) => {
    const g = gateForClass(cases, p.domain, p.autoClass);
    return { ...g, needed: neededFamilies(g) };
  });
  const populations = await stratumPopulations(db, orgId);
  const chosen = await db.select({ stratum: matchEvalCases.stratum, status: matchEvalCases.status, n: sql<number>`count(*)::int` }).from(matchEvalCases).where(eq(matchEvalCases.orgId, orgId)).groupBy(matchEvalCases.stratum, matchEvalCases.status);
  const strata = STRATA.map((s) => ({
    name: s.name,
    /** A uniform sample describes the population; the others were chosen because they are interesting and describe only themselves. */
    kind: s.name === UNIFORM_STRATUM ? ('uniform' as const) : ('enriched' as const),
    population: populations[s.name] ?? 0,
    selected: chosen.filter((x) => x.stratum === s.name).reduce((a, x) => a + x.n, 0),
    labelled: chosen.find((x) => x.stratum === s.name && x.status === 'labelled')?.n ?? 0,
  }));
  const [report] = await db
    .insert(matchEvalReports)
    .values({
      orgId, split: 'all', cases: cases.length, createdBy: userId, createdAt: svc.clock(), engineVersion: ENGINE_VERSION, model: svc.config.GEMINI_MODEL, promptVersion: AI_PROMPT_VERSION,
      report: {
        all, holdout, development, poolDepthPerSite: 25, shortlistDepthPerSite: 3, shortlistRecall: { hits: shortlistHits, total: shortlistMeasured.length }, policyVersion: AUTO_POLICY_VERSION, strata,
        populationEstimate: { basis: 'only the uniform "random" sample describes the whole catalogue; every other kind of case was chosen because it is interesting and describes only itself', cases: cases.filter((c) => c.stratum === UNIFORM_STRATUM).length, score: uniform },
        note: 'Scored against labels made by people; the system\'s own answers are never used as truth.',
      } as unknown as Record<string, unknown>,
      gates: gates as unknown as Record<string, unknown>[],
    })
    .returning();
  // a policy that is on is switched off again when its measurement no longer passes, when the rules it was switched on for have changed, or when audits of what it approved fall below the gate
  const audited = cases.filter((c) => c.stratum === 'auto_audit' && (c.acceptable.length > 0 || c.complete || c.incorrect.length > 0));
  const auditCorrect = audited.filter((c) => c.autoApproved && c.acceptable.some((a) => a.variantId === c.combined?.variantId && a.relationship === c.combined?.relationship)).length;
  const auditFails = audited.length >= 30 && auditCorrect / audited.length < DEFAULT_GATE.autoPrecision;
  let withdrawn = false;
  const enabledNow = await db.select().from(matchAutoApproval).where(and(eq(matchAutoApproval.orgId, orgId), eq(matchAutoApproval.enabled, true)));
  for (const f of enabledNow) {
    const g = gates.find((x) => x.domain === f.domain && x.autoClass === f.autoClass);
    const reason = (f.policyVersion ?? '') !== AUTO_POLICY_VERSION ? 'The rules this was switched on for have changed: the new rules must pass their own measurement.'
      : !g ? 'There is no policy for this class any more.'
      : g.units.critical > 0 ? 'The latest measurement found a critical compatibility mistake.'
      : !g.result.passed && g.units.families >= DEFAULT_GATE.minExamples ? 'The latest measurement no longer passes the release gate.'
      : auditFails ? 'Audits of automatically approved pairs fell below the gate.'
      : null;
    if (!reason) continue;
    await db.update(matchAutoApproval).set({ enabled: false, disabledReason: reason, updatedAt: svc.clock() }).where(eq(matchAutoApproval.id, f.id));
    await db.insert(auditEvents).values({ orgId, userId, action: 'match_auto.disable', target: `${f.domain}:${f.autoClass}`, meta: { reason, automatic: true } });
    withdrawn = true;
  }
  // approvals made under a policy that is no longer on are taken back (reversibly, with the reason recorded)
  if (withdrawn) await svc.queue.enqueue('ai-match', { orgId, task: 'reconcile' }, { singletonKey: `reconcile:${orgId}` });
  return { reportId: report!.id, cases: cases.length };
}

/**
 * A person switches a policy on (only when the latest measurement, made after the last label and for the CURRENT rules, passed the gate) or off. Either change queues the reconciliation of every
 * stored answer: switching on approves the answers that qualify without asking the model anything again; switching off takes the system's own approvals back. A person's decisions are never touched.
 */
export async function setAutoApproval(db: DbLike, queue: JobQueue, orgId: string, userId: string, p: { domain: EvalDomain; autoClass: AutoClass; enabled: boolean }, now: Date) {
  if (!SUPPORTED_POLICIES.some((s) => s.domain === p.domain && s.autoClass === p.autoClass)) throw new MatchError('There is no automatic-approval policy for that kind of product and match.', 400);
  if (p.enabled) {
    const [rep] = await db.select().from(matchEvalReports).where(eq(matchEvalReports.orgId, orgId)).orderBy(desc(matchEvalReports.createdAt)).limit(1);
    const [lastLabel] = await db.select({ at: sql<Date | null>`max(${matchEvalCases.labelledAt})` }).from(matchEvalCases).where(and(eq(matchEvalCases.orgId, orgId), eq(matchEvalCases.status, 'labelled')));
    if (!rep) throw new MatchError('There is no evaluation yet: label a sample and run the evaluation first.', 409);
    if (lastLabel?.at && new Date(lastLabel.at) > rep.createdAt) throw new MatchError('Labels were added after the last evaluation: run the evaluation again.', 409);
    const gate = (rep.gates as unknown as { domain: string; autoClass: string; policyVersion?: string; result: { passed: boolean } }[]).find((g) => g.domain === p.domain && g.autoClass === p.autoClass);
    if (!gate || gate.policyVersion !== AUTO_POLICY_VERSION) throw new MatchError('The latest evaluation was made for different rules: run the evaluation again.', 409);
    if (!gate.result.passed) throw new MatchError('This policy has not passed the release gate (enough independent labelled families, precision with its confidence bound, and no critical mistake), so it cannot be switched on.', 409);
    await db.insert(matchAutoApproval).values({ orgId, domain: p.domain, autoClass: p.autoClass, enabled: true, enabledBy: userId, enabledAt: now, gateAtEnable: gate as unknown as Record<string, unknown>, policyVersion: AUTO_POLICY_VERSION, disabledReason: null, updatedAt: now })
      .onConflictDoUpdate({ target: [matchAutoApproval.orgId, matchAutoApproval.domain, matchAutoApproval.autoClass], set: { enabled: true, enabledBy: userId, enabledAt: now, gateAtEnable: gate as unknown as Record<string, unknown>, policyVersion: AUTO_POLICY_VERSION, disabledReason: null, updatedAt: now } });
  } else {
    await db.update(matchAutoApproval).set({ enabled: false, disabledReason: 'Switched off by a person.', updatedAt: now }).where(and(eq(matchAutoApproval.orgId, orgId), eq(matchAutoApproval.domain, p.domain), eq(matchAutoApproval.autoClass, p.autoClass)));
  }
  await db.insert(auditEvents).values({ orgId, userId, action: p.enabled ? 'match_auto.enable' : 'match_auto.disable', target: `${p.domain}:${p.autoClass}`, meta: { policy: AUTO_POLICY_VERSION } });
  await queue.enqueue('ai-match', { orgId, task: 'reconcile' }, { singletonKey: `reconcile:${orgId}` });
}
