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

---

# Update (directive 29, 2026-11-04): facts, price safety, compatible equivalents

Status: **built, tested and committed locally; NOT yet deployed** (the server was unreachable: the laptop's address changed and only the owner can allow the new one in the AWS security group). Deploy = push, then `sudo shelfwatch-update` immediately (migration 0019, additive).

## What the review found, and what changed

| Finding | Change | Where |
|---|---|---|
| A **Dodge Charger** was read as an electrical "charger" accessory | A companion noun right after a vehicle maker is the vehicle's name (Dodge Charger, Chevrolet Bolt) | `core/match/dossier.ts` `isVehicleName` |
| A **42 mm** bulb vs a **41 mm** bulb "held different quantities" | A length on a bulb, lamp or fitting is a physical dimension, never the amount sold; the quantity comes from a count or stays unknown. Cable, tape, ribbon… still count by length | `core/quantity-policy.ts` `DIMENSIONAL_ITEM` |
| **Belga Star** called brand-unknown although the title names it | The AI is shown how an unbranded title begins (`title_begins_with`), and the prompt says never to call a named brand unknown | `core/ai/dossier.ts`, `prompt.ts` (prompt v3, dossier v2) |
| Descriptions loaded only if they contain "location bulb size" | The AI now also gets a short, markup-free excerpt around the first mention of fitment, compatibility, package contents or the bulb chart (the rule engine still reads only the chart, so matching is unchanged) | `services/ai-match.ts` `loadFitmentExcerpts` |
| A person's confirmation silently established equal pack contents | A confirmed pair whose listings do not establish quantity/bundle contents is **not** a direct price comparison until a person attests "same pack" (`POST /matches/:id/pack-attestation`, button on the card, audit event). It never overrides a quantity or bundle shown to differ. Decisions themselves are untouched | `services/comparison.ts`, `services/matching.ts attestPack`, migration 0019 |
| A pair marked "needs reevaluation" still fed price conclusions | It is excluded from direct comparison until the person has checked it again ("Keep my decision") | `services/comparison.ts` |
| The best candidate was chosen **before** checking it was delisted | Only live candidates are ranked; the other valid candidates at the same website are listed under the best one (`alternatives`, at most three) | `services/comparison.ts` |
| Rows omitted variant titles; Match review cards omitted part numbers | Variant name and part number/SKU on Match review and Price comparison | `Matches.tsx`, `Prices.tsx`, `queries.ts` |
| "Every suggestion has been decided" (an empty *To review* tab) | Says what the list is: only same-product suggestions; shows the number of suggested substitutes and related/unclear pairs that sit in other tabs | `Matches.tsx` |
| Price page said both "Confirmed and suggested" and "suggestions are not shown" | The note now follows the "Show" filter | `match-text.ts awaitingNote` |
| "Has a match" counted suggestions | **Has a confirmed match** / **No confirmed match** | `queries.ts`, `Products.tsx` |
| Manual "Choose a different product" searched names/SKU/barcode only | Also manufacturer part number, model, bulb codes under any of their names (searching H11 finds H8 listings), and vehicle words | `services/matching.ts matchesSearch` |
| The correct *variant* could disappear before judgment | Up to three variants of each competitor product go through the evidence check and the best by evidence represents the product | `core/ai/retrieval.ts` `variantsPerProduct` |

## Compatible equivalent is a real relationship

`equivalent` is now a relationship (stored in `product_matches.relationship`, class `comparable`; no schema change). It is **not** the same product and not a mere substitute: it has its own **Price comparison → Equivalents** view, is never counted in the identical-item price position (`directlyComparable` is false) and appears in none of the other views. An AI "close equivalent" accepted by a person is stored as `equivalent`. People can also choose it manually in Match review.

**The compatibility gate** (`core/ai/guard.ts`): the AI's "close equivalent" stands only for a part whose fit can be checked (automotive) when the rule engine found the bulb/socket code to be the same and found no decisive difference, and the bundle contents and quantity are not in doubt. Otherwise it is recorded as a **substitute** with the reason (`compat_gate`). Food, drink and other consumables are never "equivalents". The prompt also says a 24-pack is not a 6-pack and an alcohol-free drink is not the alcoholic one.

## Release gate for automatic approval (not enabled)

`core/ai/gate.ts` computes, with Wilson 95% intervals, candidate recall (at least 95%), automatic-approval precision (at least 98%), match recall (at least 90%), and refuses to pass a class with fewer than 100 labelled examples. **No class of automatic approval is switched on**: that needs an independently labelled test set (automotive cases labelled by someone who knows the parts, kept out of development and tuning), which does not exist yet. Until then AI output stays a suggestion and the 60–70% / 20–30% figures are targets, not claims.

## Gemini free-tier scale (for planning)

At the application's own cap of 200 requests per Pacific day and about 10 pair decisions per fully packed request, one day analyses about 2,000 pairs. 5,000 variants × 3 websites × 3 candidates is about 45,000 decisions, about 4,500 requests, about **23 days**. The free tier is workable only if local rules decide most cases and Gemini sees just the uncertain shortlist. The actual Google allowance is per project and was not observed beyond 15 requests a minute; do not split work across keys.

## Pending / not done

* Automatic approval of any class (needs the independent labelled set and the measured gate).
* Variant-level candidate-recall *measurement* on real labels (retrieval now keeps variants through the check; `scripts/ai-eval-retrieval.ts` still reports product-level recall).
* Semantic (embedding) retrieval: the production path passes no semantic results; enabling it needs `GEMINI_EMBEDDING_MODEL`, cached vectors and wiring into `retrieveShortlist`.
* The rule engine's own per-website cap (three suggestions, two substitutes) is unchanged: it is a display limit, not the retrieval used for AI.
* Reports draw on the same-product view only, so equivalents are in no report; separate report counts for parent products / variants / confirmed / suggested / directly comparable are not yet split out.
* Existing confirmations whose packs are unknown now show under **Match review → Packs not verified** and drop out of the direct price comparison until attested. This is deliberate and visibly changes the headline figures.

---

# Update (directive 30, 2026-11-04): the rest of the guide

Directive 29 left several items open. This update completes them (see also `docs/matching-evaluation.md`). Status words: **built** = in the code; **tested** = automated tests pass; **production** = running on the server (filled in when deployed).

| Guide requirement | Built | Tested | Notes |
|---|---|---|---|
| Fact sheet: identity / offer / compatibility kept apart, each fact with its source | yes | yes | The comparison groups facts as "What it is", "What is sold", "What it fits or does", "Size and strength", each with where it was read. New: the product page's own specification lines (wattage, voltage, lumens, colour temperature, socket, position, CAN-bus, dimensions, package contents, fitment, alcohol, ingredients) are read by `core/ai/specs.ts`; physical dimensions stay dimensions; alcohol content is a fact; unknown stays unknown |
| Vehicle name vs accessory; bulb length vs quantity; named brand not "unknown" | yes (directive 29) | yes | |
| Candidate discovery: several methods, variants kept through the check, pool beyond the AI shortlist, hard conflicts remove candidates | yes | yes | Up to three variants per competitor product reach the evidence check; the internal pool is 25–60 products per website; the AI judges 3 per website; "Find another product" searches the whole catalogue |
| Semantic retrieval (embeddings) | yes | yes (imitation API) | `ai-embed.ts`: paced, resumable background embedding (about 80 texts a minute, below the free limit), vectors kept per product and rebuilt only when its text changes; embeddings only ADD candidates; a different bulb code still removes one. Needs `GEMINI_EMBEDDING_MODEL` (off until set) |
| Compatible equivalent as a real relationship end to end | yes | yes | Gemini → shared types → `product_matches.relationship` → Match review → its own Price comparison view → reports/exports (own sheet, own KPI) |
| Equivalents in Reports | yes | yes | A "Compatible equivalents" worksheet and section and an `equivalentBenchmark` KPI, never part of the identical-item figures; saved reports are unchanged |
| Separate counts (parent products, variants, pairs, unique variants, confirmed/suggested, equivalents, substitutes, related, uncertain, no counterpart, directly comparable) | yes | yes | `loadMatchCounts`, `/matches/counts`; shown on Match review, Products and Reports (saved with new reports); KPI labels say "variants" where they count variants |
| Match review: Needs a decision / Automatically approved / Equivalents / Suggested substitutes / Related & unclear / No counterpart found / Uncertain / Changed since approval / Packs not verified | yes | yes | Uncertain is a status of an AI suggestion (AI tab filter); real actions: Accept, Change, **Not a match (Reject)**, Not sure yet, None of these, Find another product |
| Manual search by part number, aliases, vehicle | yes (directive 29) | yes | Shared search is used from AI suggestions, "no counterpart found" and labelling |
| Evaluation framework: labels, development vs holdout, blind labelling, scoring, intervals | yes | yes | `match-eval.ts`, `core/ai/evaluation.ts`, `/eval/*`, Evaluation tab |
| Release gate and gated automatic approval | yes | yes | Closed with no labels. When a class is on: only no-person-decided pairs, protected from the rule engine, audited, reversible, self-disabling |
| Independent human labels / the gates actually passing | **no** | n/a | Requires people; see "Pending" |

## Pending (genuinely dependent on people or data)

* **Independent labels.** About 300–500 cases across both workspaces must be labelled by people, including automotive cases by someone who knows the parts. Until then no gate can pass and no class is approved automatically; candidate recall, precision and recall on production data are therefore **not yet measured** (the measuring tool exists and is tested).
* **Fitment data.** A product-to-vehicle fitment table does not exist in the data; compatibility rests on what listings state (titles, options, descriptions, spec lines). ACES/VCdb would have to be sourced or created.
* **Embeddings on production:** deployed 2026-11-04 with `GEMINI_EMBEDDING_MODEL=gemini-embedding-001` (stable; listed for this project), started for the `adi` workspace only (13,917 products, about 80 texts a minute, so several hours; it pauses and resumes by itself when the free daily quota is used). `Aditya` is not embedded yet. Its effect on candidate recall cannot be stated until labels exist.
* Not built: an Insights card for the equivalent benchmark; browser-level end-to-end tests of the screens (the screens are covered by render tests and the API by integration tests).

---

# Update (directive 31, 2026-11-06): matching automation — the implementation contract

This update implements `docs/original-prompt/31_MATCHING_FIX_IMPLEMENTATION_BRIEF_2026-11-06.md` (pinned to commit `f0b33a3`). Status words: **built** = in the code; **tested** = an automated test proves it (file named); **production** = filled in after deployment (see the end).

## The verified defects, and what changed

| Defect in the brief | What was wrong | What it is now | Proved by |
|---|---|---|---|
| **P0 — enabling a policy stored only a flag** | `setAutoApproval` wrote a row; nothing approved the answers already stored | Activation stores the policy **version** and queues the **reconciliation job** (`task: 'reconcile'`), which re-decides every stored answer, in slices of 25 products, resumable and idempotent, with zero Gemini requests | `match-gate-path` (activation → reconcile → approvals, calls unchanged, re-run changes nothing), `auto-matching` ("switching the policy on…") |
| **P0 — cached unchanged pairs were skipped before approval** | A cache hit returned before the approval step | A cache hit **re-evaluates** the pair: safeguards and eligibility are recomputed from today's facts, the stored row is brought up to date, then `reconcileOne` decides approval | `auto-matching` ("a cache hit is promoted too", zero requests) |
| **P0 — collection never triggered AI analysis** | Scheduled collection ran the rule matcher and reports only | **Continuous matching** (per-workspace switch): after a collection finishes (or at least daily) a *sweep* run covers the whole active catalogue, never-worked products first, and each product has a durable **work item** | `auto-matching` (continuous: off does nothing, the initial backlog, a finished collection brings in a new product) |
| **P0 — products with earlier suggestions were never selected again** | Selection excluded them, and the promised cached fallback was missing | Selection is by work-item state (never worked → waiting for quota/retry → needs evidence → the rest); cached answers cost nothing | `auto-matching`, `ai-match` |
| **P0 — evaluation scored one candidate per site** | The gate saw the strongest answer only | The gate scores **every answer production would approve** (current policy version, current facts) | `match-gate-path` ("the scoring rules": a right + a wrong second candidate, two right, one unjudged) |
| **P0 — learned code aliases counted as identity-code evidence** | Codes that merely co-occur were treated as the same lamp | Two codes are the same only if written the same or listed in the **verified** alias table (`core/match/code-aliases.ts`). Learned families still help *retrieval* and never satisfy compatibility | `auto-matching` ("learned code family", "verified alias") |
| P1 — holdout split by variant | Sibling variants could straddle the split | Split by **product family** (normalised parent title); a family is never on both sides | `match-gate-path` ("split by product family") |
| P1 — one stored counterpart | Ground truth could not say "two are valid" or "this one is wrong" | `match_eval_truths`: per-candidate judgments (acceptable with a relationship / not a counterpart / critical), a *complete* flag; unlabelled = **unjudged** | `match-gate-path` |
| P1 — default comparison excluded equivalents | No overview of everything approved | **Price comparison → All approved** (default): identical items, pack variants and verified equivalents, each labelled with who approved it, the evidence, and the price limitation; equivalents never enter identical-item KPIs or the price position | `auto-matching` ("equivalents are visible…"), `match-gate-path` |
| P1 — facts both known and unknown | A fact enriched from a spec table was still listed as unknown | Merged facts clear the unknown list (dossier version 3) | core `directive29.test.ts` |
| P1 — grocery equivalent shown | Only automotive has an equivalent policy | Only the policies that exist are offered and accepted (`SUPPORTED_POLICIES`) | `match-gate-path` ("only policies that exist") |

## The one reconciliation operation

`reconcileOne` (`services/match-reconcile.ts`) takes the pair, the current facts and the enabled policies, and writes in **one transaction that locks the pair's row**: a person's decision (or one made at the same moment) always wins; stale fingerprints withdraw the system's own approval; eligibility is recomputed (never trusted from storage); the policy must be on **for the current version**; two rival identical items are ambiguous and neither is approved. Outcomes are explicit: approved, already approved, human decision preserved, stale analysis, missing critical facts, conflict, ambiguous candidate, policy not enabled, not eligible. Approvals store **no confidence number** (`0`), a reason and the policy version; screens and exports say "approved by policy". It is called after a new answer, after a cache hit, on activation/deactivation, and for stored answers whose pair is no longer in a product's shortlist (so an approval can never outlive the evidence it rested on). Race test: a person's rejection and two concurrent reconciliations, eight rounds, the rejection always wins.

## Continuous matching and durable work

`ai_match_work` has one row per own variant with a status (queued, running, **waiting for quota**, retry, completed, **needs evidence**), a reason (approved, awaiting review, no candidate, no acceptable candidate, unsupported category, kit, missing fitment, conflicting fitment, ambiguous variant, ambiguous candidate, policy not enabled, stale, human decision), counts and an attempt number. A quota stop marks the work **waiting for quota**, never completed; the run keeps its cursor and resumes from it (tested: 14 products, quota gone after two requests, resumed the next Pacific day, every pair asked exactly once). A product with no acceptable candidate is looked at **more widely** the next time (once; the wider answers are then cached). Price-only changes cost no model request (the pair's hash ignores price; tested). A changed fact (another bulb code) takes the approval back even when the pair is no longer shortlisted (tested).

## Two Gemini keys

`GEMINI_API_KEY` and `GEMINI_API_KEY_2` live **only** in the server's environment file (root:shelfwatch 640). Everywhere else a key is `k1` / `k2`. Each key has **its own** rate limiter, daily count, learned limits, pause and stop, stored per `(model, key)` (`ai_quota_state`, `ai_usage_daily`), so restarts and the API/worker split see the same truth. Each request goes to the key that can take it now with the most of its own daily budget left; a key Google pauses is skipped until its pause ends; a key Google refuses, or whose project reports a **non-free-tier** quota, is stopped on its own and the other carries on; answers already received are kept when a key runs out mid-request; when every key is out, the work waits and resumes from its checkpoint. Embeddings are spread and paced the same way, per key. Nothing is ever sent beyond a key's own ceilings and no paid model is selected. (Google applies free-tier limits per **project**: if both keys belong to one project they share one allowance, which the 429 answers reveal and the limiters then respect.) Tested in `ai-key-pool.test.ts`: both keys carry requests with their own counts; a paused key, a refused key and a non-free quota each leave the other key finishing the work; both out → pause and resume; neither key ever appears in a response, a stored record, an address or a request body.

## Automotive equivalence (replacement bulbs, policy `auto-2-bulb`)

Relationship, approval and price suitability are separate. The policy states each critical field — **code, function, colour** — as established, conflicting or unknown, from sourced evidence: the code as the listing writes it for the *selected variant* (a title that lists many codes without a selected option is an *ambiguous variant*), the intended light function, colour for signal lamps. Marketing figures (lumens, power, colour temperature) never block by themselves. Unknown critical fitment → needs evidence, not a guess. Kits, assemblies and accessories are out of scope. An unknown pack quantity keeps the relationship visible but shows **no price percentage**; different quantities are never approved as equivalents (tested).

## Coverage and the funnel

`/ai/funnel` (shown on **Match review → AI suggestions → Matching coverage**) counts **distinct own variants**: active → a candidate found → judged → qualifies for a policy → approved (anyone) → approved automatically → visible in the comparison, with one reason for every variant that is not approved, parent-product coverage, the 50% / 60% targets (automotive) with the exact shortfall and, when below the floor, its attribution (quota and backlog / no counterpart found / missing specifications / policy scope), the work waiting for people, and each policy's audited precision with its uncertainty. A variant that only has a *suggested* substitute is a candidate, not an automated match, and is never counted as one.

## Pending — what only a person can supply

* **Independent human labels.** At least 100 independent product families per policy, judged by people who know the parts (automotive), then *Measure* and *Switch on*. Until then every real gate is closed and the coverage figure is **0% automatic by design**; no number here is a claim about accuracy. The mechanism is proved on a constructed catalogue only.
* **Fitment data** beyond what listings state (ACES/VCdb) — unchanged.
* **Rotate both Gemini keys.** They were pasted into a chat.

## First day in production (2026-11-06): what the real deployment showed

* **Deployed** in two steps: `b8ea2f1` (the release) and `746b30d` (a fix: the coverage funnel crashed on the evaluation report production already held, a report made before families and policy versions existed; an old-format report now counts for nothing under the current rules). Backups were taken first; 23 migrations applied; human decisions, match statuses, products, variants and price history were byte-identical before and after (only unlabelled evaluation cases were re-split by family, totals unchanged).
* **The second key works and is tracked on its own** (`Key 1` / `Key 2`, each with its own counts); neither key appears in logs, the build, `/tmp`, or the public web bundle.
* **The quota is shared by every workspace on the server.** Two minutes after the release a person turned on "Match automatically" in another workspace; its sweep used the whole day's budget on both keys (400 requests) in about 35 minutes, and an analysis started in `adi` had to wait for the reset. Three things changed as a result:
  * Automatic matching (a sweep) may use at most **70%** of each day's free quota (`SWEEP_SHARE`); the rest is kept for analyses people start. A sweep that reaches its share pauses until the next Pacific midnight.
  * A run now waits **at once** when every key has used its whole day or is paused. Before, it analysed the whole catalogue first (about 140 seconds of CPU on the small server) only to learn there was no quota.
  * When two workers both met the quota, one's plain "stopped" could overwrite the other's "waiting for quota", leaving the run marked "running" until the 20-minute safety net re-queued it. A quota wait or a failure now always outranks a plain stop.
* **Real catalogue numbers (read-only, before any policy exists):** `adi` (automotive) has 9,311 active variants in 1,133 parents; a candidate counterpart exists for 5,345 (57.4%: candidate coverage, not automation); only 32 variants have ever been judged by the AI; 2 have an approved counterpart; **0 are automatically approved**. The 50% / 60% targets (4,656 / 5,587 variants) are therefore not met, and the exact attribution is: 9,279 variants not yet worked through (quota and backlog), 16 waiting on a policy or a person, 14 judged with no counterpart. The next constraint after quota is labels: no policy can be switched on until ≥ 100 independent families are labelled. Re-checking `adi`'s 213 stored answers against the current rules (no model requests): 132 stale against today's facts, 62 not eligible, 13 missing critical facts, 1 conflict, 5 human decisions preserved, **0 would be approved**.
