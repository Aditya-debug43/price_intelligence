Matching automation: verified diagnosis and implementation contract

Prepared 6 November 2026 from the live automotive and grocery workspaces and repository commit f0b33a3fe2961cb6fa43ee5318a26769c87f9d33. This is an implementation specification, not a claim that repairs have been deployed. No production approvals, settings, labels, or source code were changed. Existing tests were inspected, not executed.

Repository examined: https://github.com/Aditya-debug43/price_intelligence/tree/f0b33a3fe2961cb6fa43ee5318a26769c87f9d33

1. What the live application actually shows

| Measure | Automotive | Grocery |
|---|---:|---:|
| Own parent products | 1,130 | 2,381 |
| Own sellable variants | 9,245 | 2,385 |
| Confirmed pairs, all relationships | 5 | 708 |
| Own variants with any confirmed relationship | 5 | 613 |
| Confirmed compatible equivalents | 0 | 0 |
| Suggested substitute pairs | 22,388 | 1,648 |
| Own variants with substitute suggestions | 5,347 | 707 |
| AI suggestions tab count | 213 | 178 |
| Evaluation labels in latest measurement | 0 | 0 |
| New AI automatic-approval classes | All off; activation disabled | All off; activation disabled |

The automotive “Needs a decision” tab contains zero entries. This does not mean matching is complete: substitutes, unclear relationships and AI suggestions are in separate tabs. Its Equivalents comparison view is empty. Grocery's comparison page does display confirmed products. Its visible examples are marked “Confirmed by you”; the total confirmed count is not evidence that those pairs were AI-approved.

Both workspaces show an evaluation dated 4 November with zero labelled cases. The new gate requires candidate recall >=95%, class approval precision >=98%, and domain match recall >=90%, with at least 100 examples for each denominator. With zero labels, the new AI approval path is intentionally disabled. This does not disable every older rule-based matching path.

The current comparison page defaults to Same products. Equivalents have a separate tab. Merely enabling an equivalent policy will therefore not populate the initial Same products view.

2. Verified source defects and exact changes required

All paths below refer to the pinned commit above. Line numbers describe that version, not future revisions.

| Priority | Finding | Location | Required repair |
|---|---|---|---|
| P0 | Enabling a class only stores its flag; it does not promote existing AI answers. | packages/services/src/match-eval.ts:288–301 | Enqueue reconciliation immediately after activation. |
| P0 | An unchanged cached pair is skipped before approval. Approval runs only for newly received answers. | packages/services/src/ai-match.ts:566–578 and 703–705 | Reuse cached analysis, then independently re-evaluate approval. |
| P0 | Scheduled collection runs rule matching and reporting, not new AI analysis. The resume loop resumes only existing work. | packages/services/src/scheduler.ts:158–159; packages/services/src/ai-match.ts:716–734 | Create durable matching work on collection completion and process an initial backlog. |
| P0 | Source selection excludes products with previous suggestions. The comment promising a cached fallback has no corresponding implementation. | packages/services/src/ai-match.ts:238,249–250,269–274 | Select unseen or materially changed evidence, not “has never had a suggestion.” |
| P0 | Evaluation scores one AI candidate per source/site, while production can approve every eligible answer. | packages/services/src/match-eval.ts:245–246; packages/services/src/ai-match.ts:653–705 | Evaluate every pair the deployed policy would approve, including alternatives. |
| P0 | Code co-occurrence is converted to transitive aliases and later treated as identity-code support. | packages/core/src/match/corpus.ts:172–193,323; packages/services/src/ai-match.ts:665,680 | Keep learned families for retrieval; require sourced compatibility evidence for approval. |
| P1 | Holdout assignment hashes the source variant ID, despite documentation describing product grouping. | packages/services/src/match-eval.ts:75–79 | Split by product family; keep sibling variants and close duplicates together. |
| P1 | Ground truth stores one counterpart, although several equivalents may be valid. | packages/core/src/ai/evaluation.ts:36–37,80,197–198; packages/services/src/match-eval.ts:178–189 | Store acceptable counterpart/relationship sets, plus explicitly incorrect and unjudged candidates. |
| P1 | Default comparison excludes equivalents. | apps/web/src/pages/Prices.tsx:26,47; packages/services/src/comparison.ts:77–79 | Add an All approved matches overview, retaining relationship labels and existing exact-price restrictions. |
| P1 | Facts can be listed both as known and unknown after specification enrichment. | packages/core/src/ai/dossier.ts:114–117,150–154,174 | Compute missing fields after merging and resolving evidence. |
| P1 | Grocery equivalent activation is displayed even though eligibility only supports automotive equivalents. | packages/core/src/ai/guard.ts:97–105; packages/core/src/ai/evaluation.ts:175 | Show only supported policies. Define any future grocery substitute policy separately. |

