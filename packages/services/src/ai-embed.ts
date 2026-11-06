import { and, eq, sql } from 'drizzle-orm';
import { analyseCatalogue, hashText, type Dossier, type SemanticHit } from '@ci/core';
import { geminiEmbed } from '@ci/connectors';
import { aiEmbeddings, aiQuotaState, type DbLike } from '@ci/database';
import type { Services } from './context.ts';
import { withHeavyWork } from './heavy.ts';
import { loadEngineInputs } from './matching.ts';
import { addUsage, aiKeysOf, markKeyStopped } from './ai-keys.ts';

/**
 * Semantic retrieval (Gemini embeddings, free tier). An embedding finds differently worded listings of the same thing (a "headlamp" for a "headlight"); it only ADDS candidates to the shortlist.
 * Every candidate still goes through the rule engine's evidence check, so a decisive incompatibility (a different part code, a different vehicle) removes it however close its meaning is.
 *
 * The free tier counts every text as a request (about 100 a minute), so the catalogue is embedded in the background in small paced batches, once: a product is embedded again only when the text it
 * was made from changes. Vectors are kept short (256 numbers) and stored with the product.
 */

export const EMBEDDING_DIMS = 256;
const BATCH = 50;
/** Texts per minute the job allows itself: below Google's free limit of about 100. */
const TEXTS_PER_MINUTE = 80;
const TIME_BUDGET_MS = 6 * 60_000;

