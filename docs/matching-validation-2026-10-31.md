# Universal matching, activated: what was built, what it does on real data, what is still weak (directive 20, 2026-10-31)

Request: `docs/original-prompt/20_DIRECTIVE_ACTIVATE_UNIVERSAL_MATCHING_2026-10-31.md`. Builds on `docs/matching-validation-2026-10-30.md` and `docs/matching-engine-v2.md`.

**Verdict.** The new matcher (`match-v2.8`) is **live and active in all three production workspaces**. It sorts every pair into same product / same product in another pack / substitute / related / not a match / not enough evidence, explains each one, and the application shows the first four separately. In the grocery workspace it also **confirms clear-cut matches automatically** (214 pairs, on a pre-stated reliability bar that was met). Nothing a person decided was changed. **The acceptance criteria are still not all met** (recall about 58–62 %, candidate recall below 95 % on some websites, strong tier too rarely used to prove) and every label behind these numbers is the assistant's, not an independent person's. Details below.

## 1. What was implemented

| Layer | What it does |
|---|---|
| Understanding a listing | Reads each product (and each variant) for identifiers, part codes, years and vehicle, specifications, colour and mode, pack, bundle markers and the kind of thing it is. **Product descriptions are now read** for a "Location / Bulb Size / Watt-Lumens" chart: the variant's own position (Low Beam, Backup Light …) is looked up in it, so a vehicle kit's variant gets its real bulb size and power. |
| What the catalogue says about itself | Read from the data, nothing per category: alias codes (H4 = 9003 = HB2), which words name a vehicle, which words are a maker, which words name a kind of product, which kinds are never seen together ("mat" and "bulb"), which positions each part code is used for. |
| Finding candidates | Several independent keys per competitor website (identifier, shared code, vehicle words, rare words, names). Broad on purpose. |
| Judging a pair | Typed evidence (agrees / differs / conflicts / missing), not one score. A conflict ends the question; a missing fact is **not** a conflict. Names are aligned even without a brand field (same rare maker word, spelling variants, a maker named on one side only → at most a substitute). Same-kind products from different makers are stand-ins. Two vehicle kits are related unless both name the same model. A code that is the only link needs a shared kind. |
| Result | exact · variant · substitute · related · not a match · insufficient, each with a tier (strong / medium) and the evidence in plain words. The closest alternative ranks first. |
| Deciding what happens | A person's decision always wins and is never changed. With **automatic confirmation** on (a workspace setting, off by default) the engine confirms only pairs that meet its fixed policy; each is marked, recorded in the pair's history and can be overruled; turning the setting off takes every one back at once. |

**Approaches considered and why not others.** A learned model (embeddings, an AI judge) would need paid services or a larger server (neither approved), could not explain a verdict, and cannot be trusted on this little verified data; the evidence model already beats pure text similarity here because the decisive facts (socket code, model, years, size) are structured. It stays optional in the design. Fixed per-website rules were rejected: every rule above is read from the data or stated for any shop.

## 2. Automotive and other categories

* **Sockets and aliases:** codes are read from titles, variants and the description chart; aliases are learned (7443/7440/T20 …). A missing code is "unknown", a different code is a conflict. H11 and H7 never match; H11 from two brands is a substitute without any barcode.
* **Vehicle:** make → head model from the title (Cherokee ≠ Grand Cherokee, Transit ≠ F-250, F-250 Super Duty = Ford 250), years and ranges, "not for", adjacent generations (same bulb size but another generation = related).
* **Function:** position tokens (low/high beam, fog, backup, brake, dome, license plate …); a variant does not inherit a title's code for a position that code has never been seen with (a dome light is not an H7).
* **Technology, power, light output, colour temperature, colour mode:** extracted as specifications; hard ones (voltage, length) conflict, soft ones (power, light output) are listed as differences; a switchback bulb is not a stand-in for a single-colour bulb of the same socket.
* **Kits, adapters, decoders:** bulb ≠ adapter/decoder/harness/socket accessory (related); a combo is not a single bulb.
* **Accessories** (mats, steps, brackets) are not offered as stand-ins for a vehicle's bulbs: 19 of about 1,350 accessory variants still get a wrong suggestion (1.4 %).
* **Groceries and anything else** use the same engine: names without brand fields, spelling, flavour/variety/edition/formulation words, product forms ("strained" pear ≠ fresh pear), packs and sizes (per-unit prices), cross-brand stand-ins of the same kind.

## 3. Evidence

**Labels.** 486 development pairs and 330 fresh pairs (below) were labelled by the assistant under written policies (P1–P6, in the 2026-10-30 report); none by an independent person. The fresh set was labelled **before** the final engine saw it and covers products never pooled, labelled or audited before.

**Development set** (486 pairs, 98 genuine; tuned on; includes everything examined earlier):

