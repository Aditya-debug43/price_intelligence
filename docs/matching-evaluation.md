# Measuring the matching system (independent evaluation)

Shelfwatch does **not** claim that its matching reaches a given accuracy until people who are independent of the system have labelled a test set and the system has been scored against it. This page says how that works, what is measured, and what must exist before automatic approval of any class can be switched on. Screen: **Match review → Evaluation**. API: `/api/v1/orgs/:org/eval/*`.

## What is measured

Each *case* is one of your variants at one competitor website. A person records which competitor variant there, if any, is the true counterpart and what the two are (the same product, the same product in another pack, a compatible equivalent, a substitute, related only) — or that there is none. The system is then scored against those labels:

| Measure | Meaning |
|---|---|
| **Candidate recall** | The true **variant** (not merely its parent product) reached the candidates, at the internal pool depth (25 products per website, several variants each) and at the depth the AI judges (3 per website). Measured per website and per category. |
| **Match recall** | Of the cases that truly have a counterpart, the share where the system pointed at that exact variant. |
| **Precision** | Of the system's positive answers, the share that were the true variant with the true relationship. |
| **Wrong on "no counterpart"** | Of the cases with no counterpart, the share that still received a positive answer. |
| **Auto-approval precision** | Of the pairs the matcher confirmed itself, the share that were right. Before a class is switched on this is measured over the AI answers that *meet its deterministic conditions* (below). |
| **Automatic coverage / human review / unresolved** | Of the true counterparts: the share given a correct automatic decision, the share left for a person, and the rest. |

Reported for rule only, AI only and combined; for the development and the holdout sets; per domain, website, category and kind of case. "Accuracy across all possible pairs" is deliberately not used: nearly every random pair is a non-match, so it looks excellent while real matches are missed. Every proportion carries a 95% Wilson interval.

## The cases

`Select cases to label` draws a stratified sample (default about 300 per workspace): confirmed pairs, suggested pairs, rejected pairs, pairs set aside, AI suggestions, look-alike candidates (two or more live candidates at one website), automatic-approval audits, variants with **no counterpart found**, and random variants. A fixed rule on the product (40% of products, by a hash of its id) puts it in the **holdout** set; the rest are **development**. A product never moves between the sets, and re-selecting only adds. Tune on development; judge on holdout.

## Labelling

Labelling is **blind**: the page shows the products at that website (title, variant, brand, part number, price, source link) in an order that does not reveal the system's ranking, and never the system's own relationship, tier, confidence or AI answer, nor why the case was selected. The labeller can search the whole competitor catalogue (names, brand, SKU, barcode, part number, bulb codes under any of their names, vehicle words), pick the counterpart and say what the two are, or say that none exists. They also say how well they know these products; for **automotive** parts only labels from someone who says they know the parts count towards the gate. Each label records who and when. Nothing is ever labelled automatically and Gemini's answers are never used as truth. A case can be skipped.

## The release gate and automatic approval

A class of automatic approval, per domain, may be switched on only when the latest measurement on the **holdout** cases (made after the last label) passes **every** line, each with at least 100 labelled examples:

| Line | Needed |
|---|---|
| Candidate recall (true variant reached the candidates) | at least 95% |
| Automatic-approval precision of the class | at least 98% |
| Match recall | at least 90% |

Too few examples is never a pass. The two classes:

* **Identical item**: the AI says exact item, the rule engine found no decisive difference, **and** a valid equal barcode (or the same maker's part number), the same verified quantity and bundle contents, no safeguard fired, confidence not low.
* **Compatible equivalent** (automotive only): the AI says close equivalent and it passed the compatibility gate (the same bulb/socket code, nothing in doubt), quantity not shown to differ, no safeguard fired.

Each AI answer records which class (if any) its conditions qualify for, so the class can be measured before it is used. When a class is on, a qualifying answer is confirmed by the system only if no person has decided the pair: the confirmation carries the automatic marker, is recorded in the pair's history and the audit log, is exactly as strict about quantity as any automatic confirmation, is protected from the rule engine's own runs, and a person's later decision clears the marker and is final. A class switches itself off again when a later measurement no longer passes, or when audits of what it approved (the *automatic approval audit* cases) fall below 98% with at least 30 audited. A person can switch any class off at any time.

## Status

**No labels exist yet, so every gate is closed and nothing is approved automatically.** To open one: label about 300 cases across both workspaces (more until each class has at least 100 holdout examples), including automotive cases labelled by someone who knows the parts, then press *Measure the system now*. Measuring runs in the worker; it does not use the Gemini quota.
