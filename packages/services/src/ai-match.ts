import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AI_DOSSIER_VERSION,
  AI_PROMPT_VERSION,
  AI_SYSTEM_PROMPT,
  DEFAULT_BATCH_LIMITS,
  analyseCatalogue,
  applyGuards,
  autoClassOf,
  AUTO_POLICY_VERSION,
  evaluateBulbPolicy,
  evaluatePair,
  buildAiDossier,
  buildRetrievalIndex,
  extractSpecTable,
  factGroupOf,
  groundingText,
  hashText,
  nextPacificMidnight,
  pacificDay,
  planBatches,
  retrieveShortlist,
  toWire,
  type AiCandidate,
  type AiDecision,
  type AiDossier,
  type AutoFacts,
  type BulbPolicyResult,
  type GuardContext,
  type AppConfig,
  type Corpus,
  type Dossier,
  type PageSpecFact,
  type PayloadGroup,
  type PlannedRequest,
  type RetrievalIndex,
} from '@ci/core';
import {
  AI_TYPE_LABEL,
  AI_TYPE_TO_RELATIONSHIP,
  aiRunSchema,
  type AiConfidence,
  type AiEngineReading,
  type AiKeyView,
  type AiMatchType,
  type AiPolicyReading,
  type AiProductView,
  type AiReviewRequest,
  type AiRunRequest,
  type AiRunUsage,
  type AiRunView,
  type AiStatusView,
  type AiSuggestionStatus,
  type AiSuggestionView,
  type DecidableRelationship,
} from '@ci/shared';
import { aiDossiers, aiMatchFeedback, aiMatchRuns, aiMatchSuggestions, aiMatchWork, aiQuotaState, aiUsageDaily, auditEvents, orgSettings, productMatches, type DbLike } from '@ci/database';
import type { Services, JobQueue } from './context.ts';
import { askRequest, pairKey, restrict, type AskDeps, type AskResult, type UsageEvent } from './ai-gemini.ts';
import { aiKeysOf, addUsage, hydrateLimiter, markKeyStopped, pickOrder, runtimeFor, saveLimiterState, setAiClock, type AiKey, type KeyRuntime } from './ai-keys.ts';
import { enabledPolicies, reconcileOne, tally, type EnabledPolicies, type ReconcileResult } from './match-reconcile.ts';
import { withHeavyWork } from './heavy.ts';
import { loadVectors, semanticHits } from './ai-embed.ts';
import { MatchError, decideMatch, loadEngineInputs, rejectPair, setManualMatch } from './matching.ts';
import { BUCKET_SQL, type MatchBucket } from './queries.ts';

/**
 * AI-assisted matching: runs, the worker job that processes them, usage and quota records, and the human review of what the AI suggested.
 *
 * What this module never does: change a match, a price, a report or a person's decision by itself. It writes to the ai_* tables only. A person's decision on a suggestion is
 * applied through the existing human-decision functions (`decideMatch`, `setManualMatch`), which also keep the quantity and bundle policies in force.
 */

// ───────────────────────────────────────────────────────────── settings, limiter, records

export interface AiSettings {
  configured: boolean;
  /** The configured API keys (labels k1, k2…): backend only, never sent to a browser. */
  keys: AiKey[];
  model: string;
  rpm: number;
  tpm: number;
  dailyRequests: number;
  maxConcurrency: number;
  batchCandidates: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export function aiSettings(config: AppConfig): AiSettings {
  return {
    configured: aiKeysOf(config).length > 0,
    keys: aiKeysOf(config),
    model: config.GEMINI_MODEL,
    rpm: config.GEMINI_RPM,
    tpm: config.GEMINI_TPM,
    dailyRequests: config.GEMINI_DAILY_REQUESTS,
    maxConcurrency: config.GEMINI_MAX_CONCURRENCY,
    batchCandidates: config.GEMINI_BATCH_CANDIDATES,
    maxInputTokens: config.GEMINI_MAX_INPUT_TOKENS,
    maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
    timeoutMs: config.GEMINI_TIMEOUT_MS,
  };
}

const ZERO_USAGE: AiRunUsage = { requests: 0, successes: 0, failures: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedResults: 0, candidatesAnswered: 0, ms: 0 };
const ZERO_PROGRESS = { sources: 0, sourcesDone: 0, candidates: 0, answered: 0, cachedResults: 0 };

const charsPerTokenState = { charsPerToken: DEFAULT_BATCH_LIMITS.charsPerToken };

// ───────────────────────────────────────────────────────────── views

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function runView(r: typeof aiMatchRuns.$inferSelect): AiRunView {
  return {
    id: r.id, kind: r.kind, status: r.status, model: r.model, promptVersion: r.promptVersion, createdAt: r.createdAt.toISOString(), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), resumeAt: iso(r.resumeAt),
    pauseReason: r.pauseReason, error: r.error, progress: { ...ZERO_PROGRESS, ...(r.progress ?? {}) }, usage: { ...ZERO_USAGE, ...(r.usage ?? {}) }, params: r.params ?? {},
  };
}

export async function listAiRuns(db: DbLike, orgId: string, limit = 20): Promise<AiRunView[]> {
  const rows = await db.select().from(aiMatchRuns).where(eq(aiMatchRuns.orgId, orgId)).orderBy(desc(aiMatchRuns.createdAt)).limit(Math.min(limit, 100));
  return rows.map(runView);
}

export async function getAiRun(db: DbLike, orgId: string, runId: string): Promise<AiRunView> {
  const [r] = await db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.id, runId), eq(aiMatchRuns.orgId, orgId)));
  if (!r) throw new MatchError('Analysis run not found');
  return runView(r);
}

/**
 * What the admin page shows: the setup, each key's own use today, the limits Shelfwatch applies and what Google's own answers taught it. Google does not expose the remaining quota, so none is claimed.
 * The figures are totals over the configured keys; every key also appears on its own.
 */
export async function aiStatus(db: DbLike, config: AppConfig, orgId: string, now: Date): Promise<AiStatusView> {
  const s = aiSettings(config);
  const day = pacificDay(now.getTime());
  const usageRows = await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.day, day), eq(aiUsageDaily.model, s.model)));
  const stateRows = await db.select().from(aiQuotaState).where(eq(aiQuotaState.model, s.model));
  const [settings] = await db.select({ c: orgSettings.aiContinuous }).from(orgSettings).where(eq(orgSettings.orgId, orgId));
  const [active] = await db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, orgId), inArray(aiMatchRuns.status, ['queued', 'running', 'paused']))).orderBy(desc(aiMatchRuns.createdAt)).limit(1);
  const counts = await db.select({ status: aiMatchSuggestions.status, n: sql<number>`count(*)::int` }).from(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, orgId)).groupBy(aiMatchSuggestions.status);
  const n = (k: AiSuggestionStatus) => counts.find((c) => c.status === k)?.n ?? 0;
  const total = counts.reduce((a, c) => a + c.n, 0);
  const learnedOf = (st: (typeof stateRows)[number] | undefined) => ({ ...(st?.learnedRpm ? { rpm: st.learnedRpm } : {}), ...(st?.learnedRpd ? { rpd: st.learnedRpd } : {}), ...(st?.learnedTpm ? { tpm: st.learnedTpm } : {}) });
  const keys: AiKeyView[] = s.keys.map((k) => {
    const u = usageRows.find((x) => x.keyId === k.id);
    const st = stateRows.find((x) => x.keyId === k.id);
    const pausedUntil = st?.pausedUntil && st.pausedUntil > now ? st.pausedUntil : null;
    return {
      id: k.id, label: `Key ${k.id.slice(1)}`, state: st?.stopped ? 'stopped' : pausedUntil ? 'paused' : 'ready', pausedUntil: iso(pausedUntil), pauseReason: pausedUntil ? (st?.pauseReason ?? null) : null, stopped: st?.stopped ?? null,
      today: { requests: u?.requests ?? 0, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, failures: u?.failures ?? 0, rateLimited: u?.rateLimited ?? 0 }, learned: learnedOf(st),
    };
  });
  const sum = (f: (x: (typeof usageRows)[number]) => number) => usageRows.reduce((a, x) => a + f(x), 0);
  const working = keys.filter((k) => k.state !== 'stopped');
  const state: AiStatusView['state'] = !s.configured ? 'not_configured' : !working.length ? 'stopped' : working.every((k) => k.state === 'paused') ? 'paused' : active?.status === 'running' ? 'running' : 'idle';
  const soonest = working.filter((k) => k.pausedUntil).sort((a, b) => a.pausedUntil!.localeCompare(b.pausedUntil!))[0];
  return {
    configured: s.configured,
    keys,
    continuous: settings?.c ?? false,
    model: s.model,
    limits: { rpm: s.rpm * Math.max(1, keys.length), tpm: s.tpm * Math.max(1, keys.length), dailyBudget: s.dailyRequests * Math.max(1, keys.length), learned: keys[0]?.learned ?? {} },
    today: { day, requests: sum((x) => x.requests), inputTokens: sum((x) => x.inputTokens), outputTokens: sum((x) => x.outputTokens), failures: sum((x) => x.failures), rateLimited: sum((x) => x.rateLimited), cachedResults: sum((x) => x.cachedResults) },
    state,
    pausedUntil: state === 'paused' ? (soonest?.pausedUntil ?? null) : null,
    pauseReason: state === 'paused' ? (soonest?.pauseReason ?? null) : null,
    stopped: state === 'stopped' ? (keys.map((k) => k.stopped).find(Boolean) ?? null) : null,
    activeRun: active ? runView(active) : null,
    counts: { pending: n('pending'), accepted: n('accepted'), changed: n('changed'), uncertain: n('uncertain'), noneOfThese: n('none_of_these'), total },
    note: s.configured
      ? `Gemini’s free tier is used and nothing is ever sent to a paid tier. ${keys.length > 1 ? `Work is spread over ${keys.length} keys, each with its own limits. ` : ''}Google does not tell us how much of its quota is left: the figures here are what Shelfwatch itself has sent, and the limits Google’s own answers revealed.`
      : 'No Gemini API key is configured on the server. Everything else in Shelfwatch works without it.',
  };
}

