# Matching engine v2.4 — validation against the release gates (directive 18)

Request: `docs/original-prompt/18_DIRECTIVE_IMPROVE_MATCHING_ACCURACY_2026-10-29.md`. Date of the measurements: 2026-10-29. Companion to `docs/matching-engine-v2.md`.

**Verdict.** The engine is more accurate and asks the reviewer for less than the version that was deployed, but **the release gates are not met and it is not production-ready. It stays off (`v1`) for every workspace.** Deployed code on the server is still the earlier v2.0 (`98bab87`); v2.4 is committed locally only (SSH to the server was blocked, see §7).

## 1. Gates, measured on the frozen engine `match-v2.4`

| Gate | Target | Measured | Status |
|---|---|---|---|
| Candidate recall @10, per website | ≥ 95 % | dev: allalighting 75 % (9/12), auxito 82 % (14/17), sealight-led 100 % (9/9), quickmart 97 % (36/37), Ling & Sons 78 % (7/9). Held-out foodstore2go 100 % (15/15, lower bound 80 %). Retrieved at all (not only top 10) ≈ 95 % on dev | **Not met** |
| Strong-tier precision, lower 95 % bound | ≥ 90 % on held-out | The held-out set has **no strong-tier suggestion** (grocery has no strong tier; the non-lighting category has no genuine pair). Audit of the engine's own strong automotive output (36 random product pairs, two samples, labelled by title): 27 clearly right, 1 clearly wrong, 8 ambiguous → 75 %–97 % (Wilson 59 %–86 %). Dev pool: 15/16 (lower bound 72 %) | **Not met, not demonstrable on this data** |
| Strong + review recall | ≥ 90 % | Dev 57.1 % (48/84, lower bound 46.5 %); automotive 60.5 % (23/38), grocery 54.3 % (25/46). Held-out: **0/15 for the engine frozen before the held-out set was opened (v2.1)**; 4/15 = 26.7 % (lower bound 10.9 %) after changes made with that failure known (v2.4, **not independent**) | **Not met** |
| False suggestions for products with no counterpart | ≤ 2 % | 0 of 55 (95 % upper bound 6.5 %); was 4 of 55 (7.3 %) at v2.0. 55 products cannot show ≤ 2 % (≈ 150 clean products would be needed) | Observed 0; **not demonstrable** |
| Review workload | ≤ 30 per 100 source products | Automotive "adi" (nothing decided): 7,153 variant pairs = **634 / 100**; 2,053 product pairs = **182 / 100**; strong-tier product pairs 75 / 100. Grocery "Aditya" with the owner's 705 decisions applied: 580 = **24.4 / 100** (met); the same catalogue with nothing decided: 53.8 / 100 | Grocery steady state met; **automotive not met** |
| Human decisions preserved on repeated runs | 100 % | End-to-end test (three re-runs, every decided row identical) | Met |
| Grocery regression | ≥ 95 % re-proposed | 701 of 705 accepted pairs = 99.4 % (lower bound 98.6 %); the four missing are Miller Lite / Coors Light 12 oz bottles | Met |
| Runtime ≤ 10 min / memory ≈ ≤ 600 MB | | Laptop: automotive ≈ 64 s, grocery ≈ 6 s, RSS ≈ 350–400 MB, no API calls. **Not measured on the t3.micro** | Unverified on the server |
| Paid API calls / auto-accept | none | None / nothing is ever auto-accepted | Met |

Two numbers describe the evaluation honestly. The labels are one labeller's (the assistant's, from titles only); a second-reviewer sheet exists (§5) and **no agreement is claimed**. The held-out set was opened once at v2.1; every later change was made knowing that result, so the v2.4 held-out number is a second look, not validation.

## 2. Before and after, same data, same script (v2.0 as deployed vs v2.4)

| | v2.0 | v2.4 |
|---|---|---|
| Strong + medium precision, dev (pairs surfaced from labelled pools) | 81.5 % (44/54) | 92.3 % (48/52) |
| — automotive | 67.9 % (19/28) | 85.2 % (23/27) |
| — grocery | 96.2 % (25/26) | 100 % (25/25) |
| Strong + medium recall, dev | 52.4 % | 57.1 % |
| — automotive / grocery | 50.0 % / 54.3 % | 60.5 % / 54.3 % |
| Strong tier, dev | 13/14 (lower 69 %) | 15/16 (lower 72 %) |
| Candidate recall @10, dev | 85.7 % | 89.3 % |
| Products with no counterpart that get a suggestion | 4 / 55 | 0 / 55 |
| Automotive variant pairs (1,129 source products) | 9,598 (850 / 100) | 7,153 (634 / 100), −25 % |
| Automotive product pairs | 2,233 (198 / 100) | 2,053 (182 / 100), −8 % |
| Grocery queue, owner's real decisions applied | 37.8 / 100 (as documented for the deployed v2.0) | 580 = 24.4 / 100, −35 % |

