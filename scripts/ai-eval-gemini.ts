/**
 * OFFLINE evaluation of the AI classifier on a saved export: shortlists candidates with the local retrieval, asks Gemini (free tier, rate-limited, hard request budget), applies the
 * safeguards and compares the answers with reviewers' labels and with the rule engine. The key is read from GEMINI_API_KEY (environment only; never printed, never written).
 * Resumable: every answer is cached in a JSON file (keyed by model, prompt version and the exact request), so an interrupted or quota-limited run continues where it stopped and
 * never asks the same question twice.
 *
 *   GEMINI_API_KEY=… npx tsx scripts/ai-eval-gemini.ts --data export.json --domain automotive|grocery [--labels eval-set.json …] [--decisions 40]
 *       [--max-sources 20] [--max-requests 60] [--cache cache.json] [--out report.json] [--per-site 3] [--batch 10] [--model gemini-3.5-flash-lite]
 *
 * Labels written by the development process are NOT independent human truth, and the report says so. `--decisions N` additionally scores N of the pairs a person accepted
 * by hand (`decisions` in the export): those are human labels.
 */
import fs from 'node:fs';
import {
  AI_PROMPT_VERSION, AI_SYSTEM_PROMPT, AiLimiter, analyseCatalogue, applyGuards, buildAiDossier, buildRetrievalIndex, buildUserPayload, DEFAULT_BATCH_LIMITS, groundingText, hashText, isPlaceholderBrand, placeholderBrandKeys, planBatches,
  retrieveShortlist, sizeHintOf, toWire, type AiDecision, type AiDossier, type DossierInput, type GuardedDecision, type PayloadGroup, type PlannedRequest,
} from '@ci/core';
import { askRequest, pairKey, type AskDeps } from '@ci/services';

interface Row { variantId: string; productId: string; siteId: string; role: 'source' | 'competitor'; site?: string; title: string; variantTitle: string | null; brand: string | null; category: string | null; gtin: string | null; sku: string | null; mpn: string | null; model: string | null; qtyLabel: string | null; attrs: Record<string, unknown> | null; options?: Record<string, string> | null }
interface LabelPair { id: string; domain: string; set: string; sourceProductId: string; competitorProductId: string; competitorSite: string; label: string; uncertain?: boolean }

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const all = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]!] : []));
const dataPath = arg('data');
const domain = arg('domain');
const KEY = process.env['GEMINI_API_KEY'];
if (!dataPath || !domain) { console.error('usage: GEMINI_API_KEY=… tsx scripts/ai-eval-gemini.ts --data export.json --domain automotive|grocery [--labels labels.json …] [--decisions N]'); process.exit(1); }
if (!KEY) { console.error('GEMINI_API_KEY is not set in the environment.'); process.exit(1); }
const model = arg('model', 'gemini-3.5-flash-lite')!;
const maxSources = Number(arg('max-sources', '20'));
const maxRequests = Number(arg('max-requests', '60'));
const perSite = Number(arg('per-site', '3'));
const batchSize = Number(arg('batch', '10'));
const nDecisions = Number(arg('decisions', '0'));
const cachePath = arg('cache', `ai-eval-cache-${domain}.json`)!;
const outPath = arg('out');

