# AI-assisted product matching (Gemini, free tier) — directive 28

Status: **deployed to production 2026-11-04 in shadow mode** (commit `bca615b`). The rule-based matcher (engine v2.8) is unchanged and remains the only thing that feeds Match review's existing tabs, Price Comparison and reports. AI output lives in its own tables and tab.

## What it does

For a chosen set of the shop's own products, Shelfwatch builds a compact, sourced fact sheet ("dossier") for each product, shortlists several diverse competitor candidates per website with many local search methods, asks Gemini to classify each pair, applies safeguards the model cannot override, and stores the result as a *suggestion*. A person then reviews it on **Match review → AI suggestions**.

Six answers: `exact_item`, `same_product_different_pack`, `close_equivalent`, `substitute`, `related`, `no_match_uncertain`. Each carries a confidence level (how well the stated facts support the answer — not a probability), facts that agree, facts that differ, facts not stated, a plain-language reason, and whether the pair could be compared on price.

## Where it sits

| Piece | File |
|---|---|
| Dossiers, retrieval, prompt, batching, limiter, safeguards (pure) | `packages/core/src/ai/*` |
| Gemini Developer API client (structured JSON, error/quota classification, key redaction) | `packages/connectors/src/gemini.ts` |
| One request with retries, quota handling, splitting | `packages/services/src/ai-gemini.ts` |
| Runs, worker job `ai-match`, usage/quota records, review actions | `packages/services/src/ai-match.ts` |
| API | `apps/api/src/routes/ai-match.ts` (`/ai/status`, `/ai/runs`, `/ai/suggestions`, review) |
| Screen | `apps/web/src/pages/AiSuggestions.tsx`, tab in `Matches.tsx` |
| Tables (migration 0018, additive) | `ai_match_runs`, `ai_match_suggestions`, `ai_match_feedback`, `ai_dossiers`, `ai_usage_daily`, `ai_quota_state` |
| Offline evaluation | `scripts/ai-eval-retrieval.ts`, `scripts/ai-eval-gemini.ts` |
| Start/inspect a run from the server | `scripts/ops-run-ai.ts` |

## Rules that never bend

* **Shadow mode.** Suggestions never change a match, a decision, a price, a report or Price Comparison. Only a person's Accept / Change / Find another product does, and that goes through the existing `decideMatch` / `setManualMatch`, so the quantity and bundle policies apply exactly as for any decision. Accepting one suggestion does not set other waiting suggestions aside. "Close equivalent" is stored as a *substitute* (the finer label stays in the AI record and the decision note).
* **Safeguards** (`core/ai/guard.ts`) — recorded on every suggestion, with what the model said before and after: a decisive incompatibility found by the rule engine caps the answer at *related*; a verified bundle mismatch caps it at *related*; an unknown bundle caps it at *no match*; different or unknown quantity can never be *exact* and never price-comparable; different brands are never assumed the same maker; two different barcodes are never the same item; a value the model quotes that is not in the facts it was given is flagged and not counted as support; a differing part code/socket stops "stand-in" claims. Price is never given to the model.
* **Free tier only.** Shelfwatch's own ceilings (12 requests/min, 150k tokens/min, 200 requests per Pacific day — all configurable) sit below Google's. A per-minute 429 waits the time Google names (plus jitter) and continues; a daily 429 pauses the run until the quota resets; any quota that is not a free-tier quota, a refused key or a missing model **stops** Gemini processing until a person clears it ("Resume Gemini"). Nothing is retried endlessly, no second key/project is used, no paid model is selected. If Gemini is unavailable everything else works.
* **Key handling.** `GEMINI_API_KEY` exists only in the server's environment file (root:shelfwatch, 640). It is sent only as a request header; it is never in the repository, the web bundle (checked in the build and in the live bundle), a URL, a log line, an API response or a stored record (asserted by tests).
* **Heavy work stays in the worker.** A run is processed in windows of 6 products, at most ~6 minutes per job slice, then re-queued; progress, usage and learned limits are stored, so a restart, pause or quota wait loses nothing. A safety net re-queues a run that lost its job. A process-wide lock keeps matching, report generation and AI analysis from building the catalogue in memory at the same time.

## Free-tier facts observed with the project's own key (2026-11)

