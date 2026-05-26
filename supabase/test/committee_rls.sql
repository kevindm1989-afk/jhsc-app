-- ===========================================================================
-- T06.1 — pgTAP: committee_membership RLS + SECURITY DEFINER functions.
--
-- Source: ADR-0022 (server sibling of ADR-0021). Run:
--   pg_prove -d <db> supabase/test/committee_rls.sql
-- against a stack where app.hmac_pseudonym_key is set and the Supabase shim
-- (roles + auth.uid() reading app.test_uid) is present.
-- ===========================================================================

BEGIN;
SELECT plan(18);

-- Seed: a founding active co-chair + two more users.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true),
  ('00000000-0000-0000-0000-0000000000c2', true),
  ('00000000-0000-0000-0000-0000000000a1', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at)
  VALUES ('00000000-0000-0000-0000-0000000000f1',
          ARRAY['worker_member','worker_co_chair'], true, now());

-- (1) RLS + (2) write grants empty + (3) single-tenant.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'committee_membership'),
  'committee_membership has RLS enabled');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
     WHERE table_name='committee_membership' AND grantee IN ('authenticated','anon')
       AND privilege_type IN ('INSERT','UPDATE','DELETE')$$,
  $$VALUES (0)$$,
  'committee_membership write grants empty for authenticated/anon');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_name IN ('committee_membership','committee_invite') AND column_name='committee_id'$$,
  $$VALUES (0)$$,
  'single-tenant — no committee_id column');

-- (4) is_active_member reflects state.
SELECT ok(public.is_active_member('00000000-0000-0000-0000-0000000000f1'), 'founder is active member');
SELECT ok(NOT public.is_active_member('00000000-0000-0000-0000-0000000000a1'), 'invitee not yet active');

-- (5) non-co-chair invite is denied.
SET app.test_uid = '00000000-0000-0000-0000-0000000000a1';
SELECT throws_like(
  $$SELECT public.committee_invite_member('00000000-0000-0000-0000-000000000099', ARRAY['worker_member'])$$,
  '%rls_denied%', 'non-co-chair cannot invite');

-- (6) co-chair invites; (7) invitee activates → active + member.added audit.
SET app.test_uid = '00000000-0000-0000-0000-0000000000f1';
SELECT lives_ok(
  $$SELECT public.committee_invite_member('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'])$$,
  'co-chair invites the invitee');
SET app.test_uid = '00000000-0000-0000-0000-0000000000a1';
SELECT lives_ok(
  $$SELECT public.committee_activate_membership(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a1' ORDER BY issued_at DESC LIMIT 1),
       '00000000-0000-0000-0000-0000000000a1')$$,
  'invitee activates the membership');
SELECT ok(public.is_active_member('00000000-0000-0000-0000-0000000000a1'), 'invitee now active');
SELECT ok((SELECT EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='member.added')),
  'member.added audit row emitted on activation');

-- (8) activation cannot resurrect a removed member via a stale invite.
SET app.test_uid = '00000000-0000-0000-0000-0000000000f1';
SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000a1');  -- remove invitee
SELECT throws_like(
  $$SELECT public.committee_activate_membership(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a1' ORDER BY issued_at DESC LIMIT 1),
       '00000000-0000-0000-0000-0000000000a1')$$,
  '%invite_invalid%', 'a stale invite cannot resurrect a removed member');

-- (9) setRoles emits member.role_changed + reconciles users.role mirror.
SELECT public.committee_reactivate_member('00000000-0000-0000-0000-0000000000a1');
SELECT lives_ok(
  $$SELECT public.committee_set_roles('00000000-0000-0000-0000-0000000000a1', ARRAY['certified_member','worker_member'])$$,
  'co-chair sets roles');
SELECT is(
  (SELECT role FROM public.users WHERE id='00000000-0000-0000-0000-0000000000a1'),
  'certified_member', 'users.role mirror reconciled to highest-precedence role');
SELECT ok((SELECT EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='member.role_changed')),
  'member.role_changed audit row emitted');

-- (10) last-active-co-chair cannot be removed.
SET app.test_uid = '00000000-0000-0000-0000-0000000000f1';
SELECT throws_like(
  $$SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000f1')$$,
  '%last_co_chair%', 'the last active co-chair cannot be removed');

-- (11) 4-eyes: with a 2nd co-chair, self-removal needs a distinct approver.
INSERT INTO public.committee_membership (user_id, role, active, activated_at)
  VALUES ('00000000-0000-0000-0000-0000000000c2', ARRAY['worker_co_chair'], true, now());
SELECT throws_like(
  $$SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000f1')$$,
  '%4eyes_required%', 'co-chair self-removal without a second approver is denied');
SELECT lives_ok(
  $$SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000c2')$$,
  'co-chair self-removal with a distinct active co-chair approver succeeds');

-- (12) retention class for the reserved event.
SELECT is(public.retention_class_for('member.role_changed'), 'membership+7y',
  'member.role_changed retention class mapped');

SELECT * FROM finish();
ROLLBACK;
