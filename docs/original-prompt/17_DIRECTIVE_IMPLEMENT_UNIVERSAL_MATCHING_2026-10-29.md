# Directive 17 — 2026-10-29 — Implement the approved universal product-matching architecture (verbatim)

(Follows directive 16, the research and design request, whose result is `docs/proposals/universal-matching-design.md`.)

---

Shelfwatch: Implement the Approved Universal Product-Matching Architecture
I have reviewed your proposal in `docs/proposals/universal-matching-design.md`. I approve the overall architecture and want you to proceed with implementation.
Your objective is to transform Shelfwatch's existing product matcher into a reliable, universal, evidence-based matching system that works across automotive accessories, groceries, electronics, household products, and other product categories.
I am approving the architecture and the decisions specified below. Do not stop to ask me to make those same decisions again. Use your technical judgement for implementation details, investigate the actual codebase, and execute the work in stages.
However, preserve the proposal's central requirement: improve matching coverage without sacrificing the accuracy and trustworthiness of price comparisons.
1. Decisions that are already approved
Implement the proposed staged architecture, including product dossiers, multi-key candidate generation, an explainable evidence model, optional grey-zone adjudication, preserved human decisions, and ongoing evaluation.
Use the following product relationships:

* Exact product: The same underlying product from different sellers.
* Same product, different pack or variant: The same product with a meaningful difference in pack quantity, size, colour, or another variant attribute.
* Substitute: A different product that is sufficiently interchangeable for the same purpose, with any important differences made clear.
* Related product: A product associated with another product but not necessarily interchangeable.
* Non-match: Products that are genuinely different or have decisive incompatibilities.
* Insufficient evidence: The available information does not support a reliable conclusion.

Do not combine these relationships into a single generic similarity score or label.
My decision on Price Comparison
The default Price Comparison view must contain only human-confirmed exact matches and confirmed same-product variants.
Confirmed substitutes may be available through a separate, clearly labelled substitute-comparison view. They must never be presented as identical products.
Unconfirmed suggestions must not enter the normal Price Comparison results. They belong in Match Review until they have been reviewed.
My decision on automatic acceptance
For the initial implementation, do not automatically accept any newly generated matches, including deterministic identifier matches. All new suggestions must remain reviewable until a human confirms them.
My decision on AI usage
Keep paid LLM extraction and adjudication disabled by default. The system must operate using the normal matching pipeline without paid API calls. Any future LLM functionality must be optional, cached where appropriate, evidence-bound, and subject to an explicit budget cap.
My decision on vehicle-specific versus generic products
Sharing a bulb code or model code alone does not establish that two products are identical.
A vehicle-specific listing and a generic listing may be suggested as substitutes if the product type, essential specifications, and relevant compatibility evidence support that relationship. Any unresolved fitment conflict must prevent an automatic strong classification.
Such pairs must be clearly classified as substitutes or insufficient evidence, not exact matches. Human confirmation is required before a substitute can be used for price comparison.
Apply analogous reasoning to other categories: a shared identifier or similar name must not override an important compatibility, quantity, size, or product-type conflict.
2. Start with a complete audit of the current implementation
Inspect the actual codebase and compare it against your proposal.
Identify the modules responsible for product normalisation, token extraction, candidate generation, pair scoring, match statuses, Match Review, Price Comparison, database persistence, and background jobs.
Review the existing grocery workspace, automotive workspace, historical decisions, and existing collection data.
Confirm the precise limitations of the current system rather than assuming the proposal already answers every implementation question.
Before changing anything, inspect the Git state, deployment version, database schema, and backup arrangements. Preserve all unrelated work and production data.
Do not use a destructive migration, delete existing records, reset the database, or overwrite human decisions.
3. Implement the product dossier
Introduce a reliable, reusable representation of a product and its variants.
The implementation should be capable of extracting and preserving relevant evidence such as product type, brand, GTIN, manufacturer part number, identity codes, fitment ranges, numerical specifications, unit information, packaging, colours, variant options, and explicit compatibility exclusions.
Follow the approved proposal's principle of keeping different sources of information separate and recording where each attribute came from.
Do not invent missing attributes. Preserve unknown values as unknown.
Pay particular attention to the failure cases discovered in the earlier investigation, including bulb codes being removed as numeric noise, year ranges being misclassified as identity codes, variant attributes being confused with product-level attributes, and product categories being confused because they share terminology.
Where an attribute cannot be extracted reliably, represent that uncertainty instead of creating false evidence.
Use deterministic extraction where appropriate. Evaluate any additional technique against actual data and measurable benefits before introducing unnecessary complexity.
4. Implement multi-key candidate generation
Replace the existing candidate-selection assumptions with the approved multi-key approach.
Candidate discovery must be capable of finding potentially comparable products when one or more identifiers are missing or when product names differ.
Use the architecture in the approved proposal as the starting point, and determine the appropriate combination of identity codes, product-type information, fitment, attribute evidence, lexical retrieval, and other justified signals.
Candidate-generation recall must be measured independently from final matching accuracy.
Do not discard useful candidates merely because their titles contain common terminology. Equally, do not generate an uncontrolled number of weak candidates that makes Match Review unusable.
Rank candidates sensibly and retain the strongest few candidates per competitor for each source product, with the actual limit determined by evaluation.
The implementation must scale to the existing catalogue sizes and support future website additions without requiring an entirely new matching algorithm for each merchant or category.
5. Implement the explainable evidence model
Build the approved evidence-based scoring and classification layer.
Each candidate pair should have an explainable relationship, evidence list, confidence tier, and relevant conflicts.
The model should distinguish:

