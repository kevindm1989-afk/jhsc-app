-- ===========================================================================
-- ADR-0029 P1-8e — pgTAP: F-182 residual pins (threat-model §3.18 :4093-4094).
-- RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
--
-- These characterize ALREADY-SHIPPED behaviour of committee_remove_member /
-- committee_reactivate_member (migration 00000000000002:373-468). They are the
-- "documented-and-tested-as-KNOWN residual" (A-8.9 ruling): removal is a
-- MEMBERSHIP revocation, NOT a cryptographic one. So they are GREEN against the
-- current SQL — but they are written so that a FUTURE change that deletes the
-- removed member's wrap on removal, or rotates the committee data key, or adds/
-- removes a 4-eyes gate on reactivation, BREAKS them (the re-pass trigger of
-- Amendment A-8.9 :4110-4112).
--
--   Finding 8 (must-fail-first structural residual):
--     after committee_remove_member(target) the target's live-key
--     committee_key_wraps row STILL EXISTS (wrap NOT deleted) and
--     committee_data_keys is NOT rotated (no new epoch/key row); after
--     committee_reactivate_member(target) the target is active=true and
--     get_committee_key_wrap_for_self() (AS the target) RESOLVES the retained
--     wrap (the F-182 reactivation-restores-crypto-access residual).
--
--   Finding 9 (no-4-eyes contrast — the known reprisal-restoration gap):
--     committee_reactivate_member succeeds for a SINGLE active co-chair with NO
--     second_approver_id (it takes NONE), UNLIKE committee_remove_member /
--     committee_set_roles which RAISE 4eyes_required on a self-action.
--
-- Run: pg_prove -d <db> supabase/test/committee_manage_residual.sql
--   (migrations 0..44 + the test shim). NOTE: this cannot run locally without
--   Postgres — it runs in CI.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(16);

-- --------------------------------------------------------------------------
-- Seed: f1 (founder co-chair), a1 (member target), c2 (second co-chair, added
-- later for the contrast), plus live sessions (session_id = jti).
-- --------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true),   -- founder co-chair
  ('00000000-0000-0000-0000-0000000000a1', true),   -- member target
  ('00000000-0000-0000-0000-0000000000c2', true);   -- second co-chair (contrast)
INSERT INTO public.committee_membership (user_id, role, active, activated_at)
  VALUES ('00000000-0000-0000-0000-0000000000f1',
          ARRAY['worker_member','worker_co_chair'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111f1', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c2', '00000000-0000-0000-0000-0000000000c2', now() + interval '5 min');

-- A single LIVE committee data key (rotated_at IS NULL). Removal must NOT rotate
-- it (no new epoch), so this stays the one and only key across the flow.
INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at) VALUES
  ('22222222-2222-2222-2222-222222222201', 1, NULL);   -- live

-- --------------------------------------------------------------------------
-- f1 invites a1; a1 activates → a1 is an active member.
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SELECT lives_ok(
  $$SELECT public.committee_invite_member('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'])$$,
  'f1 (co-chair) invites a1');
SELECT lives_ok(
  $$SELECT public.committee_activate_membership(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a1' ORDER BY issued_at DESC LIMIT 1),
       '00000000-0000-0000-0000-0000000000a1')$$,
  'a1 activates the membership');
SELECT ok(public.is_active_member('00000000-0000-0000-0000-0000000000a1'), 'a1 is now an active member');

-- Seed a1's RETAINED per-member wrap on the LIVE key (direct insert — we only
-- need the residual wrap row to exist, not the full grant ceremony).
INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222201', '\xAA01'::bytea);

SELECT is(
  (SELECT count(*)::int FROM public.committee_key_wraps w
     JOIN public.committee_data_keys cdk ON cdk.key_id = w.key_id
    WHERE w.user_id = '00000000-0000-0000-0000-0000000000a1' AND cdk.rotated_at IS NULL),
  1,
  'baseline: a1 holds exactly one live-key wrap before removal');

-- Baseline count of committee_data_keys (must be unchanged by removal — no
-- rotation / no new epoch row).
CREATE TEMP TABLE _dk_base AS SELECT count(*)::int AS n FROM public.committee_data_keys;

