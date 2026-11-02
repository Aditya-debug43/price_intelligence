# Directive 24 — verbatim (2026-11-02)

# Shelfwatch: Exclude Automotive Combos with Different Bundle Contents from Comparisons

I need to fix a specific issue in the existing automotive product-matching system.

My professor has clarified that when two products are sold as combos/bundles but their contents differ, they should be ignored for comparison because the price comparison would be misleading.

## 1. Actual problem

Currently, Shelfwatch sometimes identifies two automotive bundles as substitutes or comparable products even when one bundle contains additional items that the other does not.

Example:

**Website A — Source product:**
- Headlight
- Brake light

**Website B — Competitor product:**
- Headlight
- Brake light
- Indicator lights

The core products are similar, but Website B includes an additional product.

These two bundles must be classified as **incomparable**, not as:
- Exact matches
- Same product with different variants
- Substitutes eligible for price comparison
- Automatically confirmed comparisons

The price difference between these bundles cannot provide a fair comparison because the customer receives different package contents.

## 2. Required behaviour

Investigate how the existing matching engine identifies and compares automotive bundles.

Extract and compare bundle composition using available evidence, including:

- Product titles.
- Product descriptions.
- Product specifications.
- Variant information.
- Explicit package contents.
- Included accessories and additional components.
- Product images or manufacturer-provided content descriptions, where available.

The system must identify whether two listings contain the same set of products/components.

Apply these rules:

| Source bundle | Competitor bundle | Expected result |
|---|---|---|
| Headlight + brake light | Headlight + brake light | Eligible for comparison |
| Headlight + brake light | Headlight + brake light + indicator lights | Incomparable |
| Headlight only | Headlight + brake light | Incomparable |
| Headlight + 2 indicator lights | Headlight + 1 indicator light | Incomparable |
| Headlight + brake light | Headlight + brake light, different wording | Eligible if contents are verified equivalent |
| Headlight + brake light | Headlight + unrelated accessories | Incomparable |

## 3. Important classification rules

A bundle with additional or missing components must not be treated as a substitute merely because its main product is similar.

For example, the fact that both bundles contain a headlight does not make their complete packages comparable.

Do not use these assumptions:
- Similar product titles mean identical bundles.
- Same vehicle compatibility means identical bundles.
- Same main component means identical package contents.
- Different brands automatically mean substitutes.
- An extra included item can be ignored when comparing the total selling price.

Bundle composition must be considered independently from brand, product similarity and vehicle compatibility.

When a bundle's contents cannot be reliably established, classify it as **insufficient evidence** rather than assuming the contents are identical.

## 4. Enforce the rule throughout Shelfwatch

This restriction must apply to the complete comparison pipeline:

- Candidate classification.
- Exact-match suggestions.
- Substitute suggestions.
- Automatic confirmations.
- Human review recommendations.
- Price Comparison.
- Price-gap calculations.
- Reports and comparison exports.

A bundle-content mismatch must make that particular product pair ineligible for direct price comparison, even if the matching engine gives it a high similarity score.

Suggested exclusion reason:

`INCOMPARABLE_BUNDLE_CONTENT_MISMATCH`

Store the available evidence explaining the exclusion, for example:

- Source bundle: Headlight + brake light.
- Competitor bundle: Headlight + brake light + indicator lights.
- Difference: Competitor includes additional indicator lights.

Do not silently discard the reason.

## 5. Audit existing automotive matches

This is important.

The current matching system has already classified some different-content bundles as substitutes or comparable products.

Audit existing automotive product relationships and identify pairs where bundle contents differ.

For affected pairs:

- Remove their eligibility for price comparison.
- Prevent them from affecting price-gap calculations.
- Stop them from appearing as valid substitute comparisons.
- Preserve existing human decisions and audit history.
- Do not delete the underlying product records.
- Do not silently overwrite human decisions.
- Record the bundle-content mismatch as the reason for exclusion.

This should exclude only the invalid product pair. Do not globally remove a source product from all comparisons if it has other valid competitor matches.

## 6. Important distinction: Unknown contents versus different contents

Do not treat missing information as proof that two bundles are different.

Use three states:

1. **Verified equivalent:** Contents are established as equivalent; eligible for comparison.
2. **Verified mismatch:** One bundle has additional, missing or different components; incomparable.
3. **Unknown:** Available evidence is insufficient to establish equivalence; do not automatically compare.

Do not fabricate bundle contents or make assumptions from incomplete product descriptions.

## 7. Testing requirements

Test at least these scenarios:

1. Identical bundle contents with different wording → Eligible for comparison.
2. Competitor bundle has one extra component → Incomparable.
3. Competitor bundle has one missing component → Incomparable.
4. Same main product but different accessories → Incomparable.
5. Same vehicle compatibility but different bundle contents → Incomparable.
6. One product is standalone and the other is a combo → Incomparable.
7. Bundle composition is unknown → Insufficient evidence.
8. Different brands but verified equivalent bundle contents → Do not reject solely because of brand difference.
9. Existing human-confirmed match with a bundle mismatch → Preserve decision history but exclude from price comparison.
10. Same source product has another valid competitor match → Preserve that valid relationship.

Also test that the rule does not incorrectly identify ordinary product attributes, such as different colour options, as extra bundle components.

## 8. Strict scope restrictions

Do not redesign the matching engine.

Do not modify:
- Product collection.
- Price collection.
- Website management.
- Quantity-compatibility rules already implemented.
- Grocery product matching.
- Authentication.
- Dashboard design.
- Unrelated automotive matching rules.

Implement only the necessary bundle-composition detection and comparison-eligibility changes.

Do not introduce paid AI API dependencies or assume an LLM can reliably identify contents without supporting evidence.

## 9. Final verification

Before declaring completion:

- Audit existing automotive matches.
- Report how many invalid bundle comparisons were identified.
- Report how many were excluded.
- Verify that valid bundle comparisons remain available.
- Verify that mismatched bundles no longer contribute to price comparisons.
- Preserve all existing human decisions and product data.
- Run regression tests for automotive and grocery matching.
- Deploy only after testing and taking an appropriate backup.

Do not report success merely because the code compiles.

**Final principle: Two automotive bundles should be comparable only when their actual included contents are equivalent. If one bundle contains an extra or different component, exclude that product pair from comparison rather than treating it as a substitute.**
