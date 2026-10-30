# Directive 19 — verbatim (2026-10-30)




Shelfwatch: Complete the Universal Product-Matching Project Without Requiring Manual Labelling From Me
I have reviewed your reconciliation report and the evaluation workbook. I understand that 36 product pairs were flagged for human verification and that the two AI evaluations disagreed on several products.
However, I am not an expert in automotive products, product specifications, or matching evaluation, so I cannot reliably judge these pairs myself. I do not want the project to remain blocked waiting for me to label products.
I want you to take responsibility for completing the remaining evaluation, making the necessary matching improvements, and progressing the implementation as far as possible using your own research, technical judgement, and the available evidence.
Do not ask me to manually review the 36 disputed pairs or label 300 products before continuing. Determine the best practical way to proceed independently.
1. Continue from the current project state
Start by reviewing the existing documents and artifacts, including:

* `docs/proposals/universal-matching-design.md`
* `docs/matching-engine-v2.md`
* `docs/matching-validation-2026-10-29.md`
* The original product-pair review workbook.
* The reconciled workbook containing both evaluators' labels and your recommended decisions.
* The current matching engine implementation and its latest evaluation results.

Inspect the repository and deployment state rather than assuming previous work is still unchanged.
Continue from the existing implementation. Do not unnecessarily repeat completed work or rewrite the system from scratch.
2. Evaluate the disputed product pairs yourself
Review all 120 product pairs, paying particular attention to the 36 cases flagged for verification.
You may use the product URLs, stored descriptions, variant options, part numbers, sizes, compatibility information, images, and other available evidence.
Where necessary, conduct additional web research to understand relevant product terminology, automotive bulb standards, vehicle compatibility, grocery variants, packaging conventions, or other category-specific differences.
Use multiple sources of evidence where appropriate. Distinguish information obtained from a product's own page from information inferred from its title, another website, general product knowledge, or a third-party source.
Do not rely blindly on either AI evaluator's labels. Reassess the evidence and explain why a classification is justified.
For each disputed pair, make your best defensible decision among:

* Exact product.
* Same product with a different variant or packaging.
* Comparable substitute.
* Related product.
* Non-match.
* Insufficient evidence.

Do not ask me to resolve disagreements. Use your own judgement and available research.
If the source pages are inaccessible or the available information cannot establish compatibility reliably, record that limitation and classify the pair conservatively. You may recommend a plausible substitute where supported by evidence, but do not present an uncertain product as an exact match.
The aim is to complete the evaluation independently, not to pretend that every product can be verified with certainty.
3. Establish usable evaluation labels
Create a consolidated evaluation dataset using the reconciled workbook, your original labels, and the other AI's labels.
Preserve the provenance of every label so that it is clear whether a decision came from the first evaluator, the other AI, your own evidence-based adjudication, or a verified identifier or source attribute.
Where the evaluators disagree, record your final recommendation and its supporting evidence.
Where all evaluators agree, still check important cases for obvious mistakes. Agreement between AI systems does not itself establish that a product match is correct.
Do not overwrite the original workbook or erase the previous labels.
Produce a final adjudicated dataset that can be used for further development and testing. Keep genuinely uncertain pairs explicitly marked rather than forcing them into a positive or negative category.
Because you are performing the adjudication yourself, do not describe the resulting labels as independent human ground truth. State this limitation clearly in the evaluation report.
4. Use the evaluation to improve the matching engine
Review the remaining shortcomings in the matching engine and make the necessary improvements.
Your priorities are:

1. Improve the discovery of genuine product matches across different websites and categories.
2. Reduce false positives caused by similar titles, common part codes, vehicle names, incompatible product types, different flavours, and misleading variant information.
3. Keep exact matches separate from substitutes and related products.
4. Reduce unnecessary review suggestions without sacrificing genuine matches.
5. Preserve useful matching behaviour for existing grocery products while improving support for automotive accessories and other categories.
6. Make matching decisions explainable, with evidence for the similarities and differences.
7. Preserve existing accepted and rejected decisions across reruns.

