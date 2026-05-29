-- ===========================================================================
-- T19.1 — pgTAP: record_panic_wipe_invoked (G-T19-PRIV-3 wire-up).
-- Run: pg_prove -d <db> supabase/test/t19_panic_wipe_rls.sql
--   (migrations 0-11 + shim).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(8);

INSERT INTO public.users (id, active) VALUES ('00000000-0000-0000-0000-0000000000a1', true);
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min');

-- (1) No session → rls_denied (the session_is_live gate runs first).
SET request.jwt.claims = '{}';
SELECT throws_like(
  $$SELECT public.record_panic_wipe_invoked(
    jsonb_build_object('surface','settings','wipe_scope','local_only','completed',true,'partial_failure_classes',ARRAY[]::text[])
  )$$,
  '%rls_denied%',
  'no session → record_panic_wipe_invoked raises rls_denied (F-116)');

-- Act as a1.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';

-- (2) Success — function returns void without raising.
SELECT lives_ok(
  $$SELECT public.record_panic_wipe_invoked(
    jsonb_build_object('surface','settings','wipe_scope','local_only','completed',true,'partial_failure_classes',ARRAY[]::text[])
  )$$,
  'record_panic_wipe_invoked succeeds under a live session');

-- (3) Audit row exists with the canonical event_type.
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
    WHERE event_type='panic_wipe.invoked'
      AND target_id='00000000-0000-0000-0000-0000000000a1'),
  'panic_wipe.invoked audit row emitted');

-- (4) Severity is 'warn' per ADR-0020 Decision 5 (forensic, not alertable).
SELECT is(
  (SELECT severity FROM public.audit_log
     WHERE event_type='panic_wipe.invoked'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  'warn', 'severity=warn (operational signal, not security-critical)');

-- (5) target_class is C1 (lifecycle metadata).
SELECT is(
  (SELECT target_class FROM public.audit_log
     WHERE event_type='panic_wipe.invoked'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  'C1', 'target_class=C1 (lifecycle metadata)');

-- (6) Meta carries the client-supplied fields verbatim.
SELECT is(
  (SELECT meta->>'surface' FROM public.audit_log
     WHERE event_type='panic_wipe.invoked'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  'settings',
  'audit meta carries the client-supplied surface verbatim');

-- (7) Meta has the server-derived actor_id (NOT trusting any client-supplied value).
SELECT lives_ok(
  $$SELECT public.record_panic_wipe_invoked(
    jsonb_build_object(
      'surface','lock_screen','wipe_scope','local_only','completed',false,
      'partial_failure_classes',ARRAY['indexeddb','caches']::text[],
      'actor_id','99999999-9999-9999-9999-999999999999'
    )
  )$$,
  'record_panic_wipe_invoked accepts a row containing a client-supplied actor_id');
SELECT is(
  (SELECT meta->>'actor_id' FROM public.audit_log
     WHERE event_type='panic_wipe.invoked'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  '00000000-0000-0000-0000-0000000000a1',
  'meta.actor_id is the server-derived auth.uid() (overrides any client-supplied value)');

SELECT * FROM finish();
ROLLBACK;
