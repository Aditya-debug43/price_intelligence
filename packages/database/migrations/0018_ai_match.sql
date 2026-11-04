CREATE TABLE "ai_dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"version" text NOT NULL,
	"dossier" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_match_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"suggestion_id" uuid,
	"source_variant_id" uuid NOT NULL,
	"competitor_variant_id" uuid NOT NULL,
	"action" text NOT NULL,
	"ai_match_type" text NOT NULL,
	"ai_confidence" text NOT NULL,
	"relationship" text,
	"chosen_variant_id" uuid,
	"match_id" uuid,
	"note" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_match_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'sample' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pause_reason" text,
	"resume_at" timestamp with time zone,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_match_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"source_variant_id" uuid NOT NULL,
	"competitor_variant_id" uuid NOT NULL,
	"competitor_site_id" uuid NOT NULL,
	"match_type" text NOT NULL,
	"ai_match_type" text NOT NULL,
	"confidence" text NOT NULL,
	"ai_confidence" text NOT NULL,
	"price_comparable" boolean DEFAULT false NOT NULL,
	"requires_review" boolean DEFAULT true NOT NULL,
	"explanation" text NOT NULL,
	"supporting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"found_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"engine" jsonb,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"candidate_fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"source_url" text,
	"candidate_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_relationship" text,
	"review_note" text,
	"analysed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_quota_state" (
	"model" text PRIMARY KEY NOT NULL,
	"learned_rpm" integer,
	"learned_rpd" integer,
	"learned_tpm" integer,
	"paused_until" timestamp with time zone,
	"pause_reason" text,
	"stopped" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"thought_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_results" integer DEFAULT 0 NOT NULL,
	"candidates_answered" integer DEFAULT 0 NOT NULL,
	"ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_dossiers" ADD CONSTRAINT "ai_dossiers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_dossiers" ADD CONSTRAINT "ai_dossiers_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_feedback" ADD CONSTRAINT "ai_match_feedback_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_feedback" ADD CONSTRAINT "ai_match_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_runs" ADD CONSTRAINT "ai_match_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_runs" ADD CONSTRAINT "ai_match_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD CONSTRAINT "ai_match_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD CONSTRAINT "ai_match_suggestions_run_id_ai_match_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_match_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD CONSTRAINT "ai_match_suggestions_source_variant_id_variants_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD CONSTRAINT "ai_match_suggestions_competitor_variant_id_variants_id_fk" FOREIGN KEY ("competitor_variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD CONSTRAINT "ai_match_suggestions_competitor_site_id_sites_id_fk" FOREIGN KEY ("competitor_site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD CONSTRAINT "ai_match_suggestions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_dossiers_variant_uq" ON "ai_dossiers" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "ai_feedback_org_idx" ON "ai_match_feedback" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_feedback_pair_idx" ON "ai_match_feedback" USING btree ("source_variant_id","competitor_variant_id");--> statement-breakpoint
CREATE INDEX "ai_runs_org_idx" ON "ai_match_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_status_idx" ON "ai_match_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_suggestions_pair_uq" ON "ai_match_suggestions" USING btree ("source_variant_id","competitor_variant_id");--> statement-breakpoint
CREATE INDEX "ai_suggestions_org_status_idx" ON "ai_match_suggestions" USING btree ("org_id","status","match_type");--> statement-breakpoint
CREATE INDEX "ai_suggestions_source_idx" ON "ai_match_suggestions" USING btree ("source_variant_id");--> statement-breakpoint
CREATE INDEX "ai_suggestions_run_idx" ON "ai_match_suggestions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_day_model_uq" ON "ai_usage_daily" USING btree ("day","model");