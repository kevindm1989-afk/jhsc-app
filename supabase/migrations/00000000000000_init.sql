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

-- All later migrations live in numbered files under supabase/migrations/
-- and are version-controlled. ADR-0004 (RLS on every table) is enforced
-- at PR review; each new table migration MUST declare its RLS policies
-- in the same file.
