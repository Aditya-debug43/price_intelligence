import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AI_DOSSIER_VERSION,
  AI_PROMPT_VERSION,
  AI_SYSTEM_PROMPT,
  AiLimiter,
  DEFAULT_BATCH_LIMITS,
  analyseCatalogue,
  applyGuards,
  autoClassOf,
  CLASS_RELATIONSHIP,
  buildAiDossier,
  buildRetrievalIndex,
  extractSpecTable,
  factGroupOf,
  groundingText,
  hashText,
  pacificDay,
  planBatches,
  retrieveShortlist,
  toWire,
  type AiCandidate,
  type AiDecision,
  type AiDossier,
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
import { aiDossiers, aiMatchFeedback, aiMatchRuns, aiMatchSuggestions, aiQuotaState, aiUsageDaily, auditEvents, productMatches, type DbLike } from '@ci/database';
import type { Services, JobQueue } from './context.ts';
import { askRequest, pairKey, type AskDeps, type UsageEvent } from './ai-gemini.ts';
import { withHeavyWork } from './heavy.ts';
import { autoApprovePair, enabledAutoClasses } from './match-eval.ts';
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
    configured: !!config.GEMINI_API_KEY,
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

/** One limiter per process and per set of ceilings, shared by every workspace's runs: the API key (and so Google's quota) is shared too. */
const limiters = new Map<string, AiLimiter>();
/** The limiter reads time through this, set by each job from its services (the clock tests move), so the limiter and the rest of the job always agree about "now". */
let aiClock: () => Date = () => new Date();
const charsPerTokenState = { charsPerToken: DEFAULT_BATCH_LIMITS.charsPerToken };

function limiterFor(s: AiSettings): AiLimiter {
  const key = `${s.model}|${s.rpm}|${s.tpm}|${s.dailyRequests}|${s.maxConcurrency}`;
  let l = limiters.get(key);
  if (!l) {
    l = new AiLimiter({ rpm: s.rpm, tpm: s.tpm, dailyRequests: s.dailyRequests, maxConcurrency: s.maxConcurrency }, () => aiClock().getTime());
    limiters.set(key, l);
  }
  return l;
}

/** The shared truth (the database) is loaded into the limiter before a run works: what was used today, what Google taught us, a pause or a stop. */
async function hydrateLimiter(db: DbLike, l: AiLimiter, model: string, now: Date): Promise<void> {
  const day = pacificDay(now.getTime());
  const [usage] = await db.select({ n: aiUsageDaily.requests }).from(aiUsageDaily).where(and(eq(aiUsageDaily.day, day), eq(aiUsageDaily.model, model)));
  l.setToday(day, usage?.n ?? 0);
  const [st] = await db.select().from(aiQuotaState).where(eq(aiQuotaState.model, model));
  l.restore({
    learned: { ...(st?.learnedRpm ? { rpm: st.learnedRpm } : {}), ...(st?.learnedRpd ? { rpd: st.learnedRpd } : {}), ...(st?.learnedTpm ? { tpm: st.learnedTpm } : {}) },
    pausedUntil: st?.pausedUntil?.getTime() ?? null,
    pauseReason: st?.pauseReason ?? null,
    stopped: st?.stopped ?? null,
  });
}

async function saveLimiterState(db: DbLike, l: AiLimiter, model: string, now: Date): Promise<void> {
  const s = l.snapshot();
  const values = {
    model,
    learnedRpm: s.learned.rpm ?? null,
    learnedRpd: s.learned.rpd ?? null,
    learnedTpm: s.learned.tpm ?? null,
    pausedUntil: s.pausedUntil ? new Date(s.pausedUntil) : null,
    pauseReason: s.pauseReason,
    stopped: s.stopped,
    updatedAt: now,
  };
  await db.insert(aiQuotaState).values(values).onConflictDoUpdate({ target: aiQuotaState.model, set: values });
}

