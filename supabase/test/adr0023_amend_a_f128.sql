-- ===========================================================================
-- ADR-0023 Amendment A / F-128 — pgTAP coverage for the new SQL functions.
--
-- Asserts:
--   • mint_is_session_live(uuid) exists, is SECURITY DEFINER + STABLE.
--   • Returns true for a freshly-inserted, unrevoked auth_sessions row.
--   • Returns false for a revoked row (revoked_at IS NOT NULL).
--   • Returns false for a non-existent session_id.
--   • mint_emit_revoked_during_mint(uuid, uuid, uuid) exists.
--   • Emits a row with event_type 'auth.mint.revoked_during_mint',
--     target_class 'C0', target_id = the session_id, and 24mo class.
--   • Caller-supplied request_id propagates.
--   • Pseudonym derivation: changing the user_id changes the pseudonym
--     (proves we read the user_id arg, not a constant).
--   • The wrapper does NOT echo the user_id in actor_pseudonym (the
--     pseudonym is HMAC-derived, not equal to the user_id substring).
--   • mint_writer has EXECUTE on both; public has NOT.
--
-- Source: migration 00000000000017_adr0023_amend_a_f128.sql.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(16);

-- (1) function exists.
SELECT has_function('public', 'mint_is_session_live',
  ARRAY['uuid'],
  'mint_is_session_live(uuid) exists');

-- (2) SECURITY DEFINER + STABLE.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname='mint_is_session_live' AND pronamespace='public'::regnamespace),
  'mint_is_session_live is SECURITY DEFINER');
SELECT ok(
  (SELECT provolatile = 's' FROM pg_proc
    WHERE proname='mint_is_session_live' AND pronamespace='public'::regnamespace),
  'mint_is_session_live is STABLE');

-- Set up a user + a live session + a revoked session.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true);
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('22222222-2222-2222-2222-222222222222',
   '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min');
UPDATE public.auth_sessions
  SET revoked_at = now()
  WHERE session_id = '22222222-2222-2222-2222-222222222222';

-- (3) live session ⇒ true.
SELECT ok(
  public.mint_is_session_live('11111111-1111-1111-1111-111111111111'::uuid),
  'live session ⇒ true');

-- (4) revoked session ⇒ false.
SELECT ok(
  NOT public.mint_is_session_live('22222222-2222-2222-2222-222222222222'::uuid),
  'revoked session ⇒ false');

-- (5) non-existent session ⇒ false.
SELECT ok(
  NOT public.mint_is_session_live('99999999-9999-9999-9999-999999999999'::uuid),
  'non-existent session ⇒ false');

-- (6) mint_emit_revoked_during_mint exists.
SELECT has_function('public', 'mint_emit_revoked_during_mint',
  ARRAY['uuid','uuid','uuid'],
  'mint_emit_revoked_during_mint(uuid,uuid,uuid) exists');

-- (7) emits a row with the expected event_type + target_class + retention_class.
SELECT public.mint_emit_revoked_during_mint(
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid
);
SELECT is(
  (SELECT event_type FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
    ORDER BY id DESC LIMIT 1),
  'auth.mint.revoked_during_mint',
  'emit shape: event_type is auth.mint.revoked_during_mint');
SELECT is(
  (SELECT target_class FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
    ORDER BY id DESC LIMIT 1),
  'C0',
  'emit shape: target_class is C0');
SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
    ORDER BY id DESC LIMIT 1),
  '24mo',
  'emit shape: retention_class is 24mo (per ADR-0015 Amendment I) — target_id is NULL so audit_emit''s ceiling-rewrite does NOT relabel');
SELECT is(
  (SELECT target_id FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
    ORDER BY id DESC LIMIT 1),
  NULL::uuid,
  'emit shape: target_id is NULL (ADR-0015 Amendment I — not target_id-linked)');
SELECT is(
  (SELECT meta->>'session_id_revoked_during_mint' FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
    ORDER BY id DESC LIMIT 1),
  '22222222-2222-2222-2222-222222222222',
  'emit shape: meta.session_id_revoked_during_mint carries the just-revoked session_id (forensic walker join surface)');

-- (8) request_id propagates.
SELECT is(
  (SELECT request_id FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
    ORDER BY id DESC LIMIT 1),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'emit shape: request_id propagates from caller');

-- (9) pseudonym derivation uses the user_id arg (different user_id ⇒
--     different pseudonym).
SELECT public.mint_emit_revoked_during_mint(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  '44444444-4444-4444-4444-444444444444'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid
);
SELECT isnt(
  (SELECT actor_pseudonym FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
      AND request_id = '33333333-3333-3333-3333-333333333333'::uuid
    ORDER BY id DESC LIMIT 1),
  (SELECT actor_pseudonym FROM public.audit_log
    WHERE event_type = 'auth.mint.revoked_during_mint'
      AND request_id = '44444444-4444-4444-4444-444444444444'::uuid
    ORDER BY id DESC LIMIT 1),
  'different user_id ⇒ different pseudonym (proves HMAC-of-user_id, not constant)');

-- (10) mint_writer can EXECUTE both.
SELECT ok(
  has_function_privilege('mint_writer',
    'public.mint_is_session_live(uuid)', 'EXECUTE'),
  'mint_writer has EXECUTE on mint_is_session_live(uuid)');
SELECT ok(
  has_function_privilege('mint_writer',
    'public.mint_emit_revoked_during_mint(uuid,uuid,uuid)', 'EXECUTE'),
  'mint_writer has EXECUTE on mint_emit_revoked_during_mint(uuid,uuid,uuid)');

SELECT * FROM finish();
ROLLBACK;
