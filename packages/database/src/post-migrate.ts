/**
 * Idempotent SQL applied after every Drizzle migration run.
 *  1. Row-Level Security on EVERY table that has an org_id column (so a newly added table is covered automatically).
 *  2. Append-only guards on observation tables and immutability of published report snapshots.
 *  3. Grants for the application roles (created by `npm run db:setup`).
 *
 * Roles:
 *   ci_app    — used by the API. Subject to RLS. Cannot read another tenant's rows even with a buggy query.
 *   ci_worker — used by the worker/scheduler. BYPASSRLS because it must span tenants; it always passes org ids explicitly.
 */

/** Tables with an org_id column that are intentionally NOT tenant-isolated by RLS, with the reason. */
export const RLS_EXEMPT_TABLES: Record<string, string> = {
  memberships: 'read before a tenant context exists (listing the orgs a user belongs to); access is checked in the API',
  oauth_states: 'OAuth callbacks arrive before a tenant is known; the single-use random state + user binding are verified in the API',
  email_outbox: 'system emails (verification/reset) have no org; the API only exposes it to authenticated dev tooling',
  invitations: 'an invitation is accepted before the person belongs to any workspace; the single-use token (stored hashed) and the invited email are verified in the API, and listing/revoking is always scoped to the caller\'s workspace',
};

export const POST_MIGRATE_SQL = /* sql */ `
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'org_id'
      AND c.table_name NOT IN (${Object.keys(RLS_EXEMPT_TABLES).map((t) => `'${t}'`).join(', ')})
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      r.table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ci_forbid_update() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% rows are append-only observations and cannot be updated', TG_TABLE_NAME;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS price_observations_append_only ON price_observations;
CREATE TRIGGER price_observations_append_only BEFORE UPDATE ON price_observations
  FOR EACH ROW EXECUTE FUNCTION ci_forbid_update();
DROP TRIGGER IF EXISTS stock_observations_append_only ON stock_observations;
CREATE TRIGGER stock_observations_append_only BEFORE UPDATE ON stock_observations
  FOR EACH ROW EXECUTE FUNCTION ci_forbid_update();

CREATE OR REPLACE FUNCTION ci_reports_immutable() RETURNS trigger AS $fn$
BEGIN
  IF OLD.status IN ('ready', 'partial')
     AND (NEW.data IS DISTINCT FROM OLD.data
          OR NEW.data_hash IS DISTINCT FROM OLD.data_hash
          OR NEW.period_date IS DISTINCT FROM OLD.period_date
          OR NEW.is_partial IS DISTINCT FROM OLD.is_partial) THEN
    RAISE EXCEPTION 'published report snapshots are immutable';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reports_immutable ON reports;
CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION ci_reports_immutable();

-- The demo/live workspace split no longer exists (migration 0008): every workspace is a real customer's. These guards belonged to it.
DROP TRIGGER IF EXISTS organizations_mode_immutable ON organizations;
DROP TRIGGER IF EXISTS sites_fixture_only_in_demo ON sites;
DROP FUNCTION IF EXISTS ci_org_mode_immutable();
DROP FUNCTION IF EXISTS ci_fixture_only_in_demo();

DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ci_app', 'ci_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role_name);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', role_name);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', role_name);
    END IF;
  END LOOP;
  -- Read-only: lets the readiness check compare the applied migrations with the ones this build expects.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_app') AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    GRANT USAGE ON SCHEMA drizzle TO ci_app;
    GRANT SELECT ON drizzle.__drizzle_migrations TO ci_app;
  END IF;
END $$;
`;
