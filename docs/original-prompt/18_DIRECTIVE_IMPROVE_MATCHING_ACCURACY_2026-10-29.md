# Directive 18 — verbatim (2026-10-29)




# Shelfwatch: Improve Matching Accuracy, Reduce Review Overload, and Validate Before Activation

You have already built and deployed the new universal product-matching engine for Shelfwatch. The backend and frontend changes are live, but the new engine remains disabled for all workspaces because several release criteria have not been met.

I want you to continue from the current state of the project and finish this work properly.

Your priorities are:

1. Reduce irrelevant and excessive match suggestions.
2. Improve and independently evaluate matching accuracy.
3. Verify that the new engine can run safely on the existing AWS EC2 server.
4. Preserve existing product data and all human matching decisions.
5. Activate the new engine only after it meets the agreed acceptance criteria.

Do not simply lower the number of suggestions until the interface looks manageable. The goal is to reduce false and redundant suggestions without losing genuine product matches.

## 1. Begin by inspecting the current state

Inspect the actual repository, Git history, matching-engine documentation, database schema, existing test results, and current production deployment.

Establish which version is deployed and whether the matching engine is enabled or disabled for every workspace.

Use the latest available production data and the results from your previous investigations. Do not repeat work unnecessarily, assume earlier results are still current, or overwrite changes made since your last session.

The most recent evaluation reported the following:

- The new matcher reproduces 701 of 705 previously accepted grocery matches (99.4%) in the production grocery workspace.
- In automotive, the new matcher generates approximately 11,913 suggestions, compared with zero from the old matcher.
- The automotive review workload is approximately 850 variant-pair suggestions per 100 products, or roughly 198 product pairs per 100 products.
- The target review workload is no more than 30 pairs per 100 source products.
- The new matcher has not passed all its independent accuracy criteria.
- Its resource consumption has not been measured reliably on the production EC2 server.

Verify these findings against the actual current state before relying on them.

## 2. Reduce unnecessary match suggestions

The new matcher has improved candidate discovery, but its output is too large to review efficiently.

Investigate why so many candidates are produced and determine how to make the results more useful.

I want the system to prioritise the best potential matches for each product and competitor, rather than overwhelming the user with every remotely plausible pair.

Distinguish between a useful candidate, a redundant candidate, a genuinely different product, a related product, and a case where there is insufficient evidence.

Pay particular attention to automotive products that share common bulb codes, fitment information, or model terminology but may represent different parts.

For example, sharing an automotive code must not cause a bulb, adapter, harness, decoder, and unrelated lighting accessory to be presented as equivalent products.

At the same time, do not discard genuine substitutes simply because they have different brands or lack a shared manufacturer part number.

Evaluate the appropriate balance between recall, precision, ranking, product-level review, and variant-level evidence using the actual catalogue data. Choose the implementation that best addresses these problems rather than applying an arbitrary cap or an untested threshold.

The result should make Match Review practical for a human to use while still surfacing genuinely useful alternatives.

## 3. Meet the review-workload target

Use the existing proposal's target of no more than 30 candidate pairs requiring review per 100 source products as the initial acceptance criterion.

Measure the workload separately for automotive and grocery products and, where possible, for each website.

Report both product-level and variant-level counts so that the same candidate is not misleadingly counted multiple times simply because a product has several variants.

If the review workload remains above the target, investigate why and continue improving it. Do not claim success by hiding candidates that are required to meet the recall target.

Track how the workload changes as accuracy and coverage improve. Explain any remaining trade-offs instead of silently weakening the matching criteria.

## 4. Establish a reliable accuracy evaluation

I do not want to activate a matcher just because it produces more suggestions.

Build a representative evaluation set of at least 300 reviewed product pairs, spanning different categories and websites, including automotive accessories, groceries, and other available product types.

Include difficult examples such as:

- Products that are genuinely identical despite different titles.
- Products from different brands that are valid substitutes.
- Products with similar codes but different functions.
- Different vehicle models or incompatible fitment ranges.
- Different sizes, colours, pack quantities, and variants.
- Products that appear related but should not be price-compared.
- Products with insufficient information.
- Products that have no genuine counterpart among the competitors.

Use independent candidate-discovery methods and targeted searches when constructing the sample. Do not evaluate only candidates produced by the new matcher, since that could hide products the matcher failed to discover.

Keep development and evaluation data separate. At least one website and one product category must be held out from development and tuning.

Include a second human reviewer for at least 20% of the labelled pairs, with disagreements recorded and resolved appropriately. If another reviewer is unavailable, create a straightforward review file or interface for me to audit a random sample and do not claim that independent agreement has been established.

Preserve uncertain labels as uncertain rather than forcing a decision.

## 5. Measure the agreed acceptance criteria

Use the thresholds in `docs/proposals/universal-matching-design.md` as the starting point.

