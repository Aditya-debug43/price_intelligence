# Shelfwatch — Universal Product-Matching System: research, diagnosis and recommended design

Status: **APPROVED 2026-10-29 and implemented — see `docs/matching-engine-v2.md` for what was built, how it was measured and which gates are still open.** (Original status: proposal for review.)
No application code, thresholds, migrations, database rows, jobs or deployments were changed while preparing it. All data access was read-only; all experiments ran in a scratch directory outside the repository.

Date: 2026-10-29. Author: Claude (Sonnet 5.5), for the Shelfwatch owner.

How to read the evidence labels used throughout:

- **[Demonstrated]** — measured by me on Shelfwatch's own data in this investigation, or reported by the cited authors on their benchmarks.
- **[Judgement]** — my engineering inference. It is reasoned, but not proven for Shelfwatch.
- **[Unknown]** — we do not have the data to say yet; section G says how we would find out.

---

## 0. Summary and the decisions I need from you

**Recommendation (one architecture).** Replace "score every pair with brand/GTIN/MPN/size rules" with a **staged, evidence-based matcher**:

1. build a typed *dossier* per product (identity codes, fitment ranges, numeric specs, colour and pack attributes, with provenance per field);
2. retrieve candidates with several independent keys (never skipping common tokens, never relying on one similarity score);
3. score each candidate pair with an **explainable evidence model** that produces a *relationship* (exact / same-product-variant / substitute / related / not-a-match / insufficient-evidence) plus the list of facts behind it, with hard-conflict vetoes;
4. send only the grey zone to an optional, budget-capped LLM that may answer "insufficient";
5. keep humans in charge: confirmed/rejected decisions are pinned and never overwritten, every human decision becomes a labelled example, and probabilities are only shown after they are calibrated on those labels.

**Why this and not "just use an LLM / embeddings / lower the threshold"** — see B and the measured pilot in G. In short:

- A single similarity threshold cannot separate substitutes from near-misses: the best TF-IDF threshold reached **F1 0.70–0.76 at 54–70 % precision** on my pilot samples.
- A hand-written rule set tuned on one sample **did not generalise** to a held-out source website (**strong-tier recall fell from 75 % to 15 %**; section G.2–G.3). That is the main reason the proposal insists on a labelled held-out evaluation and learned/calibrated weights, rather than more hand-tuned rules.
- Neither of those failures is a retrieval problem. The current engine's failure is entirely in its pairwise decision rules (A).

**What I need from you before anything is built:**

| # | Decision | My default if you have no preference |
|---|---|---|
| 1 | Approve (or amend) this architecture | — |
| 2 | Approve the acceptance criteria in G.5 (defined *before* implementation) | as written |
| 3 | Labelling commitment: ~300 reviewed pairs on held-out sites/categories. I can pre-label and you audit a random 100, or you label. | pre-label + you audit 100 |
| 4 | Is paid LLM use allowed at all? Estimated cost is ~$0.3–0.5 for a one-off extraction pass and ~$1 per full grey-zone pass (H). | **off** until you opt in, with a hard monthly cap |
| 5 | Should Price Comparison show *unconfirmed* "suggested substitutes" (clearly badged), or only human-confirmed matches? | confirmed only; suggested substitutes behind a switch |

---

## A. Diagnosis of the current system

### A.1 What the data shows [Demonstrated]

