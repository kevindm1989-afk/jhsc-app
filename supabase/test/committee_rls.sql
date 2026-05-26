-- ===========================================================================
-- T06.1 — pgTAP: committee_membership RLS + SECURITY DEFINER functions,
-- including the F-116 session-liveness gate (ADR-0023 / threat-model §3.12).
--
-- Source: ADR-0022 + ADR-0023. Run:
--   pg_prove -d <db> supabase/test/committee_rls.sql
-- against a stack where app.hmac_pseudonym_key is set and the Supabase shim
-- (roles + auth.uid() reading the JWT `sub` claim) is present. An authenticated
-- caller is simulated by SET request.jwt.claims = '{"sub":..,"session_id":..}'
-- plus a live public.auth_sessions row keyed by that session_id (the jti).
-- ===========================================================================

BEGIN;
SELECT plan(21);

-- Users.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true),   -- founder co-chair
  ('00000000-0000-0000-0000-0000000000c2', true),   -- second co-chair
  ('00000000-0000-0000-0000-0000000000a1', true);   -- invitee
-- Founding active co-chair.
INSERT INTO public.committee_membership (user_id, role, active, activated_at)
  VALUES ('00000000-0000-0000-0000-0000000000f1',
          ARRAY['worker_member','worker_co_chair'], true, now());
-- Live sessions (jti = session_id) for each actor.
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000c2', now() + interval '5 min'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min');

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
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
SELECT throws_like(
  $$SELECT public.committee_invite_member('00000000-0000-0000-0000-000000000099', ARRAY['worker_member'])$$,
  '%rls_denied%', 'non-co-chair cannot invite');

-- (6) co-chair invites; (7) invitee activates → active + member.added audit.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT lives_ok(
  $$SELECT public.committee_invite_member('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'])$$,
  'co-chair invites the invitee');
SELECT lives_ok(
  $$SELECT public.committee_activate_membership(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a1' ORDER BY issued_at DESC LIMIT 1),
       '00000000-0000-0000-0000-0000000000a1')$$,
  'invitee activates the membership');
SELECT ok(public.is_active_member('00000000-0000-0000-0000-0000000000a1'), 'invitee now active');
SELECT ok((SELECT EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='member.added')),
  'member.added audit row emitted on activation');

-- (8) activation cannot resurrect a removed member via a stale invite.
SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000a1');  -- remove invitee (founder acting)
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

-- (13) F-116 session liveness. Act as the still-active second co-chair.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","session_id":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SELECT ok(public.session_is_live(), 'session_is_live() true for a live co-chair session');
-- Revoke that session; the liveness gate must flip the same request.
UPDATE public.auth_sessions SET revoked_at = now() WHERE session_id = '22222222-2222-2222-2222-222222222222';
SELECT ok(NOT public.session_is_live(), 'session_is_live() false immediately after revoke');
SELECT throws_like(
  $$SELECT public.committee_invite_member('00000000-0000-0000-0000-000000000088', ARRAY['worker_member'])$$,
  '%rls_denied%', 'F-116: a co-chair with a revoked session is denied within the same request');

SELECT * FROM finish();
ROLLBACK;
