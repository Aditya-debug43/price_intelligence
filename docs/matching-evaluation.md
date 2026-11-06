# Measuring the matching system (independent evaluation)

Shelfwatch does **not** claim that its matching reaches a given accuracy until people who are independent of the system have labelled a test set and the system has been scored against it. This page says how that works, what is measured, and what must exist before automatic approval of any policy can be switched on. Screen: **Match review → Evaluation**. API: `/api/v1/orgs/:org/eval/*`. (Rewritten for directive 31, 2026-11-06: the unit of scoring is the product family, a case holds several judgments, and the gate scores everything a policy would approve.)

## What is measured

Each *case* is one of your variants at one competitor website. A person **judges the candidates there**: each acceptable counterpart, with what it is (the same product, the same product in another pack, a compatible equivalent, a substitute, related only) — several can be valid at once; each candidate that is **not** a counterpart (and whether approving it would be a *critical* mistake: a wrong fit or function); and whether the judged list is **complete** ("no other product here is a counterpart"; with nothing acceptable this says *no counterpart*). A candidate nobody judged is **unjudged**: never right, never wrong. The system is scored against those judgments:

| Measure | Meaning |
|---|---|
| **Candidate recall** | An acceptable **variant** (not merely its parent product) reached the candidates, at the internal pool depth (25 products per website) and at the depth the AI judges (3 per website). |
| **Match recall** | Of the cases that truly have a counterpart, the share where the system pointed at one of the acceptable variants. |
| **Precision** | Of the system's positive answers, the share that were an acceptable variant with the right relationship. |
| **Wrong on "no counterpart"** | Of the cases judged to have none, the share that still received a positive answer. |
| **Auto-approval precision** | Of the answers a policy would approve, the share that were right. |
| **Automatic coverage / human review / unresolved** | Of the true counterparts: the share given a correct automatic decision, the share left for a person, and the rest. |

Reported for rule only, AI only and combined; for the development and the holdout sets; per domain, website, category and kind of case. "Accuracy across all possible pairs" is deliberately not used: nearly every random pair is a non-match, so it looks excellent while real matches are missed. Every proportion carries a 95% Wilson interval.

### The decision set that is scored (parity with production)

The gate scores **every answer production would approve now**, not the strongest one at each website: every AI answer at a case whose deterministic conditions qualify it for a policy **under the current policy version**, **from the products' current facts** (an answer whose stored facts no longer match is stale and is not scored, as production would not approve it either). A deliberately wrong second candidate counts against precision like any other answer. Several correct equivalents are all correct. An unlabelled eligible answer is *unjudged*: it is reported, and a family with an unjudged answer and no wrong one is **held out** of the count — an unjudged answer can never help a policy pass.

## The cases and the split

`Select cases to label` draws a stratified sample (default about 300 per workspace): confirmed pairs, suggested pairs, rejected pairs, pairs set aside, AI suggestions, look-alike candidates, automatic-approval audits, variants with **no counterpart found**, and a **uniform random sample**. Every case records its **product family** (a normalised parent title: sibling variants and duplicate listings share one). A fixed rule on the family (40% of families, by a hash of the family) puts **all** of its cases in the **holdout** set; the rest are **development**. A family never straddles the split, a case never moves, and re-selecting only adds. Tune on development; judge on holdout.

Only the uniform sample describes the whole catalogue; every other kind of case was chosen because it is interesting and describes only itself. The report lists each kind with its population, how many were selected and how many labelled, labels the two kinds, and gives population estimates from the uniform sample alone.

## Labelling

Labelling is **blind**: the page shows the products at that website (title, variant, brand, part number, price, source link) in an order that does not reveal the system's ranking, and never the system's own relationship, tier, confidence or AI answer, nor why the case was selected. The labeller can search the whole competitor catalogue (names, brand, SKU, barcode, part number, bulb codes under any of their names, vehicle words) and add a product to judge. They also say how well they know these products; for **automotive** parts only labels from someone who says they know the parts count towards the gate. Each label records who and when; relabelling replaces the earlier judgments completely. Nothing is ever labelled automatically and Gemini's answers are never used as truth. A case can be skipped.

## The release gate and automatic approval

A **narrow** policy (one class in one domain) may be switched on only when the latest measurement on the **holdout** cases — made after the last label and **for the policy version now in force** — passes every *required* line:

| Required line | Needed |
|---|---|
| Independent examples | at least **100 product families** judged |
| Automatic-approval precision | observed at least **98%**, and the 95% lower bound **above 90%** |
| Critical compatibility mistakes | **none** (any one blocks the policy until the rule is repaired and retested) |

Whole-domain **candidate recall** (goal 95%) and **match recall** (goal 90%) are measured and shown beside the gate, marked *a goal, does not block*: poor recall elsewhere says nothing about whether a precise policy is reliable. Too few examples is never a pass, and the screen says how many more families are needed — to reach the minimum, and (once precision meets the target) how many would bring the lower bound above the line at the observed rate.

The policies that exist (anything else is not offered, and the API refuses it): **automotive identical item**, **automotive compatible equivalent**, **grocery identical item**. A different-brand grocery product is a labelled *substitute*, never an automatic match.

* **Identical item**: the AI says exact item, the rule engine found no decisive difference, **and** a valid equal barcode (or the same maker's part number), the same verified quantity and bundle contents, no safeguard fired, confidence not low, and no rival candidate at the same website also qualifies.
* **Compatible equivalent** (automotive replacement bulbs, policy `auto-2-bulb`): the AI says close equivalent **and** the category policy established every critical field from *sourced* evidence — the same bulb code as written for the selected variant (a raw match or a **verified** standard alias such as 9005 / HB3), the same stated light function, no colour conflict — quantity not shown to differ, no safeguard fired. Codes that merely appear together in the catalogue (the software's *learned* families, e.g. H8/H9/H11) can **retrieve** a candidate but never satisfy this policy. Kits, assemblies and other parts are out of scope until their own policy exists.

## Activation and reconciliation

Switching a policy on stores the **policy version** it was measured for and queues the **reconciliation** of every stored answer: each is re-decided against the current facts and rules **without asking the model anything**, in one transaction that locks the pair's row so a person's decision made at the same moment wins. The same operation runs after a new answer, after a cache hit, and whenever a product's facts or the rules change. Outcomes: approved, already approved, human decision preserved, stale analysis, missing critical facts, conflict, ambiguous candidate, policy not enabled. It is idempotent: repeating it changes nothing and records nothing twice. An approval made by the system is taken back (returned to the review queue, recorded) when its evidence changed or its policy is no longer valid; a person's accept or reject is never touched.

Each approval keeps its provenance — policy, policy version, the shared code and function recorded when it was approved — and stores **no confidence number** (screens and exports show "approved by policy", never a score). A policy switches itself off when a later measurement no longer passes or finds a critical mistake, when the rules it was switched on for have changed, or when audits of what it approved (the *automatic approval audit* cases) fall below 98% with at least 30 audited; its approvals are then taken back. A person can switch any policy off at any time.

## Status

**No independent human labels exist yet for either workspace, so every real gate is closed and nothing is approved automatically.** To open one: label about 300 cases (more until each policy has at least 100 holdout families), including automotive cases labelled by someone who knows the parts, then press *Measure the system now* and switch the policy on. Measuring runs in the worker; it does not use the Gemini quota. The mechanism is proved end to end by `tests/e2e/match-gate-path.test.ts` against a constructed catalogue (those labels are the test's, and prove the mechanism — they say nothing about real accuracy), including a workspace whose labels expose mistakes the listings cannot show and which therefore fails the same gate.