| | start of this work (v2.7) | final (v2.8) |
|---|---|---|
| Strong tier | 16 of 17 | **23 of 23** (lower bound 85.7 %) |
| Strong + medium: right / proposed | 53 / 57 (93.0 %) | 61 / 67 (91.0 %) |
| Recall of genuine matches | 54.1 % | **62.2 %** (lower bound 52.4 %) |
| Automotive: precision / recall | 89.3 % / 64.1 % | 92.6 % / 64.1 % |
| Grocery: precision / recall | 96.6 % / 47.5 % | 90.0 % / 61.0 % |
| Candidate recall @10 | 91.8 % | 92.9 % (automotive 89.7 %, grocery 94.9 %) |
| Products with no counterpart given a suggestion | 0 of 55 | 0 of 55 |
| Proposed as "same product / other pack": agree with label | 27 of 28 | 31 of 33 |
| Genuine **grocery substitutes** found (0 before) | 0 of 19 | 4 of 19 |

**Fresh set 3** (330 pairs from products never used before; 69 genuine, 38 related, 212 non-matches, 11 insufficient; 6 sources with no counterpart). Two readings, reported separately:

| | frozen engine, first and only look (independent of engine tuning) | final engine (after I fixed what that look exposed, so no longer independent for those fixes) |
|---|---|---|
| Strong tier | 3 of 3 | 4 of 5 |
| Strong + medium: right / proposed | 38 / 43 (88.4 %) | 40 / 45 (88.9 %) |
| Recall | 55.1 % (lower bound 43.4 %) | 58.0 % (lower bound 46.2 %) |
| "Same product / other pack" proposals right | 21 of 21 | 21 of 21 (lower bound 84.5 %) |
| Stand-ins right | 16 of 22 (72.7 %) | 18 of 24 (75.0 %) |
| Candidate recall @10 | 82.6 % | 85.5 % (the automotive websites 50–80 %) |
| No counterpart given a suggestion | 0 of 6 | 0 of 6 |

What that first look exposed, fixed and re-measured: a part code such as "H7" was being read as part of a vehicle's name on one shop's titles (so its kits lost their bulb size), which also let model numbers ("Ram 1500") act as part codes and offer **bed mats as stand-ins for bulbs** (18 of 55 accessories in the first deployment of that rule, found by an audit of the live suggestions). Both are corrected (above); the cost is a little recall.

**Audits of unlabelled output** (my judgement, random samples): 30 of 30 "same product" and 26 of 26 "other pack" proposals from the new name rules were right; automotive stand-ins in a 60-pair sample were mostly plausible with a handful of wrong or related-only cases, which led to the rules in section 1 about shared codes and vehicle kits.

**Automatic confirmation: the bar was fixed first, then measured** (a class qualifies only if the lower 95 % bound on agreement with decisions/audit is at least 95 %):

* *Same product* (identifier, or same maker, identical names, both sizes stated and equal): 624 pairs in the real grocery catalogue; **all 624 are pairs you accepted** (lower bound 99.4 %).
* *Same product in another pack* (same, but sizes both stated and different): 247 pairs; your 37 accepted decisions plus a fresh random audit of 80 of the remaining 211 (**80 of 80**) = 117 of 117 (lower bound 96.8 %). Two earlier audit rounds found 3 of 60 and 2 of 70 wrong (a spray against a spread, "with sunscreen", "Original" against "Natural"); the policy was tightened (identical names, edition words) and re-audited on a new sample.
* Automotive: no exact/other-pack pairs exist across different makers, so nothing is auto-confirmable there, and the setting is **off** in that workspace.
* Known flaw in auto-confirmed other-pack pairs: a leading pack count in a title ("24 Poland Spring …") is not read, so its per-unit price is overstated. The identity is right; the per-unit difference is wrong for such titles.

## 4. Production (real server, real records)

| | Before | After |
|---|---|---|
| Engine per workspace | `v1`, `v1`, `v1` | `v2` ×3 (grocery with automatic confirmation **on**, automotive **off**, the empty third workspace has nothing to match) |
| Your decided pairs | 705, fingerprint `1ba327b6…` | 705, **identical fingerprint**; no duplicate pairs |
| Products / variants | 11,215 / 21,993 | unchanged |
| Migrations | 14 | 15 (`0014`, two additive columns, rehearsed on a copy of the local database first) |

**Grocery workspace (live):** 919 same-product pairs confirmed (662 + 43 by you, 214 automatically); 255 waiting for a decision; 1,657 suggested substitutes; 1,500 related or unclear. Price comparison: confirmed 679 of your products with 710 competitor prices (612 directly comparable, 98 other-pack by unit price); with suggestions 791 products / 904 prices; substitutes view 708 / 1,126; related view 670 / 872. A second run created 0, changed 0, left 3,571 unchanged.
**Automotive workspace (live):** 23,108 suggested substitutes (2,285 strong), 1,175 related, 1,289 insufficient; substitutes view 5,604 of your variants with 12,765 competitor prices; related 965 / 1,175. Nothing waits for a decision. A repeat run left all rows unchanged.