/** A person clears a stop or a pause after fixing the cause (a new key, the right model). */
export async function resumeGemini(db: DbLike, config: AppConfig, userId: string, orgId: string, now: Date): Promise<void> {
  const s = aiSettings(config);
  await db.update(aiQuotaState).set({ stopped: null, pausedUntil: null, pauseReason: null, updatedAt: now }).where(eq(aiQuotaState.model, s.model));
  await db.insert(auditEvents).values({ orgId, userId, action: 'ai_match.resume_gemini', target: s.model, meta: {} });
}

/** A person turns continuous matching on or off for the workspace. */
export async function setContinuousMatching(db: DbLike, orgId: string, userId: string | null, enabled: boolean, now: Date): Promise<void> {
  await db.update(orgSettings).set({ aiContinuous: enabled, updatedAt: now }).where(eq(orgSettings.orgId, orgId));
  await db.insert(auditEvents).values({ orgId, userId, action: enabled ? 'ai_match.continuous_on' : 'ai_match.continuous_off', target: orgId, meta: {} });
}

// ───────────────────────────────────────────────────────────── choosing what to analyse

// ───────────────────────────────────────────────────────────── choosing what to analyse

const uuidList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const SOURCE_FILTER = sql`ss.active and ss.role = 'source' and ps.delisted_at is null`;
/** Within a list, products of different categories first (a spread, not fifty bulbs), then a fixed pseudo-random order: the same request always picks the same products. */
const SPREAD = sql`row_number() over (partition by coalesce(pr.category, '') order by md5(p.id::text)), md5(p.id::text)`;

/** Products not yet worked through: no completed work item (never analysed, or waiting for quota, or retrying). A product that already has suggestions but unfinished work is still included. */
const NOT_DONE = (alias: string) => sql.raw(`not exists (select 1 from ai_match_work w where w.source_variant_id = ${alias}.id and w.status = 'completed')`);

async function pickFromBucket(db: DbLike, orgId: string, bucket: MatchBucket, limit: number, fresh: boolean): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with picked as (
      select distinct m.source_variant_id as id from product_matches m
      join variants vs on vs.id = m.source_variant_id join products ps on ps.id = vs.product_id join sites ss on ss.id = ps.site_id
      where m.org_id = ${orgId} and ${SOURCE_FILTER} and ${BUCKET_SQL[bucket]}
    )
    select p.id from picked p join variants v on v.id = p.id join products pr on pr.id = v.product_id
    ${fresh ? sql`where ${NOT_DONE('p')}` : sql``}
    order by ${SPREAD} limit ${limit}`);
  return rows.rows.map((r) => r.id);
}

/** Source variants with no pair at all in Match Review (the engine found no counterpart). */
async function pickUnmatched(db: DbLike, orgId: string, limit: number, fresh: boolean): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with picked as (
      select v.id from variants v join products ps on ps.id = v.product_id join sites ss on ss.id = ps.site_id
      where v.org_id = ${orgId} and ${SOURCE_FILTER}
        and not exists (select 1 from product_matches m where m.source_variant_id = v.id)
        ${fresh ? sql`and ${NOT_DONE('v')}` : sql``}
    )
    select p.id from picked p join variants v on v.id = p.id join products pr on pr.id = v.product_id order by ${SPREAD} limit ${limit}`);
  return rows.rows.map((r) => r.id);
}

/**
 * Every active variant of the shop, in the order work is most needed: products never worked on first, then work waiting for quota or retrying, then products that need evidence, then the rest
 * (which cost no model request unless a candidate or a fact changed: their earlier answers are reused and their approval is re-checked).
 */