-- --------------------------------------------------------------------------
-- FINDING 8 — removal leaves the wrap intact + does NOT rotate the key.
-- --------------------------------------------------------------------------
SELECT lives_ok(
  $$SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000a1')$$,
  'f1 removes a1 (a1 is not a co-chair → no 4-eyes needed)');
SELECT ok(
  NOT public.is_active_member('00000000-0000-0000-0000-0000000000a1'),
  'a1 is inactive after removal');

-- The must-fail-first structural residual: the removed member's LIVE-key wrap
-- SURVIVES. A future delete-wrap-on-removal change would flip this to 0 and
-- break the test (re-pass trigger A-8.9 :4111).
SELECT is(
  (SELECT count(*)::int FROM public.committee_key_wraps w
     JOIN public.committee_data_keys cdk ON cdk.key_id = w.key_id
    WHERE w.user_id = '00000000-0000-0000-0000-0000000000a1' AND cdk.rotated_at IS NULL),
  1,
  'F-182 residual: a1''s live-key wrap STILL EXISTS after removal (removal is non-cryptographic)');

-- The committee data key is NOT rotated (still live, rotated_at IS NULL). A
-- future rotate-on-removal change would set rotated_at and break this.
SELECT ok(
  (SELECT rotated_at IS NULL FROM public.committee_data_keys WHERE key_id = '22222222-2222-2222-2222-222222222201'),
  'F-182 residual: the committee data key is NOT rotated on removal (rotated_at stays NULL)');
-- No NEW epoch/key row was inserted (rotation would add one).
SELECT is(
  (SELECT count(*)::int FROM public.committee_data_keys),
  (SELECT n FROM _dk_base),
  'F-182 residual: no new committee_data_keys epoch row is created on removal (no rotation)');

-- --------------------------------------------------------------------------
-- FINDING 8 (cont.) — reactivation restores active + the RETAINED wrap resolves.
-- FINDING 9 (positive) — a SINGLE active co-chair (f1) reactivates with NO
-- second approver (reactivate takes none).
-- --------------------------------------------------------------------------
SELECT lives_ok(
  $$SELECT public.committee_reactivate_member('00000000-0000-0000-0000-0000000000a1')$$,
  'F-182/no-4-eyes: a single active co-chair reactivates a1 with NO second approver');
SELECT ok(
  public.is_active_member('00000000-0000-0000-0000-0000000000a1'),
  'a1 is active again after reactivation');

-- As a1, the retained wrap re-satisfies get_committee_key_wrap_for_self (the
-- active gate is re-satisfied; the live-key wrap join still resolves a1's row).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.get_committee_key_wrap_for_self()),
  1,
  'F-182 residual: reactivated a1 resolves the RETAINED wrap via get_committee_key_wrap_for_self (crypto access returns with no fresh grant)');
SELECT is(
  (SELECT wrapped_ciphertext FROM public.get_committee_key_wrap_for_self() LIMIT 1),
  '\xAA01'::bytea,
  'F-182 residual: the resolved wrap is the SAME retained ciphertext (never re-sealed / re-issued)');

-- --------------------------------------------------------------------------
-- FINDING 9 (structural + contrast) — reactivate has NO 4-eyes; remove/set_roles
-- DO (self-action). This pins the known reprisal-restoration gap.
-- --------------------------------------------------------------------------
SELECT is(
  (SELECT p.pronargs::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'committee_reactivate_member'),
  1,
  'F-182 contrast: committee_reactivate_member takes exactly ONE arg (target only — NO second_approver_id / no 4-eyes)');

-- Add c2 as a second active co-chair so the last_co_chair guard passes and the
-- self-action 4-eyes branch is reached on remove/set_roles.
INSERT INTO public.committee_membership (user_id, role, active, activated_at)
  VALUES ('00000000-0000-0000-0000-0000000000c2', ARRAY['worker_co_chair'], true, now());

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SELECT throws_like(
  $$SELECT public.committee_remove_member('00000000-0000-0000-0000-0000000000f1')$$,
  '%4eyes_required%',
  'F-181/F-182 contrast: co-chair self-REMOVE without a second approver RAISES 4eyes_required (unlike reactivate)');
SELECT throws_like(
  $$SELECT public.committee_set_roles('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member'])$$,
  '%4eyes_required%',
  'F-181/F-182 contrast: co-chair self-DEMOTE (drop worker_co_chair) without a second approver RAISES 4eyes_required');

SELECT * FROM finish();
ROLLBACK;
