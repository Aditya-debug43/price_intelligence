ALTER TABLE "evidence" ADD COLUMN "provenance" text DEFAULT 'public_web' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "provenance" text DEFAULT 'exchange_rate_service' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_activities" ADD COLUMN "provenance" text DEFAULT 'public_web' NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "provenance" text DEFAULT 'public_web' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_observations" ADD COLUMN "provenance" text DEFAULT 'public_web' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_observations" ADD COLUMN "provenance" text DEFAULT 'public_web' NOT NULL;--> statement-breakpoint
-- Data backfill. Workspaces that already contain fictional fixture websites become demo workspaces; every existing row is labelled with where it came from.
UPDATE "organizations" SET "mode" = 'demo' WHERE "id" IN (SELECT DISTINCT "org_id" FROM "sites" WHERE "is_fixture");--> statement-breakpoint
UPDATE "evidence" SET "provenance" = 'fixture' WHERE "is_fixture";--> statement-breakpoint
UPDATE "offers" SET "provenance" = 'fixture' WHERE "site_id" IN (SELECT "id" FROM "sites" WHERE "is_fixture");--> statement-breakpoint
UPDATE "marketing_activities" SET "provenance" = 'official_api' WHERE "extraction_method" = 'official_api';--> statement-breakpoint
UPDATE "marketing_activities" SET "provenance" = 'fixture' WHERE "is_fixture";--> statement-breakpoint
UPDATE "exchange_rates" SET "provenance" = 'configuration' WHERE "is_fixed";--> statement-breakpoint
-- The observation tables are append-only (a trigger rejects UPDATE). Adding a metadata column is the one sanctioned exception, so the guard is paused only for this backfill.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'price_observations_append_only') THEN ALTER TABLE "price_observations" DISABLE TRIGGER "price_observations_append_only"; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_observations_append_only') THEN ALTER TABLE "stock_observations" DISABLE TRIGGER "stock_observations_append_only"; END IF;
END $$;--> statement-breakpoint
UPDATE "price_observations" SET "provenance" = 'fixture' WHERE "is_fixture";--> statement-breakpoint
UPDATE "stock_observations" SET "provenance" = 'authorised_api' WHERE "quantity_source" = 'authorised_inventory';--> statement-breakpoint
UPDATE "stock_observations" SET "provenance" = 'fixture' WHERE "is_fixture" OR "quantity_source" = 'simulated';--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'price_observations_append_only') THEN ALTER TABLE "price_observations" ENABLE TRIGGER "price_observations_append_only"; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_observations_append_only') THEN ALTER TABLE "stock_observations" ENABLE TRIGGER "stock_observations_append_only"; END IF;
END $$;