const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as { rows: Row[]; decisions?: { source: string; competitor: string; status: string; matchClass?: string }[] };
const rows = raw.rows;
const rowOf = new Map(rows.map((r) => [r.variantId, r]));
const tags = (a: Record<string, unknown> | null | undefined) => (Array.isArray(a?.['tags']) ? (a!['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []);
const placeholders = placeholderBrandKeys(rows.map((r) => ({ siteId: r.siteId, brand: r.brand, title: r.title })));
const inputs: (DossierInput & { role: 'source' | 'competitor' })[] = rows.map((r) => ({
  variantId: r.variantId, productId: r.productId, siteId: r.siteId, role: r.role, title: r.title, variantTitle: r.variantTitle, brand: isPlaceholderBrand(placeholders, r.siteId, r.brand) ? null : r.brand, category: r.category, gtin: r.gtin, sku: r.sku,
  mpn: r.mpn, model: r.model, sizeHints: [r.qtyLabel, sizeHintOf(r.attrs)], context: tags(r.attrs).join(' ') || null, options: r.options ?? {}, tags: tags(r.attrs),
}));
const corpus = analyseCatalogue(inputs);
const index = buildRetrievalIndex(inputs.filter((i) => i.role === 'competitor').map((c) => corpus.byVariant.get(c.variantId)!), corpus);
const dossiers = new Map<string, AiDossier>();
const aiDossier = (variantId: string) => {
  let d = dossiers.get(variantId);
  if (!d) { d = buildAiDossier(corpus.byVariant.get(variantId)!, { alias: corpus.alias }); dossiers.set(variantId, d); }
  return d;
};

// ── the sample: (a) the products the labels talk about, (b) pairs a person accepted
const labels: LabelPair[] = all('labels').flatMap((f) => (JSON.parse(fs.readFileSync(f, 'utf8')) as { pairs: LabelPair[] }).pairs).filter((p) => p.domain === domain);
const variantsOf = new Map<string, string[]>();
for (const r of rows) if (r.role === 'source') (variantsOf.get(r.productId) ?? variantsOf.set(r.productId, []).get(r.productId)!).push(r.variantId);
const richest = (p: string) => [...(variantsOf.get(p) ?? [])].sort((a, b) => Object.keys(aiDossier(b).attributes).length - Object.keys(aiDossier(a).attributes).length || a.localeCompare(b))[0]!;
const labelProducts = [...new Set(labels.map((l) => l.sourceProductId))].filter((p) => variantsOf.has(p));
const chosenProducts = labelProducts.filter((_, i) => i % Math.max(1, Math.floor(labelProducts.length / maxSources)) === 0).slice(0, maxSources);
const sourceVariants = chosenProducts.map(richest);
const accepted = (raw.decisions ?? []).filter((d) => d.status === 'accepted' && rowOf.get(d.source)?.role === 'source' && rowOf.has(d.competitor));
const decisionSample = nDecisions ? accepted.filter((_, i) => i % Math.max(1, Math.floor(accepted.length / nDecisions)) === 0).slice(0, nDecisions) : [];
const allSources = [...new Set([...sourceVariants, ...decisionSample.map((d) => d.source)])];

// ── shortlists and request payloads
interface Cand { variantId: string; engine: NonNullable<ReturnType<typeof retrieveShortlist>[number]['engine']> | null; foundBy: string[] }
const shortlist = new Map<string, Cand[]>();
let hardDropped = 0;
for (const sv of allSources) {
  const stats = { considered: 0, droppedHardConflict: 0 };
  const list = retrieveShortlist(index, corpus.byVariant.get(sv)!, { perSiteProducts: perSite }, null, stats);
  hardDropped += stats.droppedHardConflict;
  shortlist.set(sv, list.map((c) => ({ variantId: c.variantId, engine: c.engine, foundBy: c.foundBy.map((f) => f.method) })));
}
const groups: PayloadGroup[] = allSources.map((sv) => ({
  ref: sv,
  source: toWire(aiDossier(sv)),
  candidates: shortlist.get(sv)!.map((c) => ({ id: '', ref: c.variantId, wire: toWire(aiDossier(c.variantId)), chk: { q: (c.engine?.quantity.verdict ?? 'unknown') as 'same' | 'different' | 'unknown', ...(c.engine?.bundle ? { b: c.engine.bundle.verdict } : {}) } })),
}));
const tokensState = { charsPerToken: DEFAULT_BATCH_LIMITS.charsPerToken };
const plan = planBatches(groups, { ...DEFAULT_BATCH_LIMITS, maxCandidates: batchSize });
console.log(`${domain}: ${allSources.length} source variants (${sourceVariants.length} from labels, ${decisionSample.length} person-accepted), ${groups.reduce((n, g) => n + g.candidates.length, 0)} candidates (${hardDropped} left out as decisive conflicts), ${plan.length} requests planned (≈ ${plan.map((p) => p.estimatedInputTokens).join('/')} input tokens)`);

// ── asking Gemini
const cache: Record<string, { decisions: [string, AiDecision][] }> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
const limiter = new AiLimiter({ rpm: Number(arg('rpm', '12')), tpm: 150_000, dailyRequests: maxRequests, maxConcurrency: 1 });
const stats = { requests: 0, cached: 0, failures: 0, prompt: 0, output: 0, thoughts: 0, total: 0, ms: 0, errors: {} as Record<string, number> };
const deps: AskDeps = {
  cfg: { apiKey: KEY, model, maxOutputTokens: DEFAULT_BATCH_LIMITS.maxOutputTokens, timeoutMs: 120_000, maxWaitMs: 60_000 },
  limiter, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, tokens: tokensState,
  shouldStop: () => false,
  onRequest: (e) => {
    stats.requests++;
    stats.ms += e.ms;
    if (e.usage) { stats.prompt += e.usage.promptTokens; stats.output += e.usage.outputTokens; stats.thoughts += e.usage.thoughtsTokens; stats.total += e.usage.totalTokens; }
    if (!e.ok) { stats.failures++; stats.errors[e.errorKind ?? '?'] = (stats.errors[e.errorKind ?? '?'] ?? 0) + 1; }
  },
};
const decisions = new Map<string, AiDecision>(); // `${sourceVariant}|${candidateVariant}` → decision
let stoppedBy: string | null = null;
for (const req of plan) {
  const key = hashText(`${model}|${AI_PROMPT_VERSION}|${AI_SYSTEM_PROMPT.length}|${buildUserPayload(req.groups)}`);
  if (cache[key]) {
    stats.cached++;
    for (const [pair, d] of cache[key]!.decisions) decisions.set(pair, d);
    continue;
  }
  if (stats.requests >= maxRequests) { stoppedBy = 'request budget'; break; }
  const res = await askRequest(req as PlannedRequest, deps);
  const got = res.status === 'done' ? res.decisions : res.partial;
  const entries: [string, AiDecision][] = [];
  for (const g of req.groups) for (const c of g.candidates) { const d = got.get(pairKey(g.ref, c.ref)); if (d) { decisions.set(pairKey(g.ref, c.ref), d); entries.push([pairKey(g.ref, c.ref), d]); } }
  if (res.status === 'done') { cache[key] = { decisions: entries }; fs.writeFileSync(cachePath, JSON.stringify(cache)); }
  if (res.status === 'blocked') { stoppedBy = `blocked (${res.reason}) until ${new Date(res.resumeAt).toISOString()}`; break; }
  if (res.status === 'failed') { stoppedBy = `failed (${res.error.kind}: ${res.error.message.slice(0, 100)})`; break; }
}

// ── safeguards, then scoring
const guarded = new Map<string, GuardedDecision>();
for (const [key, d] of decisions) {
  const [sv, cv] = key.split('|') as [string, string];
  const cand = shortlist.get(sv)?.find((c) => c.variantId === cv);
  const s = corpus.byVariant.get(sv)!;
  const c = corpus.byVariant.get(cv)!;
  guarded.set(key, applyGuards(d, {
    engine: cand?.engine ? { relationship: cand.engine.relationship, conflicts: cand.engine.conflicts } : null,
    quantity: cand?.engine?.quantity ?? null, bundle: cand?.engine?.bundle ?? null,
    sourceBrandKey: s.brand.key, candidateBrandKey: c.brand.key,
    gtinEqual: !!s.identifiers.gtin && !!c.identifiers.gtin && s.identifiers.gtin.value === c.identifiers.gtin.value,
    gtinDiffer: !!s.identifiers.gtin && !!c.identifiers.gtin && s.identifiers.gtin.value !== c.identifiers.gtin.value,
    codesAgree: !!cand?.engine?.evidence.items.some((i) => i.kind === 'identity_code' && i.effect === 'supports'),
    sourceFacts: groundingText(aiDossier(sv)), candidateFacts: groundingText(aiDossier(cv)),
  }));
}

const POSITIVE = new Set(['exact_item', 'same_product_different_pack', 'close_equivalent', 'substitute']);
const FAMILY: Record<string, string> = { E: 'exact_item', V: 'same_product_different_pack', S: 'close_equivalent|substitute', R: 'related', I: 'no_match_uncertain', N: 'no_match_uncertain' };
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const engineSays = (e: Cand['engine']) => (e ? (['exact', 'variant', 'substitute'].includes(e.relationship) && e.tier !== 'insufficient' ? 'positive' : 'not') : 'not');
const report: Record<string, unknown> = { domain, model, promptVersion: AI_PROMPT_VERSION, sample: { sourceVariants: allSources.length, candidates: groups.reduce((n, g) => n + g.candidates.length, 0), answered: guarded.size }, usage: stats, stoppedBy };

console.log(`\nrequests sent ${stats.requests}, from cache ${stats.cached}, failures ${stats.failures} ${JSON.stringify(stats.errors)}; tokens: prompt ${stats.prompt}, output ${stats.output}, thinking ${stats.thoughts}, total ${stats.total}; mean latency ${stats.requests ? Math.round(stats.ms / stats.requests) : 0} ms; chars/token ${tokensState.charsPerToken.toFixed(2)}${stoppedBy ? `; STOPPED: ${stoppedBy}` : ''}`);
console.log(`answered candidates: ${guarded.size}; AI types after safeguards: ${JSON.stringify([...guarded.values()].reduce<Record<string, number>>((m, d) => ((m[d.match_type] = (m[d.match_type] ?? 0) + 1), m), {}))}`);
console.log(`safeguards fired: ${JSON.stringify([...guarded.values()].flatMap((d) => d.guards.map((g) => g.code)).reduce<Record<string, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {}))}; model type changed by a safeguard: ${[...guarded.values()].filter((d) => d.match_type !== d.ai_match_type).length}`);

// (a) assistant-labelled pairs (product level): the labelled competitor product must be among the candidates of one of the source product's asked variants
{
  const rowsOut: { label: string; ai: string | null; engine: string; uncertain: boolean }[] = [];
  for (const l of labels.filter((x) => chosenProducts.includes(x.sourceProductId))) {
    const sv = richest(l.sourceProductId);
    const cand = shortlist.get(sv)?.find((c) => rowOf.get(c.variantId)?.productId === l.competitorProductId);
    const g = cand ? guarded.get(`${sv}|${cand.variantId}`) : undefined;
    rowsOut.push({ label: l.label, ai: cand ? (g?.match_type ?? 'not asked') : null, engine: cand ? engineSays(cand.engine) : 'not retrieved', uncertain: !!l.uncertain });
  }
  const positives = rowsOut.filter((r) => ['E', 'V', 'S'].includes(r.label));
  const negatives = rowsOut.filter((r) => !['E', 'V', 'S'].includes(r.label));
  const inList = rowsOut.filter((r) => r.ai !== null && r.ai !== 'not asked');
  const aiPos = (r: { ai: string | null }) => r.ai !== null && POSITIVE.has(r.ai);
  console.log(`\nASSISTANT-LABELLED pairs for the sampled products (labels by the development process, not independent): ${rowsOut.length} pairs; genuine ${positives.length}, not genuine ${negatives.length}; competitor product in the shortlist for ${rowsOut.filter((r) => r.ai !== null).length}`);
  console.log(`  genuine pairs found as a match: AI ${positives.filter(aiPos).length}/${positives.length} (${pct(positives.filter(aiPos).length, positives.length)}) | rule engine on the same shortlist ${positives.filter((r) => r.engine === 'positive').length}/${positives.length} (${pct(positives.filter((r) => r.engine === 'positive').length, positives.length)})`);
  console.log(`  not-genuine pairs wrongly called a match: AI ${negatives.filter(aiPos).length}/${negatives.length} | rule engine ${negatives.filter((r) => r.engine === 'positive').length}/${negatives.length}`);
  const tp = positives.filter(aiPos).length;
  const fp = negatives.filter(aiPos).length;
  console.log(`  AI precision on labelled pairs ${pct(tp, tp + fp)}, recall ${pct(tp, positives.length)} (a labelled pair outside the shortlist counts as missed)`);
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of inList) { (confusion[r.label] ??= {})[r.ai!] = (confusion[r.label]![r.ai!] ?? 0) + 1; }
  console.log(`  label × AI type: ${JSON.stringify(confusion)}`);
  const strict = inList.filter((r) => FAMILY[r.label]!.split('|').includes(r.ai!)).length;
  console.log(`  type agrees with the label (exact↔exact, pack↔pack, S↔close/substitute, R↔related, I/N↔no match): ${strict}/${inList.length} (${pct(strict, inList.length)})`);
  report['assistantLabelled'] = { pairs: rowsOut.length, positives: positives.length, aiFound: tp, engineFound: positives.filter((r) => r.engine === 'positive').length, aiFalsePositives: fp, engineFalsePositives: negatives.filter((r) => r.engine === 'positive').length, confusion, strictAgreement: [strict, inList.length] };
}

// (b) pairs a person accepted
if (decisionSample.length) {
  const out: { cls: string; ai: string | null; engine: string }[] = [];
  for (const d of decisionSample) {
    const cand = shortlist.get(d.source)?.find((c) => rowOf.get(c.variantId)?.productId === rowOf.get(d.competitor)!.productId);
    const g = cand ? guarded.get(`${d.source}|${cand.variantId}`) : undefined;
    out.push({ cls: d.matchClass ?? '?', ai: cand ? (g?.match_type ?? 'not asked') : null, engine: cand ? engineSays(cand.engine) : 'not retrieved' });
  }
  const found = out.filter((r) => r.ai !== null && POSITIVE.has(r.ai));
  const expected: Record<string, string[]> = { identical: ['exact_item'], different_pack: ['same_product_different_pack'], comparable: ['close_equivalent', 'substitute'] };
  const typed = out.filter((r) => r.ai && expected[r.cls]?.includes(r.ai)).length;
  console.log(`\nPERSON-ACCEPTED pairs (the owner's own decisions: human labels), ${out.length} sampled`);
  console.log(`  in the shortlist ${out.filter((r) => r.ai !== null).length}/${out.length}; called a match by AI ${found.length}/${out.length} (${pct(found.length, out.length)}); rule engine called it a match ${out.filter((r) => r.engine === 'positive').length}/${out.length} (${pct(out.filter((r) => r.engine === 'positive').length, out.length)})`);
  console.log(`  the owner's kind agrees with the AI's type: ${typed}/${out.length} (${pct(typed, out.length)}); AI types on these pairs: ${JSON.stringify(out.reduce<Record<string, number>>((m, r) => ((m[`${r.cls}→${r.ai}`] = (m[`${r.cls}→${r.ai}`] ?? 0) + 1), m), {}))}`);
  report['personAccepted'] = { sampled: out.length, inShortlist: out.filter((r) => r.ai !== null).length, aiMatch: found.length, engineMatch: out.filter((r) => r.engine === 'positive').length, typeAgrees: typed };
}
if (outPath) fs.writeFileSync(outPath, JSON.stringify({ ...report, decisions: [...guarded.entries()].map(([k, d]) => ({ pair: k, type: d.match_type, ai: d.ai_match_type, conf: d.confidence_level, guards: d.guards.map((g) => g.code), why: d.explanation, ev: { for: d.supporting_evidence, against: d.conflicting_evidence, missing: d.missing_evidence } })) }, null, 1));