/** What a product is embedded from: its name, maker, options, bulb codes and category. Never a price. */
export function variantText(d: Dossier): string {
  return [d.title, d.brand.name ?? '', Object.values(d.axes).join(' '), d.codes.map((c) => c.toUpperCase()).join(' '), d.category ?? ''].filter(Boolean).join(' | ').slice(0, 600);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The closest competitor products to a source product, by meaning. Not a probability and never shown as one. */
export function semanticHits(source: Float32Array, competitors: Map<string, Float32Array>, k = 80, minScore = 0.55): SemanticHit[] {
  const scored: SemanticHit[] = [];
  for (const [variantId, v] of competitors) {
    const score = cosine(source, v);
    if (score >= minScore) scored.push({ variantId, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

export async function loadVectors(db: DbLike, orgId: string, model: string): Promise<Map<string, { hash: string; v: Float32Array }>> {
  const rows = await db.select({ id: aiEmbeddings.variantId, hash: aiEmbeddings.textHash, vector: aiEmbeddings.vector }).from(aiEmbeddings).where(and(eq(aiEmbeddings.orgId, orgId), eq(aiEmbeddings.model, model)));
  return new Map(rows.map((r) => [r.id, { hash: r.hash, v: Float32Array.from(JSON.parse(r.vector) as number[]) }]));
}

export async function embeddingStatus(db: DbLike, orgId: string, model: string | undefined): Promise<{ model: string | null; embedded: number; total: number }> {
  const total = await db.execute<{ n: string }>(sql`select count(*)::text as n from variants v join products p on p.id = v.product_id join sites s on s.id = p.site_id where v.org_id = ${orgId} and s.active and p.delisted_at is null`);
  if (!model) return { model: null, embedded: 0, total: Number(total.rows[0]?.n ?? 0) };
  const done = await db.execute<{ n: string }>(sql`select count(*)::text as n from ai_embeddings where org_id = ${orgId} and model = ${model}`);
  return { model, embedded: Number(done.rows[0]?.n ?? 0), total: Number(total.rows[0]?.n ?? 0) };
}

export interface EmbedOutcome {
  outcome: 'done' | 'continue' | 'daily' | 'stopped' | 'not_configured';
  embedded: number;
  remaining: number;
}

/**
 * Embeds the products that have no vector yet (or whose text changed), a paced batch at a time, until done, out of time, or out of quota. Batches are spread over the configured keys: each key is
 * paced on its OWN allowance (about 80 texts a minute), is stopped on its own if Google refuses it, and its use is recorded under its own label. A key that reports its daily quota is used up
 * is left alone for the rest of the job; when every key is, the job ends (and is resumed after the quota resets).
 */
export async function embedCatalogue(svc: Services, orgId: string): Promise<EmbedOutcome> {
  const db = svc.db as DbLike;
  const model = svc.config.GEMINI_EMBEDDING_MODEL;
  const keys = aiKeysOf(svc.config);
  if (!model || !keys.length) return { outcome: 'not_configured', embedded: 0, remaining: 0 };
  const states = await db.select().from(aiQuotaState).where(eq(aiQuotaState.model, model));
  const stoppedKeys = new Set(states.filter((s) => s.stopped).map((s) => s.keyId));
  const usable = () => keys.filter((k) => !stoppedKeys.has(k.id) && !spent.has(k.id));
  const spent = new Set<string>();
  if (!usable().length) return { outcome: 'stopped', embedded: 0, remaining: 0 };
  // (the whole catalogue's analysis is built under the same lock as matching, then released: the paced waits below never hold it)
  const corpus = await withHeavyWork(async () => analyseCatalogue(await loadEngineInputs(db, orgId)));
  const have = await loadVectors(db, orgId, model);
  const todo = corpus.dossiers.map((d) => ({ id: d.variantId, text: variantText(d) })).map((t) => ({ ...t, hash: hashText(t.text) })).filter((t) => have.get(t.id)?.hash !== t.hash);
  const sleep = svc.aiSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  const interval = Math.ceil((BATCH / TEXTS_PER_MINUTE) * 60_000);
  /** Per key: the earliest time (in the service clock) it may send its next batch. */
  const ready = new Map<string, number>(keys.map((k) => [k.id, svc.clock().getTime()]));
  let embedded = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    if (Date.now() - started > TIME_BUDGET_MS) return { outcome: 'continue', embedded, remaining: todo.length - i };
    const part = todo.slice(i, i + BATCH);
    let done = false;
    for (let attempt = 0; !done && attempt < 6; attempt++) {
      const pool = usable();
      if (!pool.length) return { outcome: spent.size ? 'daily' : 'stopped', embedded, remaining: todo.length - i };
      // the key that is ready soonest takes the batch; waiting happens only when every key has just been used
      const key = pool.reduce((a, b) => (ready.get(a.id)! <= ready.get(b.id)! ? a : b));
      const wait = ready.get(key.id)! - svc.clock().getTime();
      if (wait > 0) await sleep(wait);
      const res = await geminiEmbed({ apiKey: key.apiKey, model, embeddingModel: model, timeoutMs: svc.config.GEMINI_TIMEOUT_MS }, part.map((x) => x.text), { dimensions: EMBEDDING_DIMS, task: 'SEMANTIC_SIMILARITY' }, svc.geminiHttp);
      ready.set(key.id, svc.clock().getTime() + interval);
      if (res.ok) {
        const now = svc.clock();
        for (let j = 0; j < part.length; j++) {
          const values = { orgId, variantId: part[j]!.id, model, textHash: part[j]!.hash, dims: res.vectors[j]!.length, vector: JSON.stringify(res.vectors[j]!.map((x) => Math.round(x * 1e5) / 1e5)), createdAt: now };
          await db.insert(aiEmbeddings).values(values).onConflictDoUpdate({ target: [aiEmbeddings.variantId, aiEmbeddings.model], set: { textHash: values.textHash, dims: values.dims, vector: values.vector, createdAt: now } });
        }
        // every text counts as a request on the free tier: recorded beside the answers' usage, under the embedding model and the key that sent it
        await addUsage(db, model, key.id, now, { requests: part.length, successes: 1, inputTokens: res.usage.promptTokens, ms: res.ms });
        embedded += part.length;
        done = true;
        continue;
      }
      const kind = res.error.kind;
      if (kind === 'quota_day') { spent.add(key.id); continue; } // this key is used up for today; the others carry on
      if (kind === 'quota_minute' || kind === 'quota_tokens' || kind === 'overloaded' || kind === 'timeout' || kind === 'transient') {
        // try again on the next key that is ready (or this one after its pause)
        ready.set(key.id, svc.clock().getTime() + Math.max(15, res.error.retryAfterSeconds ?? 60) * 1000);
        continue;
      }
      // a refused key, a missing model or a non-free quota stops THAT key until a person looks at it; nothing is retried on it
      stoppedKeys.add(key.id);
      await markKeyStopped(db, model, key.id, res.error.message, svc.clock());
    }
    if (!done) return { outcome: usable().length ? 'continue' : spent.size ? 'daily' : 'stopped', embedded, remaining: todo.length - i };
  }
  return { outcome: 'done', embedded, remaining: 0 };
}
