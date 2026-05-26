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
-- APPLY time. `supabase start` auto-applies migrations in one session with no
-- hook to set it first, so we seed a NON-SECRET placeholder here (session
-- scope, persists for the apply run). It is guarded by a coalesce so it never
-- overrides a value already set out-of-band — production sets the real key via
-- the dashboard secret (ALTER DATABASE … SET), and the committee-db-tests CI
-- harness sets it via ALTER DATABASE before applying. This value is a
-- throwaway test key, never used to pseudonymise real data.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF nullif(current_setting('app.hmac_pseudonym_key', true), '') IS NULL THEN
    PERFORM set_config('app.hmac_pseudonym_key', 'dev-ci-pseudonym-key-not-secret', false);
  END IF;
END $$;


-- All later migrations live in numbered files under supabase/migrations/
-- and are version-controlled. ADR-0004 (RLS on every table) is enforced
-- at PR review; each new table migration MUST declare its RLS policies
-- in the same file.
