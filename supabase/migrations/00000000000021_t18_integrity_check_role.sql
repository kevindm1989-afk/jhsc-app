-- ===========================================================================
-- M8.B / T18.1 — integrity_check_role + integrity_check_runs +
--                audit_chain_anchors scaffolding
--
--   Mirrors the #213 (M6) and the M8.A (T17.1 backup_writer_role)
--   scaffolding pattern for ADR-0019. This migration ships the
--   B6.2 trust boundary + the two tables T18.1 needs; the
--   SECURITY DEFINER integrity-check function set lands in T18.1+
--   subsequent PRs.
--
-- Authoritative ADRs: ADR-0019 (T18 audit-log integrity library +
--   MemoryIntegrityStore). Threat-model.md §6 F-86..F-100 (B6.2
--   trust boundary added at T18.1; this migration creates the role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. integrity_check_role (B6.2 boundary)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'integrity_check_role') THEN
    CREATE ROLE integrity_check_role NOLOGIN;
  END IF;
END $$;

COMMENT ON ROLE integrity_check_role IS
  'ADR-0019 / T18.1 / B6.2 trust boundary: NOLOGIN sibling of retention_service_role (B6), backup_writer_role (B6.1), c4_read_service, mint_writer, deploy_reader_role. SELECT-only on audit_log + retention_sweep_runs + backup_manifests; INSERT only via the dedicated integrity_check_emit_* SECURITY DEFINER functions whose bodies hard-code the closed event-type allowlist (audit.integrity_check.ran, audit.integrity_check.mismatch, audit.chain_anchor.weekly). NO UPDATE, NO DELETE, NO BYPASSRLS. Reached via a pg_cron-bound service connection at 04:30 ET daily + Mon 00:00 ET weekly.';