export async function sweepSources(db: DbLike, orgId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select v.id from variants v join products pr on pr.id = v.product_id join sites ss on ss.id = pr.site_id
    left join ai_match_work w on w.source_variant_id = v.id
    where v.org_id = ${orgId} and ss.active and ss.role = 'source' and pr.delisted_at is null
    order by (case when w.id is null then 0 when w.status in ('queued','retry','waiting_quota','running') then 1 when w.status = 'needs_evidence' then 2 else 3 end), md5(v.id::text)`);
  return rows.rows.map((r) => r.id);
}

const SAMPLE_BUCKETS: MatchBucket[] = ['review', 'substitutes', 'unclear', 'confirmed', 'rejected', 'set_aside'];

/** A spread over every kind of Match Review row (waiting, stand-ins, unclear, confirmed, rejected, set aside) and over products the engine found nothing for. Products already worked through come last, and only to fill the limit. */
export async function selectSources(db: DbLike, orgId: string, req: AiRunRequest): Promise<string[]> {
  if (req.scope === 'sweep') return sweepSources(db, orgId);
  if (req.scope === 'products') {
    const ids = [...new Set(req.variantIds ?? [])];
    if (!ids.length) return [];
    const rows = await db.execute<{ id: string }>(sql`select v.id from variants v join products ps on ps.id = v.product_id join sites ss on ss.id = ps.site_id where v.org_id = ${orgId} and ${SOURCE_FILTER} and v.id in (${uuidList(ids)})`);
    const ok = new Set(rows.rows.map((r) => r.id));
    return ids.filter((i) => ok.has(i));
  }
  const spread = (lists: string[][], out: string[], seen: Set<string>) => {
    for (let i = 0; out.length < req.limit && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < req.limit && !seen.has(l[i]!)) { seen.add(l[i]!); out.push(l[i]!); }
  };
  const out: string[] = [];
  const seen = new Set<string>();
  const build = async (fresh: boolean) => {
    const lists: string[][] = [];
    if (req.scope === 'sample') for (const b of SAMPLE_BUCKETS) lists.push(await pickFromBucket(db, orgId, b, req.limit, fresh));
    lists.push(await pickUnmatched(db, orgId, req.limit, fresh));
    spread(lists, out, seen);
  };
  await build(true);
  // nothing new left for some buckets: the products already worked through fill the rest (their answers are reused, so they cost no model request)
  if (out.length < req.limit) await build(false);
  return out;
}

export async function createAiRun(db: DbLike, config: AppConfig, orgId: string, userId: string | null, input: unknown, now?: Date): Promise<{ run: AiRunView; selected: number }> {
  const s = aiSettings(config);
  if (!s.configured) throw new MatchError('No Gemini API key is configured on the server, so AI analysis cannot start. Everything else works without it.', 409);
  const req = aiRunSchema.parse(input);
  const [open] = await db.select({ id: aiMatchRuns.id }).from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, orgId), inArray(aiMatchRuns.status, ['queued', 'running', 'paused']))).limit(1);
  if (open) throw new MatchError('An analysis is already in progress. Pause or cancel it before starting another.', 409);
  const sourceIds = await selectSources(db, orgId, req);
  if (!sourceIds.length) throw new MatchError('There are no products to analyse for this choice (no matching products).', 400);
  const [row] = await db
    .insert(aiMatchRuns)
    .values({ orgId, kind: req.scope, status: 'queued', model: s.model, promptVersion: AI_PROMPT_VERSION, params: req, sourceIds, progress: { ...ZERO_PROGRESS, sources: sourceIds.length }, usage: ZERO_USAGE, createdBy: userId, ...(now ? { createdAt: now, updatedAt: now } : {}) })
    .returning();
  await db.insert(auditEvents).values({ orgId, userId, action: 'ai_match.run_created', target: row!.id, meta: { scope: req.scope, sources: sourceIds.length, model: s.model } });
  return { run: runView(row!), selected: sourceIds.length };
}

export const enqueueAiRun = (queue: JobQueue, orgId: string, runId: string, startAfterSeconds?: number) =>
  queue.enqueue('ai-match', { orgId, runId }, { singletonKey: `ai-match:${runId}`, ...(startAfterSeconds && startAfterSeconds > 0 ? { startAfterSeconds: Math.ceil(startAfterSeconds) } : {}) });

export async function pauseAiRun(db: DbLike, orgId: string, userId: string, runId: string, now: Date): Promise<AiRunView> {
  const [r] = await db.update(aiMatchRuns).set({ status: 'paused', pauseReason: 'Paused by a person', resumeAt: null, updatedAt: now }).where(and(eq(aiMatchRuns.id, runId), eq(aiMatchRuns.orgId, orgId), inArray(aiMatchRuns.status, ['queued', 'running', 'paused']))).returning();
  if (!r) throw new MatchError('This analysis is not running.', 409);
  await db.insert(auditEvents).values({ orgId, userId, action: 'ai_match.run_paused', target: runId, meta: {} });
  return runView(r);
}

export async function resumeAiRun(db: DbLike, queue: JobQueue, orgId: string, userId: string, runId: string, now: Date): Promise<AiRunView> {
  const [r] = await db.update(aiMatchRuns).set({ status: 'queued', pauseReason: null, resumeAt: null, updatedAt: now }).where(and(eq(aiMatchRuns.id, runId), eq(aiMatchRuns.orgId, orgId), eq(aiMatchRuns.status, 'paused'))).returning();
  if (!r) throw new MatchError('Only a paused analysis can be resumed.', 409);
  await db.insert(auditEvents).values({ orgId, userId, action: 'ai_match.run_resumed', target: runId, meta: {} });
  await enqueueAiRun(queue, orgId, runId);
  return runView(r);
}

export async function cancelAiRun(db: DbLike, orgId: string, userId: string, runId: string, now: Date): Promise<AiRunView> {
  const [r] = await db.update(aiMatchRuns).set({ status: 'cancelled', finishedAt: now, updatedAt: now }).where(and(eq(aiMatchRuns.id, runId), eq(aiMatchRuns.orgId, orgId), inArray(aiMatchRuns.status, ['queued', 'running', 'paused']))).returning();
  if (!r) throw new MatchError('This analysis has already finished.', 409);
  await db.insert(auditEvents).values({ orgId, userId, action: 'ai_match.run_cancelled', target: runId, meta: {} });
  return runView(r);
}

// ───────────────────────────────────────────────────────────── the worker job

const WINDOW_SOURCES = 6;
/** One job works for at most this long, then queues itself again: the worker is never held for a whole run. */
const TIME_BUDGET_MS = 6 * 60_000;
const STOP_KINDS = new Set(['paid_tier', 'invalid_key', 'model_unavailable', 'not_configured']);
const STALE_RUNNING_MS = 20 * 60_000;

export interface Ctx {
  corpus: Corpus;
  index: RetrievalIndex;
  sources: Set<string>;
  descriptions: Map<string, string | null>;
  /** What each product page's specification lines state (see `extractSpecTable`). */
  specs: Map<string, PageSpecFact[]>;
  /** Embeddings of the products, when semantic search is set up and the catalogue has been embedded: they only ADD candidates. */
  semantic: { competitors: Map<string, Float32Array>; all: Map<string, Float32Array> } | null;
  dossiers: Map<string, AiDossier>;
  urls: Map<string, string | null>;
}

interface PairCtx {
  key: string;
  sv: string;
  cv: string;
  siteId: string;
  src: Dossier;
  cand: Dossier;
  aiS: AiDossier;
  aiC: AiDossier;
  c: AiCandidate;
  inputHash: string;
  chk: { q: 'same' | 'different' | 'unknown'; b?: 'equivalent' | 'mismatch' | 'unknown' };
  /** What the category policy established from sourced evidence (null outside automotive). */
  policy: BulbPolicyResult | null;
}

/**
 * What the product pages say about FIT and WHAT IS IN THE BOX, one short excerpt per product (never a whole page, markup removed): the line around the first mention of fitment, compatibility,
 * the package contents or the bulb-size chart. The rule engine reads only the bulb-size chart; the AI is also shown these, because a listing that names its vehicles or its kit only in the
 * description would otherwise look as if it said nothing.
 */
async function loadFitmentExcerpts(db: DbLike, orgId: string): Promise<Map<string, string>> {
  const rows = await db.execute<{ id: string; d: string }>(sql`
    select id, d from (
      select p.id, substring(regexp_replace(left(p.description, 8000), '<[^>]+>', ' ', 'g') from '(?i)(.{0,100}(?:location bulb size|fitment|fits |compatib|package includes|in the box|kit includes|includes:|replaces).{0,250})') as d
      from products p join sites s on s.id = p.site_id
      where p.org_id = ${orgId} and s.active and p.delisted_at is null and p.description is not null
    ) x where d is not null`);
  return new Map(rows.rows.map((r) => [r.id, r.d]));
}

/** The specification lines a product page states (read by `extractSpecTable`): only products whose description has such lines are returned, and only the first part of the text. */
export async function loadSpecTexts(db: DbLike, orgId: string): Promise<Map<string, PageSpecFact[]>> {
  const rows = await db.execute<{ id: string; t: string }>(sql`
    select p.id, left(regexp_replace(left(p.description, 6000), '<[^>]+>', ' ', 'g'), 2500) as t
    from products p join sites s on s.id = p.site_id
    where p.org_id = ${orgId} and s.active and p.delisted_at is null and p.description is not null
      and p.description ~* '(wattage|voltage|lumens|brightness|colou?r temperature|socket|bulb (type|size|model)|can-?bus|dimension|alcohol|abv|package includes|ingredients)[^a-z]{0,6}[:：]'`);
  const out = new Map<string, PageSpecFact[]>();
  for (const r of rows.rows) {
    const facts = extractSpecTable(r.t);
    if (facts.length) out.set(r.id, facts);
  }
  return out;
}

/** The vectors of the catalogue, if semantic search is configured and the products have been embedded. */
async function loadSemantic(db: DbLike, orgId: string, competitorIds: string[], model: string | undefined): Promise<Ctx['semantic']> {
  if (!model) return null;
  const have = await loadVectors(db, orgId, model);
  if (!have.size) return null;
  const all = new Map([...have].map(([id, x]) => [id, x.v]));
  return { all, competitors: new Map(competitorIds.filter((id) => all.has(id)).map((id) => [id, all.get(id)!])) };
}

export async function semanticFor(ctx: Ctx, variantId: string) {
  const v = ctx.semantic?.all.get(variantId);
  return v && ctx.semantic ? semanticHits(v, ctx.semantic.competitors) : null;
}

export async function buildContext(db: DbLike, orgId: string, embeddingModel?: string): Promise<Ctx> {
  const inputs = await loadEngineInputs(db, orgId);
  const excerpts = await loadFitmentExcerpts(db, orgId);
  const specTexts = await loadSpecTexts(db, orgId);
  const corpus = analyseCatalogue(inputs);
  const competitors = inputs.filter((i) => i.role === 'competitor').map((i) => corpus.byVariant.get(i.variantId)!);
  return {
    corpus,
    index: buildRetrievalIndex(competitors, corpus),
    sources: new Set(inputs.filter((i) => i.role === 'source').map((i) => i.variantId)),
    descriptions: new Map(inputs.map((i) => [i.variantId, excerpts.get(i.productId) ?? i.description ?? null])),
    specs: new Map(inputs.map((i) => [i.variantId, specTexts.get(i.productId) ?? []])),
    semantic: await loadSemantic(db, orgId, inputs.filter((i) => i.role === 'competitor').map((i) => i.variantId), embeddingModel),
    dossiers: new Map(),
    urls: new Map(),
  };
}

const aiDossierOf = (ctx: Ctx, variantId: string): AiDossier => {
  let d = ctx.dossiers.get(variantId);
  if (!d) {
    d = buildAiDossier(ctx.corpus.byVariant.get(variantId)!, { alias: ctx.corpus.alias, url: ctx.urls.get(variantId) ?? null, description: ctx.descriptions.get(variantId) ?? null, specs: ctx.specs.get(variantId) ?? [] });
    ctx.dossiers.set(variantId, d);
  }
  return d;
};

/**
 * What each product's facts say NOW, as the fingerprint a stored answer was made from: an answer whose fingerprints differ is stale and is neither trusted nor approved. Used by the evaluation
 * to score only answers production would still act on.
 */
export async function currentFingerprints(db: DbLike, ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => ctx.corpus.byVariant.has(id));
  await refreshFacts(db, ctx, unique);
  return new Map(unique.map((id) => [id, aiDossierOf(ctx, id).fingerprint]));
}

/** Loads the page address of some products and forgets their cached dossiers, so they are rebuilt from today's facts. */
async function refreshFacts(db: DbLike, ctx: Ctx, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 2000) {
    const part = ids.slice(i, i + 2000);
    const urlRows = await db.execute<{ id: string; url: string | null }>(sql`select id, url from variants where id in (${uuidList(part)})`);
    for (const r of urlRows.rows) ctx.urls.set(r.id, r.url);
    for (const id of part) ctx.dossiers.delete(id); // rebuilt with the page address
  }
}

/** A stored answer rebuilt as a pair against today's products, or null when either product is no longer active. */
function pairFromRow(ctx: Ctx, row: StoredRow): PairCtx | null {
  const src = ctx.corpus.byVariant.get(row.sourceVariantId);
  const cand = ctx.corpus.byVariant.get(row.competitorVariantId);
  if (!src || !cand || !ctx.sources.has(row.sourceVariantId)) return null;
  const aiS = aiDossierOf(ctx, row.sourceVariantId);
  const aiC = aiDossierOf(ctx, row.competitorVariantId);
  const engine = evaluatePair(src, cand, ctx.corpus);
  return {
    key: pairKey(row.sourceVariantId, row.competitorVariantId), sv: row.sourceVariantId, cv: row.competitorVariantId, siteId: row.competitorSiteId, src, cand, aiS, aiC,
    c: { variantId: row.competitorVariantId, productId: cand.productId, siteId: row.competitorSiteId, score: 0, foundBy: [], siteRank: 0, engine }, inputHash: row.inputHash, chk: { q: 'unknown' }, policy: aiS.domain === 'automotive' ? evaluateBulbPolicy(aiS, aiC) : null,
  };
}

/** Everything the answer depends on. An unchanged pair (same facts, same checks, same model and instructions) is never sent again. */
function inputHashOf(model: string, aiS: AiDossier, aiC: AiDossier, c: AiCandidate, chk: PairCtx['chk']): string {
  const material = [model, AI_PROMPT_VERSION, hashText(AI_SYSTEM_PROMPT), aiS.fingerprint, aiC.fingerprint, chk.q, chk.b ?? '-', c.engine?.relationship ?? '-', c.engine?.conflicts.length ?? 0].join('|');
  return hashText(material) + hashText(material, 7);
}

/** What ended a window outranks what merely followed it: a quota wait or a failure over a plain stop. */
const windowRank = (o: WindowOutcome): number => (o.kind === 'complete' ? 0 : o.kind === 'stopped' ? 1 : 2);

type WindowOutcome = { kind: 'complete' } | { kind: 'blocked'; reason: string; resumeAt: number } | { kind: 'stopped' } | { kind: 'failed'; errorKind: string; message: string };

async function setRun(db: DbLike, runId: string, now: Date, set: Partial<typeof aiMatchRuns.$inferInsert>): Promise<void> {
  await db.update(aiMatchRuns).set({ ...set, updatedAt: now }).where(eq(aiMatchRuns.id, runId));
}

/**
 * The job: works through a run in windows of a few products until it finishes, is paused, runs into a quota, or has used its time slice (then it queues itself again). Requests are spread over the
 * configured keys, each held to its OWN limits. When every working key is paused the run waits (its work items wait for quota — they are never marked done) and resumes from its checkpoint.
 */
/** The part of each day's free quota that AUTOMATIC matching (a sweep) may use. The rest is kept for analyses a person starts, in any workspace: the quota is shared by every workspace on the server. */
export const SWEEP_SHARE = 0.7;

/** When an automatic sweep has to wait because it has used its share of today's quota (null: it may go on). */
async function sweepHold(db: DbLike, s: AiSettings, kind: string, now: Date): Promise<Date | null> {
  if (kind !== 'sweep') return null;
  const rows = await db.select({ n: aiUsageDaily.requests }).from(aiUsageDaily).where(and(eq(aiUsageDaily.day, pacificDay(now.getTime())), eq(aiUsageDaily.model, s.model)));
  const used = rows.reduce((a, r) => a + r.n, 0);
  return used >= Math.floor(s.dailyRequests * Math.max(1, s.keys.length) * SWEEP_SHARE) ? nextPacificMidnight(now) : null;
}
const SWEEP_PAUSE = 'Automatic matching has used its share of today’s free quota and keeps the rest for analyses people start. It continues after the quota resets (midnight Pacific Time).';

export async function processAiRun(svc: Services, orgId: string, runId: string): Promise<{ outcome: string }> {
  const db = svc.db as DbLike;
  const s = aiSettings(svc.config);
  const now = () => svc.clock();
  setAiClock(now);
  const [run0] = await db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.id, runId), eq(aiMatchRuns.orgId, orgId)));
  if (!run0) return { outcome: 'not_found' };
  if (run0.status === 'completed' || run0.status === 'failed' || run0.status === 'cancelled') return { outcome: run0.status };
  if (run0.status === 'paused' && (!run0.resumeAt || run0.resumeAt > now())) return { outcome: 'paused' };
  if (!s.configured) {
    await setRun(db, runId, now(), { status: 'paused', pauseReason: 'No Gemini API key is configured on the server.', resumeAt: null });
    return { outcome: 'not_configured' };
  }
  const pool = runtimeFor(s, s.keys);
  for (const k of pool) await hydrateLimiter(db, k.limiter, s.model, k.id, now());
  const working = pool.filter((k) => !k.limiter.snapshot().stopped);
  if (!working.length) {
    await setRun(db, runId, now(), { status: 'paused', pauseReason: pool[0]?.limiter.snapshot().stopped ?? 'Gemini processing is stopped.', resumeAt: null });
    return { outcome: 'stopped' };
  }
  // a key that has used its whole daily budget, or that Google paused, cannot take a request now: when none can, the run waits at once (not after building the catalogue's analysis for nothing)
  const nowMs = now().getTime();
  const holds = working.map((k) => {
    const c = k.limiter.check(0);
    return !c.ok && c.reason === 'daily' ? { until: nowMs + c.waitMs, why: 'daily' as string | null | undefined } : { until: k.limiter.snapshot().pausedUntil ?? 0, why: k.limiter.snapshot().pauseReason };
  });
  if (holds.every((h) => h.until > nowMs)) {
    const first = holds.reduce((a, b) => (b.until < a.until ? b : a));
    await setRun(db, runId, now(), { status: 'paused', pauseReason: pauseText(first.why), resumeAt: new Date(first.until) });
    await enqueueAiRun(svc.queue, orgId, runId, (first.until - nowMs) / 1000);
    return { outcome: 'waiting' };
  }
  const reserve = await sweepHold(db, s, run0.kind, now());
  if (reserve) {
    await setRun(db, runId, now(), { status: 'paused', pauseReason: SWEEP_PAUSE, resumeAt: reserve });
    await enqueueAiRun(svc.queue, orgId, runId, (reserve.getTime() - nowMs) / 1000);
    return { outcome: 'waiting_share' };
  }

  await setRun(db, runId, now(), { status: 'running', startedAt: run0.startedAt ?? now(), pauseReason: null, resumeAt: null, model: s.model, promptVersion: AI_PROMPT_VERSION });
  const params = aiRunSchema.parse(run0.params);
  const started = Date.now();
  let cursor = run0.cursor;
  const usage: AiRunUsage = { ...ZERO_USAGE, ...(run0.usage ?? {}) };
  const progress = { ...ZERO_PROGRESS, ...(run0.progress ?? {}), sources: run0.sourceIds.length };
  const persist = (extra: Partial<typeof aiMatchRuns.$inferInsert> = {}) => setRun(db, runId, now(), { cursor, usage, progress: { ...progress, sourcesDone: cursor }, ...extra });

  try {
    const ctx = await withHeavyWork(() => buildContext(db, orgId, svc.config.GEMINI_EMBEDDING_MODEL));
    for (;;) {
      if (cursor >= run0.sourceIds.length) {
        await persist({ status: 'completed', finishedAt: now(), pauseReason: null, resumeAt: null });
        svc.log.info('ai analysis finished', { orgId, runId, sources: run0.sourceIds.length, requests: usage.requests });
        return { outcome: 'completed' };
      }
      const [live] = await db.select({ status: aiMatchRuns.status }).from(aiMatchRuns).where(eq(aiMatchRuns.id, runId));
      if (live?.status !== 'running') return { outcome: live?.status ?? 'gone' }; // paused or cancelled by a person
      if (Date.now() - started > TIME_BUDGET_MS) {
        await persist({ status: 'queued' });
        await enqueueAiRun(svc.queue, orgId, runId, 1);
        return { outcome: 'continued' };
      }
      const hold = await sweepHold(db, s, run0.kind, now());
      if (hold) {
        await persist({ status: 'paused', pauseReason: SWEEP_PAUSE, resumeAt: hold });
        await enqueueAiRun(svc.queue, orgId, runId, (hold.getTime() - now().getTime()) / 1000);
        svc.log.info('ai sweep waits for the next day (its share of the quota is used)', { orgId, runId });
        return { outcome: 'waiting_share' };
      }
      const ids = run0.sourceIds.slice(cursor, cursor + WINDOW_SOURCES);
      const outcome = await runWindow(svc, db, orgId, runId, ids, ctx, params.perSite, s, pool, usage, progress);
      if (outcome.kind === 'complete') {
        cursor += ids.length;
        await persist();
        continue;
      }
      if (outcome.kind === 'blocked') {
        await markWork(db, orgId, ids, 'waiting_quota', pauseText(outcome.reason), runId, now());
        await persist({ status: 'paused', pauseReason: pauseText(outcome.reason), resumeAt: new Date(outcome.resumeAt) });
        await enqueueAiRun(svc.queue, orgId, runId, (outcome.resumeAt - now().getTime()) / 1000);
        svc.log.info('ai analysis paused for quota', { orgId, runId, reason: outcome.reason });
        return { outcome: 'blocked' };
      }
      if (outcome.kind === 'stopped') return { outcome: 'stopped_by_person' };
      // every key is stopped (refused, wrong model, non-free quota): processing waits for a person; a bad request fails the run
      if (STOP_KINDS.has(outcome.errorKind)) {
        await markWork(db, orgId, ids, 'waiting_quota', outcome.message, runId, now());
        await persist({ status: 'paused', pauseReason: outcome.message, resumeAt: null });
        svc.log.warn('ai analysis stopped', { orgId, runId, kind: outcome.errorKind });
        return { outcome: 'stopped' };
      }
      await persist({ status: 'failed', error: outcome.message.slice(0, 300), finishedAt: now() });
      return { outcome: 'failed' };
    }
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    svc.log.error('ai analysis failed', { orgId, runId, error: message });
    await setRun(db, runId, now(), { status: 'failed', error: message, finishedAt: now(), usage, progress: { ...progress, sourcesDone: cursor }, cursor });
    return { outcome: 'failed' };
  }
}

/** Marks the work items of some products (creating them), without touching their counts. */
async function markWork(db: DbLike, orgId: string, ids: string[], status: 'queued' | 'running' | 'waiting_quota' | 'retry' | 'needs_evidence' | 'completed', reason: string | null, runId: string, now: Date): Promise<void> {
  for (const id of ids) {
    await db.insert(aiMatchWork).values({ orgId, sourceVariantId: id, status, reason, lastRunId: runId, updatedAt: now }).onConflictDoUpdate({ target: aiMatchWork.sourceVariantId, set: { status, reason, lastRunId: runId, updatedAt: now } });
  }
}

const pauseText = (reason: string | null | undefined): string =>
  reason === 'daily' ? 'The daily quota is used up. Analysis continues after the quota resets (midnight Pacific Time).'
    : reason === 'rate' || reason === 'rpm' || reason === 'tpm' ? 'Waiting for the per-minute limit to clear.'
    : reason === 'backoff' || reason === 'paused' ? 'Google is busy or slow; trying again shortly.'
    : 'Waiting for the quota.';

/** What the guards need to know about a pair: the same evidence whether the answer is new or was stored earlier. */
function guardCtxOf(p: PairCtx): GuardContext {
  const eng = p.c.engine;
  return {
    engine: eng ? { relationship: eng.relationship, conflicts: eng.conflicts } : null,
    quantity: eng?.quantity ?? null,
    bundle: eng?.bundle ?? null,
    sourceBrandKey: p.src.brand.key,
    candidateBrandKey: p.cand.brand.key,
    gtinEqual: !!p.src.identifiers.gtin && !!p.cand.identifiers.gtin && p.src.identifiers.gtin.value === p.cand.identifiers.gtin.value,
    gtinDiffer: !!p.src.identifiers.gtin && !!p.cand.identifiers.gtin && p.src.identifiers.gtin.value !== p.cand.identifiers.gtin.value,
    // the code is "the same" only on SOURCED evidence (a raw code, or a verified standard alias): codes that merely co-occur in the catalogue never count
    codesAgree: p.policy?.fields.code === 'established',
    domain: p.aiS.domain,
    ...(p.aiS.domain === 'automotive' ? { policy: p.policy } : {}),
    sourceFacts: groundingText(p.aiS),
    candidateFacts: groundingText(p.aiC),
  };
}

function autoFactsOf(p: PairCtx, g: { match_type: AiMatchType; confidence_level: AiConfidence; guards: { code: string }[] }): Omit<AutoFacts, 'decidedByPerson'> {
  const eng = p.c.engine;
  return {
    matchType: g.match_type, confidence: g.confidence_level, guardCodes: g.guards.map((x) => x.code), domain: p.aiS.domain,
    gtinEqual: !!p.src.identifiers.gtin && !!p.cand.identifiers.gtin && p.src.identifiers.gtin.value === p.cand.identifiers.gtin.value,
    sameBrand: !!p.src.brand.key && p.src.brand.key === p.cand.brand.key, mpnEqual: !!p.src.identifiers.mpn && p.src.identifiers.mpn.value === p.cand.identifiers.mpn?.value,
    policy: p.policy, quantity: (eng?.quantity.verdict ?? 'unknown') as 'same' | 'different' | 'unknown', bundle: eng?.bundle?.verdict ?? null, engine: eng ? { relationship: eng.relationship, conflicts: eng.conflicts } : null,
  };
}

const policyReadingOf = (p: PairCtx): AiPolicyReading => {
  const eng = p.c.engine;
  return {
    compat: p.policy ? { version: p.policy.version, category: p.policy.category, fields: p.policy.fields, sharedCode: p.policy.sharedCode, eligible: p.policy.eligible, blocker: p.policy.blocker, reasons: p.policy.reasons } : null,
    quantity: eng ? { verdict: eng.quantity.verdict as 'same' | 'different' | 'unknown', note: eng.quantity.note } : null,
    bundle: eng?.bundle ? { verdict: eng.bundle.verdict, note: eng.bundle.note } : null,
  };
};

/** What happened to each source in a window: the numbers behind its work item and the funnel. */
interface SourceTally { candidates: number; judged: number; /** answers that name a counterpart (identical, pack variant, equivalent or substitute) */ acceptable: number; eligible: number; approved: number; /** pairs a person has already decided */ decided: number; unanswered: number; reasons: Set<string> }
type WindowTally = Map<string, SourceTally>;
const tallyOf = (m: WindowTally, sv: string): SourceTally => m.get(sv) ?? m.set(sv, { candidates: 0, judged: 0, acceptable: 0, eligible: 0, approved: 0, decided: 0, unanswered: 0, reasons: new Set() }).get(sv)!;

const COUNTERPART_TYPES = new Set<AiMatchType>(['exact_item', 'same_product_different_pack', 'close_equivalent', 'substitute']);

/** Records what happened to one judged pair in its source's tally (which the work item and the coverage funnel are made from). */
function notePair(t: SourceTally, p: PairCtx, matchType: AiMatchType, r: ReconcileResult): void {
  t.judged++;
  if (COUNTERPART_TYPES.has(matchType)) t.acceptable++;
  if (r.autoClass) t.eligible++;
  if (r.outcome === 'approved' || r.outcome === 'already_approved') t.approved++;
  else if (r.outcome === 'human_decision_preserved') t.decided++;
  else t.reasons.add(r.outcome === 'not_eligible' || r.outcome === 'missing_critical_facts' || r.outcome === 'conflict' ? (p.policy?.blocker ?? r.outcome) : r.outcome);
}

/** Approval for one pair against the CURRENT evidence and rules: the single operation behind a new answer, a cache hit, a switched-on policy and a changed product. */
async function reconcilePair(db: DbLike, orgId: string, p: PairCtx, stored: { s: string; c: string }, g: { match_type: AiMatchType; confidence_level: AiConfidence; guards: { code: string }[] }, enabled: EnabledPolicies, now: Date): Promise<ReconcileResult> {
  const facts = autoFactsOf(p, g);
  const eng = p.c.engine;
  const wouldBe = autoClassOf({ ...facts, decidedByPerson: false });
  let rivals = 0;
  if (wouldBe === 'exact_item') {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from ai_match_suggestions where org_id = ${orgId} and source_variant_id = ${p.sv}::uuid and competitor_site_id = ${p.siteId}::uuid and competitor_variant_id <> ${p.cv}::uuid and auto_class = 'exact_item'`);
    rivals = r.rows[0]?.n ?? 0;
  }
  return reconcileOne(db, { orgId, sv: p.sv, cv: p.cv, siteId: p.siteId, facts, quantity: eng?.quantity ?? null, bundle: eng?.bundle ?? null, fingerprints: { stored, current: { s: p.aiS.fingerprint, c: p.aiC.fingerprint } }, rivalExactItems: rivals }, enabled, now);
}