**Server limits (t3.micro, 913 MB), measured through the real background worker with the API polled every 4 s:** grocery 15–21 s, worker 170–193 MB; automotive 137–173 s, worker 327–368 MB; the API answered every health check in every run (more than 200 checks); the host's lowest free memory was 27 MB before a memory fix (the saving step no longer loads each row's evidence text) and 79–97 MB after. **It fits but with little headroom**; running two heavy jobs at once, or a bigger catalogue, is not safe on this size.

**What I could not do:** sign in to the application (I never enter passwords), so there was no logged-in click-through. Instead the *same* Price comparison and Match review code ran read-only on the live records (`scripts/ops-match-report.ts`), the deployed website bundle was checked for the new screens and labels, and the new endpoints answer 401 without a login. Please open Price comparison and Match review once.

## 5. Acceptance criteria (design G.5)

| Criterion | Target | Measured | Status |
|---|---|---|---|
| Candidate recall @10 per website | ≥ 95 % | dev 92.9 % overall; fresh 85.5 % (automotive websites 50–80 %, groceries 93–100 %) | **Not met** |
| Strong-tier precision, lower bound | ≥ 90 % | dev 23/23 (bound 85.7 %); fresh 4/5 (bound 37.6 %) | **Not demonstrated** (strong tier is rarely used) |
| Recall of strong + medium | ≥ 90 % | 62.2 % dev; 58.0 % fresh | **Not met** |
| No-counterpart false suggestions | ≤ 2 % | 0 of 55 and 0 of 6 (upper bound 6.5 % on the larger set) | **Observed 0; cannot be proven at 2 %** |
| Review workload | ≤ 30 per 100 | items needing a decision: grocery 255 product pairs = 10.7 per 100 of your products; automotive 0 (stand-ins need no decision and are shown with their differences). Counting every suggestion as work, as before, would be about 80 per 100 for groceries | **Met under the new definition; not under the old one** |
| Decisions preserved on rerun | 100 % | 705 of 705 identical; reruns create nothing new | **Met** |
| Grocery regression | ≥ 95 % | 701 / 705 = 99.4 % | **Met** |
| Resources | ≤ 10 min, ≤ ~600 MB, no paid calls | measured above; no paid service | **Met, thin margin** |
| Nothing shown as verified that is not | | every price is labelled person / automatic / suggested; suggestions never count towards "cheapest" | **Met** |

## 6. What is still weak, and why

* **Recall is about 58–62 %.** Misses are mostly: vehicle kits whose combo variants hold several bulbs and whose sockets are only in a chart that about a quarter of listings have; a vehicle named without years (not read as a vehicle); abundant same-socket stand-ins where only two are stored per website; cross-brand grocery stand-ins whose names share little ("Glutino crackers" against "AH cassava crackers"); sparse titles.
* **Fresh-set candidate recall for the automotive websites is 50–80 %.**
* **Stand-ins are suggestions**: about one in five or six shown as "suggested" will be wrong (75–85 % precision measured).
* **Accessories**: 1.4 % of mats/steps still get a wrong stand-in suggestion.
* **Unit prices** depend on size parsing; leading pack counts ("24 Poland Spring") are not read.
* **The strong tier is rarely predicted** (2 grocery pairs, about 2,300 automotive), so its precision cannot be bounded tightly.
* **Everything is judged by the assistant**; the review workbook for a second reviewer still exists and would be the next independent check.
* **Memory headroom on the server is thin** during an automotive run.

## 7. Operating it, rolling back, evaluating the next change

* **Settings → Product matching:** the matcher and "confirm clear-cut matches automatically" per workspace. Turning automatic confirmation off returns its confirmations to the review list immediately; switching the matcher back to the earlier one needs no data change (the new suggestions stay as history). A backup was taken before each step (the latest 36 MB, read back).
* **Re-run:** the button "Run matching again", or `scripts/ops-run-matching.ts <workspace id>`; the daily schedule runs it after collection.
* **Evidence at any time:** `scripts/ops-match-report.ts` (read-only) prints the counts by relationship/confirmation, the last run and the real comparison and review output.
* **Next change:** develop on the development set and on audits of the live suggestions; freeze the engine (file hashes) before opening a fresh set once; report precision and recall with and without uncertain labels per domain; state which labels are AI-made. Fresh set 3 is now development data for the fixes it exposed. Sets and labels live outside the repository (`fixtures/matching/eval-v3/` is git-ignored).
