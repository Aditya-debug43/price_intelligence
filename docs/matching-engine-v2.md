# Matching engine v2 — what was built, how it was measured, what is and is not established

Status: **implemented, tested and DEPLOYED (backend `98bab87` on the server, frontend on Vercel, 2026-10-29) — but NOT switched on anywhere.** Every workspace still runs the earlier engine (`matching_engine = 'v1'`). The new engine can be run in
**shadow** (`v2_shadow`: computes and records, changes nothing a person sees) or switched on (`v2`) per workspace. The release gates in section 6 are not all
established, so the engine stays off until the evaluation data exists. Design and reasoning: `docs/proposals/universal-matching-design.md` (approved 2026-10-29).
Verbatim request: `docs/original-prompt/17_DIRECTIVE_IMPLEMENT_UNIVERSAL_MATCHING_2026-10-29.md`.

> **Later the same day (directive 18):** the engine was improved to `match-v2.4` and validated against an independent evaluation set. The numbers in §5–§6 below are the v2.0 measurements as first reported; **the current measurements, the gate table and what is still not established are in `docs/matching-validation-2026-10-29.md`.** The gates are still not met; v2.4 is not deployed and nothing is switched on.

> **Directive 19 (2026-10-30):** the engine is now `match-v2.7` (deployed 2026-10-30 on the server and Vercel, **switched off**; deployment record in the validation doc §9), Match Review lists one item per product pair (§9), and the evaluation uses labels the assistant adjudicated from evidence (not independent human ground truth). **Current measurements, the acceptance-criteria table and the open weaknesses are in `docs/matching-validation-2026-10-30.md`.** The criteria are still not met; the matcher stays off.

## 1. Rules that now hold for every workspace, whatever engine it uses