type StoredRow = typeof aiMatchSuggestions.$inferSelect;

/** A stored answer reused without asking again: its safeguards and eligibility are recomputed from the current facts, the row is brought up to date, and its approval is re-checked. */
async function reuseStored(db: DbLike, orgId: string, p: PairCtx, row: StoredRow, enabled: EnabledPolicies, now: Date): Promise<ReconcileResult & { matchType: AiMatchType }> {
  const raw: AiDecision = { candidate_id: p.cv, match_type: row.aiMatchType, confidence_level: row.aiConfidence, supporting_evidence: row.supporting, conflicting_evidence: row.conflicting, missing_evidence: row.missing, explanation: row.explanation, price_comparable: false, requires_human_review: row.requiresReview };
  const g = applyGuards(raw, guardCtxOf(p));
  const autoClass = autoClassOf({ ...autoFactsOf(p, g), decidedByPerson: false });
  const changed = g.match_type !== row.matchType || g.confidence_level !== row.confidence || autoClass !== (row.autoClass ?? null) || row.autoPolicyVersion !== AUTO_POLICY_VERSION || g.guards.map((x) => x.code).join() !== row.guards.map((x) => x.code).join();
  if (changed) {
    const keep = row.status === 'pending' || row.matchType === g.match_type;
    await db.update(aiMatchSuggestions).set({ matchType: g.match_type, confidence: g.confidence_level, priceComparable: g.price_comparable, requiresReview: g.requires_human_review, guards: g.guards, policy: policyReadingOf(p), autoClass, autoPolicyVersion: AUTO_POLICY_VERSION, updatedAt: now, ...(keep ? {} : { status: 'pending' as const, reviewedBy: null, reviewedAt: null, reviewRelationship: null, reviewNote: null }) }).where(eq(aiMatchSuggestions.id, row.id));
  }
  return { ...(await reconcilePair(db, orgId, p, { s: row.sourceFingerprint, c: row.candidateFingerprint }, g, enabled, now)), matchType: g.match_type };
}

