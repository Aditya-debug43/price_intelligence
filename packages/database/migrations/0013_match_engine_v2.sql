CREATE TABLE "match_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_variant_id" uuid NOT NULL,
	"competitor_variant_id" uuid NOT NULL,
	"match_id" uuid,
	"kind" text NOT NULL,
	"relationship" text,
	"tier" text,
	"status" text,
	"decision" text,
	"evidence" jsonb,
	"engine_version" text,
	"pair_hash" text,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"engine_version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "matching_engine" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "relationship" text;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "pair_hash" text;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "needs_reevaluation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_runs" ADD CONSTRAINT "match_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_events_pair_idx" ON "match_events" USING btree ("org_id","source_variant_id","competitor_variant_id","created_at");--> statement-breakpoint
CREATE INDEX "match_events_kind_idx" ON "match_events" USING btree ("org_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "match_runs_org_idx" ON "match_runs" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "matches_org_rel_idx" ON "product_matches" USING btree ("org_id","relationship","status");