Tuning used only the development part of the evaluation set and the engine's own output audits (below). Parameters chosen on development data are named in the code: the kind-difference threshold (`wcKind < 0.15` for titles whose last words are disjoint), and the "same name" route's title-difference limit (0.2). A tie-breaking similarity score was tried and **reverted** (it lost a surfaced positive and gained nothing).

### What changed in the engine (all in `packages/core/src/match/`)

* **Vehicle identity.** A word the title puts in front of a model name changes the model (Cherokee ≠ Grand Cherokee: `subjectChain`); the kind of part standing between the vehicle and the year no longer hides the vehicle ("Ford Focus LED Bulbs (2015-2018)"); a bare number shared by two different vehicle lines is not agreement (Transit-250 ≠ F-250).
* **Kind of product.** Vehicle names no longer count as shared description (floor mats ≠ a side-marker light; "4Runner" splits into "runner" in title words, which leaked); "LED" in both is not a shared kind; a decoder or resistor a few words before the end of the title is still a companion part; the earlier matcher's "comparable" verdict can no longer override a differing kind.
* **Groceries.** New route: the same name in a different word order, with a size one listing leaves out or states in another unit, is proposed as the same product (medium tier, the missing size stated). It requires the core names to be the same word set and the full titles to differ by little weight; the first, looser versions were audited and rejected (a quarter to a third wrong: "Original" vs "Strawberry"). The "same lead word, only the size differs" rule now requires the same names too, except for the same unit size in a different pack count with one descriptor word apart ("Fiji Artesian Water 1L" vs "Fiji Water 1 L – 6 pack"): two random 30-pair audits of the whole grocery queue (different samples, before and after) went from 18 right / 6 clearly wrong (flavour and variety errors) to 27 right / 2 wrong.
* Per-website limit left at **3** per source variant: measured on development data, keeping 2 loses one of the 21 surfaced positives, keeping 3 loses none (rank positions: 1st 14, 2nd 6, 3rd 1); keeping 1 would lose a third.
* Tests: `engine.test.ts` has 46 tests (37 before this round), 332 in `packages/core`, with a regression test per rule above (Cherokee/Grand Cherokee, Fiesta/Focus, floor mats, decoder, wiper blade, Transit/F-250, the name route and its flavour guard, the flavour/variety guard on size variants). The whole suite on the final v2.4 code: 1,131 tests in 73 files passed; repo-wide typecheck clean, eslint 0 errors (the two documented `any` warnings), `npm run build` succeeds.

## 3. Audits of the engine's own output (precision cannot be read from the labelled pools)

Random product pairs from the engine's own suggestions, labelled by title by the assistant; "ambiguous" = vehicle-bundle vs generic bulb, colour or feature differs, or the title cannot settle it. Counted both ways:

| Sample | n | right | clearly wrong | ambiguous | precision (strict – lenient), Wilson 95 % |
|---|---|---|---|---|---|
| Automotive, v2.2 before the last fixes (all tiers) | 60 | 36 | 6 | 18 | 60 %–90 % (47–71 % / 80–95 %) |
| Automotive, v2.3 (all tiers) | 40 | 27 | 4 | 9 | 68 %–90 % (52–80 % / 77–96 %) |
| — strong tier of the two samples | 36 | 27 | 1 | 8 | 75 %–97 % (59–86 % / 86–99 %) |
| Grocery whole queue, v2.3 | 30 | 18 | 6 | 6 | 60 %–80 % |
| Grocery whole queue, **v2.4** | 30 | 27 | 2 | 1 | 90 %–93 % (74–97 % / 79–98 %) |
| foodstore2go (held-out website), v2.2 | 40 | 35 | 2 | 3 | 88 %–93 % (74–95 % / 80–97 %) |

Remaining clearly wrong automotive suggestions are of four kinds: a vehicle name destroyed by the site's own phrase ("Fit for 2009 Honda **Fit**" loses "Fit" as site vocabulary), a two-digit year range ("(18-21)") that is not read, the same model number on different vehicle lines ("ProMaster 1500" vs "Ram 1500"), and a colour- or feature-specific generic bulb matched to a vehicle bundle. They are **not fixed**.

## 4. Why ≤ 30 per 100 and ≥ 90 % recall do not both hold on the automotive catalogue

