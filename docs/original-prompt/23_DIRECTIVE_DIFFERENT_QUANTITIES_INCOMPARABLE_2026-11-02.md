# Directive 23 — verbatim (2026-11-02)

# Shelfwatch: Make Products with Different Quantities Incomparable

I want to implement a specific change in Shelfwatch's product-matching and price-comparison system.

My professor has advised that products with different quantities or sizes should be treated as incomparable for now, rather than normalising their prices into per-litre, per-kg or per-unit prices.

For example:
- One website sells a 10-litre bottle, while another sells a 20-litre bottle.
- One website sells 500 g of a product, while another sells 1 kg.
- One website sells a pack of 6 pieces, while another sells a pack of 12 pieces.
- One website sells a 1-litre container, while another sells a 5-litre container.

Even when the product name and brand are identical, these products must not be treated as directly comparable when their actual quantities differ.

## 1. Main requirement

Implement a strict quantity-compatibility rule.

**Products with different actual quantities must be classified as incomparable for price comparison.**

Do not:
- Compare their total selling prices.
- Convert their prices into per-litre or per-kg prices.
- Use unit-price normalisation to make them comparable.
- Automatically accept them as the same product with a different pack size.
- Include them in normal price-comparison conclusions.

The goal is to avoid misleading price differences.

## 2. Quantity information to investigate

Determine the actual product quantity using all relevant available information:

- Product title.
- Product variant title and options.
- Product description.
- Structured product attributes.
- Package-size information.
- Unit and measurement information.
- Existing extracted product attributes.

Support relevant quantity dimensions, including:

| Dimension | Examples |
|---|---|
| Volume | ml, L, litres |
| Mass / weight | g, kg, mg |
| Count | 1 piece, 6 pieces, 12 pieces |
| Length | cm, m, mm |
| Area | sq. ft., sq. m. |
| Other measurable quantities | Where reliably identified |

Do not assume all numerical values in a product title represent quantities. For example, a model number, vehicle year, bulb code or product identifier must not be mistaken for pack size.

## 3. Normalise units only to determine equivalence

Unit conversion is allowed only to determine whether two products have the same actual quantity.

Examples:

| Product A | Product B | Classification |
|---|---|---|
| 1 L | 1000 ml | Comparable |
| 1 kg | 1000 g | Comparable |
| 500 g | 1 kg | Incomparable |
| 10 L | 20 L | Incomparable |
| 6 pieces | 12 pieces | Incomparable |
| 2 m | 200 cm | Comparable |
| 1 kg | 1 L | Incomparable / unknown |

Important:
- Never assume that 1 kg equals 1 litre.
- Do not convert between different measurement dimensions without reliable, product-specific conversion information.
- Do not infer missing quantities.
- Do not treat unknown quantity as a confirmed quantity match.

For multi-pack products, investigate the total actual quantity, not just the number of containers. For example, 2 × 1 L and 1 × 2 L both contain 2 L in total. However, preserve the package configuration as a separate attribute.

## 4. Handle missing or uncertain quantity information

Not every website provides quantity information in a structured format.

Apply these rules:

- If both quantities are clearly identified and equal after unit normalisation, they can remain eligible for comparison.
- If both quantities are clearly identified but differ, classify the products as incomparable.
- If one quantity is missing or ambiguous, do not automatically accept the pair as comparable.
- If the system cannot reliably determine whether quantities match, classify it as insufficient evidence or quantity unknown.

Do not guess quantities from product names or similar descriptions.

## 5. Integrate this rule into the existing matching engine

Investigate how the current matching engine handles:

- Exact matches.
- Same product with different pack sizes.
- Substitutes.
- Related products.
- Automatically confirmed matches.
- Human-confirmed matches.

The new quantity rule must be enforced before a pair is used for price conclusions.

A product with a different actual quantity must not appear as a direct price comparison simply because its name, brand, model or description is similar.

Do not let the AI matcher override this rule based on textual similarity or brand similarity.

Keep quantity mismatch distinct from an ordinary non-match so that the system can record why the products were excluded.

Suggested classification reason:

`INCOMPARABLE_QUANTITY_MISMATCH`

Also retain the extracted values and evidence, for example:

`Product A: 10 L`
`Product B: 20 L`
`Reason: Actual volume differs`

## 6. Existing matches and historical decisions

This is important because Shelfwatch already contains accepted and automatically confirmed product pairs.

Audit existing comparison pairs for quantity mismatches.

For pairs that violate the new rule:
- Prevent them from contributing to direct price comparisons.
- Prevent them from generating misleading price-gap conclusions.
- Preserve existing human decisions and their audit history.
- Do not silently delete or overwrite human decisions.
- Clearly record that the pair is excluded by the new quantity-compatibility policy.
- Do not automatically re-confirm previously rejected pairs.

If a human-confirmed pair conflicts with this policy, retain the original decision record but make the pair ineligible for price comparison until the conflict is explicitly resolved.

## 7. Test the implementation

Create tests covering at least these cases:

1. Same brand, same product, 10 L versus 20 L → Incomparable.
2. Same brand, same product, 500 g versus 1 kg → Incomparable.
3. Same product, 1 L versus 1000 ml → Eligible.
4. Same product, 1 kg versus 1000 g → Eligible.
5. Same product, pack of 6 versus pack of 12 → Incomparable.
6. Same product, 2 × 1 L versus 1 × 2 L → Same total volume; preserve packaging difference.
7. Same numerical product code but different measurement quantities → Quantity mismatch must take priority.
8. Quantity missing on one side → Insufficient evidence, not automatically comparable.
9. 1 kg versus 1 L → Incomparable; do not assume equal quantities.
10. A model number such as 9005 or 7443 must not be interpreted as a product quantity.
11. Existing human-confirmed pair with a quantity mismatch → Decision history preserved, but excluded from price conclusions.

Also verify that the Price Comparison page no longer displays quantity-mismatched products as directly comparable.

## 8. Strict scope restrictions

Do not redesign or rewrite the entire matching engine.

Do not modify unrelated functionality, including:
- Product collection and scraping.
- Competitor website management.
- Price collection.
- Authentication.
- Dashboard layout.
- Reports unrelated to affected comparisons.
- Existing matching decisions except for the comparison-eligibility enforcement described above.

Preserve the existing matching architecture and implement the smallest reliable change that enforces this rule.

Do not introduce paid AI API dependencies.

## 9. Final verification and report

Before declaring this complete:

- Run the relevant automated tests.
- Audit existing production matches for quantity mismatches.
- Verify that excluded pairs no longer influence Price Comparison.
- Verify that equal quantities expressed in different units remain eligible.
- Verify that existing human decisions and historical records are preserved.
- Confirm that unrelated matching behaviour has not regressed.

Provide a report with:
1. Root cause and implementation details.
2. Files and database components changed.
3. Number of existing pairs identified as quantity mismatches.
4. Number of pairs excluded from price comparison.
5. Test results.
6. Confirmation that human decisions were preserved.
7. Confirmation of production deployment, if performed.

**Final principle: When actual product quantities differ, Shelfwatch should leave the products incomparable for now. Do not manufacture comparability through per-unit price calculations. Accuracy is more important than increasing the number of product comparisons.**
