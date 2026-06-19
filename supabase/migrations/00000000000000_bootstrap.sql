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
-- Extension search_path normalisation (hosted Supabase vs plain Postgres).
--
-- Plain Postgres (CI's committee-db-tests job) creates pgcrypto / uuid-ossp
-- in `public`, so later migrations resolve `hmac()`, `digest()`,
-- `gen_random_bytes()`, `crypt()` etc. UNQUALIFIED off the default path.
--
-- A hosted Supabase project PRE-INSTALLS those extensions in the dedicated
-- `extensions` schema — the `CREATE EXTENSION IF NOT EXISTS` calls above
-- no-op ("already exists, skipping"), and `extensions` is NOT on the
-- search_path that `supabase db push` runs migrations under. Without this
-- block the next migration (00000000000002_committee) fails at apply time
-- with `function hmac(bytea, bytea, unknown) does not exist`.
--
-- Fix: put `extensions` on the path at BOTH scopes so every apply model is
-- covered:
--   (a) DATABASE-level default — inherited by every NEW connection (covers
--       `supabase start`'s connection-per-migration apply AND all runtime
--       connections that call the pseudonym fns).
--   (b) SESSION-level — effective immediately for the REST of this apply
--       (covers `supabase db push`'s single-connection apply, where the
--       ALTER DATABASE default does not affect the in-flight connection).
-- Both are no-ops on plain Postgres: the `extensions` schema simply does not
-- exist there, and Postgres tolerates a missing schema in a search_path.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path TO public, extensions',
                 current_database());
EXCEPTION WHEN insufficient_privilege THEN
  -- `supabase start` applies migrations as a non-superuser that cannot
  -- ALTER DATABASE; the session SET below carries the apply, and the local
  -- stack already has `extensions` on the default path anyway.
  NULL;
END $$;
SET search_path TO public, extensions;

-- ---------------------------------------------------------------------------
-- HMAC pseudonym-key accessor (ADR-0016 / ADR-0024) — GUC-OR-Vault resolver.
--
-- The pseudonym key was originally a Postgres GUC (`app.hmac_pseudonym_key`).
-- That works on plain Postgres (CI's committee-db-tests job) and the local
-- `supabase start` stack, where a superuser can `ALTER DATABASE … SET` the GUC.
-- It does NOT work on a hosted Supabase project: PostgreSQL 15+ requires
-- superuser (or `GRANT SET ON PARAMETER`) to set a custom placeholder GUC, and
-- the hosted `postgres` role is not a superuser — so the key cannot live in the
-- GUC there (you get `42501: permission denied to set parameter`).
--
-- This accessor resolves the key from whichever source is configured:
--   1. the `app.hmac_pseudonym_key` GUC          (CI plain-PG, local stack)
--   2. the Supabase Vault secret `hmac_pseudonym_key`  (hosted Supabase)
-- It is the single read-point every HMAC/pseudonym call site now uses (the 18
-- former inline `current_setting(...)` reads + the key-parity SHA function).
--
-- Security posture:
--   * Lives in the `private` schema, which PostgREST does NOT expose — the raw
--     key is unreachable over the REST/RPC surface regardless of grants.
--   * SECURITY DEFINER (owned by the migration role) so it can read
--     `vault.decrypted_secrets` (granted to postgres/service_role on Supabase)
--     on behalf of callers WITHOUT widening vault access to app roles. Every
--     existing key-reading function is itself SECURITY DEFINER owned by the
--     same migration role, so the inner call runs as the owner and needs no
--     extra grant; EXECUTE is revoked from PUBLIC.
--   * `SET search_path = ''` + fully-qualified references (the SECURITY DEFINER
--     hardening pattern); `pg_catalog` is always implicitly searched, so
--     `current_setting` / `nullif` / `pg_extension` still resolve.
--   * No code path returns the raw key to a client: key_parity_server_sha
--     returns only its SHA, the pseudonym fns return only HMAC outputs.
--
-- `p_missing_ok => true` returns NULL instead of raising when no source is
-- configured (only the key-parity SHA fn uses that; the HMAC call sites take
-- the default `false` and let it raise rather than silently HMAC with no key).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE OR REPLACE FUNCTION private._hmac_pseudonym_key(p_missing_ok boolean DEFAULT false)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_key text;
BEGIN
  -- 1. GUC source (CI plain-Postgres, local supabase stack).
  v_key := nullif(current_setting('app.hmac_pseudonym_key', true), '');
  IF v_key IS NOT NULL THEN
    RETURN v_key;
  END IF;

  -- 2. Supabase Vault source (hosted Supabase, where the GUC cannot be set).
  --    The pg_extension guard ensures the `vault.*` reference is never reached
  --    on plain Postgres, where the supabase_vault extension does not exist
  --    (plpgsql plans the inner statement lazily, so the unresolved reference
  --    never trips on CI).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'supabase_vault') THEN
    SELECT nullif(s.decrypted_secret, '')
      INTO v_key
      FROM vault.decrypted_secrets AS s
      WHERE s.name = 'hmac_pseudonym_key'
      ORDER BY s.created_at DESC
      LIMIT 1;
    IF v_key IS NOT NULL THEN
      RETURN v_key;
    END IF;
  END IF;

  IF p_missing_ok THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'hmac_pseudonym_key is not configured (set the app.hmac_pseudonym_key GUC, or create the Supabase Vault secret named hmac_pseudonym_key)'
    USING errcode = 'undefined_object';
END;
$$;

REVOKE ALL ON FUNCTION private._hmac_pseudonym_key(boolean) FROM PUBLIC;

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