Do not solve these defects by setting a global confidence threshold lower, approving every substitute, manufacturing evaluation labels, or turning off compatibility checks.

3. Implement one shared decision-and-approval operation

Introduce a service such as reconcileAutoApprovals. The name is illustrative; the following behavior is the requirement.

Inputs: workspace, source variant, competitor variant, current evidence fingerprints, policy version, and an existing rule/model decision if available.

For each pair, it must:

- Load the current variant-specific facts, source provenance, relevant policy and any human decision.
- Confirm both variants remain active and belong to the expected workspace/sites.
- Preserve a person's acceptance or rejection. Changed evidence may flag that decision for attention, but must not silently reverse it.
- Check whether the stored analysis is still valid. Reuse unchanged evidence. Reanalyse materially changed facts or changed model instructions when necessary.
- Recompute the relationship and eligibility using current category rules. Do not trust a stale stored autoClass by itself.
- Check that the enabled policy's evaluation covers the current policy/model/evidence version and category scope.
- Atomically write an accepted relationship, automatic-approval provenance, suggestion status and history. Recheck human authority and evidence versions inside the write transaction to avoid races.
- Return an explicit outcome: approved, already approved, human decision preserved, stale analysis, missing critical facts, conflict, ambiguous candidate, or policy not enabled.
- Refresh/invalidate the comparison query so the result is visible without another matching run or individual acceptance.

Call this operation after a new model answer, after a cache hit, when a policy is activated, and when relevant product evidence or policy changes. An activation backfill must be resumable and idempotent. Repeating it must not duplicate approvals or audit events.

Retain source/candidate fingerprints, policy version, model and prompt version, evidence used, approval reason and time. Do not display the current hardcoded confidence 0.99 in autoApprovePair as if it were a calibrated 99% correctness probability.

4. Make matching continuous and affordable

Use this workflow:

Collection completes → normalize/enrich facts → update affected candidate sets → resolve clear cases with rules → ask Gemini about unresolved candidates → reconcile approval → publish comparison results.

Create durable jobs for the initial catalogue and subsequently for new or materially changed variants. Competitor changes must also enqueue affected source variants. Work must continue without the user repeatedly clicking Analyse for batches of 20.

Use statuses such as queued, running, waiting for quota, retryable failure, completed, and needs evidence. Store checkpoints. Exhausting Gemini quota pauses work and schedules a retry; it must not mark the product analysed successfully or discard it. Actual provider limits should come from the configured project's current quota; the application's daily cap is not proof of Google's allowance.

Separate matching evidence from price observations. A changed price usually needs comparison refresh, not another semantic matching request. A changed socket, model, selected option, pack, fitment or bundle may invalidate a prior decision. Include candidate-generation and policy versions where their changes affect eligibility.

For retrieval, combine exact identifiers, category/part filters, lexical search and semantic search. Expand the shortlist when no acceptable candidate is found; do not permanently conclude “no counterpart exists” merely because the first three candidates failed. Complete semantic indexing through a resumable backlog. Semantic similarity finds candidates; it does not certify compatibility.

5. Define automotive equivalence with category rules

One matching framework can support many categories. One universal similarity threshold cannot establish identity or compatibility across all categories.

Store separate fields for:

| Decision | Possible outcomes |
|---|---|
| Relationship | identical, same product/different pack, compatible equivalent, substitute, related, incompatible, unresolved |
| Approval | approved automatically, approved by person, waiting, rejected, stale |
| Price suitability | identical-item comparison, labelled equivalent benchmark, display-only, unavailable |

Start automatic equivalents with a narrow category for which listings contain enough reliable information. For automotive lighting, define the intended function and selected variant before checking compatibility. Necessary evidence varies by category:

| Product type | Evidence to establish before automatic equivalence |
|---|---|
| Replacement bulb | Explicit selected bulb/base specification, relevant electrical requirements, intended light function and colour behavior, applicable installation constraints |
| Vehicle-specific lamp/assembly | Compatible make/model/year/trim as applicable, side and position, connector, assembly type, relevant physical/electrical requirements |
| Multi-part kit | Verified constituent parts and their compatibility; a compatible bulb alone does not establish a compatible kit |
| Other vehicle products | Their own policy; bulb-code rules cannot validate mats, wipers or unrelated parts |

Mark each applicable critical field as established, conflicting, or unknown. Unknown critical fitment requires enrichment or review. Optional marketing figures should not automatically prevent a match when the policy can establish the intended equivalence without them. For example, brightness or power may define performance tiers for one category; they must not be blanket requirements or blanket ignored fields for every category.

Preserve raw codes and the selected option. The current corpus algorithm merges codes after at least three co-occurrences across two sites and a 0.4 co-occurrence ratio; it can then merge transitively. This proves how the software groups codes, not that the physical products are interchangeable. Represent learned code-family relationships separately from sourced, verified aliases or a listing's explicit supported-code set. No actual production merge of any particular unsafe code pair was established in this inspection.

The current equivalent eligibility already permits unknown quantity in some circumstances. Therefore unknown pack quantity is not the universal cause of the missing approvals. Preserve the distinction: a sufficiently evidenced compatible relationship can be visible, while unknown quantity prevents an unsupported price percentage. Different brands can be valid equivalents, but must never become identical products merely because names are similar.

In grocery, same-brand/identifier/flavour/form/quantity checks can establish identity; different-brand alternatives should remain labelled substitutes unless a separately defined category policy supports a stronger claim. Do not show an automotive bulb-code gate as if it were usable for groceries.

6. Repair evaluation before using it to release automation

The current zero-label state explains why approval is off. There are additional defects that would matter after labels are added:

- Score the exact decision set the production policy would approve. If production approves three candidates, all three count toward pair precision. Do not score only the strongest one.
- Allow multiple acceptable equivalents at a competitor. An unlabelled alternative is unjudged, not automatically false. Keep relationship labels for each accepted counterpart.
- Split by product family or equivalent duplicate cluster, not source variant ID. Near-identical fitment variants must not leak between development and holdout.
- Evaluate the current policy version and current evidence. Historical pass results must not silently authorize changed rules or materially changed model behavior.
- Enable narrow policies based on their audited precision and compatibility rules. Measure whole-domain retrieval recall and coverage separately as product goals. Poor recall elsewhere should not block a reliable, independently evaluated identity policy.
- Report unbiased or appropriately weighted population estimates separately from deliberately enriched difficult-case samples. A stratified development sample is not automatically a representative catalogue audit.
- Show the needed sample counts for the selected policy. “300 labels across both accounts” is not sufficient advice when the current system requires 100 eligible holdout predictions for each class.

A concrete pilot proposal is at least 100 independent, human-verified eligible holdout examples for the chosen narrow policy, observed precision >=98%, and a 95% confidence lower bound above 90%. Count independent families rather than duplicated rows; enlarge the sample if uncertainty is too high. Any discovered critical compatibility violation should block that rule until repaired and retested even if aggregate precision passes. These are proposed release criteria, not measured results or a guarantee about future products. Higher confidence requirements need more evidence.

Use knowledgeable people for automotive fitment truth. A one-time validation sample and ongoing small audits are different from manually accepting every incoming product. Gemini must not certify its own correctness by generating the truth labels.

7. Make approved matches visible where the user expects them

Default Product/Price Comparison to an All approved matches overview. Include identical items and compatible equivalents, with unmistakable labels. Keep Same products and Equivalents filters. Keep suggested substitutes accessible as suggestions, not counted as approved matches.

An automatically approved equivalent must appear immediately after the job completes without an Accept click. Display the matched variant, competitor, price timestamp, compatibility evidence, approval reason and any unresolved price limitation. Preserve the current rule that an equivalent is excluded from identical-item price-position KPIs.

If an equivalent's pack quantity is unknown, display the approved relationship and raw listing prices with the limitation; do not invent a comparable price percentage. Preserve existing protections for changed evidence, unequal packs and incompatible bundles.

8. Define the target so it cannot be satisfied with misleading counts

Primary catalogue automation coverage = distinct active own variants with at least one current automatically approved identical/equivalent counterpart / all active own variants.