* Independent agreeing signals.
* Hard incompatibilities.
* Soft specification differences.
* Missing information.
* Contradictory attributes.
* Evidence that supports a substitute but not an exact match.

Do not allow an attractive name-similarity score to override an incompatible product type or an important size, variant, or fitment conflict.
Use a defensible weighting approach and refine it through reviewed labels and held-out evaluation, rather than continually changing arbitrary thresholds until the test examples pass.
Do not show numerical confidence percentages unless the scores have been appropriately calibrated against reliable reviewed data. Until then, use evidence tiers and explicit explanations.
Every suggestion should explain, in understandable language, why it was generated and what information supports or weakens the match.
6. Implement Match Review and decision preservation
Adapt the existing Match Review workflow to the proposed relationships and evidence model.
Reviewers should be able to understand the candidate, inspect the evidence, distinguish a substitute from an identical product, and accept or reject the suggestion.
Preserve the existing user workflow as much as practical, but ensure the labels and explanations accurately describe the new system.
Existing human-accepted and human-rejected decisions must remain protected across reruns.
Store suggestions as versioned records or implement the equivalent safe design from the proposal. Rerunning the matcher must not silently erase the history of a suggestion or change a human decision.
If source product information materially changes, mark the affected suggestion for re-evaluation without silently reversing the previous human decision.
Maintain a clear distinction between current suggestions, superseded suggestions, accepted decisions, and rejected decisions.
7. Implement the correct Price Comparison rules
The normal Price Comparison page must consume only the approved confirmed relationships.
Exact matches and same-product variants may appear in the normal comparison results after human confirmation.
Confirmed substitutes may appear only in the separate, clearly labelled substitute-comparison view. Show important specification differences so that the user does not confuse functional similarity with identical products.
Related products, non-matches, insufficient-evidence pairs, and unconfirmed suggestions must not appear as ordinary comparable products.
Handle packaging and quantity differences carefully. Do not compare prices as though package quantities were equal when they are not. Use appropriate unit-price normalisation where the data supports it.
The UI must explain when there are no candidates because none were generated, when candidates were generated but none were approved, and when products genuinely have no reliable counterpart. Do not display a misleading message claiming that everything is reviewed when no suggestions were generated.
8. Preserve the human feedback loop
Every human accept, reject, or reclassification should become a useful labelled example with the relevant product evidence and engine version.
Use those labels for evaluation, and only for subsequent score refinement when the evaluation design supports it.
Keep the test set separate from the data used to tune the model. Do not tune repeatedly against a held-out set and then present its results as independent validation.
Use the evaluation protocol from the approved proposal, including a representative labelled set, multiple product categories, held-out websites and categories, and independent candidate-retrieval methods.
Where practical, use two reviewers on an overlapping portion of the labels and measure agreement. If that is not possible, document the single-reviewer limitation honestly.
9. Acceptance criteria and release gates
Use the proposal's evaluation metrics and targets as the initial acceptance criteria:

