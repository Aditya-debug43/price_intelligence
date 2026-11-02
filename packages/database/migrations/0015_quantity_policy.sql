ALTER TABLE "product_matches" ADD COLUMN "price_exclusion" text;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "price_excluded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_matches" ADD COLUMN "quantity_check" jsonb;