| Metric | Acceptance target |
|---|---:|
| Candidate recall among the top 10 per website | At least 95% |
| Strong-tier precision, using the lower 95% Wilson confidence bound on held-out data | At least 90% |
| Recall across the strong and review tiers | At least 90% |
| False suggestions for products with no true counterpart | At most 2% |
| Review workload | At most 30 pairs per 100 source products |
| Existing human decisions preserved through repeated runs | 100% |
| Grocery regression | At least 95% of existing accepted pairs re-proposed where source data remains equivalent |
| Production matching runtime | Target no more than 10 minutes |
| Production memory consumption | Target approximately 600 MB or less |
| Paid API calls | Zero by default |

Measure precision and recall for the relevant relationship types, especially exact products and substitutes.

Report the number of evaluated examples, the denominators used, actual results, and important uncertainty. Do not confuse accuracy on development examples with independent validation.

The matcher must not automatically accept new matches in this release. The system should keep human review as the final authority.

If a criterion is unmet, determine whether further development, more labels, or a change in the proposed architecture is required. Do not manipulate thresholds, remove difficult examples, or change the evaluation dataset to produce a passing result.

## 6. Preserve existing decisions and data

Your new engine must continue to protect existing production data and human decisions.

Ensure that:

- Human-confirmed and human-rejected matches are never silently overwritten by a new run.
- Repeated matching runs do not create duplicate or contradictory current suggestions.
- Superseded suggestions retain their history.
- Changes in source product information trigger appropriate re-evaluation without silently reversing a human decision.
- Existing prices, products, variants, reports, and collection history remain intact.
- The existing grocery workspace continues to behave correctly.
- Exact matches, different variants, substitutes, related products, and non-matches remain distinct relationships.

Before any migration or production data operation, take a verified backup and test the operation against a copy first.

## 7. Test the real EC2 environment safely

The matching engine has previously been evaluated on a laptop, but the production EC2 instance has limited memory and already runs the API, worker, and database.

Determine whether the new engine can run reliably on the actual server.

Measure realistic runtime and peak memory usage, including its interaction with the existing services. Determine whether concurrent matching jobs could affect catalogue collection, authentication, reports, or other production functionality.

Use a bounded, safe evaluation first. Shadow mode must not change visible matching decisions or normal Price Comparison results.

If the available resource headroom is insufficient, do not launch an uncontrolled full-catalogue matching job or jeopardise the live application. Investigate suitable alternatives and report the evidence.

Do not create additional paid infrastructure without my explicit approval.

## 8. Use shadow mode before enabling the new matcher

Run the new engine in shadow mode against a safe copy or isolated evaluation dataset, comparing its suggestions with the existing matcher and human-reviewed decisions.

Where production data is needed, use read-only exports or a method that does not alter visible decisions.

Validate the following before activation:

- The system preserves existing human decisions.
- The review workload is manageable.
- Independent accuracy criteria are met.
- The grocery regression passes.
- Automotive false-positive examples are investigated.
- Runtime and memory requirements are acceptable.
- The frontend and backend are compatible.
- Rollback is possible without losing data or human decisions.

The new matcher is already deployed but disabled. Keep it disabled for normal workspaces until the necessary release gates are satisfied.

Do not switch it on automatically simply because the tests pass.

## 9. Make the interface useful and honest

The user should be able to understand whether matching has not run, ran but found no candidates, produced suggestions that need review, or completed with all suggestions reviewed.

Every proposed match should have a clear relationship label, evidence tier, and explanation of the supporting facts or relevant differences.

Do not display uncalibrated confidence percentages.

The normal Price Comparison view must continue to show only human-confirmed exact matches and same-product variants. Confirmed substitutes may be displayed separately and clearly labelled. Unconfirmed suggestions must not be treated as confirmed price comparisons.

Avoid making unrelated UI or feature changes.

## 10. Final verification and deployment

After implementation:

- Run the complete relevant automated test suite.
- Run type checking, linting, and the production build.
- Verify the new matching engine's evaluation metrics on the held-out dataset.
- Confirm that repeated runs preserve all human decisions.
- Verify that the grocery and automotive workspaces behave correctly.
- Measure the resource requirements on EC2 wherever safely possible.
- Confirm that the live application remains healthy.
- Record the actual deployment versions and provide evidence of any changes made.

Deploy improvements through the existing workflow only when safe. If SSH or another external access requirement prevents deployment, complete independent work and explain precisely what remains blocked.

## 11. Final report

Give me a clear report covering:

1. How you reduced the review workload and why the changes are effective.
2. The actual precision, recall, candidate recall, false-positive rate, and review workload.
3. The results for each tested category and held-out website.
4. Whether the grocery regression and human-decision preservation tests pass.
5. The actual runtime and memory consumption on EC2, or why they remain unverified.
6. Whether the new matcher is still disabled or has satisfied every release gate.
7. Whether the frontend and backend are deployed and compatible.
8. Any remaining tasks that genuinely require human review.

Do not claim the matcher is production-ready merely because it has been deployed or because the automated tests pass.

**Final objective:** Make Shelfwatch's new universal matching system accurate, useful, scalable, and manageable to review. Reduce excessive suggestions without losing genuine matches, prove its quality using independent evidence, and only activate it when the agreed release criteria are satisfied.