The workload cannot fall below the number of genuine counterparts a reviewer must be shown. On the independent pools there are very roughly 0.8–0.9 genuine counterparts per source product with liberal substitute labels (an estimate from pooled samples, not a census), and 60–90 % of what the engine shows (§3) is a genuine stand-in. Most of the 182 product pairs per 100 are real: one 9005 bulb has acceptable stand-ins on three other websites, and a vehicle bundle has one for each socket it contains. Cutting the list harder removes genuine matches: measured on development data, 53 product pairs per 100 keep two thirds of the surfaced positives. So **the 30-per-100 target was not met for automotive and no cap was used to fake it**; the first-run backlog is large because every competitor bulb of the right socket is a legitimate suggestion, and the number drops as decisions accumulate (grocery: 53.8 → 24.4 per 100 once the owner's decisions are applied). A product-level review unit in the interface (confirm all variants of one product pair together) would reduce the *clicks* but not the pairs, and **was not built**; the work is reported at both levels throughout.

## 5. Evaluation set and the second reviewer

**The evaluation set is kept locally and is git-ignored on purpose:** the repository is public and the file lists competitors' product titles and production row ids (decision for the owner: publish it or not). The scripts and this report are committed. `fixtures/matching/eval-v1/eval-set.json`: 486 labelled product pairs (99 positives, 41 uncertain labels kept as uncertain), 55 products with no counterpart; development 353 (84 positives), held-out 133 (15 positives: website foodstore2go; category: non-lighting automotive accessories). Candidates were pooled from three independent retrievers (TF-IDF, rare-token, random) and the enriched overlap, never from this engine. Hash and engine files are recorded in the work log.

Second reviewer: `fixtures/matching/eval-v1/second-review/review-sheet.csv` (120 pairs, 92 development / 28 held-out, 24.7 % of the set, stratified by the first label, random order, first labels removed) with `REVIEW-GUIDE.md` and a private `mapping.json`. When the sheet comes back: `npx tsx scripts/match-kappa.ts <filled sheet>` prints agreement and Cohen's kappa (six classes, "genuine counterpart or not", "same product or not") and lists every disagreement; it edits nothing. The script was smoke-tested only with synthetic labels.

## 6. What is not established or not done

* Strong-tier precision (≥ 90 % lower bound), recall ≥ 90 %, candidate recall per website, the 2 % no-counterpart bound: not met or not demonstrable (§1).
* Held-out: a fresh held-out set (a different website and category) is needed before any validation claim, because the current one has been looked at.
* No product-level review screen; `Matches.tsx` and `Prices.tsx` are unchanged this round (relationship label, evidence tier, explanation and the four honest empty states from v2.0 remain; no percentages; substitutes separate). They were not re-driven in a browser this round.
* Memory and runtime on the production t3.micro; a bounded shadow run.

## 7. Server

SSH timed out at the AWS security group (the laptop's address is now different from the rule). Nothing was run on, or deployed to, the server in this round. To continue: set the SSH rule to this laptop's own public address /32 (`curl https://checkip.amazonaws.com`), then a bounded run under `systemd-run --scope -p MemoryMax=… -p MemorySwapMax=0` outside the 05:30 UTC collection, and `sudo shelfwatch-update` after a verified backup. Rollback and the deployed state are in `docs/matching-engine-v2.md` §7b.

## 7b. The review workbook for the second reviewer (evaluation preparation only)

The CSV sheet of §5 was replaced by an Excel workbook (`Shelfwatch-pair-review.xlsx`, kept outside the repository) with the same 120 pairs and the same `rv-…` references. Per pair: both products' names, websites and **stored** page links (a link is shown only if it is the address Shelfwatch stored for that product, on that product's own website, using the same `productPageLink` rule as the app; otherwise "No stored link"), their stored details (brand, barcode, part number, size / pack, variants and options, category, tags, description), and a side-by-side check (Agree / Differs / Check / Missing; facts read from a title are marked "from the title"; a missing detail is never assumed equal). Drop-downs for the six labels and for "unsure", filters, frozen header, a "Start here" sheet with the label meanings, and a "Side by side" sheet with every detail. `your_label` is blank; `AI_suggestion` / `AI_explanation` are empty on purpose (a suggestion shown first would bias an independent review); the first labeller's labels, the engine's verdicts and production row ids are not in the file.

The local development database holds the complete grocery catalogues, so the 53 grocery pairs are filled from it (matched by website and exact title: 48 pairs for both products, 5 for one product because two stored products share that exact title and none is shown). The 67 car-lighting pairs have **no stored details in that copy** (those catalogues exist only on the server): they show names and title-based facts and say so per row. When the server is reachable again, regenerate with the production export; answers already given are carried over by Ref:

```
npx tsx scripts/match-review-data.ts --mode sql --out <folder outside the repo>/query-production.sql     # read-only query, products picked by stored id
ssh <server> 'sudo -u postgres psql -d competitor_intel -q -At -f -' < query-production.sql > records-production.json
npx tsx scripts/match-review-data.ts --mode local --out <folder outside the repo>/records-local.json     # local database must be running (npm run dev:db)
npx tsx scripts/match-review-xlsx.ts --records records-production.json --records records-local.json --carry <current workbook> --out <new workbook>
npx tsx scripts/match-kappa.ts <returned workbook>                                                      # agreement, after the answers come back
```
All three scripts refuse to write inside the repository. No matching code, decision or server was changed to make the workbook.

## 8. How to reproduce

```
npx tsx scripts/match-eval-set.ts --auto-data dataset-adi.json --grocery-data dataset-Aditya.json --set dev|heldout|all [--out report.json]
npx tsx scripts/match-eval.ts --data dataset-Aditya.json --engine v2        # grocery regression on accepted decisions
npx tsx scripts/match-review-sheet.ts                                      # regenerate the second-reviewer sheet
npx tsx scripts/match-kappa.ts <filled sheet>                              # agreement after the second review
```
The production exports (`dataset-*.json`) contain the owner's catalogue and were kept outside the repository and deleted afterwards.
