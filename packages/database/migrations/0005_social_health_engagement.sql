ALTER TABLE "marketing_activities" ADD COLUMN "engagement" jsonb;--> statement-breakpoint
ALTER TABLE "marketing_activities" ADD COLUMN "engagement_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "credential_fingerprint" text;