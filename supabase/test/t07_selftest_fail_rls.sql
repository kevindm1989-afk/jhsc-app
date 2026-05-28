-- ===========================================================================
-- T07.1 — pgTAP: record_identity_selftest_fail (G-T07-2 production-wire-up).
-- Asserts the gate + the audit-row shape (event_type, target_id, severity,
-- pseudonym, meta).
-- Run: pg_prove -d <db> supabase/test/t07_selftest_fail_rls.sql
--   (migrations 0-9 + shim).
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
  $$SELECT public.record_identity_selftest_fail('{"reason":"idb_corruption"}'::jsonb)$$,
  '%rls_denied%',
  'no session → record_identity_selftest_fail raises rls_denied (F-116)');

-- Act as a1.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';

-- (2) Success — function returns void without raising.
SELECT lives_ok(
  $$SELECT public.record_identity_selftest_fail('{"reason":"idb_corruption"}'::jsonb)$$,
  'record_identity_selftest_fail succeeds under a live session');

-- (3) Audit row exists with the canonical event_type.
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
    WHERE event_type='client.identity_selftest_fail'
      AND target_id='00000000-0000-0000-0000-0000000000a1'),
  'client.identity_selftest_fail audit row emitted');

-- (4) Meta carries the client-supplied reason + the server-derived actor_id.
SELECT is(
  (SELECT meta->>'reason' FROM public.audit_log
     WHERE event_type='client.identity_selftest_fail'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  'idb_corruption',
  'audit meta carries the client-supplied reason verbatim');
SELECT is(
  (SELECT meta->>'actor_id' FROM public.audit_log
     WHERE event_type='client.identity_selftest_fail'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  '00000000-0000-0000-0000-0000000000a1',
  'audit meta carries the server-derived actor_id (overrides any client-supplied actor_id)');

-- (5) Severity is 'warn' (per audit-log.md / ADR-0015 — operational signal).
SELECT is(
  (SELECT severity FROM public.audit_log
     WHERE event_type='client.identity_selftest_fail'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  'warn', 'severity=warn (operational signal, not security-critical)');

-- (6) Pseudonym is the server-derived _committee_pseudonym (no client-supplied value reaches the row).
SELECT is(
  (SELECT actor_pseudonym FROM public.audit_log
     WHERE event_type='client.identity_selftest_fail'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1'),
  'actor_pseudonym is the server-computed HMAC pseudonym');

-- (7) Empty meta (default) is accepted.
SELECT lives_ok(
  $$SELECT public.record_identity_selftest_fail()$$,
  'function accepts default-empty meta');

SELECT * FROM finish();
ROLLBACK;