async function runWindow(
  svc: Services,
  db: DbLike,
  orgId: string,
  runId: string,
  ids: string[],
  ctx: Ctx,
  perSite: number,
  s: AiSettings,
  pool: KeyRuntime[],
  usage: AiRunUsage,
  progress: typeof ZERO_PROGRESS,
): Promise<WindowOutcome> {
  const now = () => svc.clock();
  const sources = ids.filter((id) => ctx.sources.has(id) && ctx.corpus.byVariant.has(id));
  if (!sources.length) return { kind: 'complete' };
  const work = new Map((await db.select().from(aiMatchWork).where(and(eq(aiMatchWork.orgId, orgId), inArray(aiMatchWork.sourceVariantId, sources)))).map((w) => [w.sourceVariantId, w]));
  const enabled = await enabledPolicies(db, orgId);
  const tally: WindowTally = new Map();

  // shortlists: several diverse candidates per competitor website, found by many local methods. A product that found no acceptable candidate last time looks wider this time.
  const shortlists = new Map<string, AiCandidate[]>();
  for (const sv of sources) {
    const w = work.get(sv);
    const wide = w && (w.reason === 'no_acceptable_candidate' || w.reason === 'no_candidate') && w.attempts >= 1 ? Math.min(8, perSite * 2 + 2) : perSite;
    shortlists.set(sv, retrieveShortlist(ctx.index, ctx.corpus.byVariant.get(sv)!, { perSiteProducts: wide }, await semanticFor(ctx, sv)));
  }
  const involved = [...new Set([...sources, ...[...shortlists.values()].flatMap((l) => l.map((c) => c.variantId))])];
  await refreshFacts(db, ctx, involved);

  const pairs = new Map<string, PairCtx>();
  for (const sv of sources) {
    const srcD = ctx.corpus.byVariant.get(sv)!;
    for (const c of shortlists.get(sv)!) {
      const candD = ctx.corpus.byVariant.get(c.variantId);
      if (!candD) continue;
      const aiS = aiDossierOf(ctx, sv);
      const aiC = aiDossierOf(ctx, c.variantId);
      const chk: PairCtx['chk'] = { q: (c.engine?.quantity.verdict ?? 'unknown') as 'same' | 'different' | 'unknown', ...(c.engine?.bundle ? { b: c.engine.bundle.verdict } : {}) };
      const key = pairKey(sv, c.variantId);
      pairs.set(key, { key, sv, cv: c.variantId, siteId: c.siteId, src: srcD, cand: candD, aiS, aiC, c, inputHash: inputHashOf(s.model, aiS, aiC, c, chk), chk, policy: aiS.domain === 'automotive' ? evaluateBulbPolicy(aiS, aiC) : null });
      tallyOf(tally, sv).candidates++;
    }
  }
  progress.candidates += pairs.size;

  const existing = new Map((await db.select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.orgId, orgId), inArray(aiMatchSuggestions.sourceVariantId, sources)))).map((r) => [pairKey(r.sourceVariantId, r.competitorVariantId), r]));
  const todo = [...pairs.values()].filter((p) => existing.get(p.key)?.inputHash !== p.inputHash);
  const cachedPairs = [...pairs.values()].filter((p) => existing.get(p.key)?.inputHash === p.inputHash);
  usage.cachedResults += cachedPairs.length;
  progress.cachedResults += cachedPairs.length;
  if (cachedPairs.length) await addUsage(db, s.model, pool[0]?.id ?? 'k1', now(), { cachedResults: cachedPairs.length });
  // an unchanged pair is not asked again, but its approval is decided afresh: a policy switched on since, or a rule that changed, applies to it too
  for (const p of cachedPairs) {
    const r = await reuseStored(db, orgId, p, existing.get(p.key)!, enabled, now());
    notePair(tallyOf(tally, p.sv), p, r.matchType, r);
  }
  // answers stored earlier for pairs that are NOT in today's shortlist (a product changed, so other candidates now rank above it): their approval is re-checked against today's facts too, so an
  // approval can never outlive the evidence it rested on just because the pair stopped being proposed
  const orphans = [...existing.values()].filter((r) => !pairs.has(pairKey(r.sourceVariantId, r.competitorVariantId)));
  if (orphans.length) {
    await refreshFacts(db, ctx, [...new Set(orphans.map((r) => r.competitorVariantId))].filter((id) => ctx.corpus.byVariant.has(id)));
    for (const row of orphans) {
      const p = pairFromRow(ctx, row);
      if (!p) continue;
      const r = await reuseStored(db, orgId, p, row, enabled, now());
      notePair(tallyOf(tally, p.sv), p, r.matchType, r);
    }
  }
  await storeDossiers(db, orgId, todo.flatMap((p) => [p.aiS, p.aiC]));
  if (todo.length) {
    const groups: PayloadGroup[] = sources
      .map((sv) => ({ ref: sv, source: toWire(aiDossierOf(ctx, sv)), candidates: todo.filter((p) => p.sv === sv).map((p) => ({ id: '', ref: p.cv, wire: toWire(p.aiC), chk: p.chk })) }))
      .filter((g) => g.candidates.length);
    const plan = planBatches(groups, { ...DEFAULT_BATCH_LIMITS, maxCandidates: s.batchCandidates, maxInputTokens: s.maxInputTokens, maxOutputTokens: s.maxOutputTokens, charsPerToken: charsPerTokenState.charsPerToken });
    let outcome: WindowOutcome = { kind: 'complete' };
    let next = 0;
    const base = {
      cfg: { model: s.model, maxOutputTokens: s.maxOutputTokens, timeoutMs: s.timeoutMs, maxWaitMs: 90_000 },
      ...(svc.geminiHttp ? { http: svc.geminiHttp } : {}),
      sleep: svc.aiSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
      now: () => svc.clock().getTime(),
      tokens: charsPerTokenState,
      shouldStop: async () => outcome.kind !== 'complete' || (await db.select({ status: aiMatchRuns.status }).from(aiMatchRuns).where(eq(aiMatchRuns.id, runId)))[0]?.status !== 'running',
    };
    const onRequest = async (keyId: string, e: UsageEvent) => {
      const limited = e.errorKind === 'quota_minute' || e.errorKind === 'quota_day' || e.errorKind === 'quota_tokens';
      const d = { requests: 1, successes: e.ok ? 1 : 0, failures: e.ok ? 0 : 1, rateLimited: limited ? 1 : 0, inputTokens: e.usage?.promptTokens ?? 0, outputTokens: e.usage?.outputTokens ?? 0, thoughtTokens: e.usage?.thoughtsTokens ?? 0, ms: e.ms };
      usage.requests += d.requests; usage.successes += d.successes; usage.failures += d.failures; usage.rateLimited += d.rateLimited;
      usage.inputTokens += d.inputTokens; usage.outputTokens += d.outputTokens; usage.thoughtTokens += d.thoughtTokens; usage.ms += d.ms;
      await addUsage(db, s.model, keyId, now(), d);
    };
    const worker = async () => {
      for (;;) {
        if (outcome.kind !== 'complete') return;
        const req: PlannedRequest | undefined = plan[next++];
        if (!req) return;
        const res = await askWithPool(req, pool, base, onRequest, db, s.model, now);
        const got = res.status === 'done' ? res.decisions : res.partial;
        const saved = await saveDecisions(db, orgId, runId, s, got, pairs, existing, enabled, tally, now());
        usage.candidatesAnswered += saved;
        progress.answered += saved;
        if (saved) await addUsage(db, s.model, pool[0]?.id ?? 'k1', now(), { candidatesAnswered: saved });
        // the first thing that ended the window is what it reports: a worker that merely saw the others stop (or a person pause the run) never overwrites a quota wait or a failure
        const ended: WindowOutcome | null = res.status === 'blocked' ? { kind: 'blocked', reason: res.reason, resumeAt: res.resumeAt } : res.status === 'failed' ? { kind: 'failed', errorKind: res.error.kind, message: res.error.message } : res.status === 'stopped' ? { kind: 'stopped' } : null;
        if (ended) {
          if (windowRank(ended) > windowRank(outcome)) outcome = ended;
        } else if (res.status === 'done') for (const k of res.unanswered) tallyOf(tally, k.split('|')[0]!).unanswered++;
      }
    };
    const width = pool.reduce((n, k) => n + (k.limiter.snapshot().stopped ? 0 : k.limiter.concurrency), 0);
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, plan.length)) }, () => worker()));
    if (outcome.kind !== 'complete') return outcome;
  }
  await finishWork(db, orgId, runId, sources, tally, work, now());
  return { kind: 'complete' };
}

