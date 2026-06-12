-- ===========================================================================
-- ADR-0015 Amendment I — pgTAP coverage for the three new retention classes.
--
-- Asserts retention_class_for() returns '24mo' for the three new event-types
-- introduced by Amendment I, and that the function still returns the existing
-- canonical values for a spot-check of the pre-existing arms (regression
-- guard against accidental clobber by future CREATE OR REPLACE migrations).
--
-- Source: ADR-0015 Amendment I (`.context/decisions.md`),
--   migration 00000000000015_adr0015_amend_i_retention_classes.sql.
-- ===========================================================================

BEGIN;
SELECT plan(7);

-- The three new arms.
SELECT is(public.retention_class_for('key_parity.mismatch'),
          '24mo',
          'ADR-0015 Amend I: key_parity.mismatch → 24mo (F-125 forensic anchor)');

SELECT is(public.retention_class_for('key_parity.deploy_ok'),
          '24mo',
          'ADR-0015 Amend I: key_parity.deploy_ok → 24mo (forensic asymmetry protection)');

SELECT is(public.retention_class_for('auth.mint.revoked_during_mint'),
          '24mo',
          'ADR-0015 Amend I: auth.mint.revoked_during_mint → 24mo (F-128 race detector)');

-- Regression spot-checks: each previous migration's signature arm survives.
SELECT is(public.retention_class_for('auth.passkey.enrolled'),
          '90d',
          'regression: auth.passkey.enrolled still 90d (original ADR-0015)');

SELECT is(public.retention_class_for('member.role_changed'),
          'membership+7y',
          'regression: member.role_changed still membership+7y (ADR-0022 Q2 / 0002)');

SELECT is(public.retention_class_for('recovery_reset.issued'),
          'membership+24mo',
          'regression: recovery_reset.issued still membership+24mo (T07.1 / 0007)');

-- Unknown event-types still hit the safe-ceiling fallback.
SELECT is(public.retention_class_for('not_a_real_event_type_xyz'),
          '24mo',
          'unknown event_type falls back to 24mo safe ceiling');

SELECT * FROM finish();
ROLLBACK;