| Rule | Where it is enforced |
|---|---|
| **Nothing is accepted by a run.** Not a barcode match, not a brand + part-number match, not a near-identical name. Every suggestion has status `needs_review` until a person decides. (The earlier engine's `auto` status is no longer written; existing `auto` rows wait for review like any other.) | `services/matching.ts`, `services/matching-v2.ts` |
| **The default Price Comparison holds only human-confirmed "same product" (exact) and "same product, other pack/size/colour" (variant) pairs.** | `services/comparison.ts` (`view: 'prices'`) |
| **Confirmed substitutes have their own view** ("Substitutes" tab), labelled as different products, with what differs listed, and never counted as a price for the same product. | `comparison.ts` (`view: 'substitutes'`), `web/pages/Prices.tsx` |
| Related products, non-matches, "not enough information" pairs and unconfirmed suggestions appear in neither view. | `comparison.ts` |
| **A person's accept / reject / reclassify is never changed by a run.** A decided pair whose product changed since is flagged (`needs_reevaluation`) for a second look; the decision itself stands. | `matching-v2.ts` `persistSuggestions` |
| **Suggestions are never deleted by a run.** One no longer proposed is *set aside* (`superseded_at`), kept with its history, and comes back (`reinstated`) if proposed again. | `matching.ts`, `matching-v2.ts` |
| Every suggestion, change, set-aside, flag and decision is appended to `match_events` with the evidence and a snapshot of both products: the labelled-example store (decision + evidence + engine version). Rows cannot be changed. | `matching-v2.ts` `recordMatchEvents`, trigger `ci_match_events_guard` |
| No percentage is shown anywhere: scores are not calibrated. The UI shows a relationship, an evidence tier (strong / some / not enough) and the evidence list. | `web/pages/Matches.tsx`, `Prices.tsx` |
| Paid LLM extraction/adjudication is **off** and not used by engine v2 at all. (The older optional adjudicator remains behind its existing off-by-default setting, v1 only.) | — |

**A visible consequence of the first two rules.** Pairs the earlier engine had marked `auto` (accepted by itself) were part of the comparison before. They are
not human-confirmed, so they no longer appear in the default comparison until a person confirms them (Match review → "Confirm many at once" does a whole
group after showing a sample). Production's "Aditya" workspace had 2,056 matched pairs when last read; how many of them were `auto` rather than confirmed by
a person is in section 7.

## 2. The six relationships (never folded into one score)

`exact` · `variant` · `substitute` · `related` · `non_match` · `insufficient` (`packages/shared/src/constants.ts`). Stored in `product_matches.relationship`;
older readers see a mapped `match_class` (`identical`, `different_pack`, `comparable`; "related" and "insufficient" map to `not_comparable`, which no
older reader shows as a comparison). Rows written before engine v2 have `relationship = null` and are read through `relationshipOfClass`.

## 3. Architecture as built (`packages/core/src/match/`)

1. **Dossier** (`dossier.ts`) — per variant: identifiers (GTIN, MPN, SKU), brand (field or inferred), code-shaped tokens, year mentions and ranges (never read as codes),
   numeric specifications with units (W, lm, K, V, A, mm/in/cm, GB, …; "6,000LM" is 6000; "8K" is 8000 K), colours (from the variant's own colour option, else the title),
   pack count, bundle markers, explicit exclusions ("Not for Classic"), the kind of thing the listing is (and whether it is a companion such as an adapter, harness or
   decoder), option axes. Unknown stays unknown (`unknown: []` records what could not be read).
2. **Corpus analysis** (`corpus.ts`) — read from the data, nothing per category: alias codes (H4 = 9003 = HB2: codes that always appear together on ≥ 2 websites, never
   from a combo title), codes seen on one website only are that website's series names, numbers scattered over unrelated kinds of product are not part codes, which words say
   *what a fitment listing is for* (they accompany year ranges), which words name the kind of thing (they usually come last in a title), colour words (seed + the sites' own colour options).
3. **Candidate generation** (`candidates.ts`) — union of independent keys per competitor website: identifier, shared identity code, vehicle/device words, rare descriptive words, and
   the earlier engine's name tokens (so nothing it could find is lost). Measured separately from the decision.
4. **Evidence model** (`evidence.ts`) — typed facts (agree / conflict / differ / missing) → relationship + tier + conflicts. Decisive incompatibilities (different part codes, other
   vehicle or non-overlapping years, a different voltage/size, an explicit "not for") end the question; a name can never outvote them. A vehicle-specific listing against a
   generic one is a substitute at most and never "strong". Shared identifiers never override a conflict, and a shared code alone never makes two products identical.
5. **Engine** (`engine.ts`) — keeps the best few suggestions per website (default 3 exact/variant/substitute; one "related"/"not enough information" only when nothing better exists).
   Pure: no database, network or clock.
6. **Persistence** (`services/matching-v2.ts`, migration `0013_match_engine_v2.sql`) — additive: nullable columns on `product_matches`, tables `match_events` and `match_runs`,
   column `org_settings.matching_engine`. No destructive change.
7. **Match review** (`web/pages/Matches.tsx`) — tabs: To review · Related & unclear · Confirmed · Not a match · Look again · Set aside; every suggestion shows its relationship, tier,
   the one-sentence reason, the evidence list (✓ supports / △ differs / ✕ conflicts / ? not stated), the two products side by side and the history of the pair.
   Empty states are built from facts (`GET /matches/summary`): never run / being tested / ran and proposed nothing / suggestions waiting / all decided.
8. **Evaluation** (`core/match/metrics.ts`, `scripts/match-eval.ts`, `scripts/migration-rehearsal.ts`) — see below.

Not built, deliberately: embedding retrieval (no evidence yet that lexical keys miss real substitutes), LLM extraction/adjudication (off by default; would need its own approval and budget cap),
calibrated probabilities (no reviewed data large enough), learned weights (the evidence rules are hand-written and documented; no label set large enough to fit or test weights honestly).

## 4. Verification

* Unit tests: `packages/core/src/match/engine.test.ts` (37) and `metrics.test.ts` — every scenario in the request: identical GTIN; same maker + MPN; different-brand stand-ins; abbreviations and word order;
  bulb codes and model years; different sockets; vehicle-specific vs generic; different fitment generations; colour/variant conflicts; pack sizes; a shared code on different kinds of product;
  adapter / harness / bulb / decoder; missing identifiers; products with no counterpart; plus the regressions the real grocery catalogue taught (below).
* End-to-end: `tests/e2e/match-engine-v2.test.ts` (shadow mode; nothing accepted; comparison empty until a person confirms; substitutes only in their view; three re-runs leave every decision
  byte-for-byte unchanged; a changed product flags a decided pair without touching the decision; set aside / reinstated with history; two queued jobs leave one row per pair; old records keep working;
  history cannot be edited) and `tests/unit/match-text.test.ts` (empty-state wording). The existing suite was updated where it assumed unconfirmed pairs are compared.
* **Migration rehearsal** on a copy of the owner's local database (`scripts/migration-rehearsal.ts`): 12 → 14 migrations in 124 ms; every table has the same number of rows; all 4,179 match rows are
  byte-for-byte unchanged; no old row has a new field set; every workspace is `v1`. The original database was never opened.

## 5. Measured results

### 5.1 Groceries — the owner's real local catalogue (3 workspaces, real human decisions)

`scripts/match-eval.ts` on a read-only export. "Decisions" are the pairs a person accepted. **These decisions were available while the engine was tuned (the regressions below were found by looking at
exactly these pairs), so they are development data, not independent validation.**

| Workspace | Source / competitor variants | Accepted pairs | Re-proposed as exact/variant/substitute | In any relationship | Review queue after protecting decisions |
|---|---|---|---|---|---|
| AdityaGraphics | 2,385 / 5,574 | 879 (629 same, 250 other pack) | **878 = 99.9 %** (95 % lower bound 99.4 %), all in the kind the person chose | 99.9 % | 723 pairs = 30.4 per 100 source products |
| Exploration Workspace | 2,385 / 5,574 | 235 | **235 = 100 %** | 100 % | 1,366 = 57.4 per 100 (only 235 decided) |
| Aditya (small) | 2,385 / 878 | 46 (8 same, 38 "comparable") | **39 = 84.8 %** (lower bound 71.8 %); same kind for only 16 | **45 = 97.8 %** | 18 = 0.8 per 100 |

Runtime on this laptop: ~4 s for 7,959 variants; heap 73–119 MB, RSS ≈ 250 MB (well inside the 600 MB / 10 min targets, **not yet measured on the production server**).
Suggestions by tier (AdityaGraphics): 1 strong, 1,760 medium, 1,236 "not enough information". Grocery names carry almost no specific evidence, so almost nothing is "strong" — by design.

What the real data changed in the engine (kept as regression tests): "100%" / "2%" had been read as a part code and produced a "strong" stand-in of pomegranate juice for wholewheat bread; numbers scattered
over unrelated kinds are now discarded; titles that start with the same brand name but name another variety are *related*, not stand-ins from another maker; the same product as a single bottle and as a pack is a
*variant*; a year or lone model number on one side is a stated difference on a probable match, not a different product.

### 5.2 Automotive accessories (lasfit.com vs auxito, allalighting, sealight-led) — real production data, **accuracy not established, workload far over target**

**Production export (read-only, 2026-10-29, workspace "adi")**: 9,199 of your variants (1,129 products) against 4,826 competitor variants, no human decisions yet. The earlier engine proposes **0** pairs here (the original finding).
The new engine, after the corrections below, proposes **11,913** suggestions: 9,598 substitutes (**1,100 strong**, every one resting on shared part codes; **8,498 medium**, of which about half rest on the vehicle alone), 504 related, 1,811 "not enough information";
**4,063 of your 9,199 variants get no suggestion at all**. Per 100 of your products the review queue would be **850 variant pairs** (104 per 100 variants), or about **198 per 100 as distinct product pairs** (2,233 product pairs) — against a target of 30.
Laptop run: 49 s, heap 173 MB, RSS ≈ 350 MB (the t3.micro has 913 MB with the API and worker already using ≈ 420 MB: **tight; not yet run on the server**).

What looking at the real data corrected (each is a regression test or a documented rule now): the first run gave 24,148 suggestions with 10,928 "strong" — a floor-mat listing matched a bulb listing on a model number; "F-150" and "4Runner" lost their model names while tokenising, so "Ford F-150" matched "Ford F-350";
a fog-light variant matched a dome-light variant of the same vehicle (variants now carry the part/position they are, learned from the websites' own variant titles); "Honda" matched "Honda Accord" (a model must now agree, not just the make);
fitment alone can no longer be "strong" (a shared part code or hard specification is needed, and the kind of product must agree); and a competitor product offers one variant per variant of yours instead of all of them. **All of this was tuned while reading this very export, so it is development data too.**
I read ten random strong suggestions at the end: all were genuine part-code substitutes (9012, 9007, H10, 9006 …). That is an impression, not a measurement. The medium tier still contains many same-vehicle pairs whose part differs (a licence-plate bulb against a low-beam bulb listing); the unmet workload target comes from there.

Before the production export, only the earlier **title-only pilot** existed
(180 pooled pairs from 30 of the owner's products, one labeller, `fixtures/matching/pilot-pairs.json`). Both parts were used while the engine was developed, so neither is held out:

| Pilot set | strong-tier precision (substitute) | strong-tier recall | strong + medium recall | strong + medium precision |
|---|---|---|---|---|
| development (120 pairs, 36 substitutes) | 19 / 21 | 19 / 36 | 36 / 36 | 36 / 48 |
| second source website (60 pairs, 27 substitutes) | 19 / 20 | 19 / 27 | 27 / 27 | 27 / 35 |

The lower 95 % bound of those strong-tier precisions is about 71 % and 76 %: **the ≥ 90 % gate is not met on this evidence**, and it would not be even with a perfect score on so few pairs. No claim is made.

## 6. Release gates — status

| Gate | Target | Status |
|---|---|---|
| Candidate recall @10 per website on confirmed substitutes | ≥ 95 % | **Not established** — needs a labelled set with substitutes found by independent retrieval (pooling). The harness measures it (`candidateRecall_*` in `match-eval`); no such label set exists yet. |
| Strong-tier precision, lower 95 % Wilson bound | ≥ 90 % | **Not met / not established** — pilot bound ≈ 71–76 % (above). Strong-tier suggestions are therefore not promoted: no auto-accept exists at all, and the tier is shown as a label only. |
| Recall of strong + medium | ≥ 90 % | Pilot: 100 % on both sets, but in-sample and title-only. **Not established.** |
| False suggestions for products with no genuine counterpart | ≤ 2 % | **Not established** — the harness takes a `noCounterpart` list; none has been labelled. In the pilot's 20 products, 11 had no counterpart and the earlier hand check found none missed. |
| Review workload | ≤ 30 per 100 source products | **Not met.** Production grocery ("Aditya", 705 decided): **37.8**. Production automotive ("adi", nothing decided): **850** variant pairs per 100 products (≈ 198 as distinct product pairs). Local grocery copies: 30.4 / 57.4 / 0.8. The queue needs grouping by product pair and a stricter medium tier before it is usable on the automotive catalogue. |
| Calibration error | ≤ 0.05 before showing percentages | Not applicable: **no percentage is shown**. |
| Human decisions preserved across repeated runs | 100 % | **Met** (end-to-end test: three re-runs, every decided row identical; a changed product flags, never edits). |
| Grocery regression | ≥ 95 % of accepted pairs re-proposed | **Met on production "Aditya": 701 of 705 = 99.4 % (lower bound 98.6 %)**, 661 of 662 "same product" in the same kind; the earlier engine also re-proposes 701. The 4 missing are Miller Lite / Coors Light multipacks. Local copies: 99.9 % / 100 % / 84.8 % (the last strictly, 97.8 % in any relationship). Development data (see 5.1). |
| Resources | ≤ 10 min, ≤ ~600 MB, no paid API | Laptop: 4 s grocery, 49 s automotive, ≈ 250–350 MB RSS, no API calls. **Not measured on the t3.micro, where the margin looks thin for the automotive catalogue.** |

**Consequence:** the engine is shipped in `v1` (off) with `v2_shadow` available. Switching a workspace to `v2` is the owner's decision, to be made after (a) an export of the automotive and grocery production workspaces is evaluated,
(b) ≥ 300 reviewed pairs including a held-out website and category exist (two labellers on ≥ 20 % to report agreement), and (c) the strong-tier lower bound reaches 90 %.

## 7. Running it

```
# measure (offline; reads a dataset file only)
npx tsx scripts/match-eval.ts --data export.json [--labels labels.json] [--engine v1|v2|both] [--out report.json]

# rehearse the migration on a copy of a local database (the original is untouched) and export per-workspace datasets
npx tsx scripts/migration-rehearsal.ts --out <dir> --export

# per workspace (admin): PUT /orgs/:id/settings { "matchingEngine": "v2_shadow" }   then "Run matching again"; the run is recorded in match_runs
```
Shadow runs record time, memory, counts by relationship and tier, the reasons pairs were dropped as incompatible, and sources without any suggestion — read them with
`select stats from match_runs order by started_at desc`.

Roll back: set `matching_engine` back to `v1` (suggestions already written stay as history; nothing was deleted). The migration is additive and needs no rollback; the new columns are ignored by the earlier code.

## 7b. Deployment record (2026-10-29)

* Backup first (`shelfwatch-2026-10-29T095800Z.dump`, 16 MB; an earlier one, `…T095734Z.dump`, was read back with `pg_restore -l`). Backend updated with `sudo shelfwatch-update` from `ee463da`/`03aa072` to `98bab87`: migration 0013 applied (14 of 14), readiness `ready`, smoke test 30/30 through nginx. The throw-away smoke-test account was removed again (3 real accounts, 3 workspaces untouched).
* Nothing in production data changed: 705 accepted + 1,353 waiting pairs exactly as before; no row has a v2 field; every workspace is on engine `v1`; `match_events` and `match_runs` are empty. Because the "Aditya" workspace had no `auto` rows, the confirmed-only comparison rule changes nothing it shows today; "Groceries To Go Aruba" has no products and "adi" has no matches yet.
* The frontend was pushed to `main` (Vercel) and the backend updated immediately after; the pages tolerate a backend that lacks the new endpoints for the minutes between the two. Vercel serves the new bundle (checked by its text) and proxies `/api/v1/ready` to the new backend. The new pages were not clicked through with a real login on production.
* Rollback: set an affected workspace's `matching_engine` back to `v1`; to remove the code, `git revert 98bab87 3b3d43d` and `sudo shelfwatch-update` (the migration is additive and the old code ignores the new columns); the backups above restore the data.

## 8. Limitations (what cannot be determined)

* Information absent from the listings cannot be recovered: with no part code, fitment or size the honest answer is "not enough information".
* Private-label equivalence is not verifiable from titles: "same socket" is not "same brightness"; soft differences (power, light output) are listed, not hidden.
* Fitment truth (does a 2016–2018 listing fit a 2019 truck?) needs sources the titles do not give; adjacent generations go to a person.
* Product kind relies on title structure plus one small, language-level list of companion nouns (adapter, harness, case, charger …, `COMPANION_NOUNS`); kinds outside it are only compared by learned title words.
* Evidence rules are hand-written and were refined while looking at the development data above; weights have not been fitted or tested on a held-out set.
* Descriptions, tags and images are not yet used (titles, option axes and identifiers are).
* Multi-variant products are matched variant by variant; a bundle's single bulb position can match a competitor's single bulb, the whole bundle never matches one.

## 9. State after directive 19 (engine `match-v2.7`)

**How a suggestion is made, in order.** (1) Each variant becomes a dossier (identifiers, codes, years, vehicle chain, sizes, colours, kind, options). (2) The corpus is analysed once per workspace (alias codes, series names, vehicle makes learned from the titles, kind words, colour words). (3) Candidates are retrieved per competitor website by several independent keys (identifier, shared code, vehicle/device words, rare tokens, name tokens). (4) `evaluatePair` turns typed facts into a relationship, a tier and a list of evidence; decisive conflicts end the question and a name never outvotes them. (5) At most three suggestions per website are kept. (6) Nothing is accepted: every suggestion waits for a person.

**What v2.4 → v2.7 added** (details, tests and measurements: `docs/matching-validation-2026-10-30.md` §2): head-model identity from the product title (Transit vs F-250, ProMaster vs Ram 1500, Cherokee vs Grand Cherokee, F-250 Super Duty = Ford 250); two-digit bracketed years; colour-mode and kind-of-part rules (switchback, combos with different sockets, decoder or resistor companions); NA/NAK suffixes; a grocery "same name, size not comparable" route with guards for flavour and variant size.

**Product-pair review unit.** `GET /matches?group=product` returns one row per (your product, competitor product) — the strongest variant pair, `groupSize`, the others on request (`sourceProductId` and `competitorProductId` filters). `POST /matches/product-pair/reject` (`{sourceProductId, competitorProductId, note?}`) rejects every waiting variant pair of the pair through the ordinary decision path (history, audit, `match_events`); decided and set-aside rows are not touched; confirming stays per variant pair. `GET /matches/summary` also reports `awaitingProductPairs`. No schema change; the web page works against an older backend. End-to-end test: `tests/e2e/match-product-pairs.test.ts`.

**How an improvement is evaluated** (rules in `docs/matching-validation-2026-10-30.md` §7): develop on the development set and audits of the engine's own output; freeze the engine (record file hashes) before opening a fresh set once; report precision and recall with and without uncertain labels, per domain and website, the workload as variant pairs and product pairs, grocery regression, no-counterpart rate, resources on the server; state which labels are AI-made; a label is "verified" only after a person opened the pages. Datasets, labels and the fresh set stay outside the repository (`fixtures/matching/eval-v1/` and `eval-v2/` are git-ignored).

## 10. State after directive 20 (2026-10-31): ACTIVE (`match-v2.8`)

The new matcher is the active matcher in all three production workspaces. Measurements, the acceptance table and the weaknesses: **`docs/matching-validation-2026-10-31.md`** (read it first). What changed since §9:

* **Name alignment** without brand fields (rare maker word that starts both titles, spelling pairs, maker on one side only = never "the same product"), **same-kind stand-ins** across makers for products with no codes (kind head word), edition/variety/form guards, a **strict kind test** for fitment-only matches, **kinds that are never seen together** (mat/bulb) learned from the catalogue, vehicle kits for different models = related, a model ("Ram 1500") told from a part code ("H7") by a make right next to it.
* **Description charts:** a "Location | Bulb Size | … | Watt/Lumens" chart in a product description gives each variant its own bulb size and power (`chartFacts`, matched on the variant's position option; the description is read once per product and not kept).
* **Automatic confirmation** (`org_settings.matching_auto_confirm`, off by default; `product_matches.auto_confirmed_at`): the engine confirms only pairs its policy allows (identifier, or same maker + identical normalised names + both sizes stated and consistent, no one-sided edition word), marks them, records `auto_confirmed` / `auto_withdrawn` in `match_events`, withdraws only its own confirmations, and a person's decision clears the marker and is final.
* **Price comparison** views: same products (exact + other pack), substitutes, related; "confirmed only" or "confirmed and suggested"; each price labelled person / automatic / suggested; suggestions never count towards a price position; substitutes list their differences. **Match review:** "to review" is only what needs a decision (same product / other pack); substitutes have their own list.
* At most two stand-ins are stored per competitor website for each of your variants. The saving step reads only the columns it compares.
* Ops: `scripts/ops-run-matching.ts` (queues the same job as the button), `scripts/ops-match-report.ts` (read-only, runs the real comparison and review code on live records).

## 11. Quantity-compatibility policy (directive 23, 2026-11-02; policy `quantity-1`)

**The rule.** Products that hold different actual quantities are incomparable for price comparison, whatever their names, brands, part numbers or even barcodes say. Their prices are not compared and not converted into a price per litre, per kilogram or per item; they are never confirmed automatically as "the same product in another pack"; they appear in no price conclusion (position, insight, KPI, report). The professor's advice is to leave them incomparable for now; accuracy matters more than the number of comparisons.

**What counts as a quantity** (`packages/core/src/quantity-policy.ts`). The size the matcher already reads from the title and the shop's size hints (volume ml, mass g, counts), then the variant's option values, then a length (mm, cm, m, inch, ft, yd) or an area (sq ft, sq m, cm², …) written in the title, then a labelled net-content line in the description ("Net weight: 500 g", "Package size: …", read only when nothing else states a quantity). A number without a unit beside it (9005, 7443, a year, a part id) is never a quantity. Units are converted only to decide equality (1 L = 1000 ml, 2 m = 200 cm; labels within 1 % are equal: 16.9 fl oz = 500 ml). The total counts, the packaging is kept apart: 2 × 1 L and 1 × 2 L are the same quantity, packaged differently.

**Three outcomes** per pair, stored with the values read and where they came from:

| verdict | meaning | effect |
|---|---|---|
| `same` | both clearly stated, equal after conversion | eligible; may be confirmed automatically |
| `different` | both clearly stated, not equal, or measured in different kinds of unit (1 kg vs 1 L) | recorded as `INCOMPARABLE_QUANTITY_MISMATCH`: left out of price comparison |
| `unknown` | missing on a side, a title that states two pack counts, ounces that may be weight or volume, a count with no size against a measured quantity | never taken as a match: no automatic confirmation, not a direct comparison unless a person confirmed the pair |

**Where it is enforced.** (1) The engine (`evidence.ts`): the assessment is part of every evaluated pair; an "exact" pair whose quantities differ becomes a "variant"; automatic confirmation requires `same`. (2) Storage (migration 0015, three nullable columns on `product_matches`: `price_exclusion`, `price_excluded_at`, `quantity_check`): written when a suggestion is persisted, when a person makes a pair by hand, by the first matcher, and by the audit script. (3) The price comparison (`comparison.ts`): a pair with the marker (or, for a row nobody has assessed, whose stored product sizes differ) is dropped from the price and substitute views before any price is read, whatever its status; per-unit prices are no longer computed (`unitPrice` stays empty; `unitDiffPct` is only the plain difference between equal quantities). (4) Insights: the per-unit fallback is gone. Reports are built from the same loader, so every report generated from now on follows the rule; saved snapshots are immutable and keep the figures they were saved with.

**Decisions of people.** A run keeps the marker current on a person's decided pair but never touches its status, relationship, note, author or time; the change is appended to the pair's history (`quantity_excluded` / `quantity_released`). A person's confirmation with a quantity that is merely not stated still counts (they could see the products), labelled "quantity not verified"; with a quantity shown to differ it is kept and not used for price until the quantities agree (a product page corrected, or the person changes the decision). A confirmation the MATCHER made on its own is withdrawn by the next run unless the quantities are shown equal. Bulk acceptance skips excluded pairs; nobody is asked to review them (own view "Different quantity" in Match review, with the recorded values).

**Audit of stored pairs.** `scripts/ops-quantity-audit.ts` (read-only by default; `--apply` writes only the three policy fields and the history entries; `--before-migration` for a database without the columns). Offline on the owner's local copy of real catalogues (older, first-matcher pairs): 73 pairs in one grocery workspace, 52 differ (31 of them accepted by a person); 2,053 pairs in each of two others, 968 and 971 differ.

**Limits.** A leading count with no pack word ("24 Poland Spring …" with a 500 ml size label) is read as the 500 ml it states, not as 24 × 500 ml: such a pair is left out (the safe direction). Only counts the parser knows are read (pack, ct, pcs, sheets, wipes, tablets, capsules, pods …). Length is read as a quantity only when no volume, mass or count is stated (a lug nut's "14 mm" next to "20 pcs" is a size, not a length of stock). Description text is read only under a strong label. The basket comparison (already outside every export) still has no CSV table. The labelled evaluation set could not be re-run (its workspace exports are deleted by design); the unit and end-to-end suites that cover the engine's grocery and automotive regressions pass.
