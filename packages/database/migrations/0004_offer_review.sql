ALTER TABLE "offers" ADD COLUMN "review_status" text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "original_reading" jsonb;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;