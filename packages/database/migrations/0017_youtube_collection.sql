ALTER TABLE "marketing_activities" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "external_title" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "syncing_since" timestamp with time zone;