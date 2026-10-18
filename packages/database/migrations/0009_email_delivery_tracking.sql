ALTER TABLE "email_outbox" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_response" text;--> statement-breakpoint
-- Earlier versions marked messages that were only written to the local outbox (no mail server) as "dev_logged". Nothing was ever sent, and the
-- product now says exactly that.
UPDATE "email_outbox" SET "status" = 'not_configured', "error" = COALESCE("error", 'Email delivery was not configured, so this message was not sent.') WHERE "status" = 'dev_logged';