/** Why a source variant with a counterpart candidate is not approved, in the order that matters most (the first one found names it). */
const BLOCKERS = ['ambiguous_candidate', 'stale_analysis', 'unsupported_category', 'kit', 'missing_fitment', 'ambiguous_variant', 'conflicting_fitment', 'policy_not_enabled'];

/** The durable record of where each product stands, written once a window is fully worked through. */
async function finishWork(db: DbLike, orgId: string, runId: string, sources: string[], tally: WindowTally, work: Map<string, typeof aiMatchWork.$inferSelect>, now: Date): Promise<void> {
  for (const sv of sources) {
    const t = tallyOf(tally, sv);
    const blocker = BLOCKERS.find((r) => t.reasons.has(r)) ?? null;
    const status: 'completed' | 'needs_evidence' | 'retry' = t.unanswered > 0 ? 'retry' : !t.approved && !t.eligible && (blocker === 'missing_fitment' || blocker === 'ambiguous_variant') ? 'needs_evidence' : 'completed';
    // why this variant is where it is: the funnel is made of these
    const reason = t.unanswered > 0 ? 'unanswered' : t.candidates === 0 ? 'no_candidate' : t.approved > 0 ? 'approved' : t.decided > 0 && !blocker ? 'human_decision' : blocker ?? (t.acceptable > 0 ? 'awaiting_review' : 'no_acceptable_candidate');
    const prior = work.get(sv);
    const values = { orgId, sourceVariantId: sv, status, reason, policyVersion: AUTO_POLICY_VERSION, lastRunId: runId, candidates: t.candidates, judged: t.judged, eligible: t.eligible, approved: t.approved, attempts: (prior?.attempts ?? 0) + (reason === 'no_acceptable_candidate' || reason === 'no_candidate' || status === 'retry' ? 1 : 0), updatedAt: now, completedAt: status === 'completed' ? now : null, nextAttemptAt: status === 'retry' ? new Date(now.getTime() + 15 * 60_000) : null };
    await db.insert(aiMatchWork).values(values).onConflictDoUpdate({ target: aiMatchWork.sourceVariantId, set: values });
  }
}

/**
 * One planned request, tried on the keys in the order of who can take it now: a key that Google paused is skipped, a key that was refused or reports a non-free-tier quota is stopped on its own
 * (the others carry on), and answers already received are kept when a key runs out part-way. Only when no key can take it does the work wait.
 */
async function askWithPool(
  req: PlannedRequest,
  pool: KeyRuntime[],
  base: Omit<AskDeps, 'cfg' | 'limiter' | 'onRequest'> & { cfg: Omit<AskDeps['cfg'], 'apiKey'> },
  onRequest: (keyId: string, e: UsageEvent) => Promise<void>,
  db: DbLike,
  model: string,
  now: () => Date,
): Promise<AskResult> {
  const partial = new Map<string, AiDecision>();
  const tried = new Set<string>();
  let last: AskResult | null = null;
  let resumeAt = Infinity;
  const wanted = new Set(req.groups.flatMap((g) => g.candidates.map((c) => pairKey(g.ref, c.ref))));
  for (;;) {
    const k = pickOrder(pool, now().getTime(), req.estimatedInputTokens + req.estimatedOutputTokens).find((x) => !tried.has(x.id));
    if (!k) break;
    const left = new Set([...wanted].filter((w) => !partial.has(w)));
    const res = await askRequest(left.size === wanted.size ? req : restrict(req, left, base), { ...base, cfg: { ...base.cfg, apiKey: k.apiKey }, limiter: k.limiter, onRequest: (e) => onRequest(k.id, e) });
    await saveLimiterState(db, k.limiter, model, k.id, now());
    for (const [a, b] of res.status === 'done' ? res.decisions : res.partial) partial.set(a, b);
    if (res.status === 'done') return { status: 'done', decisions: partial, unanswered: [...wanted].filter((w) => !partial.has(w)) };
    if (res.status === 'stopped') return { status: 'stopped', partial };
    tried.add(k.id);
    last = res;
    if (res.status === 'blocked') { resumeAt = Math.min(resumeAt, res.resumeAt); continue; }
    if (res.status === 'failed') {
      if (!STOP_KINDS.has(res.error.kind)) return { status: 'failed', error: res.error, partial };
      await markKeyStopped(db, model, k.id, res.error.message, now());
    }
  }
  // every working key was tried
  if (last?.status === 'failed') return { status: 'failed', error: last.error, partial };
  if (Number.isFinite(resumeAt)) return { status: 'blocked', reason: last?.status === 'blocked' ? last.reason : 'daily', resumeAt, partial };
  return { status: 'failed', error: { kind: 'not_configured', status: 0, message: 'No working Gemini key is available.' }, partial };
}

/** The dossier the AI was shown, kept per product and rebuilt only when it changed. */
async function storeDossiers(db: DbLike, orgId: string, list: AiDossier[]): Promise<void> {
  const byVariant = new Map(list.map((d) => [d.ref, d]));
  if (!byVariant.size) return;
  const have = await db.select({ id: aiDossiers.variantId, fingerprint: aiDossiers.fingerprint, version: aiDossiers.version }).from(aiDossiers).where(and(eq(aiDossiers.orgId, orgId), inArray(aiDossiers.variantId, [...byVariant.keys()])));
  const same = new Map(have.map((h) => [h.id, h]));
  const now = new Date();
  for (const d of byVariant.values()) {
    const h = same.get(d.ref);
    if (h && h.fingerprint === d.fingerprint && h.version === AI_DOSSIER_VERSION) continue;
    const values = { orgId, variantId: d.ref, fingerprint: d.fingerprint, version: d.version, dossier: d as unknown as Record<string, unknown>, updatedAt: now };
    await db.insert(aiDossiers).values(values).onConflictDoUpdate({ target: aiDossiers.variantId, set: { fingerprint: values.fingerprint, version: values.version, dossier: values.dossier, updatedAt: now } });
  }
}