* Candidate recall at the top 10 per website: at least 95% on confirmed substitutes.
* Strong-tier precision: lower 95% Wilson confidence bound of at least 90% before strong-tier suggestions are promoted in the user-facing workflow.
* Recall across strong and review tiers: at least 90%.
* False suggestions for products with no genuine counterpart: at most 2%.
* Review workload: target at most 30 pairs per 100 source products after ranking.
* Calibration error: at most 0.05 before showing calibrated probability percentages.
* Existing human decisions preserved across repeated matching runs: 100%.
* Grocery regression: re-propose at least 95% of the existing accepted pairs where their source data remains equivalent.
* Production resource target: a complete matching run should ideally take no more than 10 minutes and use approximately 600 MB or less of memory on the existing server, without paid API calls by default.

Measure and report these metrics on a properly designed evaluation set. Do not present the small earlier pilot as proof that these targets have been met.
Because this first release will not automatically accept new matches, the auto-accept precision target is not a release requirement. Do not enable auto-acceptance without a separate, explicitly approved change.
If a release criterion fails, investigate why and improve the implementation where feasible. Do not lower a threshold, remove difficult examples, or manipulate the evaluation set merely to declare success.
10. Implementation and migration plan
Proceed through these stages, keeping the work reversible:

1. Implement the dossier extraction and pure-function tests.
2. Implement candidate generation and the evidence model, then run offline evaluations.
3. Build the reviewed evaluation set and compare the new engine with the current engine.
4. Run the new engine in shadow mode against a copy or isolated evaluation dataset.
5. Implement additive, reversible persistence and the versioned suggestion store.
6. Integrate the new suggestions and explanations into Match Review.
7. Enforce the approved Price Comparison inclusion rules.
8. Verify the grocery regression and the automotive catalogue behaviour.
9. Test repeated runs, concurrent jobs, changed source products, missing information, and protected human decisions.
10. Enable the new matcher only after the release gates have been met, using the existing deployment workflow and a verified backup.

Adapt the sequence to the actual codebase where necessary, but preserve the safety and evaluation gates.
Do not change production match decisions just to populate the pages. Do not automatically accept uncertain matches. Do not run a production-wide matching job before the implementation has been validated.
11. Required regression scenarios
Include tests covering at least:

* Exact products with identical GTINs.
* Same-manufacturer products with matching manufacturer part numbers.
* Different-brand products with strong evidence of functional substitutability.
* Products whose names use abbreviations or different word ordering.
* Automotive bulb codes and model years.
* Different sockets or incompatible product types.
* Vehicle-specific versus generic listings.
* Different fitment generations.
* Colour and variant-axis conflicts.
* Different pack sizes and quantities.
* Products that share an identity code but are different product types.
* Adapter, harness, bulb, and decoder listings with overlapping terminology.
* Missing identifiers and insufficient evidence.
* Products with no genuine counterpart.
* Grocery products from the existing workspace.
* Existing human-accepted and rejected decisions.
* Repeated reruns and changed product descriptions.
* Empty candidate results and accurate UI explanations.

Do not rely only on synthetic examples. Evaluate the implementation using actual Shelfwatch catalogues and reviewed evidence.
12. Production safety and deployment
Shelfwatch is already deployed, with its frontend on Vercel and backend on AWS EC2.
Keep existing product, variant, price, workspace, report, and collection data intact.
Use an additive database migration if required. Take a verified backup before migrating, rehearse the migration against a copy, and maintain a rollback plan.
Do not force-push Git history, reset the production database, introduce new paid infrastructure without my explicit approval, or commit secrets.
Run the project's type checks, linting, production build, and full relevant test suite.
When deploying, ensure that the frontend and backend versions remain compatible and that actual production health checks pass.
13. Final deliverable
Do not stop at a design document or a list of proposed tasks. Implement the approved architecture and complete the safe work that can be performed.
At completion, report:

* The components implemented.
* The migrations and deployment changes made.
* Results on the held-out evaluation set.
* Precision, recall, candidate recall, false-positive rate, coverage, review load, runtime, and memory usage.
* How the matcher behaves across automotive and grocery products.
* Whether every existing human decision was preserved.
* Which acceptance criteria passed or remain unmet.
* Whether the changes are live in production.
* Any remaining limitations that require human review or additional data.

If some acceptance criteria cannot be established because the evaluation data is insufficient, report the limitation honestly and keep the matcher in shadow mode rather than claiming the targets were met.
The goal is a universal matching system that discovers more genuine comparable products, explains its evidence, avoids false matches, and improves through human review—without making Shelfwatch's price comparisons untrustworthy.