-- ---------------------------------------------------------------------------
-- 2. integrity_check_runs — one row per integrity-check pass
--
--    F-94 / G-T17-PRIV-7: NO PI in this table. Structural counts +
--    run metadata only — mirrors retention_sweep_runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.integrity_check_runs (
  run_id                  uuid PRIMARY KEY,
  -- Closed-set trigger discriminator (ADR-0019 Decision §5):
  --   'scheduled'     — pg_cron daily 04:30 ET
  --   'post_rotation' — fired by mint-session post-rotation flow
  --   'post_export'   — fired by export pipeline
  --   'weekly_anchor' — pg_cron Mon 00:00 ET
  trigger                 text NOT NULL CHECK (trigger IN
                          ('scheduled','post_rotation','post_export','weekly_anchor')),
  started_at_ms           bigint NOT NULL,
  completed_at_ms         bigint,
  -- State machine: running -> ok | mismatch_found | aborted | timed_out.
  status                  text NOT NULL DEFAULT 'running' CHECK (status IN
                          ('running','ok','mismatch_found','aborted','timed_out')),
  rows_walked             bigint NOT NULL DEFAULT 0 CHECK (rows_walked >= 0),
  mismatches_count        bigint NOT NULL DEFAULT 0 CHECK (mismatches_count >= 0),
  attributable_count      bigint NOT NULL DEFAULT 0 CHECK (attributable_count >= 0),
  unattributable_count    bigint NOT NULL DEFAULT 0 CHECK (unattributable_count >= 0),
  backup_diff_performed   boolean NOT NULL DEFAULT false,
  -- NOTE: backup_manifest_run_id is a plain uuid here (no FK) so this
  -- migration is independent of #214 / M8.A's backup_manifests table.
  -- A follow-up migration adds the FK once both M8.A and this PR land.
  -- The T18.1 SECURITY DEFINER read function enforces the join
  -- (integrity_check_read_latest_backup_manifest); the FK is
  -- referential-integrity defense in depth, not a load-bearing control.
  backup_manifest_run_id  uuid,
  -- Cursor for resumable walks (G-T18 batch ceiling, 20k row cap).
  resume_after_id         bigint,
  node_runtime_pin        text NOT NULL,
  schedule_hash           text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  -- A finished run must have completed_at_ms set.
  CHECK ((status = 'running') OR (completed_at_ms IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS integrity_check_runs_started_at_ms_idx
  ON public.integrity_check_runs (started_at_ms DESC);
CREATE INDEX IF NOT EXISTS integrity_check_runs_trigger_idx
  ON public.integrity_check_runs (trigger);
CREATE INDEX IF NOT EXISTS integrity_check_runs_status_idx
  ON public.integrity_check_runs (status);

COMMENT ON TABLE public.integrity_check_runs IS
  'ADR-0019 §"Classification per surface": one row per integrity-check pass. NO PI — structural counts + run metadata only. Retention: 24 months (operational telemetry; mirrors retention_sweep_runs).';

REVOKE INSERT, UPDATE, DELETE ON public.integrity_check_runs FROM PUBLIC;
GRANT INSERT, UPDATE, SELECT ON public.integrity_check_runs TO integrity_check_role;
-- Operators / co-chairs may SELECT for the on-call integrity-health surface.
GRANT SELECT ON public.integrity_check_runs TO authenticated;

ALTER TABLE public.integrity_check_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY integrity_check_runs_select_all
  ON public.integrity_check_runs
  FOR SELECT TO authenticated, integrity_check_role
  USING (true);
CREATE POLICY integrity_check_runs_insert_role_only
  ON public.integrity_check_runs
  FOR INSERT TO integrity_check_role
  WITH CHECK (true);
CREATE POLICY integrity_check_runs_update_role_only
  ON public.integrity_check_runs
  FOR UPDATE TO integrity_check_role
  USING (true)
  WITH CHECK (true);

-- DELETE on integrity_check_runs is REVOKED from every role — the
-- rows are retained 24mo per ADR-0019; aging out happens through the
-- audit-log retention pass via the match_underlying ceiling rule on
-- the linked audit.integrity_check.ran row.
DO $$
DECLARE v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('service_role','audit_writer_role','c4_read_service',
                       'mint_writer','authenticator','authenticated','anon',
                       'retention_service_role','backup_writer_role',
                       'integrity_check_role')
  LOOP
    EXECUTE format('REVOKE DELETE ON public.integrity_check_runs FROM %I', v_role);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. audit_chain_anchors — optional weekly head-pointer anchor.
--
--    F-94 / G-T18-12: NO PI. Head-pointer triple + delivery timestamp
--    only. T18.1 Edge Function reads from here and sends an off-app
--    email to the worker co-chair as a manual backstop (NOT an alert
--    control — delivery failure does NOT fire any alert).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_chain_anchors (
  anchor_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_at_ms        bigint NOT NULL,
  -- Head-pointer triple (matches ADR-0019 Decision §10 ChainAnchorWeeklyMeta).
  head_audit_log_id   bigint NOT NULL,
  head_ts_ms          bigint NOT NULL,
  head_hash           bytea NOT NULL,
  -- Whether the off-app email backstop has been sent.
  email_sent_at       timestamptz,
  email_recipient_pseudonym text  -- HMAC pseudonym of the co-chair, never the raw address
);

CREATE INDEX IF NOT EXISTS audit_chain_anchors_anchor_at_ms_idx
  ON public.audit_chain_anchors (anchor_at_ms DESC);

COMMENT ON TABLE public.audit_chain_anchors IS
  'ADR-0019 §"Optional audit_chain_anchors table": weekly head-pointer anchor (id, ts_ms, hash). NO PI — email_recipient_pseudonym is an HMAC pseudonym, never the raw address. Retention: 7 years (load-bearing forensic; off-app email anchor target).';

REVOKE INSERT, UPDATE, DELETE ON public.audit_chain_anchors FROM PUBLIC;
GRANT INSERT, UPDATE, SELECT ON public.audit_chain_anchors TO integrity_check_role;
GRANT SELECT ON public.audit_chain_anchors TO authenticated;

ALTER TABLE public.audit_chain_anchors ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_chain_anchors_select_all
  ON public.audit_chain_anchors
  FOR SELECT TO authenticated, integrity_check_role
  USING (true);
CREATE POLICY audit_chain_anchors_insert_role_only
  ON public.audit_chain_anchors
  FOR INSERT TO integrity_check_role
  WITH CHECK (true);
CREATE POLICY audit_chain_anchors_update_role_only
  ON public.audit_chain_anchors
  FOR UPDATE TO integrity_check_role
  USING (true)
  WITH CHECK (true);

DO $$
DECLARE v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('service_role','audit_writer_role','c4_read_service',
                       'mint_writer','authenticator','authenticated','anon',
                       'retention_service_role','backup_writer_role',
                       'integrity_check_role')
  LOOP
    EXECUTE format('REVOKE DELETE ON public.audit_chain_anchors FROM %I', v_role);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. SELECT-only grants on the source tables the integrity-check pass reads.
--    integrity_check_role MUST NOT have any privilege beyond SELECT on
--    these tables — INSERT path is exclusively through the
--    integrity_check_emit_* SECURITY DEFINER functions (T18.1+).
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.audit_log TO integrity_check_role;
GRANT SELECT ON public.retention_sweep_runs TO integrity_check_role;
-- backup_manifests is created by #214 / M8.A's migration 20. Use a
-- conditional grant so this migration is independent of merge order.
-- Once both #214 and this PR land, the grant takes effect.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'backup_manifests') THEN
    EXECUTE 'GRANT SELECT ON public.backup_manifests TO integrity_check_role';
  END IF;
END $$;

-- Permissive SELECT policies scoped to integrity_check_role (audit_log
-- has deny-by-default SELECT per 00000000000001_auth.sql; mirror the
-- retention_service_role pattern from #213).
CREATE POLICY audit_log_select_integrity_check
  ON public.audit_log
  FOR SELECT TO integrity_check_role
  USING (true);