/** Applies the safeguards to each answer and stores it, then decides its approval. One row per pair: an existing row is updated, never duplicated, and a person's review of it is kept unless the AI changed its answer. */
async function saveDecisions(
  db: DbLike,
  orgId: string,
  runId: string,
  s: AiSettings,
  got: Map<string, AiDecision>,
  pairs: Map<string, PairCtx>,
  existing: Map<string, StoredRow>,
  enabled: EnabledPolicies,
  tally: WindowTally,
  now: Date,
): Promise<number> {
  let saved = 0;
  for (const [key, decision] of got) {
    const p = pairs.get(key);
    if (!p) continue;
    const eng = p.c.engine;
    const g = applyGuards(decision, guardCtxOf(p));
    const engine: AiEngineReading | null = eng ? { relationship: eng.relationship, tier: eng.tier, conflicts: eng.conflicts.slice(0, 4), summary: eng.evidence.summary } : null;
    // which class of automatic approval the deterministic conditions qualify this answer for: recorded for EVERY answer so a class can be measured before it is ever used
    const autoClass = autoClassOf({ ...autoFactsOf(p, g), decidedByPerson: false });
    const before = existing.get(key);
    const keepReview = !!before && before.status !== 'pending' && before.matchType === g.match_type;
    const values = {
      orgId, runId, sourceVariantId: p.sv, competitorVariantId: p.cv, competitorSiteId: p.siteId,
      matchType: g.match_type, aiMatchType: g.ai_match_type, confidence: g.confidence_level as AiConfidence, aiConfidence: g.ai_confidence_level as AiConfidence,
      priceComparable: g.price_comparable, requiresReview: g.requires_human_review, explanation: g.explanation,
      supporting: g.supporting_evidence, conflicting: g.conflicting_evidence, missing: g.missing_evidence, guards: g.guards,
      foundBy: p.c.foundBy.map((f) => ({ method: f.method, rank: f.rank, detail: f.detail })), engine, policy: policyReadingOf(p),
      autoClass, autoPolicyVersion: AUTO_POLICY_VERSION, inputHash: p.inputHash, sourceFingerprint: p.aiS.fingerprint, candidateFingerprint: p.aiC.fingerprint, model: s.model, promptVersion: AI_PROMPT_VERSION,
      sourceUrl: p.aiS.url, candidateUrl: p.aiC.url, analysedAt: now, updatedAt: now,
    };
    const { orgId: _o, sourceVariantId: _s, competitorVariantId: _c, ...update } = values;
    await db
      .insert(aiMatchSuggestions)
      .values({ ...values, status: 'pending' })
      .onConflictDoUpdate({
        target: [aiMatchSuggestions.sourceVariantId, aiMatchSuggestions.competitorVariantId],
        set: keepReview ? update : { ...update, status: 'pending', reviewedBy: null, reviewedAt: null, reviewRelationship: null, reviewNote: null },
      });
    // the approval decision for this pair, against the current evidence and the policies that are switched on
    const r = await reconcilePair(db, orgId, p, { s: p.aiS.fingerprint, c: p.aiC.fingerprint }, g, enabled, now);
    notePair(tallyOf(tally, p.sv), p, g.match_type, r);
    saved++;
  }
  return saved;
}

/**
 * Re-decides the approval of every stored answer against the CURRENT facts and rules, without asking the model anything: what a person's switching a policy on, or a changed rule, needs. Resumable
 * and idempotent: repeating it changes nothing and records nothing twice; an approval whose evidence changed is taken back. Work is done in slices of products and queued again until finished.
 */
export async function reconcileSuggestions(svc: Services, orgId: string, after: string | null = null): Promise<{ outcome: 'done' | 'continue'; processed: number; tally: Record<string, number> }> {
  const db = svc.db as DbLike;
  setAiClock(() => svc.clock());
  const started = Date.now();
  const sources = (await db.execute<{ id: string }>(sql`select distinct source_variant_id as id from ai_match_suggestions where org_id = ${orgId} ${after ? sql`and source_variant_id > ${after}::uuid` : sql``} order by 1`)).rows.map((r) => r.id);
  if (!sources.length) return { outcome: 'done', processed: 0, tally: {} };
  const ctx = await withHeavyWork(() => buildContext(db, orgId, svc.config.GEMINI_EMBEDDING_MODEL));
  const enabled = await enabledPolicies(db, orgId);
  const results: ReconcileResult[] = [];
  let processed = 0;
  for (let i = 0; i < sources.length; i += 25) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      await svc.queue.enqueue('ai-match', { orgId, task: 'reconcile', after: sources[i - 1] ?? after }, { singletonKey: `reconcile:${orgId}`, startAfterSeconds: 2 });
      return { outcome: 'continue', processed, tally: tally(results) };
    }
    const part = sources.slice(i, i + 25);
    const rows = await db.select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.orgId, orgId), inArray(aiMatchSuggestions.sourceVariantId, part)));
    await refreshFacts(db, ctx, [...new Set(rows.flatMap((r) => [r.sourceVariantId, r.competitorVariantId]))].filter((id) => ctx.corpus.byVariant.has(id)));
    for (const row of rows) {
      const p = pairFromRow(ctx, row);
      if (!p) continue; // a product that is no longer active
      results.push(await reuseStored(db, orgId, p, row, enabled, svc.clock()));
      processed++;
    }
  }
  svc.log.info('ai approvals reconciled', { orgId, processed, ...tally(results) });
  // a policy switched on or off while this was running is not seen by this pass: go round again from the start (it is idempotent)
  const now = await enabledPolicies(db, orgId);
  const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  if (!same(enabled, now)) await svc.queue.enqueue('ai-match', { orgId, task: 'reconcile', after: null }, { singletonKey: `reconcile:${orgId}`, startAfterSeconds: 2 });
  return { outcome: 'done', processed, tally: tally(results) };
}

/** Starts the whole-catalogue sweep (continuous matching) unless some analysis is already open. */
export async function startSweep(svc: Services, orgId: string): Promise<string | null> {
  try {
    const { run } = await createAiRun(svc.db as DbLike, svc.config, orgId, null, { scope: 'sweep', perSite: 3 }, svc.clock());
    await enqueueAiRun(svc.queue, orgId, run.id);
    return run.id;
  } catch (e) {
    if (e instanceof MatchError) return null; // one is already open, or there is nothing to do
    throw e;
  }
}

/**
 * Safety net and scheduler, called every minute by the worker. (1) A run that should be moving but has no job (the worker restarted, a delayed job was lost) is queued again; a run a person
 * paused (no resume time) is never touched, and a run is recovered at most three times. (2) Continuous matching: a workspace that opted in gets a sweep of its whole catalogue once a collection
 * has finished since the last one (and at least once a day), so new and changed products are worked through by themselves, within the free quota of every key.
 */
export async function aiResumeTick(svc: Services): Promise<{ queued: string[]; swept: string[] }> {
  if (!aiKeysOf(svc.config).length) return { queued: [], swept: [] };
  const now = svc.clock();
  const db = svc.db as DbLike;
  const rows = await db.select().from(aiMatchRuns).where(inArray(aiMatchRuns.status, ['queued', 'running', 'paused']));
  const queued: string[] = [];
  for (const r of rows) {
    const idle = now.getTime() - r.updatedAt.getTime();
    const due = r.status === 'queued' || (r.status === 'paused' && r.resumeAt !== null && r.resumeAt <= now) || (r.status === 'running' && idle > STALE_RUNNING_MS);
    if (!due) continue;
    if (r.status === 'running') {
      const recoveries = Number((r.params as Record<string, unknown>)['recoveries'] ?? 0);
      if (recoveries >= 3) { await setRun(db, r.id, now, { status: 'failed', error: 'The analysis stopped responding three times and was closed.', finishedAt: now }); continue; }
      await setRun(db, r.id, now, { status: 'queued', params: { ...r.params, recoveries: recoveries + 1 } });
    }
    await enqueueAiRun(svc.queue, r.orgId, r.id);
    queued.push(r.id);
  }
  const swept: string[] = [];
  const orgs = await db.select({ orgId: orgSettings.orgId }).from(orgSettings).where(eq(orgSettings.aiContinuous, true));
  for (const o of orgs) {
    if (rows.some((r) => r.orgId === o.orgId)) continue; // something is already open
    const [last] = await db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, o.orgId), eq(aiMatchRuns.kind, 'sweep'))).orderBy(desc(aiMatchRuns.createdAt)).limit(1);
    const since = last ? last.createdAt : new Date(0);
    const busy = await db.execute<{ n: number }>(sql`select count(*)::int as n from scan_runs where org_id = ${o.orgId} and status in ('queued','running')`);
    const done = await db.execute<{ at: Date | null }>(sql`select max(finished_at) as at from scan_runs where org_id = ${o.orgId} and status in ('succeeded','partial')`);
    const collected = done.rows[0]?.at ? new Date(done.rows[0].at) > since : false;
    const stale = now.getTime() - since.getTime() > 24 * 3_600_000;
    if ((busy.rows[0]?.n ?? 0) === 0 && (!last || collected || stale)) {
      const id = await startSweep(svc, o.orgId);
      if (id) swept.push(id);
    }
  }
  return { queued, swept };
}

// ───────────────────────────────────────────────────────────── reading suggestions