For the observed automotive catalogue of 9,245 variants:

- 50% requires at least 4,623 variants.
- 60% requires at least 5,547 variants.
- The 5,347 variants with substitute suggestions represent about 57.8% candidate coverage. They are not verified equivalents and must not be counted as successful automation.

Also report parent-product coverage. At 1,130 parent products, 50% is 565 parents and 60% is 678. A parent with only one matched variant must not be presented as if all its variants were covered. Show both counts rather than switching denominators to make performance look better.

Report pair-level audited precision with uncertainty; automatic distinct-variant coverage; human-review workload; unresolved and no-counterpart-found counts; and missing-evidence reasons. Automatic rejection or a “no counterpart” outcome can reduce workload, but does not count as a matched product. If a variant has an approved counterpart and another unresolved alternative, report that remaining review workload separately rather than hiding it.

Build a funnel with distinct source variants at each step: active → candidate found → judged → eligible → blocked by policy → approved → visible in comparison. Include reasons such as unsupported category, missing fitment, conflicting colour/function, ambiguous variant, stale evidence, quota pause and policy disabled.

9. Required acceptance tests

| Test | Observable pass condition |
|---|---|
| Cached answer promotion | Generate a valid answer while policy is off; enable a genuinely validated policy; existing answer becomes accepted and visible with zero additional Gemini requests. Do not delete suggestions during the test. |
| New product automation | Ingest a new eligible variant; let scheduler and worker finish; approval and comparison appear without clicking Analyse or Accept. |
| Initial backlog | Start processing the existing catalogue; resume from a checkpoint after restart; every eligible record is eventually considered. |
| Equivalent visibility | A valid cross-brand equivalent appears in the default approved overview and Equivalents tab, excluded from identical-product KPIs. |
| Critical incompatibility | Wrong selected variant, conflicting required fitment/function or incompatible kit never auto-approves from a high language-model score. |
| Learned alias | Co-occurring raw codes alone can retrieve a candidate but cannot satisfy verified compatibility. |
| Evidence consistency | A specification enriched from the description does not remain simultaneously marked unknown; contradictions remain explicit. |
| Quantity separation | Unknown pack size cannot produce a price percentage, while an independently justified compatible relationship can remain visible. |
| Changed facts | Material compatibility changes invalidate the affected automatic approval; price-only changes refresh price data without needless semantic calls. |
| Human authority and races | Human rejection survives a concurrent worker; stale fingerprint writes cannot override current evidence. |
| Retry/idempotency | Retried jobs produce no duplicate decisions/history and cannot silently lose work. |
| Quota recovery | A quota response pauses the durable backlog and work resumes later from the same checkpoint. |
| Evaluation parity | Every candidate production would approve is scored, including a deliberately wrong second candidate. |
| Multiple correct equivalents | Two genuinely valid competitor equivalents can both be marked correct; unjudged alternatives remain unjudged. |
| Holdout integrity | Every sibling variant/duplicate family stays entirely in development or holdout. |
| Real gate path | Test labelling → measurement → policy activation → reconciliation → comparison, without inserting a fake passed gate into the database. |

The existing tests do not prove this contract: tests/e2e/match-eval.test.ts:175–179 removes AI suggestions before analysis, masking the cache problem; lines158–172 insert a synthetic passed gate. Add integration coverage for the actual sequence above, not merely isolated helper tests.

10. Delivery order and honest completion condition

First implement reconciliation, durable queueing and comparison visibility using isolated fixtures. In parallel, repair compatibility evidence and evaluation defects. Then run an initial dry run on the actual catalogue, audit the chosen policy, activate that policy and reconcile existing answers. Expand category coverage according to measured blockers; do not open every category at once.

The engineering promise is testable: every current, eligible pair under an enabled validated policy is processed automatically and becomes visible without individual review. The business target is separately measured: at least 50% of the whole active catalogue should have automatically approved valid counterparts, with audited correctness above the agreed minimum.

If coverage is below 50%, report the exact shortfall and how much is attributable to missing counterpart inventory, missing specifications, retrieval failures, policy scope or quota backlog. Do not declare the target reached by counting repeated pairs, suggestions, automatic non-matches or manually approved records. No inspection or prompt can guarantee 50–60% genuine coverage before catalogue overlap and correctness are measured.
