-- ===========================================================================
-- M6 / T16.1 — retention service-role + schedule + checkpoint scaffolding
--
--   This migration is the SECURITY SCAFFOLD for T16.1 (the production
--   wire-up of the retention sweep library that already exists in
--   apps/web/src/lib/retention/). It does NOT yet implement the
--   SECURITY DEFINER sweep functions (those land in subsequent M6.x
--   PRs). What it ships now:
--
--     1. Role `retention_service_role` (NOLOGIN, B6 trust boundary —
--        the only role with DELETE on `audit_log` and on the
--        operational tables that have aged-out semantics).
--     2. Table `audit_log_retention_schedule` — one row per
--        retention_class, populated from ADR-0015 Amendment I + the
--        existing retention_class_for() arms.
--     3. Table `retention_sweep_runs` — checkpoint rows recording one
--        completed retention pass (start/end ms, per-event counts,
--        per-table counts, status). F-58 / F-24 inversion anchor.
--     4. Restrict DELETE on `audit_log` to retention_service_role
--        ONLY (REVOKE from all other roles including service_role).
--        This satisfies the T18 audit-log §5.3 invariant in
--        supabase/test/c4_read_audited_rls.sql.
--
--   What this migration does NOT do (deferred to M6.1+):
--     - The full SECURITY DEFINER sweep function set matching the
--       RetentionStore TS interface (10+ functions: deleteForEventType,
--       deleteForUnderlyingRecordCeiling, deleteOperationalTable,
--       countCandidates*, emitRetentionDeletedAndRegisterRun).
--     - SupabaseRetentionStore implementing the library's RetentionStore
--       interface against these tables.
--     - pg_cron schedule kicking the sweep at 02:00 ET nightly.
--
-- Authoritative ADRs: ADR-0017 (T16 retention sweep library +
--   MemoryRetentionStore design), ADR-0015 + Amendment I (per-event-
--   type retention schedule). Threat-model.md §6 (B6 trust boundary
--   added at T16.1; this migration creates the role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. retention_service_role (B6 boundary)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_service_role') THEN
    CREATE ROLE retention_service_role NOLOGIN;
  END IF;
END $$;

COMMENT ON ROLE retention_service_role IS
  'ADR-0017 / T16.1 / B6 trust boundary: NOLOGIN sibling of c4_read_service, mint_writer, deploy_reader_role. The ONLY role with DELETE on audit_log + on operational tables with aged-out semantics. Reached via a pg_cron-bound service connection (or, in tests, by SET ROLE from the migration_role).';

-- ---------------------------------------------------------------------------
-- 2. audit_log_retention_schedule — one row per retention_class
--
--    The library reads this table at the start of every sweep to compute
--    cutoff_ms per event_type. The CI drift assertion (a follow-up gate)
--    will verify every retention_class produced by retention_class_for()
--    has exactly one row here, and vice-versa.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log_retention_schedule (
  retention_class       text PRIMARY KEY,
  -- Sweep semantics:
  --   'interval'           => DELETE rows older than `interval_ms`.
  --   'match_underlying'   => underlying-record-ceiling rule (ADR-0015 §3.5).
  --                          interval_ms is the ceiling buffer (30d).
  --   'membership_relative'=> retention is relative to membership end
  --                          (T06.1 / member_audit pattern). Not handled
  --                          by the audit-log sweep; library skips.
  semantics             text NOT NULL CHECK (semantics IN ('interval','match_underlying','membership_relative')),
  interval_ms           bigint NOT NULL CHECK (interval_ms > 0),
  -- Human-readable label echoed in retention.deleted audit row meta.
  -- Closed set; mirrors the retention_class_for() return values.
  label                 text NOT NULL,
  -- True for retention_classes whose rows have NO target_id and so are
  -- exempt from the underlying-record-ceiling rule.
  -- (E.g., retention.deleted, key_parity.*, auth.mint.revoked_during_mint
  --  — see ADR-0015 Amendment I "Note: this row is NOT linked via target_id".)
  no_target_id          boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_log_retention_schedule IS
  'ADR-0015 / ADR-0017: one row per retention_class produced by retention_class_for(). The T16 retention sweep library reads this table at start-of-pass to compute cutoff_ms per event_type. Closed semantics set.';

-- Seed rows for every retention_class that retention_class_for() can return.
-- Verbatim from ADR-0015 §"The schedule" + ADR-0015 Amendment I.
INSERT INTO public.audit_log_retention_schedule
  (retention_class, semantics, interval_ms, label, no_target_id)
VALUES
  -- ADR-0015 schedule arms (verbatim from §3.3).
  ('90d',                  'interval', (90::bigint * 24 * 60 * 60 * 1000),
                           '90 days',                  false),
  ('24mo',                 'interval', (730::bigint * 24 * 60 * 60 * 1000),
                           '24 months (PIPEDA s.10.1 breach-record floor)',
                           false),
  ('7y',                   'interval', (2555::bigint * 24 * 60 * 60 * 1000),
                           '7 years',                  false),
  ('7y_from_rotation',     'interval', (2555::bigint * 24 * 60 * 60 * 1000),
                           '7 years from rotation',    false),
  ('membership+24mo',      'membership_relative', (730::bigint * 24 * 60 * 60 * 1000),
                           'membership end + 24 months', false),
  ('membership+7y',        'membership_relative', (2555::bigint * 24 * 60 * 60 * 1000),
                           'membership end + 7 years',  false),
  -- ADR-0015 §3.5 ceiling rule: 30-day buffer after the underlying row deletes.
  ('match_underlying',     'match_underlying', (30::bigint * 24 * 60 * 60 * 1000),
                           'match underlying record retention (30d buffer)',
                           false)
ON CONFLICT (retention_class) DO NOTHING;

REVOKE INSERT, UPDATE, DELETE ON public.audit_log_retention_schedule FROM PUBLIC;
GRANT SELECT ON public.audit_log_retention_schedule TO retention_service_role;
-- Authenticated callers can SELECT too — the schedule is non-sensitive
-- (it has no PI; the rules are public policy) and the UI may display it
-- to operators on the on-call surface.
GRANT SELECT ON public.audit_log_retention_schedule TO authenticated;

ALTER TABLE public.audit_log_retention_schedule ENABLE ROW LEVEL SECURITY;
-- Allow-all SELECT — RLS is enabled only so the table is queryable via
-- the JWT-bound caller-client without bypassing the per-role grant
-- chain. There is no PI to gate.
CREATE POLICY audit_log_retention_schedule_select_all
  ON public.audit_log_retention_schedule
  FOR SELECT TO authenticated, retention_service_role
  USING (true);

-- ---------------------------------------------------------------------------
-- 3. retention_sweep_runs — checkpoint rows (F-58 / F-24 inversion anchor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_sweep_runs (
  run_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at_ms         bigint NOT NULL,
  completed_at_ms       bigint NOT NULL,
  -- Hash over the schedule rows at the start of the pass. Drift between
  -- two adjacent runs surfaces a schedule mutation between passes.
  schedule_hash         text NOT NULL,
  -- per-event and per-table counts emitted by the pass.
  per_event_counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  per_table_counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Whether the pass hit max_rows ceiling for any arm (informs next pass scheduling).
  truncated_to_row_cap  boolean NOT NULL DEFAULT false,
  -- Whether the over-delete alarm fired (F-57).
  alarm_fired           boolean NOT NULL DEFAULT false,
  status                text NOT NULL CHECK (status IN ('completed','capped','aborted')),
  CHECK (completed_at_ms >= started_at_ms)
);

CREATE INDEX IF NOT EXISTS retention_sweep_runs_started_at_ms_idx
  ON public.retention_sweep_runs (started_at_ms DESC);

COMMENT ON TABLE public.retention_sweep_runs IS
  'ADR-0017 / F-58 / F-24 inversion: one row per non-aborted retention pass. Written in the same transaction as the retention.deleted audit row (the audit row is LAST per F-24; this checkpoint can be either order within the txn).';

REVOKE INSERT, UPDATE, DELETE ON public.retention_sweep_runs FROM PUBLIC;
GRANT INSERT, SELECT ON public.retention_sweep_runs TO retention_service_role;
-- Operators / co-chairs may SELECT for the on-call sweep-health surface.
GRANT SELECT ON public.retention_sweep_runs TO authenticated;

ALTER TABLE public.retention_sweep_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY retention_sweep_runs_select_all
  ON public.retention_sweep_runs
  FOR SELECT TO authenticated, retention_service_role
  USING (true);
CREATE POLICY retention_sweep_runs_insert_service_only
  ON public.retention_sweep_runs
  FOR INSERT TO retention_service_role
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. Restrict DELETE on audit_log to retention_service_role ONLY
--
--    audit_log already had REVOKE INSERT, UPDATE, DELETE FROM
--    authenticated + anon in 00000000000001_auth.sql. service_role
--    inherits DELETE implicitly on the Supabase stack via the role's
--    default privileges. Per supabase/test/c4_read_audited_rls.sql §5.3
--    the DELETE privilege MUST be granted ONLY to retention_service_role.
-- ---------------------------------------------------------------------------
REVOKE DELETE ON public.audit_log FROM PUBLIC;
-- Belt-and-braces: explicit revoke from every role that might have it.
DO $$
DECLARE
  v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('service_role','audit_writer_role','c4_read_service',
                       'mint_writer','authenticator','authenticated','anon')
  LOOP
    EXECUTE format('REVOKE DELETE ON public.audit_log FROM %I', v_role);
  END LOOP;
END $$;

GRANT DELETE ON public.audit_log TO retention_service_role;
-- retention_service_role needs SELECT too, to find candidates before
-- deleting. The audit_log SELECT policy is deny-by-default per
-- 00000000000001_auth.sql; we add a permissive policy here scoped to
-- retention_service_role only.
GRANT SELECT ON public.audit_log TO retention_service_role;
CREATE POLICY audit_log_select_retention_service
  ON public.audit_log
  FOR SELECT TO retention_service_role
  USING (true);