async function addUsage(db: DbLike, model: string, now: Date, d: Partial<Omit<AiRunUsage, 'candidatesAnswered'>> & { candidatesAnswered?: number }): Promise<void> {
  const day = pacificDay(now.getTime());
  const inc = {
    requests: d.requests ?? 0, successes: d.successes ?? 0, failures: d.failures ?? 0, rateLimited: d.rateLimited ?? 0, inputTokens: d.inputTokens ?? 0, outputTokens: d.outputTokens ?? 0,
    thoughtTokens: d.thoughtTokens ?? 0, cachedResults: d.cachedResults ?? 0, candidatesAnswered: d.candidatesAnswered ?? 0, ms: Math.round(d.ms ?? 0),
  };
  await db
    .insert(aiUsageDaily)
    .values({ day, model, ...inc, updatedAt: now })
    .onConflictDoUpdate({
      target: [aiUsageDaily.day, aiUsageDaily.model],
      set: {
        requests: sql`${aiUsageDaily.requests} + ${inc.requests}`, successes: sql`${aiUsageDaily.successes} + ${inc.successes}`, failures: sql`${aiUsageDaily.failures} + ${inc.failures}`,
        rateLimited: sql`${aiUsageDaily.rateLimited} + ${inc.rateLimited}`, inputTokens: sql`${aiUsageDaily.inputTokens} + ${inc.inputTokens}`, outputTokens: sql`${aiUsageDaily.outputTokens} + ${inc.outputTokens}`,
        thoughtTokens: sql`${aiUsageDaily.thoughtTokens} + ${inc.thoughtTokens}`, cachedResults: sql`${aiUsageDaily.cachedResults} + ${inc.cachedResults}`,
        candidatesAnswered: sql`${aiUsageDaily.candidatesAnswered} + ${inc.candidatesAnswered}`, ms: sql`${aiUsageDaily.ms} + ${inc.ms}`, updatedAt: now,
      },
    });
}

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

/** What the admin page shows: the setup, today's use, the limits Shelfwatch applies and what Google's own answers taught it. Google does not expose the remaining quota, so none is claimed. */
export async function aiStatus(db: DbLike, config: AppConfig, orgId: string, now: Date): Promise<AiStatusView> {
  const s = aiSettings(config);
  const day = pacificDay(now.getTime());
  const [usage] = await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.day, day), eq(aiUsageDaily.model, s.model)));
  const [st] = await db.select().from(aiQuotaState).where(eq(aiQuotaState.model, s.model));
  const [active] = await db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, orgId), inArray(aiMatchRuns.status, ['queued', 'running', 'paused']))).orderBy(desc(aiMatchRuns.createdAt)).limit(1);
  const counts = await db.select({ status: aiMatchSuggestions.status, n: sql<number>`count(*)::int` }).from(aiMatchSuggestions).where(eq(aiMatchSuggestions.orgId, orgId)).groupBy(aiMatchSuggestions.status);
  const n = (k: AiSuggestionStatus) => counts.find((c) => c.status === k)?.n ?? 0;
  const total = counts.reduce((a, c) => a + c.n, 0);
  const pausedUntil = st?.pausedUntil && st.pausedUntil > now ? st.pausedUntil : null;
  const state: AiStatusView['state'] = !s.configured ? 'not_configured' : st?.stopped ? 'stopped' : pausedUntil ? 'paused' : active?.status === 'running' ? 'running' : 'idle';
  return {
    configured: s.configured,
    model: s.model,
    limits: { rpm: s.rpm, tpm: s.tpm, dailyBudget: s.dailyRequests, learned: { ...(st?.learnedRpm ? { rpm: st.learnedRpm } : {}), ...(st?.learnedRpd ? { rpd: st.learnedRpd } : {}), ...(st?.learnedTpm ? { tpm: st.learnedTpm } : {}) } },
    today: { day, requests: usage?.requests ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, failures: usage?.failures ?? 0, rateLimited: usage?.rateLimited ?? 0, cachedResults: usage?.cachedResults ?? 0 },
    state,
    pausedUntil: iso(pausedUntil),
    pauseReason: pausedUntil ? (st?.pauseReason ?? null) : null,
    stopped: st?.stopped ?? null,
    activeRun: active ? runView(active) : null,
    counts: { pending: n('pending'), accepted: n('accepted'), changed: n('changed'), uncertain: n('uncertain'), noneOfThese: n('none_of_these'), total },
    note: s.configured
      ? 'Gemini’s free tier is used and nothing is ever sent to a paid tier. Google does not tell us how much of its quota is left: the figures here are what Shelfwatch itself has sent, and the limits Google’s own answers revealed.'
      : 'No Gemini API key is configured on the server. Everything else in Shelfwatch works without it.',
  };
}

