# Directive 28 — "Shelfwatch: Implement AI-Assisted Product Matching and Comparability Using Gemini API" (2026-11-04)

This is a **condensed record** of the request, not the verbatim text (the verbatim message is in the session transcript). The API key that accompanied the request is deliberately **not** recorded anywhere in the repository.

**Goal.** Use Gemini (free tier only) to find more genuine candidates across competitor catalogues, understand product information, classify pairs into six types (exact item, same product different pack, close equivalent, substitute, related, no match/uncertain), explain why, say what is missing, and let people Accept / Change / mark Uncertain / Find another product / None of these / View source in Match review. Accuracy and evidence over the number of matches.

**Constraints.** Study engine v2.8 first and do not replace it; Gemini coexists with the rules and is never compulsory. Key backend-only, never in the frontend, GitHub, logs, URLs, responses or errors; official Developer API; a stable Flash/Flash-Lite model verified on the real free tier, configurable without code change; absolutely no paid calls, pause when quota is exhausted, no multiple keys/projects. Free-tier efficiency: batching, caching, shared rate limiter, adaptive concurrency, 429 handling, token efficiency, usage monitoring, no claim about remaining quota unless exposed.

**Product understanding.** Richer sourced dossiers (grocery and automotive attributes, unknown stays unknown); many local candidate-discovery methods with diverse candidates per website; strict evidence rules (never invent, price is not evidence, AI never overrides verified hard conflicts, shared code or vehicle alone is not equivalence).

**Policies kept.** Quantity and automotive bundle policies stay active; missing quantity stays unknown; different-pack suggestions shown separately without changing Price Comparison; document what a unit-price view would need; a human decision does not remove an exclusion by itself.

**Match review UI.** Preserve the design language; show the source and competitor product, AI type, confidence, why, evidence, links, and an attribute comparison.

**Shadow mode / data.** AI suggestions in separate tables with run, model/prompt versions, evidence, usage and human feedback; never overwrite human decisions, auto-approve, change prices or Price Comparison; use the existing human-decision functions; no duplicates on re-run.

**Rollout.** Shadow analysis on a representative sample → display in Match review → measure (precision, recall, candidate recall, workload) → automatic approval **not** enabled until an independent human-labelled evaluation exists.

**Production.** Use the existing worker, bounded batches, pause/resume, no impact on the site, backup before schema change, deploy frontend and backend together, small production run first, no full-catalogue analysis before quota and server impact are measured.

**Final report (17 items).** How Gemini was integrated; model; free-tier availability; quota information available; token/throughput management; candidate discovery improvements; classification; Match review additions; storage; quantity/bundle preservation; products and pairs analysed; results by domain; precision/recall/candidate recall with label sources; files and database changes; tests; deployment status; limitations — distinguishing implemented / tested / production-verified. See `docs/ai-matching.md`.
