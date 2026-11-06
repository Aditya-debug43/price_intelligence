ALTER TABLE "match_eval_cases" ADD COLUMN "truth_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A label made before judgments existed said "no counterpart here" with the relationship "none": that was a complete answer. A label naming one counterpart stays incomplete (nobody said the list was exhaustive).
UPDATE "match_eval_cases" SET "truth_complete" = true WHERE "truth_relationship" = 'none';
