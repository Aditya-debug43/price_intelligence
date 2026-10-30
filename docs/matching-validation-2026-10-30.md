# Matching engine v2.7 — adjudicated evaluation, improvements and acceptance criteria (directive 19)

Request: `docs/original-prompt/19_DIRECTIVE_COMPLETE_MATCHING_WITHOUT_MANUAL_LABELLING_2026-10-30.md`. Continues `docs/matching-validation-2026-10-29.md` and `docs/matching-engine-v2.md`.

**Verdict.** The engine is more careful about vehicle identity and product kind, Match Review now lists one item per product pair, and the evaluation uses labels the assistant adjudicated itself from evidence. **The acceptance criteria are still not met, nothing is validated by an independent human, the matcher stays off (`v1`) in every workspace. v2.7 is deployed (backend on the server, frontend on Vercel) and verified, but switched off (§9).** Nothing is accepted automatically.

## 1. Labels: what they are and what they are not

* Every one of the 120 reviewed pairs now carries three labels with provenance: the first labeller (names only), a second AI evaluator, and an **adjudication by the assistant**. The adjudication re-examined stored sizes and descriptions, the *complete* variant and option lists, the product pages' own fitment lists, the product pictures (the owner's own shop and competitors' stored images), a barcode, and third-party references (retail listings of a barcode; seller documentation on bulb sockets and vehicle retainers).
* The adjudication was made by the same assistant that made the first labels, so **it is not independent human ground truth**. Each record states its evidence types; uncertain pairs stay uncertain.
* Result of the adjudication (120 pairs): related 33, not a match 44, substitute 19, same product 14, same product other pack 4, **insufficient evidence 6** (kept out of precision and recall). 90 are adjudicated with confidence, 24 are adjudicated but uncertain (policy-dependent or thin evidence), 6 are insufficient.
* Six adopted policies decide the borderline cases (they are the assistant's, and changeable): **P1** a variant is another pack, size or colour, and a different flavour, formulation or key dietary attribute is *related*; **P2** a substitute does the same job with the same key attributes; **P3** a vehicle-specific listing against a listing for another vehicle or generation is related when sockets are shared, and for kits with many options the label belongs to the selected option; **P4** a defining feature or colour the other listing lacks (blue against white, switchback against single colour) makes the pair related; **P5** a different form that needs different preparation (condensed against ready to eat, dry against canned) is related; **P6** insufficient evidence where a listing contradicts itself or the decisive fact is not stated anywhere reachable.
* Where evidence overturned a label, it did so both ways: the second evaluator was right on stored sizes (four exact/variant disputes) and on complete option lists (seven "not enough information" pairs that are certain non-matches); the first labeller was right on flavour/formulation (the second evaluator called fat-free against regular a "variant"). Two cases where both evaluators agreed were overturned: a "salted" butter whose barcode settles it as exact (the stored description said unsalted), and a crackers listing whose own picture shows a different product (Ritz chips).
* The detailed dataset and the case-by-case report contain product titles and links and are kept **outside the repository** (the repository is public).

## 2. What changed in the engine (`packages/core/src/match`, v2.4 → v2.7)

* **Vehicle identity.** The head model is read from the product *title* (first word after a make learned from the data), so "Transit-250" is not "F-250", "ProMaster 1500" is not "Ram 1500", while "F-250 Super Duty" is still "Ford 250" (the earlier rule had broken that); the vehicle chain is chosen by named words, not by the rarest numbers; two-digit years in brackets, "(12-17) Toyota Camry", are read as years.
* **Kind and feature.** Colours and colour modes ("yellow", "switchback") are no longer "which part or position"; a switchback or dual-colour bulb against a single-colour bulb of the same socket is related; two combos with different sockets are never "strong"; "24 oz" of a liquid is no longer compared as a weight with litres; NA/NAK suffixes name the same bulb (7444NA is 7444).
* **Review unit.** `listMatches` groups the waiting suggestions by (your product, competitor product): one row, the strongest variant pair, the count behind it, the others on request; one action ("these are different products") rejects every waiting variant pair as ordinary recorded decisions (history and audit included) and never touches a decided or set-aside row; the summary reports waiting product pairs next to variant pairs. No schema change; the page works against an older backend.
* Tests: 341 in `packages/core`, an end-to-end test of the grouping and the rejection (4), **1,144 in 74 files passing**; typecheck and build clean; ESLint 0 errors (the two documented `any` warnings).
* **Deliberately not done:** proposing "same type, different brand" stand-ins for groceries (they are 12 of the 33 certain misses) and using product descriptions for sockets of vehicle listings. Either would add many low-precision suggestions to a queue that is already large.

## 3. Evaluation sets

| Set | Content | Status |
|---|---|---|
| Development | 486 pairs: the 120 adjudicated pairs and the 366 first-labeller pairs; **every pair ever examined, including the earlier "held-out" ones, is development data** | tuned on |
| Fresh | 151 pairs from products never used in any earlier pool, label or audit: 9 + 8 + 22 + 10 fresh source products, candidates from retrievers that are not this engine (TF-IDF, rare token, random, and pairs found by two of them), labelled by the assistant **before the final engine was evaluated on them**; 26 positives (16 certain), 22 uncertain, 4 products with no counterpart | independent of the engine *development*, **not** of the labeller; same catalogues and websites as development |

## 4. Before and after

Same labels (adjudicated), same script. "Certain" = pairs not marked uncertain.

| | previous engine (v2.4) | v2.7 |
|---|---|---|
| Development: strong + medium precision | 53 / 57 = 93.0 % | 53 / 57 = 93.0 % |
| Development: recall (all / certain positives) | 53.0 % / 60.7 % | 54.1 % / 61.4 % (positives are 98, not 100, after policy P4 was applied consistently) |
| Development: strong tier | 16 / 17 | 16 / 17 |
| Development: candidate recall @10 | 91.0 % | 91.8 % |
| Fresh, frozen engine v2.5 (**independent**): strong + medium | 14 / 16 = 87.5 %, recall 53.8 % (certain 68.8 %) | |
| Fresh, frozen engine v2.5: strong tier | 1 / 3 (33 %, lower bound 6 %) | |
| Fresh, v2.7 (**second look, not independent**): strong + medium | | 14 / 15 = 93.3 %, recall 53.8 % (certain 68.8 %); strong tier 1 / 1 |
| Products with no counterpart that get a suggestion | 0 / 55 | 0 / 55 and 0 / 4 fresh |
| Automotive workload: variant pairs per 100 of your products (1,129) | 611 | 620 (the audited fixes remove false positives and add a few found ones) |
| Automotive workload: **review items** (product pairs) per 100 | 177 | **176**, shown as one item per product pair instead of one per variant pair (6,999 variant pairs → 1,981 items) |
| Grocery review load (the owner's 705 decisions applied) | 24.4 per 100 | 24.4 per 100 |
| Grocery regression: accepted pairs re-proposed | 701 / 705 | 701 / 705 = 99.4 % (lower bound 98.6 %) |
| Deployed v2.0 for reference (earlier labels, other sample) | 850 variant pairs per 100; 198 product pairs per 100; strong + medium precision 81.5 % | |

**Honest reading.** On the development labels the headline accuracy did not move: the work this round removed errors found by audit and by the independent fresh set (and made the review unit sane), it did not raise recall. The two strong-tier errors on the fresh set (a switchback bulb against a red-only bulb of the same socket; a combo of one socket against a combo of two) were found by the frozen engine, fixed afterwards, and are therefore reported as a second look.

Audits of the engine's own output (labelled by the assistant from titles, 24 random automotive suggestions of v2.6): strong tier 6 right, 0 clearly wrong, 2 ambiguous; all tiers 13 right, 4 clearly wrong, 7 ambiguous. Two of the four errors (two-digit bracketed years) are fixed in v2.7; the others are a brand series name that equals a vehicle model ("X5") and two festoon bulbs of different lengths.

## 5. Acceptance criteria (`docs/proposals/universal-matching-design.md`, G.5)

| Criterion | Target | Measured | Status |
|---|---|---|---|
| Candidate recall @10 per website | ≥ 95 % | development: allalighting 84.6 % (11/13), auxito 86.7 % (13/15), sealight-led 90.9 % (10/11), quickmart 97.1 % (34/35), Ling & Sons 77.8 % (7/9), foodstore2go 100 % (15/15); all 91.8 %; fresh 92.3 % (24/26). Retrieval at all is higher: the misses are mostly ranks 11–19 of 20–25 same-socket candidates, which the engine still evaluates | **Not met** |
| Strong-tier precision, lower 95 % bound | ≥ 90 % on held-out | fresh (independent, frozen engine): 1 of 3 predicted correct (bound 6 %); development 16 of 17 (bound 73 %). The strong tier is rarely predicted (3 of 151 on the fresh set), so the bound cannot reach 90 % | **Not met; cannot be demonstrated** |
| Recall of strong + review tiers | ≥ 90 % | development 54.1 % (61.4 % certain); fresh 53.8 % (68.8 % certain) | **Not met** |
| False suggestions for products with no counterpart | ≤ 2 % | 0 of 55 (95 % upper bound 6.5 %) and 0 of 4 fresh | **Observed 0; cannot be verified** (too few products to bound at 2 %) |
| Review load | ≤ 30 per 100 | groceries with decisions applied: **24.4 (met)**; groceries, nothing decided: 53.8; automotive: 176 items per 100 as product pairs (620 variant pairs) | **Grocery met; automotive not met** (the list is mostly genuine stand-ins; cutting it would drop real matches) |
| Calibration | ECE ≤ 0.05 when probabilities are shown | no probability is shown | Not applicable |
| Three re-runs change no decided row | 100 % | end-to-end tests (three re-runs; product-pair rejection survives a re-run) | **Met** |
| Grocery regression | ≥ 95 % of 705 | 701 / 705 = 99.4 % | **Met** |
| Resources: ≤ 10 min, ≤ ~600 MB, no paid calls | | **measured on the production t3.micro** (§9) under a 450 MB cap, lowest priority, no database access: automotive 106 s in the engine (112 s wall), 295 MB resident, unit memory ≤ 268 MB at 5 s samples; grocery 12 s, 152 MB; the API answered 200 on every check during both runs; no paid calls. Laptop: automotive ≈ 50 s | **Met** (for the engine run on an exported catalogue; the production job path and a first shadow run were not exercised, because the matcher is off) |

## 6. What remains weak (known, not hidden)

* Recall is about 54 % (62–69 % of certain positives). The misses are cross-brand "same type" stand-ins in groceries, vehicle listings whose sockets are only in the description, multi-option kits compared at listing level, sparse titles, and pack-size variants whose names differ by more than one word.
* The strong tier is small and unproven; no strong-tier suggestion should be treated as reliable evidence.
* Remaining false-positive classes in the automotive queue: a vendor's series name that equals a vehicle model, festoon bulbs of different lengths, and vehicle kits with unparsed fitment.
* The labels are the assistant's; the fresh set has 16 certain positives. Every interval is wide.
* Descriptions, tags and images are still not used by the engine.

## 7. How future improvements will be evaluated

1. New engine rules are developed on the development set and on audits of the engine's own output only; the fresh set is evaluated **once per frozen engine** (file hashes recorded first) and then becomes development data.
2. A new fresh set (other products, ideally another website or category, and a human second reviewer: the 120-pair workbook exists) replaces it before the next validation claim.
3. Report precision and recall with and without uncertain labels, per domain and per website, the workload as variant pairs *and* product pairs, grocery regression, no-counterpart rate, runtime and memory on the server, and say which labels are AI-made.
4. Any rule that adds suggestions must show its precision on a random sample of what it adds before it is kept (this is how the first, looser grocery route was rejected).
5. A label is *verified* only when a human has opened the pages; until then the dataset says "adjudicated".

## 8. Reproducing

```
npx tsx scripts/match-eval-set.ts --eval-set <set.json> --auto-data <dataset-adi.json> --grocery-data <dataset-Aditya.json> --set dev|heldout|all [--heldout-name "<text>"]
npx tsx scripts/match-eval.ts --data <dataset-Aditya.json> --engine v2        # grocery regression on accepted decisions
npx vitest run                                                              # 1,144 tests
```
The datasets, the adjudicated labels and the fresh set hold catalogue data and live outside the repository (`fixtures/matching/eval-v2` is git-ignored).

## 9. Deployment record (2026-10-30)

* **Before:** the server ran `98bab87` (engine v2.0, disabled), ready, all 14 migrations applied. Read-only counts taken first: every workspace `matching_engine = 'v1'` (3 workspaces); 705 accepted, 1,391 waiting (36 of them set aside), 36 history events, 0 match runs, no row with a v2 field.
* **Backup:** `shelfwatch-backup` run, then read back with `pg_restore -l` (22 MB, 49 table-data entries including `product_matches`, `match_events`, `org_settings`); `shelfwatch-update` took a second backup of its own.
* **Deploy:** `main` fast-forwarded on GitHub (`98798cb..ccfbb78`; the five commits were scanned for credentials, addresses and data first); `sudo shelfwatch-update` pulled it, installed lockfile-exact, built, applied migrations (none new: 14 of 14), restarted the worker then the API, and reported ready. The server now runs `ccfbb78`; Vercel serves the new frontend (its bundle contains the product-pair call).
* **Verification:** the same read-only counts after the update are identical to the counts before it (3 × `v1`, 705 accepted, 1,391 waiting, 36 events, 0 runs, 0 v2 fields, 14 migrations); readiness `ready` on every check. The grouped review query was run on the production data read-only: 1,355 waiting variant pairs in the one grocery workspace collapse to 1,343 product pairs. The new routes answer 401 without a login (a made-up route answers 404), so they exist and are protected. **Not done:** a logged-in click-through of the new review screen, and the project's smoke test, because the smoke test registers a throwaway account in the production database and that needs the owner's say-so.
* **Resource test on the t3.micro** (913 MB): the exported catalogues were copied to a private temporary folder, the engine ran as a transient systemd unit with `MemoryMax=450M`, `MemorySwapMax=0`, lowest priority and no database access, outside the 05:30 UTC collection window, then the files and units were deleted. Grocery: engine 12 s, 152 MB resident. Automotive: engine 106 s (112 s wall), 295 MB resident, unit memory at most 268 MB in 5 s samples. The API answered 200 on all 25 readiness checks during the runs; host free memory fell to about 105 MB at the low point; no swap added. The server's results equal the laptop's (grocery review queue 580 = 24.4 per 100, regression 701 of 705; automotive 6,999 variant pairs = 619.9 per 100). Not exercised: the production job path and a first `v2_shadow` run (the matcher is off).
* **Rollback:** `git revert` the engine commit (`7884f1a`) and run `sudo shelfwatch-update`; there is no schema change to undo; the two backups above restore the data. Switching a workspace to `v2_shadow` or `v2` is a separate decision of the owner and is not made by this release.