/** A person clears a stop or a pause after fixing the cause (a new key, the right model). */
export async function resumeGemini(db: DbLike, config: AppConfig, userId: string, orgId: string, now: Date): Promise<void> {
  const s = aiSettings(config);
  await db.update(aiQuotaState).set({ stopped: null, pausedUntil: null, pauseReason: null, updatedAt: now }).where(eq(aiQuotaState.model, s.model));
  await db.insert(auditEvents).values({ orgId, userId, action: 'ai_match.resume_gemini', target: s.model, meta: {} });
}

// ───────────────────────────────────────────────────────────── choosing what to analyse

const uuidList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const SOURCE_FILTER = sql`ss.active and ss.role = 'source' and ps.delisted_at is null`;
/** Within a list, products of different categories first (a spread, not fifty bulbs), then a fixed pseudo-random order: the same request always picks the same products. */
const SPREAD = sql`row_number() over (partition by coalesce(pr.category, '') order by md5(p.id::text)), md5(p.id::text)`;

async function pickFromBucket(db: DbLike, orgId: string, bucket: MatchBucket, limit: number, fresh: boolean): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with picked as (
      select distinct m.source_variant_id as id from product_matches m
      join variants vs on vs.id = m.source_variant_id join products ps on ps.id = vs.product_id join sites ss on ss.id = ps.site_id
      where m.org_id = ${orgId} and ${SOURCE_FILTER} and ${BUCKET_SQL[bucket]}
    )
    select p.id from picked p join variants v on v.id = p.id join products pr on pr.id = v.product_id
    ${fresh ? sql`where not exists (select 1 from ai_match_suggestions a where a.source_variant_id = p.id)` : sql``}
    order by ${SPREAD} limit ${limit}`);
  return rows.rows.map((r) => r.id);
}

/** Source variants with no pair at all in Match Review (the engine found no counterpart). */
async function pickUnmatched(db: DbLike, orgId: string, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with picked as (
      select v.id from variants v join products ps on ps.id = v.product_id join sites ss on ss.id = ps.site_id
      where v.org_id = ${orgId} and ${SOURCE_FILTER}
        and not exists (select 1 from product_matches m where m.source_variant_id = v.id)
        and not exists (select 1 from ai_match_suggestions a where a.source_variant_id = v.id)
    )
    select p.id from picked p join variants v on v.id = p.id join products pr on pr.id = v.product_id order by ${SPREAD} limit ${limit}`);
  return rows.rows.map((r) => r.id);
}

const SAMPLE_BUCKETS: MatchBucket[] = ['review', 'substitutes', 'unclear', 'confirmed', 'rejected', 'set_aside'];

/** A spread over every kind of Match Review row (waiting, stand-ins, unclear, confirmed, rejected, set aside) and over products the engine found nothing for. */
export async function selectSources(db: DbLike, orgId: string, req: AiRunRequest): Promise<string[]> {
  if (req.scope === 'products') {
    const ids = [...new Set(req.variantIds ?? [])];
    if (!ids.length) return [];
    const rows = await db.execute<{ id: string }>(sql`select v.id from variants v join products ps on ps.id = v.product_id join sites ss on ss.id = ps.site_id where v.org_id = ${orgId} and ${SOURCE_FILTER} and v.id in (${uuidList(ids)})`);
    const ok = new Set(rows.rows.map((r) => r.id));
    return ids.filter((i) => ok.has(i));
  }
  if (req.scope === 'unmatched') return pickUnmatched(db, orgId, req.limit);
  const lists: string[][] = [];
  for (const b of SAMPLE_BUCKETS) lists.push(await pickFromBucket(db, orgId, b, req.limit, true));
  lists.push(await pickUnmatched(db, orgId, req.limit));
  // a bucket with nothing new falls back to products already analysed (the analysis is cached, so they cost nothing)
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < req.limit && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < req.limit && !seen.has(l[i]!)) { seen.add(l[i]!); out.push(l[i]!); }
  return out;
}

