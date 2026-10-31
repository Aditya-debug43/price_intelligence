# Directive 20 — verbatim (2026-10-31)

Shelfwatch: Complete and Activate a Reliable Universal Product-Matching System
I want to make my expectations very clear regarding the product-matching system.
We have already spent several rounds investigating, researching, designing, implementing, testing, and improving the matching engine. You have developed multiple versions, including v2.7, but I still do not have a fully operational universal matching system that reliably identifies comparable products across my websites.
I do not want another research-only response, another proposal, another list of things I should manually review, or another explanation of why the matching engine is still disabled.
I want you to solve this problem and deliver a working matching system. Take ownership of the technical decisions and complete the implementation.
The most important requirement is that the matching system must work across different product categories, especially automotive products and accessories.
1. Understand the actual objective
Shelfwatch collects products from my own store and multiple competitor websites.
The main purpose of Shelfwatch is to identify which products from different websites are:

* The exact same product.
* The same underlying product with different packaging or variants.
* Different-brand products that serve the same purpose and are valid substitutes.
* Related products that should not be treated as interchangeable.
* Completely different products.

The current matcher has struggled with automotive products because it relies too heavily on barcodes, brand names, manufacturer part numbers, and particular size attributes.
This is not acceptable for a universal competitor-intelligence platform.
For example, two automotive lighting products can be genuinely comparable even when they have different brands, titles, marketing descriptions, or incomplete identifiers.
The new matching system must understand the actual identity, function, compatibility, specifications, and differences of products rather than depending on a few fixed matching conditions.
2. Make automotive matching a major priority
Your previous evaluations revealed that automotive matching is particularly difficult.
I want you to focus heavily on this category and make the matching engine capable of identifying genuine automotive alternatives.
Consider the actual information available in automotive product listings, including:

* Bulb socket and base codes.
* Equivalent industry-standard code aliases where verified.
* Headlight, fog light, DRL, interior light, signal light, brake light, and other functions.
* Vehicle manufacturers, model names, generations, and production years.
* Vehicle-specific and universal compatibility.
* LED, HID, halogen, and other technologies.
* Voltage, wattage, lumens, colour temperature, and colour modes.
* Single-colour and dual-colour configurations.
* Product variants and different installation positions.
* Complete kits, bundles, adapters, resistors, decoders, and harnesses.
* Manufacturer part numbers and other product identifiers.
* Installation requirements and compatibility exclusions.

Do not treat these attributes as a mandatory checklist that every product must satisfy. Use the information that is actually available and relevant to each product.
For example:
Two H11 LED bulbs from different brands may be genuine substitutes even without a shared barcode or manufacturer part number.
An H11 bulb and an H7 bulb may be incompatible even if their product titles are otherwise nearly identical.
An LED bulb and a decoder may share product terminology but are different product types.
A vehicle-specific bulb and a generic bulb may be substitutes, but only when the relevant compatibility and specifications support that conclusion.
Your system must understand these distinctions.
Do not create an automotive-only matcher that cannot work with groceries or other products. Automotive is a particularly important test category, but the final architecture must remain universal.
3. Find the strongest practical matching approach
You have already researched different matching techniques and implemented an evidence-based architecture.
Now use that work and your latest findings to produce the strongest practical implementation.
You are free to conduct additional web research, examine technical literature, investigate product-identification standards, study automotive compatibility information, and evaluate other established approaches wherever necessary.
Do not restrict yourself to your existing implementation if you find a better approach.
Do not select an algorithm merely because it is fashionable or AI-based. Evaluate it against the actual matching problems in Shelfwatch.
You must determine a concrete approach that handles:

* Different product names and descriptions.
* Missing identifiers.
* Different brands.
* Different terminology and abbreviations.
* Variants and packaging differences.
* Product specifications and compatibility.
* Products that are similar but not interchangeable.
* Products whose information is incomplete.

Use your technical judgement to determine the appropriate combination of techniques, data processing, product enrichment, candidate discovery, ranking, evidence evaluation, and other capabilities.
Do not keep adding isolated rules for every new website or product that fails. Solve the underlying general problem.
4. Do not make matching unnecessarily restrictive
This is one of my most important requirements.
The old system frequently rejected genuine comparable products because an exact identifier or a particular attribute was missing.
I do not want that problem repeated.
When two products have different names, investigate the actual products before rejecting them.
When brands differ, investigate whether they are interchangeable.
When an attribute is missing, do not automatically interpret it as a mismatch.
Use all available product information to discover legitimate alternatives.
However, distinguish between missing information and contradictory information. A missing socket code is not the same as a confirmed incompatible socket.
Do not allow one weak similarity signal to establish a strong match, and do not allow an absent attribute to unnecessarily eliminate a genuinely promising candidate.
The matching system should be broad in discovering candidates and rigorous in evaluating their actual relationships.
5. Make the matching system autonomous
I do not want the entire matching process to depend on me manually reviewing hundreds of products.
I am not an expert in every product category, and manually identifying every product relationship is not practical.
The system should make its own evidence-based decisions wherever the available information is sufficient.
Use the following relationship distinctions:

1. Exact product.
2. Same product with a different variant or packaging.
3. Comparable substitute.
4. Related product.
5. Non-match.
6. Insufficient evidence.

For every result, explain the important supporting evidence and differences.
Automatic results

* Strongly supported exact matches and same-product variants should be eligible for automatic confirmation once the implemented system has demonstrated adequate reliability.
* Strongly supported substitutes should be classified separately and displayed as substitutes, never as identical products.
* Medium-confidence cases should remain available as potential matches with their explanations, rather than disappearing because they fail an exact-match condition.
* Insufficient-evidence cases should be identified honestly.
* Products with no genuine counterpart should remain unmatched.

