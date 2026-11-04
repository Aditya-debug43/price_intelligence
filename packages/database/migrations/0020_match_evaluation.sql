CREATE TABLE "ai_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"model" text NOT NULL,
	"text_hash" text NOT NULL,
	"dims" integer NOT NULL,
	"vector" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_auto_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"auto_class" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_by" uuid,
	"enabled_at" timestamp with time zone,
	"gate_at_enable" jsonb,
	"disabled_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"competitor_site_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"stratum" text NOT NULL,
	"split" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"truth_variant_id" uuid,
	"truth_relationship" text,
	"expertise" text,
	"labelled_by" uuid,
	"labelled_at" timestamp with time zone,
	"note" text,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_eval_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"split" text NOT NULL,
	"report" jsonb NOT NULL,
	"gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cases" integer NOT NULL,
	"engine_version" text,
	"model" text,
	"prompt_version" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_match_suggestions" ADD COLUMN "auto_class" text;--> statement-breakpoint
ALTER TABLE "ai_embeddings" ADD CONSTRAINT "ai_embeddings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_embeddings" ADD CONSTRAINT "ai_embeddings_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_auto_approval" ADD CONSTRAINT "match_auto_approval_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_auto_approval" ADD CONSTRAINT "match_auto_approval_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_cases" ADD CONSTRAINT "match_eval_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_cases" ADD CONSTRAINT "match_eval_cases_source_variant_id_variants_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_cases" ADD CONSTRAINT "match_eval_cases_competitor_site_id_sites_id_fk" FOREIGN KEY ("competitor_site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_cases" ADD CONSTRAINT "match_eval_cases_labelled_by_users_id_fk" FOREIGN KEY ("labelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_reports" ADD CONSTRAINT "match_eval_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_eval_reports" ADD CONSTRAINT "match_eval_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_embeddings_variant_model_uq" ON "ai_embeddings" USING btree ("variant_id","model");--> statement-breakpoint
CREATE INDEX "ai_embeddings_org_idx" ON "ai_embeddings" USING btree ("org_id","model");--> statement-breakpoint
CREATE UNIQUE INDEX "match_auto_approval_uq" ON "match_auto_approval" USING btree ("org_id","domain","auto_class");--> statement-breakpoint
CREATE UNIQUE INDEX "match_eval_case_uq" ON "match_eval_cases" USING btree ("source_variant_id","competitor_site_id");--> statement-breakpoint
CREATE INDEX "match_eval_org_idx" ON "match_eval_cases" USING btree ("org_id","status","split");--> statement-breakpoint
CREATE INDEX "match_eval_reports_org_idx" ON "match_eval_reports" USING btree ("org_id","created_at");