export async function createAiRun(db: DbLike, config: AppConfig, orgId: string, userId: string, input: unknown): Promise<{ run: AiRunView; selected: number }> {
  const s = aiSettings(config);
  if (!s.configured) throw new MatchError('No Gemini API key is configured on the server, so AI analysis cannot start. Everything else works without it.', 409);
  const req = aiRunSchema.parse(input);
  const [open] = await db.select({ id: aiMatchRuns.id }).from(aiMatchRuns).where(and(eq(aiMatchRuns.orgId, orgId), inArray(aiMatchRuns.status, ['queued', 'running', 'paused']))).limit(1);
  if (open) throw new MatchError('An analysis is already in progress. Pause or cancel it before starting another.', 409);
  const sourceIds = await selectSources(db, orgId, req);
  if (!sourceIds.length) throw new MatchError('There are no products to analyse for this choice (nothing left that has not been analysed, or no matching products).', 400);
  const [row] = await db
    .insert(aiMatchRuns)
    .values({ orgId, kind: req.scope, status: 'queued', model: s.model, promptVersion: AI_PROMPT_VERSION, params: req, sourceIds, progress: { ...ZERO_PROGRESS, sources: sourceIds.length }, usage: ZERO_USAGE, createdBy: userId })
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

export /** The specification lines a product page states (read by `extractSpecTable`): only products whose description has such lines are returned, and only the first part of the text. */
async function loadSpecTexts(db: DbLike, orgId: string): Promise<Map<string, PageSpecFact[]>> {
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

/** Everything the answer depends on. An unchanged pair (same facts, same checks, same model and instructions) is never sent again. */
function inputHashOf(model: string, aiS: AiDossier, aiC: AiDossier, c: AiCandidate, chk: PairCtx['chk']): string {
  const material = [model, AI_PROMPT_VERSION, hashText(AI_SYSTEM_PROMPT), aiS.fingerprint, aiC.fingerprint, chk.q, chk.b ?? '-', c.engine?.relationship ?? '-', c.engine?.conflicts.length ?? 0].join('|');
  return hashText(material) + hashText(material, 7);
}

type WindowOutcome = { kind: 'complete' } | { kind: 'blocked'; reason: string; resumeAt: number } | { kind: 'stopped' } | { kind: 'failed'; errorKind: string; message: string };

async function setRun(db: DbLike, runId: string, now: Date, set: Partial<typeof aiMatchRuns.$inferInsert>): Promise<void> {
  await db.update(aiMatchRuns).set({ ...set, updatedAt: now }).where(eq(aiMatchRuns.id, runId));
}

/** The job: works through a run in windows of a few products until it finishes, is paused, runs into a quota, or has used its time slice (then it queues itself again). */
export async function processAiRun(svc: Services, orgId: string, runId: string): Promise<{ outcome: string }> {
  const db = svc.db as DbLike;
  const s = aiSettings(svc.config);
  const now = () => svc.clock();
  aiClock = now;
  const [run0] = await db.select().from(aiMatchRuns).where(and(eq(aiMatchRuns.id, runId), eq(aiMatchRuns.orgId, orgId)));
  if (!run0) return { outcome: 'not_found' };
  if (run0.status === 'completed' || run0.status === 'failed' || run0.status === 'cancelled') return { outcome: run0.status };
  if (run0.status === 'paused' && (!run0.resumeAt || run0.resumeAt > now())) return { outcome: 'paused' };
  if (!s.configured) {
    await setRun(db, runId, now(), { status: 'paused', pauseReason: 'No Gemini API key is configured on the server.', resumeAt: null });
    return { outcome: 'not_configured' };
  }
  const limiter = limiterFor(s);
  await hydrateLimiter(db, limiter, s.model, now());
  const snap = limiter.snapshot();
  if (snap.stopped) {
    await setRun(db, runId, now(), { status: 'paused', pauseReason: snap.stopped, resumeAt: null });
    return { outcome: 'stopped' };
  }
  if (snap.pausedUntil && snap.pausedUntil > now().getTime()) {
    await setRun(db, runId, now(), { status: 'paused', pauseReason: pauseText(snap.pauseReason), resumeAt: new Date(snap.pausedUntil) });
    await enqueueAiRun(svc.queue, orgId, runId, (snap.pausedUntil - now().getTime()) / 1000);
    return { outcome: 'waiting' };
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
      const ids = run0.sourceIds.slice(cursor, cursor + WINDOW_SOURCES);
      const outcome = await runWindow(svc, db, orgId, runId, ids, ctx, params.perSite, s, limiter, usage, progress);
      await saveLimiterState(db, limiter, s.model, now());
      if (outcome.kind === 'complete') {
        cursor += ids.length;
        await persist();
        continue;
      }
      if (outcome.kind === 'blocked') {
        await persist({ status: 'paused', pauseReason: pauseText(outcome.reason), resumeAt: new Date(outcome.resumeAt) });
        await enqueueAiRun(svc.queue, orgId, runId, (outcome.resumeAt - now().getTime()) / 1000);
        svc.log.info('ai analysis paused for quota', { orgId, runId, reason: outcome.reason });
        return { outcome: 'blocked' };
      }
      if (outcome.kind === 'stopped') return { outcome: 'stopped_by_person' };
      // a permanent problem: processing stops until a person fixes the cause (key, model) or, for a bad request, the run fails
      if (STOP_KINDS.has(outcome.errorKind)) {
        await db.insert(aiQuotaState).values({ model: s.model, stopped: outcome.message, updatedAt: now() }).onConflictDoUpdate({ target: aiQuotaState.model, set: { stopped: outcome.message, updatedAt: now() } });
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

const pauseText = (reason: string | null | undefined): string =>
  reason === 'daily' ? 'The daily quota is used up. Analysis continues after the quota resets (midnight Pacific Time).'
    : reason === 'rate' || reason === 'rpm' || reason === 'tpm' ? 'Waiting for the per-minute limit to clear.'
    : reason === 'backoff' || reason === 'paused' ? 'Google is busy or slow; trying again shortly.'
    : 'Waiting for the quota.';

async function runWindow(
  svc: Services,
  db: DbLike,
  orgId: string,
  runId: string,
  ids: string[],
  ctx: Ctx,
  perSite: number,
  s: AiSettings,
  limiter: AiLimiter,
  usage: AiRunUsage,
  progress: typeof ZERO_PROGRESS,
): Promise<WindowOutcome> {
  const now = () => svc.clock();
  const sources = ids.filter((id) => ctx.sources.has(id) && ctx.corpus.byVariant.has(id));
  if (!sources.length) return { kind: 'complete' };

  // shortlists: several diverse candidates per competitor website, found by many local methods
  const shortlists = new Map<string, AiCandidate[]>();
  for (const sv of sources) shortlists.set(sv, retrieveShortlist(ctx.index, ctx.corpus.byVariant.get(sv)!, { perSiteProducts: perSite }, await semanticFor(ctx, sv)));
  const involved = [...new Set([...sources, ...[...shortlists.values()].flatMap((l) => l.map((c) => c.variantId))])];
  const urlRows = await db.execute<{ id: string; url: string | null }>(sql`select id, url from variants where id in (${uuidList(involved)})`);
  for (const r of urlRows.rows) ctx.urls.set(r.id, r.url);
  for (const id of involved) ctx.dossiers.delete(id); // rebuilt with the page address

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
      pairs.set(key, { key, sv, cv: c.variantId, siteId: c.siteId, src: srcD, cand: candD, aiS, aiC, c, inputHash: inputHashOf(s.model, aiS, aiC, c, chk), chk });
    }
  }
  progress.candidates += pairs.size;

  const existingRows = await db
    .select({ id: aiMatchSuggestions.id, sv: aiMatchSuggestions.sourceVariantId, cv: aiMatchSuggestions.competitorVariantId, inputHash: aiMatchSuggestions.inputHash, status: aiMatchSuggestions.status, matchType: aiMatchSuggestions.matchType })
    .from(aiMatchSuggestions)
    .where(and(eq(aiMatchSuggestions.orgId, orgId), inArray(aiMatchSuggestions.sourceVariantId, sources)));
  const existing = new Map(existingRows.map((r) => [pairKey(r.sv, r.cv), r]));
  const todo = [...pairs.values()].filter((p) => existing.get(p.key)?.inputHash !== p.inputHash);
  const cached = pairs.size - todo.length;
  usage.cachedResults += cached;
  progress.cachedResults += cached;
  if (cached) await addUsage(db, s.model, now(), { cachedResults: cached });
  const enabledAuto = await enabledAutoClasses(db, orgId);
  await storeDossiers(db, orgId, todo.flatMap((p) => [p.aiS, p.aiC]));
  if (!todo.length) return { kind: 'complete' };

  const groups: PayloadGroup[] = sources
    .map((sv) => ({ ref: sv, source: toWire(aiDossierOf(ctx, sv)), candidates: todo.filter((p) => p.sv === sv).map((p) => ({ id: '', ref: p.cv, wire: toWire(p.aiC), chk: p.chk })) }))
    .filter((g) => g.candidates.length);
  const plan = planBatches(groups, { ...DEFAULT_BATCH_LIMITS, maxCandidates: s.batchCandidates, maxInputTokens: s.maxInputTokens, maxOutputTokens: s.maxOutputTokens, charsPerToken: charsPerTokenState.charsPerToken });

  let outcome: WindowOutcome = { kind: 'complete' };
  let next = 0;
  const deps: AskDeps = {
    cfg: { apiKey: svc.config.GEMINI_API_KEY, model: s.model, maxOutputTokens: s.maxOutputTokens, timeoutMs: s.timeoutMs, maxWaitMs: 90_000 },
    limiter,
    ...(svc.geminiHttp ? { http: svc.geminiHttp } : {}),
    sleep: svc.aiSleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: () => svc.clock().getTime(),
    tokens: charsPerTokenState,
    shouldStop: async () => outcome.kind !== 'complete' || (await db.select({ status: aiMatchRuns.status }).from(aiMatchRuns).where(eq(aiMatchRuns.id, runId)))[0]?.status !== 'running',
    onRequest: async (e: UsageEvent) => {
      const limited = e.errorKind === 'quota_minute' || e.errorKind === 'quota_day' || e.errorKind === 'quota_tokens';
      const d = { requests: 1, successes: e.ok ? 1 : 0, failures: e.ok ? 0 : 1, rateLimited: limited ? 1 : 0, inputTokens: e.usage?.promptTokens ?? 0, outputTokens: e.usage?.outputTokens ?? 0, thoughtTokens: e.usage?.thoughtsTokens ?? 0, ms: e.ms };
      usage.requests += d.requests; usage.successes += d.successes; usage.failures += d.failures; usage.rateLimited += d.rateLimited;
      usage.inputTokens += d.inputTokens; usage.outputTokens += d.outputTokens; usage.thoughtTokens += d.thoughtTokens; usage.ms += d.ms;
      await addUsage(db, s.model, now(), d);
    },
  };

  const worker = async () => {
    for (;;) {
      if (outcome.kind !== 'complete') return;
      const req: PlannedRequest | undefined = plan[next++];
      if (!req) return;
      const res = await askRequest(req, deps);
      const got = res.status === 'done' ? res.decisions : res.partial;
      const saved = await saveDecisions(db, orgId, runId, s, got, pairs, existing, enabledAuto, now());
      usage.candidatesAnswered += saved;
      progress.answered += saved;
      if (saved) await addUsage(db, s.model, now(), { candidatesAnswered: saved });
      await saveLimiterState(db, limiter, s.model, now());
      if (res.status === 'blocked') outcome = { kind: 'blocked', reason: res.reason, resumeAt: res.resumeAt };
      else if (res.status === 'stopped') outcome = { kind: 'stopped' };
      else if (res.status === 'failed') outcome = { kind: 'failed', errorKind: res.error.kind, message: res.error.message };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limiter.concurrency, plan.length)) }, () => worker()));
  return outcome;
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

/** Applies the safeguards to each answer and stores it. One row per pair: an existing row is updated, never duplicated, and a person's review of it is kept unless the AI changed its answer. */
async function saveDecisions(
  db: DbLike,
  orgId: string,
  runId: string,
  s: AiSettings,
  got: Map<string, AiDecision>,
  pairs: Map<string, PairCtx>,
  existing: Map<string, { id: string; status: AiSuggestionStatus; matchType: AiMatchType }>,
  enabledAuto: Set<string>,
  now: Date,
): Promise<number> {
  let saved = 0;
  for (const [key, decision] of got) {
    const p = pairs.get(key);
    if (!p) continue;
    const eng = p.c.engine;
    const g = applyGuards(decision, {
      engine: eng ? { relationship: eng.relationship, conflicts: eng.conflicts } : null,
      quantity: eng?.quantity ?? null,
      bundle: eng?.bundle ?? null,
      sourceBrandKey: p.src.brand.key,
      candidateBrandKey: p.cand.brand.key,
      gtinEqual: !!p.src.identifiers.gtin && !!p.cand.identifiers.gtin && p.src.identifiers.gtin.value === p.cand.identifiers.gtin.value,
      gtinDiffer: !!p.src.identifiers.gtin && !!p.cand.identifiers.gtin && p.src.identifiers.gtin.value !== p.cand.identifiers.gtin.value,
      codesAgree: !!eng?.evidence.items.some((i) => i.kind === 'identity_code' && i.effect === 'supports'),
      domain: p.aiS.domain,
      sourceFacts: groundingText(p.aiS),
      candidateFacts: groundingText(p.aiC),
    });
    const engine: AiEngineReading | null = eng ? { relationship: eng.relationship, tier: eng.tier, conflicts: eng.conflicts.slice(0, 4), summary: eng.evidence.summary } : null;
    const policy: AiPolicyReading = {
      quantity: eng ? { verdict: eng.quantity.verdict as 'same' | 'different' | 'unknown', note: eng.quantity.note } : null,
      bundle: eng?.bundle ? { verdict: eng.bundle.verdict, note: eng.bundle.note } : null,
    };
    // which class of automatic approval the deterministic conditions qualify this answer for: recorded for EVERY answer so a class can be measured before it is ever used
    const autoClass = autoClassOf({
      matchType: g.match_type, confidence: g.confidence_level, guardCodes: g.guards.map((x) => x.code), domain: p.aiS.domain,
      gtinEqual: !!p.src.identifiers.gtin && !!p.cand.identifiers.gtin && p.src.identifiers.gtin.value === p.cand.identifiers.gtin.value,
      sameBrand: !!p.src.brand.key && p.src.brand.key === p.cand.brand.key, mpnEqual: !!p.src.identifiers.mpn && p.src.identifiers.mpn.value === p.cand.identifiers.mpn?.value,
      codesAgree: !!eng?.evidence.items.some((i) => i.kind === 'identity_code' && i.effect === 'supports'),
      quantity: (eng?.quantity.verdict ?? 'unknown') as 'same' | 'different' | 'unknown', bundle: eng?.bundle?.verdict ?? null, engine: eng ? { relationship: eng.relationship, conflicts: eng.conflicts } : null, decidedByPerson: false,
    });
    const before = existing.get(key);
    const keepReview = !!before && before.status !== 'pending' && before.matchType === g.match_type;
    const values = {
      orgId, runId, sourceVariantId: p.sv, competitorVariantId: p.cv, competitorSiteId: p.siteId,
      matchType: g.match_type, aiMatchType: g.ai_match_type, confidence: g.confidence_level as AiConfidence, aiConfidence: g.ai_confidence_level as AiConfidence,
      priceComparable: g.price_comparable, requiresReview: g.requires_human_review, explanation: g.explanation,
      supporting: g.supporting_evidence, conflicting: g.conflicting_evidence, missing: g.missing_evidence, guards: g.guards,
      foundBy: p.c.foundBy.map((f) => ({ method: f.method, rank: f.rank, detail: f.detail })), engine, policy,
      autoClass, inputHash: p.inputHash, sourceFingerprint: p.aiS.fingerprint, candidateFingerprint: p.aiC.fingerprint, model: s.model, promptVersion: AI_PROMPT_VERSION,
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
    // a class a person switched on after it passed the measured gate: the pair is confirmed by the system (reversible, audited), and only if no person has decided it
    if (autoClass && enabledAuto.has(`${p.aiS.domain}:${autoClass}`)) {
      const done = await autoApprovePair(db, orgId, { sourceVariantId: p.sv, competitorVariantId: p.cv, competitorSiteId: p.siteId, autoClass, quantity: eng?.quantity ?? null, bundle: eng?.bundle ?? null }, now);
      if (done === 'approved') await db.update(aiMatchSuggestions).set({ status: 'accepted', reviewRelationship: CLASS_RELATIONSHIP[autoClass], reviewNote: 'Approved automatically: this class passed the measured release gate.', reviewedAt: now }).where(and(eq(aiMatchSuggestions.sourceVariantId, p.sv), eq(aiMatchSuggestions.competitorVariantId, p.cv)));
    }
    saved++;
  }
  return saved;
}

/**
 * Safety net, called every minute by the worker: a run that should be moving but has no job (the worker restarted, a delayed job was lost) is queued again. A run a person paused
 * (no resume time) is never touched, and a run is recovered at most three times.
 */
export async function aiResumeTick(svc: Services): Promise<{ queued: string[] }> {
  if (!svc.config.GEMINI_API_KEY) return { queued: [] };
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
  return { queued };
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