Do not tune the matching engine simply to reproduce your own labels. Use a development dataset for adjustments and maintain a separate evaluation set wherever the available data allows.
Where you have already examined a held-out set during earlier development, do not continue presenting it as independent validation. Find another suitable set of products or websites where possible. If that is impossible, report the limitation.
5. Make the system useful without requiring perfect information
The matching engine should not require every product to have a barcode, manufacturer part number, complete specifications, or an identical title.
Use the available evidence appropriate to each product category to identify possible matches.
At the same time, do not force a match merely to prevent an empty Match Review page. Some products genuinely have no counterpart.
When information is missing, distinguish between a likely substitute, a related product, a non-match, and a case where the evidence is insufficient.
Rank suggestions so that the most useful candidates appear first. Keep Match Review manageable, and ensure that a large number of product variants does not create an unnecessarily overwhelming review queue.
Use the evidence from the existing product catalogues to make improvements that generalise beyond individual websites.
6. Proceed through implementation without waiting for my manual decisions
Continue implementation using the staged architecture already approved.
You have permission to make the necessary code changes, tests, documentation updates, and reversible database changes required for the matching project.
Use shadow mode, isolated evaluation data, or another safe approach where appropriate. Preserve existing production decisions and product data.
Do not automatically accept newly generated matches. The initial release should continue to require human confirmation for new exact matches, variants, and substitutes.
The normal Price Comparison page must continue to display only human-confirmed exact matches and confirmed variants. Confirmed substitutes may appear separately with a clear label. Unconfirmed suggestions must not be presented as verified comparisons.
You do not need my approval for ordinary, reversible implementation choices covered by this instruction. If you encounter a genuinely irreversible operation, a substantial new recurring cost, a requirement for new paid external services, or a material security risk, stop that operation and explain the issue.
7. Handle testing and accuracy requirements honestly
Continue evaluating the matching system using the agreed metrics, including precision, recall, candidate recall, false-positive rates, review workload, grocery regression, runtime, and memory consumption.
Keep the proposed acceptance criteria in the existing design document as the targets to work toward.
Do not manufacture a passing result by changing the definition of success, excluding difficult cases without justification, or evaluating only examples used during development.
If some acceptance criteria remain unmet, investigate what can be improved and keep working where progress is possible. Do not stop the entire project merely because the available evaluation data is imperfect.
If independent human agreement, sufficient held-out data, or reliable ground truth cannot be obtained, explain exactly what remains unverified and what conclusions can still be drawn.
Do not claim that the matching system is independently validated or production-ready solely because automated tests pass.
8. Production safety and deployment
Inspect the current Git state, deployed versions, AWS environment, and database before proceeding.
Preserve existing product records, variants, price history, workspaces, reports, and every human-confirmed or rejected match.
Use verified backups before migrations or risky production operations. Test changes safely before deployment.
If SSH access is available, complete the deployment through the existing workflow and verify the live result. If access becomes unavailable, continue the independent work, save and document the changes, and report the exact deployment blocker rather than claiming success.
Do not commit sensitive production data, product-pair evaluation exports, credentials, or private keys to the public GitHub repository.
9. Final deliverables
I want you to complete the following:

* An adjudicated evaluation dataset with evidence, relationship labels, provenance, and uncertainty recorded.
* A clear report explaining the difficult matching cases and your final judgements.
* The improved universal matching implementation and appropriate regression tests.
* A before-and-after evaluation showing the measured improvements and remaining weaknesses.
* A report of whether each acceptance criterion was met, unmet, or could not be verified.
* Verified deployment status and confirmation that existing production data and human decisions were preserved.
* Documentation explaining how the matching engine works and how future improvements will be evaluated.

Keep the original evaluation files unchanged and store sensitive working datasets outside the public repository.
Final objective
Please take ownership of completing the product-matching project using your own technical judgement and the available evidence.
Do not wait for me to become a product-matching expert or manually label every disputed pair. Research the difficult cases, make defensible decisions, improve the engine, and complete the safe implementation and deployment work.
The result must maximise useful matching coverage without creating misleading product comparisons. Where certainty is impossible, preserve the uncertainty and explain it honestly.
Proceed independently, and provide me with the completed work and a clear final report.