Do not require me to manually approve every result just to make the application useful.
Do not present uncertain substitutes as verified exact matches.
6. Make Price Comparison useful
The matching system exists to make meaningful price comparison possible.
Update the matching and comparison workflow so that customers can distinguish:

* Identical products with directly comparable prices.
* The same product with a different pack size or quantity.
* Different-brand substitutes with their specification differences.
* Related products that should not be compared directly.

Where appropriate, show normalised per-unit prices for different pack sizes.
For substitutes, show relevant differences such as wattage, compatibility, brightness, quantity, or other meaningful specifications.
Do not hide useful alternatives merely because they are not exact matches. At the same time, do not mix substitutes into an identical-product price comparison.
The interface should make these distinctions understandable without requiring the customer to understand the internal matching algorithm.
7. Stop unnecessarily delaying implementation
I want you to proceed beyond the current research and development stage.
Use the existing v2.7 implementation as your starting point. Improve it where necessary, replace defective components where justified, and complete the matching workflow.
Do not spend another session only explaining why the system does not meet an aspirational evaluation target.
Do not repeatedly ask me to label products, make technical design decisions, approve ordinary implementation details, or review dozens of individual pairs before you can continue.
Use the existing datasets, previous evaluations, research, and your own product-analysis capabilities.
Where product evidence is genuinely unavailable, preserve uncertainty. Do not use that limitation as a reason to stop improving all the other supported matching cases.
I want actual implementation, not another proposal.
8. Improve matching quality using real data
Use the available automotive and grocery catalogues to test and improve the new matcher.
Evaluate the previous mistakes, including:

* Cherokee versus Grand Cherokee.
* Transit versus F-250.
* Different bulb functions sharing the same socket terminology.
* Bulb versus adapter or decoder.
* Different colours and lighting modes.
* Different vehicle generations.
* Different grocery flavours and formulations.
* Different pack quantities and product variants.

Look at both missed genuine matches and incorrect proposed matches.
Do not simply optimise for the examples you have already examined.
Use separate development and evaluation data where possible, and conduct fresh evaluations on products and websites not used for tuning.
Measure precision, recall, false-positive rates, candidate recall, review workload, and category-specific performance.
Work towards the acceptance criteria in the existing proposal, especially:

* At least 95% candidate recall in the top 10 per website.
* At least 90% strong-tier precision, measured on a held-out dataset.
* At least 90% recall across strong and review tiers.
* No more than 2% false suggestions for products with no genuine counterpart.
* Manageable review workload.

These targets must be measured honestly. Do not manipulate the test set or claim that the system meets them without evidence.
If a target remains unmet, improve the responsible part of the system and report precisely what is still weak. Do not abandon the entire implementation simply because one metric remains below target.
9. Preserve existing functionality and production data
This is an existing, deployed application.
Preserve:

* All existing products and variants.
* Historical prices and price observations.
* Existing accounts and workspaces.
* Existing human-confirmed and rejected decisions.
* Product links and source website relationships.
* Reports, alerts, collection history, and other application features.

Do not reset the production database or destroy existing matching decisions.
Take verified backups before migrations or risky production operations.
Keep the frontend and backend compatible.
Do not introduce paid services or new recurring infrastructure costs without explaining them and obtaining my approval.
10. Activate the new matching system
I do not want another cycle where the new matching engine is built, deployed, and then left disabled indefinitely.
Once the implementation has passed its practical verification, make the new matching system the active matching approach.
Do not leave all three workspaces on the old matcher merely because some aspirational metric cannot be established perfectly.
Use appropriate confidence levels and relationship classifications to handle different levels of evidence. Activate the new system for the supported workflows and make its actual limitations visible.
If a specific category has unresolved risks, report those clearly without disabling the entire matching system across every category.
Preserve an appropriate rollback path.
No new matches should be represented as verified exact products when the evidence does not support that conclusion.
11. Test the actual production environment
The matching system runs on an AWS EC2 instance with limited memory.
Measure the actual performance on the server, not only on your laptop.
Verify that it does not disrupt the API, background worker, database, product collection, or other services.
Run representative matching jobs and confirm that results are persisted correctly and displayed on the live application.
Verify that the system can be rerun without duplicating matches or overwriting previous human decisions.
Perform the necessary backups, migrations, deployment checks, and health verification.
If SSH access fails, continue the work that does not require SSH and tell me precisely what access is needed. Do not claim deployment when it has not happened.
12. Final deliverables
I expect a working result, not another architecture proposal.
When finished, tell me:

1. What matching approach you ultimately implemented.
2. How it handles automotive products and other categories.
3. How many genuine matches, substitutes, related products, and non-matches it identifies in the tested datasets.
4. Its measured precision, recall, candidate recall, and false-positive rate.
5. How the review workload has changed.
6. Whether it works within the existing EC2 server's resource limits.
7. Whether the new matcher is actually activated in production.
8. Whether Match Review and Price Comparison show meaningful, correctly classified results.
9. What limitations remain and why.

Provide evidence from actual database records, application behaviour, and test results.
Final instruction
I am giving you ownership of solving the product-matching problem.
Do not return another research-only proposal, another list of decisions for me to make, or another explanation that the matching engine is disabled and needs my review.
Use your technical expertise, research additional approaches if necessary, improve the implementation, test it against real product data, and complete the deployment.
I want Shelfwatch to become a genuinely useful universal competitor product-matching platform, especially for automotive products, that discovers real comparable products across different websites without requiring manual intervention for every match.
Do not force incorrect matches, but do not let genuine matches go undiscovered because of unnecessarily restrictive rules.
Proceed with the implementation and complete the work.