export interface AiSuggestionFilter {
  status?: AiSuggestionStatus | 'all';
  matchType?: AiMatchType;
  siteId?: string;
  sourceVariantId?: string;
  runId?: string;
  /** 'hide' (default): leave out pairs a person already decided in Match Review; 'only': show just those (to compare the AI with the person); 'all'. */
  decided?: 'hide' | 'only' | 'all';
  page: number;
  pageSize: number;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function productView(r: Row, p: 's' | 'c', dossier: AiDossier | undefined): AiProductView {
  return {
    variantId: String(r[`${p}VariantId`]), productId: String(r[`${p}ProductId`]), siteName: String(r[`${p}Site`] ?? ''), title: String(r[`${p}Title`] ?? ''), variantTitle: str(r[`${p}VariantTitle`]), brand: str(r[`${p}Brand`]),
    price: numOrNull(r[`${p}Price`]), currency: str(r[`${p}Currency`]), url: str(r[`${p}Url`]) ?? dossier?.url ?? null,
    productType: dossier?.productType ?? null, identifiers: dossier?.identifiers ?? {}, groups: dossier ? Object.fromEntries(Object.keys(dossier.attributes).map((k) => [k, factGroupOf(k)])) : {},
    attributes: dossier ? Object.fromEntries(Object.entries(dossier.attributes).map(([k, v]) => [k, { value: v.value, source: v.source }])) : {}, unknown: dossier?.unknown ?? [], domain: dossier?.domain ?? 'general',
  };
}

export async function listAiSuggestions(db: DbLike, orgId: string, f: AiSuggestionFilter): Promise<{ rows: AiSuggestionView[]; total: number }> {
  const w = [sql`s.org_id = ${orgId}`];
  if (f.status && f.status !== 'all') w.push(sql`s.status = ${f.status}`);
  if (f.matchType) w.push(sql`s.match_type = ${f.matchType}`);
  if (f.siteId) w.push(sql`s.competitor_site_id = ${f.siteId}::uuid`);
  if (f.sourceVariantId) w.push(sql`s.source_variant_id = ${f.sourceVariantId}::uuid`);
  if (f.runId) w.push(sql`s.run_id = ${f.runId}::uuid`);
  const decided = sql`(m.status in ('accepted','rejected') and m.decided_by is not null)`;
  if ((f.decided ?? 'hide') === 'hide') w.push(sql`not coalesce(${decided}, false)`);
  else if (f.decided === 'only') w.push(sql`coalesce(${decided}, false)`);
  const where = sql.join(w, sql` and `);
  const limit = Math.min(Math.max(1, f.pageSize), 100);
  const offset = Math.max(0, (f.page - 1) * limit);
  const from = sql`
    from ai_match_suggestions s
    join variants vs on vs.id = s.source_variant_id join products ps on ps.id = vs.product_id join sites ss on ss.id = ps.site_id
    join variants vc on vc.id = s.competitor_variant_id join products pc on pc.id = vc.product_id join sites sc on sc.id = pc.site_id
    left join product_matches m on m.source_variant_id = s.source_variant_id and m.competitor_variant_id = s.competitor_variant_id`;
  const rows = await db.execute<Row>(sql`
    select s.*, s.id as "id", s.source_variant_id as "sVariantId", s.competitor_variant_id as "cVariantId", ps.id as "sProductId", pc.id as "cProductId",
           ps.title as "sTitle", vs.title as "sVariantTitle", ps.brand as "sBrand", vs.price as "sPrice", vs.currency as "sCurrency", vs.url as "sUrl", ss.name as "sSite",
           pc.title as "cTitle", vc.title as "cVariantTitle", pc.brand as "cBrand", vc.price as "cPrice", vc.currency as "cCurrency", vc.url as "cUrl", sc.name as "cSite",
           m.id as "mId", m.status as "mStatus", coalesce(m.relationship, case m.match_class when 'identical' then 'exact' when 'different_pack' then 'variant' when 'comparable' then 'substitute' else 'non_match' end) as "mRelationship"
    ${from}
    where ${where}
    order by ps.title, s.source_variant_id, (case s.match_type when 'exact_item' then 0 when 'same_product_different_pack' then 1 when 'close_equivalent' then 2 when 'substitute' then 3 when 'related' then 4 else 5 end), sc.name
    limit ${limit} offset ${offset}`);
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n ${from} where ${where}`);
  const variantIds = [...new Set(rows.rows.flatMap((r) => [String(r['sVariantId']), String(r['cVariantId'])]))];
  const dossierRows = variantIds.length ? await db.select().from(aiDossiers).where(and(eq(aiDossiers.orgId, orgId), inArray(aiDossiers.variantId, variantIds))) : [];
  const dossiers = new Map(dossierRows.map((d) => [d.variantId, d.dossier as unknown as AiDossier]));
  const by = (id: unknown) => (id ? str(id) : null);
  const reviewerIds = [...new Set(rows.rows.map((r) => by(r['reviewed_by'])).filter((x): x is string => !!x))];
  const names = reviewerIds.length ? await db.execute<{ id: string; name: string }>(sql`select id, display_name as name from users where id in (${uuidList(reviewerIds)})`) : { rows: [] };
  const nameOf = new Map(names.rows.map((u) => [u.id, u.name]));
  return {
    total: Number(total.rows[0]?.n ?? 0),
    rows: rows.rows.map((r): AiSuggestionView => ({
      id: String(r['id']),
      status: r['status'] as AiSuggestionStatus,
      matchType: r['match_type'] as AiMatchType,
      aiMatchType: r['ai_match_type'] as AiMatchType,
      confidence: r['confidence'] as AiConfidence,
      priceComparable: Boolean(r['price_comparable']),
      requiresReview: Boolean(r['requires_review']),
      explanation: String(r['explanation']),
      supporting: (r['supporting'] as AiSuggestionView['supporting']) ?? [],
      conflicting: (r['conflicting'] as AiSuggestionView['conflicting']) ?? [],
      missing: (r['missing'] as string[]) ?? [],
      guards: (r['guards'] as AiSuggestionView['guards']) ?? [],
      foundBy: (r['found_by'] as AiSuggestionView['foundBy']) ?? [],
      engine: (r['engine'] as AiEngineReading | null) ?? null,
      policy: (r['policy'] as AiPolicyReading) ?? { quantity: null, bundle: null },
      source: productView(r, 's', dossiers.get(String(r['sVariantId']))),
      candidate: productView(r, 'c', dossiers.get(String(r['cVariantId']))),
      existingMatch: r['mId'] ? { id: String(r['mId']), status: String(r['mStatus']), relationship: str(r['mRelationship']) } : null,
      model: String(r['model']),
      promptVersion: String(r['prompt_version']),
      analysedAt: new Date(r['analysed_at'] as Date | string).toISOString(),
      review: r['reviewed_at'] ? { by: nameOf.get(by(r['reviewed_by']) ?? '') ?? null, at: new Date(r['reviewed_at'] as Date | string).toISOString(), relationship: str(r['review_relationship']), note: str(r['review_note']) } : null,
    })),
  };
}

// ───────────────────────────────────────────────────────────── a person reviews a suggestion

/**
 * Accept / Change / Uncertain / None of these / Find another product. Accept and Change record a HUMAN decision through the existing functions (an existing pair is decided with
 * `decideMatch`, a new one is recorded with `setManualMatch`), so the quantity and bundle policies apply exactly as for any person's decision and the other suggestions stay waiting.
 * The suggestion itself only records what the person did; the AI's answer is kept as it was.
 */
export async function reviewAiSuggestion(db: DbLike, orgId: string, userId: string, id: string, req: AiReviewRequest, now: Date): Promise<{ suggestionId: string; status: AiSuggestionStatus; matchId: string | null; affected: number }> {
  const [s] = await db.select().from(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.id, id), eq(aiMatchSuggestions.orgId, orgId)));
  if (!s) throw new MatchError('Suggestion not found');
  const note = req.note?.trim() || null;
  let matchId: string | null = null;
  let status: AiSuggestionStatus;
  let relationship: DecidableRelationship | null = null;
  let chosen: string | null = null;
  let affected = 1;

  const decide = async (competitorVariantId: string, rel: DecidableRelationship, how: string): Promise<string> => {
    const decisionNote = `${how}${note ? `: ${note}` : ''}`.slice(0, 500);
    const [m] = await db.select({ id: productMatches.id }).from(productMatches).where(and(eq(productMatches.orgId, orgId), eq(productMatches.sourceVariantId, s.sourceVariantId), eq(productMatches.competitorVariantId, competitorVariantId)));
    if (m) {
      await decideMatch(db, orgId, m.id, userId, { decision: 'reclassify', relationship: rel, note: decisionNote }, now);
      return m.id;
    }
    return (await setManualMatch(db, orgId, userId, { sourceVariantId: s.sourceVariantId, competitorVariantId, relationship: rel, note: decisionNote, keepOthers: true }, now)).match.id;
  };

  if (req.action === 'accept') {
    const rel = AI_TYPE_TO_RELATIONSHIP[s.matchType];
    if (!rel) throw new MatchError('The AI did not find a match here. Use "Change" to say what the products are, or "None of these".', 400);
    relationship = rel;
    matchId = await decide(s.competitorVariantId, rel, `Accepted an AI suggestion (${AI_TYPE_LABEL[s.matchType]})`);
    status = 'accepted';
  } else if (req.action === 'change') {
    if (!req.relationship) throw new MatchError('Choose what these products are.', 400);
    relationship = req.relationship;
    matchId = await decide(s.competitorVariantId, req.relationship, `Changed an AI suggestion (${AI_TYPE_LABEL[s.matchType]})`);
    status = 'changed';
  } else if (req.action === 'choose_other') {
    if (!req.competitorVariantId || !req.relationship) throw new MatchError('Choose the competitor product and what the two products are.', 400);
    relationship = req.relationship;
    chosen = req.competitorVariantId;
    matchId = await decide(req.competitorVariantId, req.relationship, `Chose another product instead of an AI suggestion (${AI_TYPE_LABEL[s.matchType]})`);
    status = 'changed';
  } else if (req.action === 'reject') {
    // the person says these two products are NOT a match: recorded as their own rejection (never suggested again)
    matchId = await rejectPair(db, orgId, userId, { sourceVariantId: s.sourceVariantId, competitorVariantId: s.competitorVariantId, note: `Rejected an AI suggestion (${AI_TYPE_LABEL[s.matchType]})${note ? `: ${note}` : ''}`.slice(0, 500) }, now);
    status = 'rejected';
  } else if (req.action === 'uncertain') {
    status = 'uncertain';
  } else {
    // none of the suggested products is right for this product: every waiting suggestion for it is closed together
    status = 'none_of_these';
    const rows = await db.update(aiMatchSuggestions).set({ status, reviewedBy: userId, reviewedAt: now, reviewNote: note, updatedAt: now }).where(and(eq(aiMatchSuggestions.orgId, orgId), eq(aiMatchSuggestions.sourceVariantId, s.sourceVariantId), eq(aiMatchSuggestions.status, 'pending'))).returning({ id: aiMatchSuggestions.id, competitorVariantId: aiMatchSuggestions.competitorVariantId, matchType: aiMatchSuggestions.matchType, confidence: aiMatchSuggestions.confidence });
    affected = rows.length;
    if (rows.length) {
      await db.insert(aiMatchFeedback).values(rows.map((r) => ({ orgId, suggestionId: r.id, sourceVariantId: s.sourceVariantId, competitorVariantId: r.competitorVariantId, action: 'none_of_these' as const, aiMatchType: r.matchType, aiConfidence: r.confidence, note, model: s.model, promptVersion: s.promptVersion, userId })));
    }
  }

  if (req.action !== 'none_of_these') {
    await db.update(aiMatchSuggestions).set({ status, reviewedBy: userId, reviewedAt: now, reviewRelationship: relationship, reviewNote: note, updatedAt: now }).where(eq(aiMatchSuggestions.id, s.id));
    await db.insert(aiMatchFeedback).values({ orgId, suggestionId: s.id, sourceVariantId: s.sourceVariantId, competitorVariantId: chosen ?? s.competitorVariantId, action: req.action, aiMatchType: s.matchType, aiConfidence: s.confidence, relationship, chosenVariantId: chosen, matchId, note, model: s.model, promptVersion: s.promptVersion, userId });
  }
  await db.insert(auditEvents).values({ orgId, userId, action: `ai_match.${req.action}`, target: s.id, meta: { aiType: s.matchType, relationship, matchId, affected } });
  return { suggestionId: s.id, status, matchId, affected };
}
