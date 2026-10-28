ALTER TABLE "scan_runs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "continuations" integer DEFAULT 0 NOT NULL;