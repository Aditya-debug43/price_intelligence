CREATE TABLE "ai_match_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"source_evidence" text,
	"policy_version" text,
	"last_run_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"candidates" integer DEFAULT 0 NOT NULL,
	"judged" integer DEFAULT 0 NOT NULL,
	"eligible" integer DEFAULT 0 NOT NULL,
	"approved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "match_eval_truths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"critical" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
DROP INDEX "ai_usage_day_model_uq";--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD COLUMN "auto_policy_version" text;--> statement-breakpoint
ALTER TABLE "ai_quota_state" ADD COLUMN "key_id" text DEFAULT 'k1' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_quota_state" DROP CONSTRAINT IF EXISTS "ai_quota_state_pkey";--> statement-breakpoint
ALTER TABLE "ai_quota_state" ADD CONSTRAINT "ai_quota_state_model_key_id_pk" PRIMARY KEY("model","key_id");--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD COLUMN "key_id" text DEFAULT 'k1' NOT NULL;--> statement-breakpoint
ALTER TABLE "match_auto_approval" ADD COLUMN "policy_version" text;--> statement-breakpoint
ALTER TABLE "match_eval_cases" ADD COLUMN "family_key" text;--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "ai_continuous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_match_work" ADD CONSTRAINT "ai_match_work_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_work" ADD CONSTRAINT "ai_match_work_source_variant_id_variants_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_truths" ADD CONSTRAINT "match_eval_truths_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_truths" ADD CONSTRAINT "match_eval_truths_case_id_match_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."match_eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_match_work_source_uq" ON "ai_match_work" USING btree ("source_variant_id");--> statement-breakpoint
CREATE INDEX "ai_match_work_org_idx" ON "ai_match_work" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "match_eval_truth_uq" ON "match_eval_truths" USING btree ("case_id","variant_id");--> statement-breakpoint
CREATE INDEX "match_eval_truth_org_idx" ON "match_eval_truths" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_day_model_key_uq" ON "ai_usage_daily" USING btree ("day","model","key_id");--> statement-breakpoint
-- Evaluation cases are split by product FAMILY (a normalised parent title: sibling variants and duplicate listings stay together). Cases nobody has labelled yet are re-split by that rule;
-- a labelled case is never moved.
UPDATE "match_eval_cases" e SET "family_key" = md5(lower(regexp_replace(p.title, '[^a-zA-Z0-9]+', '', 'g'))) FROM "variants" v JOIN "products" p ON p.id = v.product_id WHERE v.id = e.source_variant_id;--> statement-breakpoint
UPDATE "match_eval_cases" SET "split" = CASE WHEN abs(('x' || substr("family_key", 1, 8))::bit(32)::bigint) % 100 < 40 THEN 'holdout' ELSE 'development' END WHERE "status" = 'pending' AND "family_key" IS NOT NULL;
