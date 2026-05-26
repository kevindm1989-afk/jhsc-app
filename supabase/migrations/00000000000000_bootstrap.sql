-- Initial migration.
--
-- Scaffolder hard rule: schema lands per-task (T07 / T08 / T13 / T14 /
-- T16 / T18 each contribute their migration). This file establishes the
-- extensions every later migration assumes and is otherwise empty.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- pgTAP is required for SQL-level tests (supabase/test/*.sql). The
-- Supabase local stack ships the extension; we just enable it.
CREATE EXTENSION IF NOT EXISTS "pgtap";

-- ---------------------------------------------------------------------------
-- Dev/CI bootstrap for the pseudonym-key GUC (ADR-0016).
--
-- The auth migration (00000000000001) checks `app.hmac_pseudonym_key` at
-- APPLY time. `supabase start` applies each migration on its OWN connection,
-- so a session-scoped set_config here would not survive into the auth
-- migration's connection. We therefore seed a NON-SECRET placeholder as a
-- DATABASE-level default (ALTER DATABASE … SET), which every subsequent
-- connection inherits. It is guarded so it never overrides a value already
-- set out-of-band — production sets the real key via the dashboard secret
-- (ALTER DATABASE … SET) BEFORE applying migrations, so the guard sees it and
-- skips; the committee-db-tests CI harness likewise sets it first. This value
-- is a throwaway test key, never used to pseudonymise real data.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF nullif(current_setting('app.hmac_pseudonym_key', true), '') IS NULL THEN
    -- Prefer a DATABASE-level default (inherited by every later connection). If
    -- the migration role lacks privilege (`supabase start` applies migrations as
    -- a non-superuser), fall back to a session-scoped value so the apply still
    -- succeeds; runtime then gets the durable default from the post-start
    -- "ALTER DATABASE … SET" step (the live-stack CI job + the dev runbook).
    BEGIN
      EXECUTE format('ALTER DATABASE %I SET app.hmac_pseudonym_key = %L',
                     current_database(), 'dev-ci-pseudonym-key-not-secret');
    EXCEPTION WHEN insufficient_privilege THEN
      PERFORM set_config('app.hmac_pseudonym_key', 'dev-ci-pseudonym-key-not-secret', false);
    END;
  END IF;
END $$;


-- All later migrations live in numbered files under supabase/migrations/
-- and are version-controlled. ADR-0004 (RLS on every table) is enforced
-- at PR review; each new table migration MUST declare its RLS policies
-- in the same file.
