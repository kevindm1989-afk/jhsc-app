-- ===========================================================================
-- Local / CI pgTAP shim — emulates the Supabase stack primitives the
-- migrations assume (roles + the auth schema's auth.uid()).
--
-- NOT a pgTAP test (kept under fixtures/ so `pg_prove supabase/test/*.sql`
-- does not pick it up). Applied via psql BEFORE the migrations in the CI
-- Postgres+pgTAP stage. In production these are provided by Supabase.
--
-- auth.uid() reads the `app.test_uid` GUC so a pgTAP test can simulate the
-- authenticated caller with `SET app.test_uid = '<uuid>'`.
-- ===========================================================================

DO $$ BEGIN CREATE ROLE authenticated;        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon;                 EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_auth_admin;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;

-- Production-accurate: GoTrue exposes the caller's uid via the JWT `sub` claim
-- in the `request.jwt.claims` GUC. Tests set that GUC (and seed auth_sessions)
-- to simulate an authenticated, live-session caller.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $f$ SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $f$;