- Workspace `adi` (automotive): `product_matches` has **0 rows** — Match Review and Price Comparison are empty because there is nothing to show, not because of a display bug.
- Catalogue sizes: lasfit 1,129 products / 9,199 variants (the owner's shop), auxito 1,483 / 3,602, allalighting 406 / 696, sealight-led 528 / 528.
- Replay of the engine on production data (read-only): token blocking produced about **387,582 candidate pairs**, and the pairwise scorer returned **no match for any of them**. Retrieval is not the problem; the **decision rules** are.
- The grocery workspace shows the engine *does* work where its preconditions hold: 705 human-accepted pairs (662 identical, 43 different-pack), all proposed by name similarity, plus 1,351 awaiting review and no rejections.

### A.2 Why the rules produce nothing on automotive accessories [Demonstrated by code reading + replay]

Files: `packages/core/src/matching.ts`, `packages/core/src/text.ts`, `packages/services/src/matching.ts`.

1. **Every positive rule needs a signal these catalogues do not have.** A pair is accepted only via GTIN, brand + MPN, same brand + same total size, or name similarity ≥ 0.7 *and* the same known quantity kind. Automotive titles rarely carry GTIN/MPN, the competing brands differ by definition (private label), and weights/volumes do not exist — an unknown size makes the pair `null`.
2. **The name comparison deletes the most discriminating tokens.** `coreNameTokens` strips sizes and *all* pure-digit tokens, so bulb codes (`9005`, `7443`, `2825`) and model years vanish before similarity is computed. Two titles can differ only in those tokens and look identical, or share them and look unrelated.
3. **Blocking skips common tokens** (`maxPosting 2500`: `led`, `bulb`, `light` are ignored), and variant-level pairing makes multi-variant Shopify products explode the pair count.
4. **The relationship vocabulary is too small.** The classes `identical / different_pack / comparable / not_comparable` cannot express "different brand, same socket codes, same function" — the relationship that actually exists in this market — without calling it "identical".
5. **Reruns delete stale `auto`/`needs_review` rows**, so suggestions have no history and a human cannot see why something disappeared.
6. **The empty-state wording** on Match Review ("Nothing to review") reads as "all done" when it means "no candidates were ever produced".

### A.3 What the catalogues do offer [Demonstrated]

Identity-bearing signals sit in places the engine ignores: socket/part codes in titles (`H11/H8/H9`, `211-2 578 212-2`), fitment year ranges, tags and categories, variant option axes (Location, Trim, Color, Series, Package, Make Year, Size …), long descriptions (4–5.6 K characters on lasfit/auxito), image URLs and SKU patterns.

### A.4 What this implies [Judgement]

In private-label categories, **exact cross-merchant identity is rare**. The commercially useful output is *"functional substitute with a stated list of agreeing and differing attributes"*, shown honestly as such. A matcher that only knows "identical" will return nothing; one that is forced to fill the queue will return false matches. The fix is a richer, explicit relationship model with evidence, not a lower threshold.

---

## B. Research findings

All sources below were consulted during this investigation (titles abbreviated; full references on request). Where I give numbers they are the authors' reported numbers on their benchmarks, not Shelfwatch results.

| Approach | Source consulted | What was demonstrated | Strengths | Weaknesses | Fit for Shelfwatch |
|---|---|---|---|---|---|
| Classical blocking + similarity-join pipelines | Papadakis et al., blocking & filtering survey (ACM CSUR 2020); Konda et al., *Magellan* (PVLDB 2016) | Entity-resolution systems are a pipeline (block → match → cluster); blocking quality bounds overall recall; end-to-end systems need human-in-the-loop labelling and debugging | Cheap, explainable, runs on a small CPU | Lexical blocking misses paraphrases; thresholds do not transfer between categories | **Keep as stage 1**, but multi-key and measured by candidate recall |
| Deep blocking | Thirumuruganathan et al., *DeepBlocker* (PVLDB 2021) | Embedding-based blocking can raise recall on dirty/textual data | Finds non-lexical candidates | Needs a model + vector search; gains depend on data | **Optional, only if held-out recall gain is proven** (not needed on current evidence, see G.4) |
| Supervised deep matchers | Mudgal et al., *DeepMatcher* (SIGMOD 2018); Li et al., *Ditto* (PVLDB 2021, up to +29 % F1 over earlier approaches, strong label efficiency) | Fine-tuned transformers beat classic matchers on textual/dirty pairs with enough labels | High accuracy in-domain | Need labelled pairs per domain; GPU for training; opaque | **Not first**: we have no labels yet. Candidate later (needs ≥ thousands of labels) |
| Hard-benchmark evidence | Peeters, Der, Bizer, *WDC Products* (EDBT 2024) | Benchmark with corner cases and **unseen entities**; ground truth from GTIN/MPN/SKU clustering with ~4 % noise; supervised models (Ditto, HierGAT, R-SupCon) fall to roughly **F1 51–69** on 80 % corner cases with unseen entities | Shows real-world difficulty | — | Justifies evaluating on held-out entities/sites, not random splits |
| LLMs as matchers | Peeters & Bizer, *Entity Matching using Large Language Models* (EDBT 2025) | GPT-4 zero-shot **F1 89.61** on WDC Products vs RoBERTa 77.53 and Ditto 84.90; pre-trained matchers trained elsewhere dropped to 16–55 F1; cost reported ≈ 0.006 ¢/pair (small GPT) to 0.474 ¢/pair (GPT-4); no single best prompt | No training data needed; generalises across categories | Per-pair cost; non-deterministic; can sound sure when wrong | **Optional stage 3 for the grey zone only**, evidence-bound, budget-capped |
| Fine-tuning LLMs | Steiner, Peeters, Bizer, *Fine-tuning LLMs for entity matching* | Fine-tuning helps in-domain and can **hurt cross-domain** | Higher in-domain accuracy | Cross-domain risk contradicts "universal" | Do **not** fine-tune per category as a default |
| LLM attribute extraction | Brinkmann et al., *LLMs for product attribute-value extraction* | GPT-4 reached about **F1 85 %** extracting attribute values from titles | Turns unstructured titles into typed fields; extraction is far cheaper than pairwise judging (linear, not quadratic) | Errors need validation; hallucinated attributes | **Good use of an LLM**: extract once per product, cache by content hash, validate against the source text |
| Foundation models for data wrangling | Narayan et al., *Can Foundation Models Wrangle Your Data?* (PVLDB 2022) | Few-shot prompting is competitive on entity matching/imputation | Low engineering cost | Cost/latency at scale | Supports a small adjudication stage, not a full pipeline |
| Sentence embeddings | Reimers & Gurevych, *Sentence-BERT* (EMNLP 2019) | Bi-encoder embeddings make similarity search cheap versus cross-encoders (their example: ~65 h vs ~5 s for all-pairs on 10 K sentences) | Fast candidate retrieval | Coarse: embeds "H11 vs H7" and "fits Camry vs fits Civic" as near-identical | Possible blocking add-on; **never** a decision-maker |
| Probabilistic record linkage | Fellegi–Sunter model (1969); Splink (open source) | Per-field match/non-match likelihood weights add up to an explainable score; works with missing fields (a missing field contributes nothing) | Explainable, handles incomplete attributes, can be fitted without labels (EM) and refined with labels | Assumes field independence | **Core of stage 2**: the structure fits the evidence-list requirement |
| Probability calibration | Guo et al., *On Calibration of Modern Neural Networks* (ICML 2017) | Scores from complex models are poorly calibrated; temperature/Platt scaling fixes much of it with a small validation set | Makes "87 %" mean something | Needs labels | Used in stage 5; **no percentage shown until calibrated** |
| Small local embedding model | `all-MiniLM-L6-v2` model card (22.7 M parameters, 384-d, Apache-2.0), runnable via transformers.js on Node CPU | Small enough for CPU | No API cost | Adds ~100 MB to memory; unmeasured speed on a t3.micro | Defer; measure first (H) |

**Cross-cutting findings [Demonstrated by the sources]:**

- Generalisation to **unseen entities/domains** is the weak point of trained matchers; LLM zero-shot is the more robust baseline.
- Candidate generation bounds recall; matching quality cannot recover what blocking drops.
- Ground-truth from identifiers (GTIN/MPN) contains noise and is biased towards products that *have* identifiers — directly relevant to us, where the products of interest often have none.

**What the literature does not settle [Unknown]:** how any of these behave on private-label automotive accessories with sparse identifiers. That is why G contains a measured pilot on our own data.

---

## C. Recommended architecture

```
 collected products + variants
          │
 0. DOSSIER (per product; variant axes kept)       ← typed tokens, provenance per field
          │      optional LLM attribute extraction (cached by content hash)
 1. CANDIDATE GENERATION (multi-key, recall-measured)
          │      identity codes · type words · fitment buckets · char n-grams · identifiers
 2. EVIDENCE MODEL (explainable, hard-conflict vetoes)
          │      → relationship + evidence list + tier (strong / medium / insufficient)
 3. GREY-ZONE ADJUDICATION (optional, bounded LLM, may say "insufficient")
          │
 4. SUGGESTIONS STORE (versioned, never deleted)  ──►  Match Review queue
          │                                              │ accept / reject / re-label
 5. DECISIONS (pinned, human-only)  ◄────────────────────┘ ──► Price Comparison
          │
 6. LEARNING LOOP: labels → weights, calibration, evaluation dashboards
```

### Stage 0 — Product dossier

- Work at **product (listing) level** with its variants attached as *axes* (Colour, Size, Pack, Fitment …), not at raw variant level. This removes the pair explosion of multi-variant products and lets "does the competitor's colour exist among my variants?" be asked properly.
- **Typed tokens extracted without per-category lists [Demonstrated feasible in the pilot]:**
  - *Identity codes*: tokens with a letter/digit shape (`H11`, `9005`, `2825`, `578`), detected by shape; **house codes** (series names such as `X5`, `S2S`, `M6`, `IP68`) are detected from statistics — a code that lives ≥ 90 % on one website and appears ≥ 3 times is not an identity code.
  - *Fitment ranges*: years and ranges (`2011-2013`, `2019 2020`) parsed as ranges, never as codes (a bug I hit and fixed in the pilot: `2011-2013` was becoming the "code" `20112013`).
  - *Numeric specs with units*: sizes, power, pack count, temperature, volume, weight.
  - *Variant-axis vocabularies* (colour, size…): mined from the sites' own variant option values rather than written by hand. The pilot recovered white/red/yellow/blue/purple/green/black but initially mis-classified `xenon`; head-final extraction fixed that, and `amber` was lost by a coarse global ratio — so axis typing should be confirmed once per website, which is cheap and human-checkable.
  - *Exclusions*: "Not for Classic", "does not fit …" become negative constraints (this exact trap occurred in the Ram 1500 pair).
- **Keep fields separate.** In the pilot, concatenating the category text with the title leaked codes between unrelated products. Title codes, category, tags and description are separate evidence with separate weights.
- **Optional LLM extraction** for products whose typed tokens are too few (structured fields `product_type`, `pack_count`, `colour`, `fitment`). Output is validated: every extracted value must be locatable in the source text, otherwise it is discarded.

### Stage 1 — Candidate generation (recall first)

- Several independent keys, union of results: identity-code overlap, IDF-weighted type words, fitment-year buckets, character n-grams, and identifiers when present (GTIN, brand+MPN).
- **No skipping of common tokens**; IDF weights replace the `maxPosting` cutoff. Limit per source by *evidence-ranked top-k per website* rather than a flat 30.
- Candidate recall is a measured KPI (G), judged against an independent retriever and manual search.
- Optional embedding retriever only if the held-out experiment shows it adds recall that the lexical keys miss.

### Stage 2 — Evidence model (the decision core)

Features per pair, each producing agree / conflict / unknown:

| Feature | Behaviour |
|---|---|
| Identity-code containment (shared / smaller set) | Strong positive; multiple independent shared codes are stronger than one |
| Fitment-range overlap and "gap" | Overlap positive; disjoint-and-far → veto; adjacent generation (gap ≤ 2 years) → review |
| Product-type agreement (title words, category, extracted type) | Needed to separate "bulb" from "adapter/harness/decoder" sharing the same code |
| Numeric specs | *Hard* attributes (size, socket, pack count basis) vs *soft* attributes (wattage, lumens) — soft differences are reported, not vetoed |
| Colour / variant-axis compatibility | Candidate colours must intersect the source's colour set; disjoint → "related", not substitute |
| Bundle / switchback / combo marker on one side only | → "related" |
| Brand relation (same / different / unknown) | "Exact" requires the same manufacturer; different brands cap the relationship at "substitute" |
| GTIN / brand+MPN equality | Decisive and deterministic |

Weights: start from Fellegi–Sunter-style log-likelihood weights (explainable, tolerant of missing fields: an unknown field contributes nothing), then fit/refine them on the reviewed labels (logistic regression is enough). **Hard-conflict vetoes** remain explicit rules.

Output per pair: `relationship`, `tier` (strong / medium / insufficient), and an **evidence list** in plain language ("shares codes H4, HB2, 9003; both fog bulbs; wattage differs 40 W vs 100 W; colour not stated").

### Stage 3 — Grey-zone adjudication (optional)

Only pairs in the medium tier. The model receives just the two dossiers and must (a) choose a relationship, (b) cite which fields support it, (c) answer **"insufficient evidence"** when they do not. Temperature 0, structured output, cached by the pair's content hashes, hard budget cap. Result is stored as an additional suggestion tagged `source = llm`; it never accepts anything.

### Stage 4–5 — Suggestions, decisions and review

- Suggestions live in a **versioned store that is never deleted** (superseded, not removed).
- Human decisions (`accepted` / `rejected`) are the only thing Price Comparison trusts by default.
- Review queue ordering: strongest evidence first within each own product, plus the "most informative" uncertain pairs, so reviewer time also improves the model (active learning).

### Stage 6 — Learning loop

Every accept/reject/re-label is a labelled example. Weights and calibration are refit from them; evaluation reports are regenerated from the same labels (G).

### Why this is preferred [Judgement, supported by A, B and G]

- It fixes the actual defect (decision rules that need absent identifiers) while keeping retrieval, the job queue and the review UI.
- It is **explainable** for every suggestion, which the Match Review UI can show directly.
- It degrades gracefully: with no GTIN/MPN/brand it still produces substitutes backed by codes, fitment and specs; with nothing usable it says "insufficient".
- It costs nothing ongoing by default (CPU only); the LLM stages are optional and capped.
- It needs no per-category code: category knowledge enters as *data* (axis vocabularies, learned weights), see F.

---

## D. Matching decisions and what each relationship means

| Relationship | Definition | Evidence required | Features that suit it | Used in Price Comparison? |
|---|---|---|---|---|
| **Exact product** | Same product from the same manufacturer, different seller | GTIN equal, or brand + MPN equal, or same brand + same identity codes + same specs | Identifiers, brand, full spec equality | Yes (after confirmation; identifier-based may auto-accept) |
| **Same product, different packaging/variant** | Same item sold as a different pack count/size/colour | As exact, with a differing pack/size/colour axis | Pack count, size, colour axes, unit-price normalisation | Yes, with per-unit normalisation shown |
| **Equivalent / substitute** | Different brand, interchangeable for the same purpose | Same product type + agreeing key identity attributes (socket/part code, fitment, size class) + no hard conflict | Identity codes, fitment, type agreement; soft specs reported | **Only as "substitute"**, never labelled identical; opt-in display |
| **Related / compatible** | Belongs together or is adjacent, not interchangeable (adapter for a bulb, same vehicle different part, switchback vs single colour) | Partial agreement or an attribute conflict | Shared codes + type difference; colour/bundle conflicts | No (shown only in a separate "related" list) |
| **Non-match** | A hard conflict (different socket, size, non-overlapping fitment, "not for X") or no shared evidence | A veto fires, or zero shared identity evidence | Vetoes | No |
| **Insufficient evidence** | Cannot tell from the data available | One side lacks codes/fitment/size, or only one weak signal | Missing-field detection | No — routed to review, never forced |

Mapping to the existing schema: `identical` → exact; `different_pack` → same-product-variant; `comparable` → substitute; `not_comparable` → non-match; **related** and **insufficient** are new and additive (I).

---

## E. Confidence and review strategy

- **No invented confidence.** Until calibrated on real human labels, the UI shows a **tier** and the **evidence list**, never a made-up percentage.
- **Strong evidence** = at least two independent agreeing signals (e.g. ≥ 2 shared identity codes, or shared code + matching fitment + type agreement) and no conflict. **Medium** = one signal, or signals that disagree. **Insufficient** = a key attribute class is missing on either side.
- **Actions by tier:**
  - strong → appears at the top of Match Review as "suggested", one-click confirm; may appear in Price Comparison only as a badged "suggested substitute" if you enable that;
  - medium → review queue, with evidence and (optionally) an LLM opinion;
  - insufficient → listed with the reason and what information would settle it (e.g. "competitor listing has no bulb code");
  - non-match → hidden, but kept so reruns do not resurface it.
- **Auto-accept policy:** none for substitutes. The pilot's strong tier was not accurate enough to justify it (G). Deterministic identifier matches (GTIN, brand+MPN) are the only candidates for auto-accept, and only after they pass the acceptance criteria.
- **Calibration:** once ≥ ~200 labels per major stratum exist, fit isotonic/Platt calibration per tier and publish reliability (expected calibration error). Until then, tiers only.
- **Review workload** is a first-class metric: the pilot's grey zone was roughly 25–50 % of pairs, which is only sustainable with ranking, per-website top-k, and batch accept for strong-tier pairs.

---

## F. Universal applicability without per-category rewrites

What is generic [Demonstrated feasible in the pilot]: shape-based identity codes, fitment/year ranges, unit-bearing numbers, IDF statistics, "house code" detection, variant-axis vocabularies mined from structured options, negation parsing, relationship taxonomy, evidence combination.

What is category knowledge, and where it lives instead of in code:

- **Axis vocabularies** (colour words, size units) — mined from each site's variant options, confirmed once per site.
- **Which attributes are hard vs soft** — a small, editable table keyed by attribute *type* (size/socket/fitment hard; wattage/lumens soft), refined by review outcomes, rather than per product category branches.
- **Product-type signal** — from category/product_type fields and the optional LLM extraction. This is the weakest part of the prototype: title-word overlap could not reliably tell a bulb from an adapter sharing the same code (G.3). It needs these structured sources.
- **Groceries/household/electronics** differ mainly in which identifiers exist (size/volume/brand/UPC vs sockets/fitment) — the evidence model simply has more or fewer features that fire, and the existing size/brand/GTIN rules become two of its features rather than the whole engine.
- **Cross-check available now:** the grocery workspace's 705 accepted pairs can test that the new engine still recovers what the old engine and a human already agreed on (regression gate in J). This is biased because those pairs exist only because the old engine proposed them [Judgement].

---

## G. Accuracy evaluation

### G.1 Method used in this investigation (a pilot, not a certification)

- **Pooled candidates:** for sampled source products, the top-2 TF-IDF candidates from each other website (not just the ones any single method likes).
- **Labelling:** one labeller (me), from titles only, using the six-way taxonomy. Pairs where I was unsure are listed separately as *ambiguous* and results are also reported with them excluded.
- **Exact (E) and same-product-variant (V) cannot occur** in these samples: every pair is cross-brand.
- **Sample A (development, 120 pairs):** 20 of the owner's products (8 bulbs with socket codes, 7 vehicle-fit bundles, 3 bars/pods/kits, 2 floor-mat items), top-2 per competitor website. Labels: 36 substitute, 23 related, 10 insufficient, 51 non-match.
- **Sample B (held-out source site, 60 pairs):** 10 random Alla Lighting products against the other three websites. Labels were written **before** scoring with the frozen scorer: 27 substitute, 18 related, 10 insufficient, 5 non-match.

### G.2 Results [Demonstrated on the pilot samples — indicative only]

Substitute-detection (binary: substitute vs everything else):

| Method | Sample A (dev) P / R / F1 | Sample B (held-out site) P / R / F1 |
|---|---|---|
| **Current engine** (replay: every pair scores null) | — / **0.00** / 0.00 | — / **0.00** / 0.00 |
| TF-IDF cosine, best threshold (oracle-tuned on the same sample) | 0.70 / 0.83 / 0.76 (θ=0.4) | 0.54 / 1.00 / 0.70 (θ=0.2) |
| Evidence scorer v1 — strong tier (tuned on A, **frozen** for B) | 0.93 / 0.75 / 0.83 | **0.57 / 0.15 / 0.24** |
| Evidence scorer v1 — strong + review tiers | 0.76 / 0.94 / 0.84 | **0.54 / 0.52 / 0.53** |
| Evidence scorer v2 — strong tier (**post-hoc repair; B is no longer held-out**) | 0.88 / 0.81 / 0.84 | 0.69 / 0.41 / 0.51 |
| Evidence scorer v2 — strong + review (post-hoc) | 0.74 / 1.00 / 0.85 | 0.65 / 0.96 / 0.78 |
| v2 on B excluding 11 ambiguous labels: strong / strong+review | — | 0.91 / 0.40 / 0.56 and 0.80 / 0.96 / 0.87 |

Statistical caution: with n ≈ 30–35 predictions the 95 % interval on a precision of 0.88 is roughly 0.73–0.95; on B it is wider. Treat every number above as direction, not measurement.

### G.3 What the pilot actually teaches [Demonstrated + Judgement]

1. **Rules tuned on one sample did not transfer.** The frozen v1 scorer scored F1 0.83 on the sample it was tuned on and 0.24 (strong tier) on a different source website. The causes were identifiable: a colour vocabulary contaminated by words like `xenon`; "8K" read as 8 Kelvin instead of 8000 K; a source listing with several colour variants treated as if it had one colour; category text leaking codes into titles; and product type inferred from title-word overlap. Fixing them (v2) recovered most of the recall — **but only after seeing the failures, which is precisely why the held-out set must be fixed in advance**.
2. **Title-word overlap is not a product-type signal.** Adapters, harnesses and decoders sharing a bulb code were repeatedly mistaken for bulbs; the strong-tier errors in both samples were of this kind or were vehicle-specific vs generic listings. Structured type (category/product_type/extracted attribute) is required.
3. **There are two distinct ambiguities.** (a) A *vehicle-specific* listing of a generic bulb versus a *generic* bulb of the same code: is it a substitute? My own labelling was not fully consistent on this, which is a real product-policy question for you (K). (b) Colour at product level when only some variants carry it.
4. **For roughly half the owner's products there is no true counterpart.** Of 20 sampled products only 9 had a substitute in the pooled candidates; a keyword search over the full competitor catalogue found none missed for the other 11 (e.g. Nissan Titan: only a third-brake-light; Chevrolet Traverse: none; Mercedes GLA and VW Jetta: only H7 adapters; 5-inch pods, 12-inch light bars, DT-connector harnesses, floor mats: none). **The correct output for those is "no match"**, and forcing matches would create false ones.
5. **Where counterparts exist there are too many, not too few.** For common codes there were 11–45 competitor products per website sharing ≥ 2 codes (e.g. H4/9003/HB2: 14/17/13; 168/194/2825/T10: 11/27/45). The system must rank (closest on soft specs: wattage, lumens, pack count, price tier) and show the best 1–3 per website, otherwise review becomes a flood.
6. **Pool-based recall is optimistic** because the pool is built from one retriever; candidate recall has to be measured against an independent method (G.4).
7. **Fitment bundles need variant alignment.** A lasfit "Fit for 2016-2019 Mercedes GLA250" listing bundles many bulb positions; a competitor's single H7 bulb matches *one variant* of it, not the product. This supports matching at product level with variant axes, as in stage 0.

### G.4 Evaluation protocol for the real build

- **Test set:** ≥ 300 human-reviewed pairs, stratified by website pair and category, built by pooling candidates from ≥ 2 independent retrievers *plus* targeted manual searches for no-match products, so recall is not circular. Include hard cases deliberately: same socket / different type, same model / different generation, "not for" exclusions, promo/gift lines, pack-size differences, multi-variant bundles.
- **Held-out design:** hold out at least one *website* and one *category* completely (never used for tuning, vocabulary, or thresholds); report them separately.
- **Labelling:** two labellers on a ≥ 20 % overlap to measure agreement (Cohen's κ); disagreements adjudicated; ambiguous items kept and flagged, not dropped. Ground-truth limits stated: titles/descriptions are not physical verification; identifier-derived truth is biased towards identified products (B).
- **Metrics reported for every release:** precision, recall, F1 per relationship and for "substitute-or-better"; **candidate-generation recall** (@k per website); coverage by website and by category; false-positive and false-negative examples (listed, not only counted); calibration curve + ECE per tier once calibrated; runtime and memory on the production instance; LLM spend; **number of pairs needing manual review per 100 source products**; and the "no true counterpart" false-suggestion rate.

### G.5 Acceptance criteria (proposed now, before any implementation)

| Criterion | Threshold |
|---|---|
| Candidate recall @10 per website, on confirmed substitutes | ≥ 95 % |
| Strong-tier precision (lower 95 % Wilson bound) on the held-out website/category | ≥ 90 % to be *shown* as suggested substitutes; ≥ 98 % before any auto-accept (identifier matches only) |
| Substitute recall of strong + review tiers | ≥ 90 % |
| False suggestions for products with no true counterpart | ≤ 2 % |
| Review load | ≤ 30 pairs per 100 source products after ranking (adjustable once measured) |
| Calibration (when probabilities are displayed) | ECE ≤ 0.05 |
| Invariant: re-running matching three times changes no human-decided row | 100 % |
| Regression: grocery workspace — fraction of its 705 accepted pairs the new engine re-proposes | ≥ 95 % |
| Full run of all products on the production instance | ≤ 10 min, ≤ ~600 MB RSS, zero paid API calls unless enabled |

Proposed thresholds are mine; please confirm or change them.

---

## H. Performance and cost

- **Default configuration costs nothing recurring.** Stages 0–2 are CPU-only TypeScript on the existing t3.micro (913 MB RAM). No vector database, no GPU, no new AWS resource.
- **Compute [Judgement, to be measured in S2]:** tokenising ~3.5 K products and scoring a few tens of thousands of candidate pairs is trivial work; my read-only replay already blocked and scored ~387 K candidate pairs for this workspace. Per-source evidence-ranked top-k bounds the pair count regardless of catalogue size.
- **Optional LLM extraction (stage 0):** about 3,546 products × ~700 input + ~150 output tokens ≈ 2.5 M input + 0.5 M output tokens. At the Claude Haiku 5.5 list price consulted ($0.10 / $0.50 per million tokens) that is **≈ $0.52 standard, ≈ $0.26 with the batch discount**, one-off; later only changed products.
- **Optional LLM adjudication (stage 3):** if ~30 % of ~30 K candidate pairs fall in the grey zone and each costs ~600 input tokens, that is ~5 M tokens ≈ **$0.5–1 per full pass**, far less in steady state (cache by content hash, rerun only changed pairs). These are estimates from the published prices and my assumed token counts, not measured spend.
- **Benefits/limits of external models [Demonstrated by B; Judgement for numbers]:** robust across categories, no labels needed; but non-deterministic, can be confidently wrong, and send product text to a third party — which is why it is off by default, evidence-bound, validated against source text, and capped.
- **Embeddings:** `all-MiniLM-L6-v2` (22.7 M parameters) would add roughly 90 MB fp32 (less quantised) and unmeasured CPU time; I recommend **not** adding it until a held-out experiment shows lexical keys miss real substitutes.

---

## I. Migration and backward compatibility

Principles: additive only, human decisions inviolable, reversible, measured in shadow mode before cutover.

1. **Decisions are pinned.** `accepted` and `rejected` rows in `product_matches` are never modified by the new engine. Reruns only add or supersede *suggestions*. This is the existing behaviour for decisions, extended to the new tables.
2. **Additive schema, no destructive change.** Add nullable `relationship`, `evidence` (jsonb), `engine_version`, and `dossier_hash` columns, or a sibling `match_suggestions` table with the same key `(source_variant_id, competitor_variant_id)`. Existing rows are back-filled: `identical` → exact, `different_pack` → same-product-variant. Take a verified `pg_dump` before any migration.
3. **Suggestions are versioned, not deleted.** Replace "delete stale auto/needs_review rows" with `superseded_at`; the UI shows only current suggestions but history is queryable ("why did this disappear?").
4. **Uniqueness and contradiction rules.** One current row per (source, competitor) pair; `setManualMatch`'s existing rule (rejecting other suggestions for the same source and competitor website) is kept. A pair rejected by a human is never re-proposed unless the underlying product content changed materially *and* the reviewer is told why it returned.
5. **Changed product information.** Each dossier carries a content hash. When a title/price/options/description changes the hash, affected pairs are re-scored; a pinned human decision is flagged "source changed since you decided" rather than altered.
6. **New products** enter the same pipeline on the next run; products with no counterpart stay unmatched rather than being forced.
7. **No corruption of product/price records:** matching only reads `products`/`variants`/`prices` and writes only match tables.
8. **Shadow mode first.** The new engine runs offline against a copy and writes to a separate table; its output is compared with the old engine and with human decisions (grocery regression, G.5) before it is allowed to populate Match Review.

---

## J. Implementation roadmap (nothing starts until you approve)

| Stage | Work | Verification gate |
|---|---|---|
| S0 | Approve design + acceptance criteria; agree labelling plan; resolve the policy questions in K | Your written approval |
| S1 | Dossier extraction as pure functions (no DB change) + offline evaluation harness committed under `scripts/` | Unit tests for every token type, including the failures found here (year ranges as codes, `8K`, negation, house codes) |
| S2 | Candidate generation + evidence model in shadow mode; build the ≥ 300-pair held-out set; run the harness | Meets G.5 on the held-out website and category, or we stop and revise |
| S3 | Additive schema + suggestions store + Match Review shows relationship and evidence; honest empty states ("no candidates generated" vs "all reviewed") | Migration rehearsed on a backup; invariant test (decisions unchanged across 3 reruns) |
| S4 | Optional LLM extraction/adjudication behind a flag with budget cap and cache | Spend report; precision of LLM-assisted tier measured on the same held-out set |
| S5 | Calibration + active-learning ordering from reviewer decisions | Reliability curve, ECE ≤ 0.05 |
| S6 | Cutover, monitoring dashboard (precision on reviewed sample, queue size, spend, runtime) | One week of monitored operation; rollback plan exercised |

Each stage is independently deployable and reversible; production deployment follows the existing process (backup first, release verified with the standing checks).

---

## K. Risks and limitations — what cannot be determined

- **Information absent from the data cannot be recovered.** If a competitor title has no code, fitment or size, the honest answer is "insufficient evidence" (about a fifth of pooled pairs in the pilot).
- **Private-label equivalence is not verifiable from listings.** "Same socket and function" is not "same quality/brightness"; the UI must keep the spec differences visible (wattage 40 W vs 100 W on the same socket).
- **Vehicle fitment correctness** (e.g. whether a Ram 1500 "Classic" 2019–2024 shares lighting with 2016–2018) is domain knowledge not in titles; adjacent-generation pairs must go to a human or to richer sources (descriptions).
- **Policy question for you:** is a *vehicle-specific* competitor listing of the same bulb code a substitute for a *generic* listing (and vice versa)? My pilot labels were inconsistent here, so the system needs an explicit, owner-approved rule.
- **Single-labeller, title-only pilot labels.** All pilot numbers carry that limitation; the real evaluation needs two labellers and agreement statistics.
- **Small samples** (120 and 60 pairs) → wide intervals; the held-out failure shows how fragile conclusions are.
- **LLM risks:** confident errors, prompt sensitivity (no single best prompt in the literature), vendor/privacy exposure, and cost drift — mitigated by evidence-binding, validation, caching and a cap, but not eliminated.
- **Drift:** websites change titles, options and pack sizes; the dossier hash and monitored precision on a rolling reviewed sample are the safeguards.
- **Ground-truth bias:** identifier-based ground truth favours products that have identifiers; most of the products Shelfwatch cares about do not.
- **Shopify multi-variant products** blur product vs variant matching; stage 0's product-with-axes model reduces but does not remove this.

---

## Appendix — provenance of the pilot numbers

The pilot used a read-only export of the `adi` workspace (3,546 products), scripts and label files kept in a temporary scratch directory outside the repository (not committed): a typed-token extractor, a TF-IDF retriever, a pool builder, and the scorer/evaluator. Sample A was drawn with a fixed seed, stratified by product kind; Sample B with a fixed seed, unstratified, from a different source website. The scorer's rules were frozen before Sample B was labelled and scored; the v2 changes were made after seeing Sample B's failures and are reported as post-hoc. The export of the owner's catalogue is deleted when this investigation closes; it can be regenerated with the same read-only query if a re-run is wanted.