* Official Developer API (`generativelanguage.googleapis.com/v1beta`), structured JSON with `responseSchema` works. Default model **`gemini-3.5-flash-lite`** (stable, available on this free tier); `gemini-3.1-flash-lite` also worked. Switch with `GEMINI_MODEL` — no code change.
* Per-minute limit seen from Google's own 429 answers: **15 requests/min** for the model (enforcement is approximate). Embedding calls count each text as a request (~100/min); embeddings are **off** (`GEMINI_EMBEDDING_MODEL` unset).
* Google does **not** expose the remaining quota; the screen shows only what Shelfwatch has sent and the limits Google's answers revealed. The daily request limit was not reached/observed, so it is unknown.
* Context caching and the Batch API were not used (not verified on this free tier); batching is done by packing several candidates (and several products) into one request.

## Production smoke run (2026-11-04, workspace `adi`, the owner's own)

6 products, 3 candidates per website → **6 requests, 44 candidate pairs judged, 0 failures, 0 rate limits**, ≈11.9k input and ≈9.6k output tokens, ≈25 s. Result mix: 16 close equivalent, 7 substitute, 12 related, 9 no match; **6 answers were changed by safeguards** (3 verified bundle mismatches, 3 unknown bundle contents); 2 answers carried a value not found in the facts given (flagged, not counted); 0 price-comparable (quantities not established for these lighting products). No product match, decision or price changed (latest `product_matches` update predates the run).
This is a smoke test, **not an accuracy measurement**.

## Evaluation status (what is and is not known)

* Candidate retrieval: measured offline against the owner's own accepted grocery decisions (human labels) and against assistant-made labels for automotive (not independent). Clear gain on grocery at small shortlist sizes; parity on automotive.
* Classification accuracy: probed on real products offline (a wrong "substitute" led to prompt v2 and the identity-conflict safeguard). **No independent human-labelled set exists for automotive**, and precision/recall of the AI on production data has **not** been measured. Do not base reports or automatic approval on these suggestions. Automatic approval is not enabled and must wait for an independent human-labelled evaluation.
* The reviews people make on the AI tab are stored (`ai_match_feedback`) and are the intended source of that evaluation.

## Operating it

* Start: Match review → AI suggestions → *Analyse with AI* (admin), or on the server  
  `sudo bash -c 'cd /opt/shelfwatch/app && set -a && . /etc/shelfwatch/shelfwatch.env && node_modules/.bin/tsx scripts/ops-run-ai.ts <orgId> 6 3'` (`--status` to inspect).
* Start small: a product costs about one request.
* Settings (all optional): `GEMINI_MODEL`, `GEMINI_RPM`, `GEMINI_TPM`, `GEMINI_DAILY_REQUESTS`, `GEMINI_MAX_CONCURRENCY`, `GEMINI_BATCH_CANDIDATES`, `GEMINI_MAX_INPUT_TOKENS`, `GEMINI_MAX_OUTPUT_TOKENS`, `GEMINI_TIMEOUT_MS`, `GEMINI_EMBEDDING_MODEL`.
* Roll back: remove `GEMINI_API_KEY` from `/etc/shelfwatch/shelfwatch.env` (a backup of the file before this change is `shelfwatch.env.bak-20261104`) and restart the worker — the AI features go idle, everything else is unaffected. The migration is additive.
* Rotate the key: it was shared in a chat; create a new one in Google AI Studio, replace the line, restart the worker.

## What would have to change later

* **A unit-price view for different packs.** Today a different-pack suggestion is shown on its own and Price Comparison ignores it (the quantity policy leaves such pairs out). A separately labelled unit-price view would need: a unit-price computation from the verified quantities (never inferred), a new comparison view/section that is clearly not "same product, same price" and is opt-in, and a rule that only pairs a person accepted as *same product, different pack* with both quantities established enter it. A human decision must still not remove the quantity or bundle exclusion by itself.
* **"Close equivalent" as its own relationship** would need a new relationship value, its handling in `relationship`/`match_class` mappings, Match review tabs, Price Comparison substitutes and reports; until then it is stored as a substitute.
* **Embeddings** for semantic candidate search: set `GEMINI_EMBEDDING_MODEL`, cache vectors per product fingerprint; mind the ~100 texts/min free limit.

## Known limitations

* The AI only knows what listings state; many lighting listings state no quantity, so "price comparable" is rarely true.
* A free-tier daily request limit exists but its size is unknown; very large analyses must be run in slices over several days.
* Review is admin-only. The screen was typechecked and built but no browser-level test of the tab exists yet (component render tests still to do).
* Grocery workspaces have not yet had a production AI run.
