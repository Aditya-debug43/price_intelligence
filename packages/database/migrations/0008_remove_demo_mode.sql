-- Removes the demo workspace concept. Every workspace is now a real customer's; nothing in the schema can mark data as fictional,
-- because fictional data can no longer be created by the product.
--
-- Safety: this migration never deletes data. If the database still holds workspaces that were created as demos (fictional fixture
-- websites, simulated inventory), it stops and changes nothing; review them and remove them explicitly with `npm run db:purge-demo`.
DO $$
DECLARE
  demo_orgs int;
  fixture_sites int;
  simulated_connections int;
  fixture_rows int;
BEGIN
  SELECT count(*) INTO demo_orgs FROM organizations WHERE mode = 'demo';
  SELECT count(*) INTO fixture_sites FROM sites WHERE is_fixture;
  SELECT count(*) INTO simulated_connections FROM integration_connections WHERE is_simulated;
  SELECT (SELECT count(*) FROM evidence WHERE provenance = 'fixture')
       + (SELECT count(*) FROM price_observations WHERE provenance = 'fixture')
       + (SELECT count(*) FROM stock_observations WHERE provenance = 'fixture' OR quantity_source = 'simulated')
       + (SELECT count(*) FROM offers WHERE provenance = 'fixture')
       + (SELECT count(*) FROM marketing_activities WHERE provenance = 'fixture')
    INTO fixture_rows;
  IF demo_orgs > 0 OR fixture_sites > 0 OR simulated_connections > 0 OR fixture_rows > 0 THEN
    RAISE EXCEPTION 'Migration 0008 removes demo mode, but this database still contains % demo workspace(s), % fixture website(s), % simulated inventory connection(s) and % fixture-labelled row(s). They hold fictional data only. Nothing was changed. Review and delete them with: npm run db:purge-demo (add -- --yes to confirm).', demo_orgs, fixture_sites, simulated_connections, fixture_rows;
  END IF;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS organizations_mode_immutable ON organizations;--> statement-breakpoint
DROP TRIGGER IF EXISTS sites_fixture_only_in_demo ON sites;--> statement-breakpoint
DROP FUNCTION IF EXISTS ci_org_mode_immutable();--> statement-breakpoint
DROP FUNCTION IF EXISTS ci_fixture_only_in_demo();--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN "is_fixture";--> statement-breakpoint
ALTER TABLE "integration_connections" DROP COLUMN "is_simulated";--> statement-breakpoint
ALTER TABLE "marketing_activities" DROP COLUMN "is_fixture";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "price_observations" DROP COLUMN "is_fixture";--> statement-breakpoint
ALTER TABLE "reports" DROP COLUMN "contains_fixture";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "is_fixture";--> statement-breakpoint
ALTER TABLE "stock_observations" DROP COLUMN "is_fixture";
