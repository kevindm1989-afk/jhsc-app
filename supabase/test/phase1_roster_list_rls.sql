-- ===========================================================================
-- ADR-0029 P1-8a (SQL) — pgTAP for the TWO co-chair-gated READ RPCs:
--   B1  public.committee_roster_list()             (Amendment A-8.1)
--   B2  public.committee_invite_list_pending()     (Amendment A-8.2)
--
-- These are the FIRST surfaces that project ALL members' PI
-- (users.display_name / users.off_employer_contact, 00000000000002:18-19) plus
-- per-member grant-state (has_identity_key / has_live_wrap) to a co-chair, and
-- the ONLY read path for committee_invite (SELECT fully revoked, :60). The
-- threat-modeler models both as facets of F-178 (the whole-committee PI +
-- grant-state oracle); F-176 rides along (no secret-adjacent material leaks).
--
-- Findings covered (threat-model §3.18 F-178, testable-mitigation block
-- threat-model.md:3999-4006):
--   F-178 — co-chair RAISE-gate (NOT silent-empty), BYTE-IDENTICAL denial
--           (not-live ≡ not-co-chair), strict GRANT/REVOKE
--           (REVOKE PUBLIC/anon/service_role; GRANT authenticated +
--           supabase_auth_admin), grant-state badges correct, raw-uid
--           projection (A-8.1) with the _committee_pseudonym REVOKE-ALL
--           boundary intact, roster read UNAUDITED, and B2 NEVER projecting
--           bootstrap_id / secret_hash / any auth_totp_bootstraps field.
--   F-176 — the RETURNS TABLE column sets carry no key bytes / secret material;
--           B2's function body references no TOTP-secret-adjacent table/column.
--
-- Templates mirrored (match style exactly):
--   supabase/test/phase1_issue_invite_rls.sql   — co-chair RAISE-gate under
--                                                 `set local role authenticated`,
--                                                 GRANT matrix, SECURITY DEFINER.
--   supabase/test/phase1_get_pubkey_rls.sql     — byte-identical denial oracle
--                                                 (DO-block SQLERRM capture),
--                                                 has_function_privilege matrix,
--                                                 structural pg_proc introspection.
-- Join shapes pinned by A-8.1:
--   concern_list_default (0040)             — SECURITY DEFINER list-read shape.
--   committee_key_state_for_self (0037:52-60) — the LIVE-wrap join
--                                              (committee_data_keys.rotated_at IS NULL).
--   get_member_identity_pubkey_for_wrap (0042:181) — the non-revoked identity
--                                              predicate (identity_keys.revoked_at IS NULL).
--
-- RED-FIRST: NEITHER function exists on `main`. Every assertion is written so a
-- missing function fails GRACEFULLY for its OWN reason (never a hard
-- transaction-abort cascade): structural checks read pg_proc via
-- `to_regprocedure(...)` (NULL when absent → the assertion fails, it does not
-- throw), the gate checks use throws_like/throws_ok (a "function does not exist"
-- error does not match the pinned literal → the assertion fails), and the happy
-- reads are captured inside DO-blocks whose EXCEPTION handler records the error
-- so `current_setting(name, true)` returns NULL → the assertion fails. The
-- implementer treats this file as READ-ONLY.
--
-- Run: pg_prove -d <db> supabase/test/phase1_roster_list_rls.sql
--   (migrations 0..N + the local auth shim; CI committee-db-tests stage).
-- `set local role authenticated` wherever a real role boundary is asserted —
-- pgTAP runs as superuser by default, so without it every EXECUTE-grant / RLS
-- assertion would silently pass.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(56);

-- ---------------------------------------------------------------------------
-- Fixtures — a single-tenant committee (ADR-0021: no committee_id anywhere).
--
--   F1  active co-chair (the happy caller)            — identity key + LIVE wrap
--   B2  active worker_member (NON-co-chair caller)    — no identity key
--   MA  active member  identity(live) + LIVE wrap     → (ik=t, lw=t)  [active]
--   MB  active member  identity(live), NO wrap        → (ik=t, lw=f)  [pending-grant]
--   MC  active member  NO identity key                → (ik=f, lw=f)  [awaiting-identity]
--   MR  active member  identity REVOKED, no wrap       → (ik=f, …)     [revoked ignored]
--   MT  active member  identity(live) + ROTATED wrap  → (ik=t, lw=f)  [rotated ≠ live]
--   MN  active member  identity(live) + LIVE wrap, NULL display_name  [NULLS LAST]
--   MD  INACTIVE (removed) member, identity + wrap    → active=false  [still listed]
--   X9  a users row (NULL display_name) that is a pending-invite target only.
--
-- Two data keys: KEY_LIVE (rotated_at IS NULL) and KEY_ROT (rotated_at set) so
-- the has_live_wrap join can be shown to ignore wraps under a rotated key.
-- ---------------------------------------------------------------------------
INSERT INTO public.users (id, active, display_name, off_employer_contact) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true, 'Anna Cochair', 'anna@union.example'),
  ('00000000-0000-0000-0000-0000000000b2', true, 'Bob Worker',   NULL),
  ('00000000-0000-0000-0000-0000000000a1', true, 'Cara Active',  'cara@home.example'),
  ('00000000-0000-0000-0000-0000000000b1', true, 'Dora Pending', NULL),
  ('00000000-0000-0000-0000-0000000000c1', true, 'Evan NoKey',   NULL),
  ('00000000-0000-0000-0000-0000000000e1', true, 'Finn Revoked', NULL),
  ('00000000-0000-0000-0000-0000000000f5', true, 'Gwen Rotated', NULL),
  ('00000000-0000-0000-0000-000000000009', true, NULL,           NULL),  -- MN: NULL PI
  ('00000000-0000-0000-0000-0000000000d1', true, 'Zeb Removed',  NULL),
  ('00000000-0000-0000-0000-0000000000a9', true, NULL,           NULL);  -- X9: invite target, NULL PI

INSERT INTO public.committee_membership
  (user_id, role, active, invited_at, activated_at, deactivated_at, grace_until) VALUES
  ('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member','worker_co_chair'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-0000000000b1', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-0000000000c1', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-0000000000e1', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-0000000000f5', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  ('00000000-0000-0000-0000-000000000009', ARRAY['worker_member'], true,  now(), now(), NULL, NULL),
  -- MD: removed (a membership revocation — active=false + 90-day grace, A-8.9).
  ('00000000-0000-0000-0000-0000000000d1', ARRAY['worker_member'], false, now(), now(), now(), now() + interval '90 days');

INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111f1', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  -- A dead (revoked) session for the co-chair F1 to exercise the session_is_live gate.
  ('11111111-1111-1111-1111-11111111dead', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min');
UPDATE public.auth_sessions SET revoked_at = now()
  WHERE session_id = '11111111-1111-1111-1111-11111111dead';

-- Two committee data keys: one live, one rotated.
INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at) VALUES
  ('00000000-0000-0000-0000-00000000ce00', 1, now()),   -- KEY_ROT (rotated)
  ('00000000-0000-0000-0000-00000000ce01', 2, NULL);    -- KEY_LIVE (live)

-- Identity keys — MC has none; MR's is REVOKED (revoked_at set) so the
-- has_identity_key EXISTS(... revoked_at IS NULL) predicate must exclude it.
INSERT INTO public.identity_keys (user_id, public_key, revoked_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', decode(repeat('f1', 32), 'hex'), NULL),
  ('00000000-0000-0000-0000-0000000000a1', decode(repeat('a1', 32), 'hex'), NULL),
  ('00000000-0000-0000-0000-0000000000b1', decode(repeat('b1', 32), 'hex'), NULL),
  ('00000000-0000-0000-0000-0000000000e1', decode(repeat('e1', 32), 'hex'), now()),   -- MR: REVOKED
  ('00000000-0000-0000-0000-0000000000f5', decode(repeat('f5', 32), 'hex'), NULL),
  ('00000000-0000-0000-0000-000000000009', decode(repeat('09', 32), 'hex'), NULL),
  ('00000000-0000-0000-0000-0000000000d1', decode(repeat('d1', 32), 'hex'), NULL);

-- Wraps — MA/MN/MD/F1 under the LIVE key; MT under the ROTATED key ONLY.
INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000ce01', '\x01'::bytea),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ce01', '\x01'::bytea),
  ('00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-00000000ce01', '\x01'::bytea),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000ce01', '\x01'::bytea),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-00000000ce00', '\x01'::bytea);  -- MT: rotated only

-- Pending invites (B2 fixtures) — issued_by F1. INV_A newest, INV_C consumed,
-- INV_B expired-unconsumed (INCLUDED), INV_NULL targets the NULL-PI user.
INSERT INTO public.committee_invite
  (invite_id, target_user_id, role, issued_by, issued_at, expires_at, consumed_at) VALUES
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000b1',
     ARRAY['worker_member'], '00000000-0000-0000-0000-0000000000f1',
     now() - interval '1 min', now() + interval '7 days', NULL),                       -- INV_A: unconsumed (newest)
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000c1',
     ARRAY['worker_co_chair','worker_member'], '00000000-0000-0000-0000-0000000000f1',
     now() - interval '2 min', now() - interval '1 day', NULL),                        -- INV_B: expired-unconsumed (INCLUDED)
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-0000000000a1',
     ARRAY['worker_member'], '00000000-0000-0000-0000-0000000000f1',
     now() - interval '3 min', now() + interval '7 days', now()),                      -- INV_C: consumed (EXCLUDED)
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-0000000000a9',
     ARRAY['worker_member'], '00000000-0000-0000-0000-0000000000f1',
     now() - interval '4 min', now() + interval '7 days', NULL);                       -- INV_NULL: NULL-PI target


-- ###########################################################################
-- B1 — committee_roster_list()   (Amendment A-8.1)
-- ###########################################################################

-- (1) The function exists with the pinned zero-arg signature.
SELECT has_function(
  'public', 'committee_roster_list', ARRAY[]::text[],
  'A-8.1: committee_roster_list() exists (zero-arg SECURITY DEFINER read)');

-- (2) SECURITY DEFINER — the table read-locks (identity_keys, committee_*_keys)
--     require definer rights; a co-chair-gated definer is the whole design.
SELECT is(
  (SELECT prosecdef FROM pg_proc
     WHERE proname = 'committee_roster_list' AND pronamespace = 'public'::regnamespace LIMIT 1),
  true,
  'A-8.1: committee_roster_list is SECURITY DEFINER');

-- (3) STABLE (A-8.1 pins `plpgsql STABLE SECURITY DEFINER`).
SELECT is(
  (SELECT provolatile FROM pg_proc
     WHERE proname = 'committee_roster_list' AND pronamespace = 'public'::regnamespace LIMIT 1),
  's'::"char",
  'A-8.1: committee_roster_list is STABLE (provolatile=s)');

-- (4)-(7) F-178 GRANT/REVOKE matrix — the strict committee_key_state_for_self
--     posture (0037:63-66): REVOKE PUBLIC/anon/service_role; GRANT authenticated
--     + supabase_auth_admin. anon (which holds only PUBLIC-inherited privileges)
--     being denied proves the REVOKE-FROM-PUBLIC. Null-safe via to_regprocedure
--     so a missing function fails the assertion rather than hard-erroring.
SELECT is(
  (SELECT has_function_privilege('anon', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')),
  false,
  'F-178: anon CANNOT execute committee_roster_list (REVOKE FROM PUBLIC/anon)');
SELECT is(
  (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')),
  false,
  'F-178: service_role CANNOT execute committee_roster_list (strict posture, NOT the concern_list_default leniency)');
SELECT is(
  (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')),
  true,
  'F-178: authenticated CAN execute committee_roster_list (co-chair-gated in-fn)');
SELECT is(
  (SELECT has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')),
  true,
  'F-178: supabase_auth_admin CAN execute committee_roster_list');

-- (8) A-8.1 — EXACTLY 11 projected TABLE columns (no extras).
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p CROSS JOIN LATERAL unnest(p.proargmodes) AS am(m)
    WHERE p.oid = to_regprocedure('public.committee_roster_list()') AND am.m::text = 't'),
  11,
  'A-8.1: committee_roster_list projects EXACTLY 11 TABLE columns');

-- (9) A-8.1 — the 11 column NAMES, in the pinned order.
SELECT is(
  (SELECT array_agg(am.n ORDER BY am.ord)
     FROM pg_proc p
     CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS am(n, m, ord)
    WHERE p.oid = to_regprocedure('public.committee_roster_list()') AND am.m::text = 't'),
  ARRAY['user_id','roles','active','invited_at','activated_at','deactivated_at',
        'grace_until','display_name','off_employer_contact','has_identity_key','has_live_wrap']::text[],
  'A-8.1: committee_roster_list OUT columns are exactly the 11 pinned names, in order');

-- (10)-(13) F-178/F-176 — no secret / key-material column is projected. Scan the
--     RETURNS TABLE text for bootstrap_id / secret_hash / public_key /
--     wrapped_ciphertext (the roster returns has_live_wrap BOOLEANS, never bytes).
SELECT ok(
  COALESCE((SELECT position('bootstrap_id' in lower(pg_get_function_result(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')), false),
  'F-178: committee_roster_list RETURNS TABLE has NO bootstrap_id column');
SELECT ok(
  COALESCE((SELECT position('secret_hash' in lower(pg_get_function_result(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')), false),
  'F-178: committee_roster_list RETURNS TABLE has NO secret_hash column');
SELECT ok(
  COALESCE((SELECT position('public_key' in lower(pg_get_function_result(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')), false),
  'F-176: committee_roster_list RETURNS TABLE has NO public_key column (grant-state is a boolean, not bytes)');
SELECT ok(
  COALESCE((SELECT position('wrapped_ciphertext' in lower(pg_get_function_result(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_roster_list()')), false),
  'F-176: committee_roster_list RETURNS TABLE has NO wrapped_ciphertext column');

-- (14) F-178 GATE (RAISE, not silent-empty) — a NON-co-chair active member (B2)
--     with a LIVE session is denied with rls_denied. `set local role
--     authenticated` so the boundary is real.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT * FROM public.committee_roster_list()$$,
  '%rls_denied%',
  'F-178: a worker_member (non-co-chair) reading the roster RAISEs rls_denied (NOT a silent-empty set)');
RESET ROLE;

-- (15) F-178 GATE — a co-chair (F1) with a DEAD session is denied (session_is_live).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT * FROM public.committee_roster_list()$$,
  '%rls_denied%',
  'F-178: a co-chair with a revoked session reading the roster RAISEs rls_denied (session_is_live gate)');
RESET ROLE;

-- (16) F-178 — BYTE-IDENTICAL denial. Capture the SQLERRM of the not-co-chair and
--     the not-live branches and assert they are the SAME literal AND both are
--     rls_denied — so no oracle distinguishes "logged out" from "not a co-chair".
--     The `LIKE '%rls_denied%'` conjunct forbids a false-green on the RED-first
--     "function does not exist" error (that error is byte-identical too, but is
--     NOT rls_denied).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.committee_roster_list();
    PERFORM set_config('test.rl_notcc', '<no exception raised>', false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('test.rl_notcc', SQLERRM, false);
  END;
END $$;
RESET ROLE;
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.committee_roster_list();
    PERFORM set_config('test.rl_notlive', '<no exception raised>', false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('test.rl_notlive', SQLERRM, false);
  END;
END $$;
RESET ROLE;
SELECT ok(
  current_setting('test.rl_notcc', true) = current_setting('test.rl_notlive', true)
  AND current_setting('test.rl_notcc', true) LIKE '%rls_denied%',
  'F-178: not-co-chair and not-live roster denials are BYTE-IDENTICAL rls_denied (no not-live-vs-not-co-chair oracle)');

-- (17) F-178 — a bare `anon` (unauthenticated) call is denied at the EXECUTE
--     boundary (42501), never reaching the body. RED-first the missing function
--     raises 42883 → this assertion fails for the right reason.
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT * FROM public.committee_roster_list()$$,
  '42501', NULL,
  'F-178: an anon (unauthenticated) roster read is denied at the EXECUTE grant (42501)');
RESET ROLE;

-- ---------------------------------------------------------------------------
-- B1 happy read — capture the roster under the F1 co-chair (live) role. All
-- reads are captured inside a DO-block; on RED (missing fn) the block's first
-- SELECT throws, the GUCs stay unset, and every downstream assertion fails via
-- current_setting(name, true) = NULL. Baseline audit_log count snapshotted FIRST
-- so the "unaudited read" delta (assertion 55) measures only the two reads.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _audit_base_reads AS SELECT count(*)::int AS n FROM public.audit_log;

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_ik boolean; v_lw boolean; v_uid uuid; v_active boolean; v_csv text; v_cnt int;
BEGIN
  SELECT has_identity_key, has_live_wrap INTO v_ik, v_lw
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000a1';  -- MA
  PERFORM set_config('test.ma_ik', v_ik::text, false);
  PERFORM set_config('test.ma_lw', v_lw::text, false);

  SELECT has_identity_key, has_live_wrap INTO v_ik, v_lw
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000b1';  -- MB
  PERFORM set_config('test.mb_ik', v_ik::text, false);
  PERFORM set_config('test.mb_lw', v_lw::text, false);

  SELECT has_identity_key, has_live_wrap INTO v_ik, v_lw
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000c1';  -- MC
  PERFORM set_config('test.mc_ik', v_ik::text, false);
  PERFORM set_config('test.mc_lw', v_lw::text, false);

  SELECT has_identity_key INTO v_ik
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000e1';  -- MR (revoked)
  PERFORM set_config('test.mr_ik', v_ik::text, false);

  SELECT has_identity_key, has_live_wrap INTO v_ik, v_lw
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000f5';  -- MT (rotated wrap)
  PERFORM set_config('test.mt_ik', v_ik::text, false);
  PERFORM set_config('test.mt_lw', v_lw::text, false);

  SELECT active INTO v_active
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000d1';  -- MD (removed)
  PERFORM set_config('test.md_active', v_active::text, false);

  SELECT user_id INTO v_uid
    FROM public.committee_roster_list() WHERE user_id = '00000000-0000-0000-0000-0000000000a1';  -- MA raw uid
  PERFORM set_config('test.ma_uid', v_uid::text, false);

  -- Output order captured via row_number() over the function's ORDER BY output.
  SELECT string_agg(user_id::text, ',' ORDER BY ord) INTO v_csv
    FROM (SELECT user_id, row_number() OVER () AS ord FROM public.committee_roster_list()) t;
  PERFORM set_config('test.roster_csv', v_csv, false);

  SELECT count(*)::int INTO v_cnt FROM public.committee_roster_list();
  PERFORM set_config('test.roster_cnt', v_cnt::text, false);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('test.roster_err', SQLERRM, false);
END $$;

-- B2 happy read captured in the SAME role context (see the B2 section for the
-- pending-invite fixtures + assertions).
DO $$
DECLARE
  v_csv text; v_cnt int; v_ccnt int; v_roles text; v_dn text; v_dn2 text;
BEGIN
  SELECT string_agg(invite_id::text, ',' ORDER BY ord) INTO v_csv
    FROM (SELECT invite_id, row_number() OVER () AS ord FROM public.committee_invite_list_pending()) t;
  PERFORM set_config('test.inv_csv', v_csv, false);

  SELECT count(*)::int INTO v_cnt FROM public.committee_invite_list_pending();
  PERFORM set_config('test.inv_total', v_cnt::text, false);

  SELECT count(*)::int INTO v_ccnt
    FROM public.committee_invite_list_pending() WHERE invite_id = '00000000-0000-0000-0000-00000000a003';  -- INV_C consumed
  PERFORM set_config('test.inv_consumed_cnt', v_ccnt::text, false);

  SELECT roles::text, display_name INTO v_roles, v_dn
    FROM public.committee_invite_list_pending() WHERE invite_id = '00000000-0000-0000-0000-00000000a001';  -- INV_A
  PERFORM set_config('test.inva_roles', v_roles, false);
  PERFORM set_config('test.inva_dn', COALESCE(v_dn, 'NULL'), false);

  SELECT display_name INTO v_dn2
    FROM public.committee_invite_list_pending() WHERE invite_id = '00000000-0000-0000-0000-00000000a004';  -- INV_NULL
  PERFORM set_config('test.invnull_dn', COALESCE(v_dn2, 'NULL'), false);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('test.inv_err', SQLERRM, false);
END $$;
RESET ROLE;

-- (18)-(19) F-178 badge — MA: enrolled identity + LIVE wrap → active badge.
SELECT is(current_setting('test.ma_ik', true), 'true',
  'F-178: MA (identity + live wrap) has_identity_key=true');
SELECT is(current_setting('test.ma_lw', true), 'true',
  'F-178: MA (identity + live wrap) has_live_wrap=true');

-- (20)-(21) F-178 badge — MB: enrolled identity, NO wrap → pending-grant
--     (has_identity_key AND NOT has_live_wrap).
SELECT is(current_setting('test.mb_ik', true), 'true',
  'F-178: MB (enrolled, un-granted) has_identity_key=true');
SELECT is(current_setting('test.mb_lw', true), 'false',
  'F-178: MB has_live_wrap=false → pending-grant badge (has_identity_key AND NOT has_live_wrap)');

-- (22)-(23) F-178 badge — MC: no identity key at all → both false.
SELECT is(current_setting('test.mc_ik', true), 'false',
  'F-178: MC (no identity key) has_identity_key=false → awaiting-identity');
SELECT is(current_setting('test.mc_lw', true), 'false',
  'F-178: MC (no identity key) has_live_wrap=false');

-- (24) F-178 — the has_identity_key join IGNORES a REVOKED identity key
--     (identity_keys.revoked_at IS NULL predicate, 0042:181).
SELECT is(current_setting('test.mr_ik', true), 'false',
  'F-178: MR with ONLY a revoked identity key → has_identity_key=false (revoked_at IS NULL predicate)');

-- (25)-(26) F-178 — the has_live_wrap join counts ONLY the LIVE key
--     (committee_data_keys.rotated_at IS NULL, 0037:52-60). MT holds an identity
--     AND a wrap, but the wrap is under a ROTATED key → NOT live.
SELECT is(current_setting('test.mt_ik', true), 'true',
  'F-178: MT has a non-revoked identity → has_identity_key=true');
SELECT is(current_setting('test.mt_lw', true), 'false',
  'F-178: MT wrap is under a ROTATED key → has_live_wrap=false (rotated_at IS NULL join)');

-- (27) F-178 — an inactive/removed member is STILL listed, with active=false.
SELECT is(current_setting('test.md_active', true), 'false',
  'F-178: a removed member appears in the roster with active=false');

-- (28)-(29) A-8.1 — the roster returns the RAW user_id (uuid), NOT a pseudonym.
SELECT is(current_setting('test.ma_uid', true), '00000000-0000-0000-0000-0000000000a1',
  'A-8.1: committee_roster_list returns the RAW user_id (equals the seeded uuid)');
SELECT ok(
  current_setting('test.ma_uid', true) IS DISTINCT FROM
    public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1')::text,
  'A-8.1: the returned user_id is the raw uuid, NOT the _committee_pseudonym value');

-- (30) A-8.1 — ORDER BY active DESC, display_name NULLS LAST. Active members
--     first, sorted by display_name ascending, with the NULL-name row (MN) LAST
--     within the active group; the inactive member (MD) sinks below all active.
--     Expected order (uuid): Anna(F1), Bob(B2), Cara(MA), Dora(MB), Evan(MC),
--     Finn(MR), Gwen(MT), <NULL name>(MN), then INACTIVE Zeb(MD).
SELECT is(
  current_setting('test.roster_csv', true),
  '00000000-0000-0000-0000-0000000000f1,00000000-0000-0000-0000-0000000000b2,00000000-0000-0000-0000-0000000000a1,00000000-0000-0000-0000-0000000000b1,00000000-0000-0000-0000-0000000000c1,00000000-0000-0000-0000-0000000000e1,00000000-0000-0000-0000-0000000000f5,00000000-0000-0000-0000-000000000009,00000000-0000-0000-0000-0000000000d1',
  'A-8.1: roster ORDER BY active DESC, display_name NULLS LAST (NULL-name active row before the inactive row)');

-- (31) The roster lists EVERY committee_membership row (9 seeded).
SELECT is(current_setting('test.roster_cnt', true), '9',
  'A-8.1: committee_roster_list returns all 9 committee_membership rows');


-- ###########################################################################
-- B2 — committee_invite_list_pending()   (Amendment A-8.2)
-- ###########################################################################

-- (32) Exists with the pinned zero-arg signature.
SELECT has_function(
  'public', 'committee_invite_list_pending', ARRAY[]::text[],
  'A-8.2: committee_invite_list_pending() exists (zero-arg SECURITY DEFINER read)');

-- (33) SECURITY DEFINER.
SELECT is(
  (SELECT prosecdef FROM pg_proc
     WHERE proname = 'committee_invite_list_pending' AND pronamespace = 'public'::regnamespace LIMIT 1),
  true,
  'A-8.2: committee_invite_list_pending is SECURITY DEFINER');

-- (34) STABLE.
SELECT is(
  (SELECT provolatile FROM pg_proc
     WHERE proname = 'committee_invite_list_pending' AND pronamespace = 'public'::regnamespace LIMIT 1),
  's'::"char",
  'A-8.2: committee_invite_list_pending is STABLE (provolatile=s)');

-- (35)-(38) F-178 GRANT/REVOKE matrix — SAME strict posture as B1.
SELECT is(
  (SELECT has_function_privilege('anon', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')),
  false,
  'F-178: anon CANNOT execute committee_invite_list_pending (REVOKE FROM PUBLIC/anon)');
SELECT is(
  (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')),
  false,
  'F-178: service_role CANNOT execute committee_invite_list_pending');
SELECT is(
  (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')),
  true,
  'F-178: authenticated CAN execute committee_invite_list_pending (co-chair-gated in-fn)');
SELECT is(
  (SELECT has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE')
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')),
  true,
  'F-178: supabase_auth_admin CAN execute committee_invite_list_pending');

-- (39) A-8.2 — EXACTLY 6 projected TABLE columns.
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p CROSS JOIN LATERAL unnest(p.proargmodes) AS am(m)
    WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()') AND am.m::text = 't'),
  6,
  'A-8.2: committee_invite_list_pending projects EXACTLY 6 TABLE columns');

-- (40) A-8.2 — the 6 column NAMES, in the pinned order.
SELECT is(
  (SELECT array_agg(am.n ORDER BY am.ord)
     FROM pg_proc p
     CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS am(n, m, ord)
    WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()') AND am.m::text = 't'),
  ARRAY['invite_id','target_user_id','display_name','roles','issued_at','expires_at']::text[],
  'A-8.2: committee_invite_list_pending OUT columns are exactly the 6 pinned names, in order');

-- (41)-(42) 🔒 F-178 — the RETURNS TABLE NEVER projects bootstrap_id / secret.
SELECT ok(
  COALESCE((SELECT position('bootstrap_id' in lower(pg_get_function_result(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')), false),
  'F-178: committee_invite_list_pending RETURNS TABLE has NO bootstrap_id column (TOTP-secret adjacency)');
SELECT ok(
  COALESCE((SELECT position('secret_hash' in lower(pg_get_function_result(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')), false),
  'F-178: committee_invite_list_pending RETURNS TABLE has NO secret_hash column');

-- (43)-(45) 🔒 F-178 — the function BODY reads NO TOTP-secret-adjacent table /
--     column: neither auth_totp_bootstraps nor bootstrap_id nor secret_hash
--     appears in the source (source-scan mirror of phase1_redeem_concurrent_redeem.sql:86-90).
SELECT ok(
  COALESCE((SELECT position('auth_totp_bootstraps' in lower(pg_get_functiondef(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')), false),
  'F-178: committee_invite_list_pending body does NOT read auth_totp_bootstraps');
SELECT ok(
  COALESCE((SELECT position('bootstrap_id' in lower(pg_get_functiondef(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')), false),
  'F-178: committee_invite_list_pending body does NOT reference bootstrap_id');
SELECT ok(
  COALESCE((SELECT position('secret_hash' in lower(pg_get_functiondef(p.oid))) = 0
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.committee_invite_list_pending()')), false),
  'F-178: committee_invite_list_pending body does NOT reference secret_hash');

-- (46) F-178 GATE — non-co-chair (B2, live) is denied rls_denied.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT * FROM public.committee_invite_list_pending()$$,
  '%rls_denied%',
  'F-178: a worker_member (non-co-chair) reading pending invites RAISEs rls_denied (NOT silent-empty)');
RESET ROLE;

-- (47) F-178 GATE — dead-session co-chair (F1) is denied rls_denied.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT * FROM public.committee_invite_list_pending()$$,
  '%rls_denied%',
  'F-178: a co-chair with a revoked session reading pending invites RAISEs rls_denied (session_is_live gate)');
RESET ROLE;

-- (48) F-178 — BYTE-IDENTICAL denial for B2 (same collapsed-oracle posture as B1).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.committee_invite_list_pending();
    PERFORM set_config('test.il_notcc', '<no exception raised>', false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('test.il_notcc', SQLERRM, false);
  END;
END $$;
RESET ROLE;
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.committee_invite_list_pending();
    PERFORM set_config('test.il_notlive', '<no exception raised>', false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('test.il_notlive', SQLERRM, false);
  END;
END $$;
RESET ROLE;
SELECT ok(
  current_setting('test.il_notcc', true) = current_setting('test.il_notlive', true)
  AND current_setting('test.il_notcc', true) LIKE '%rls_denied%',
  'F-178: not-co-chair and not-live pending-invite denials are BYTE-IDENTICAL rls_denied (no oracle)');

-- (49) A-8.2 — the pending set + order. `WHERE consumed_at IS NULL` (in the BODY)
--     INCLUDES the expired-unconsumed invite (INV_B) and EXCLUDES the consumed
--     one (INV_C); ORDER BY issued_at DESC → INV_A (newest), INV_B, INV_NULL.
SELECT is(
  current_setting('test.inv_csv', true),
  '00000000-0000-0000-0000-00000000a001,00000000-0000-0000-0000-00000000a002,00000000-0000-0000-0000-00000000a004',
  'A-8.2: pending list = unconsumed invites (incl. expired-unconsumed) ORDER BY issued_at DESC; consumed excluded');

-- (50) A-8.2 — the consumed invite (INV_C) is EXCLUDED (WHERE consumed_at IS NULL).
SELECT is(current_setting('test.inv_consumed_cnt', true), '0',
  'A-8.2: a CONSUMED invite is excluded from committee_invite_list_pending (WHERE consumed_at IS NULL)');

-- (51) A-8.2 — exactly 3 pending rows (INV_A, INV_B, INV_NULL).
SELECT is(current_setting('test.inv_total', true), '3',
  'A-8.2: committee_invite_list_pending returns the 3 unconsumed invites');

-- (52) A-8.2 — roles := ci.role (the invite role array), projected as `roles`.
SELECT is(current_setting('test.inva_roles', true), '{worker_member}',
  'A-8.2: pending-invite roles column = the invite role array (roles := ci.role)');

-- (53) A-8.2 — display_name comes from the LEFT JOIN users on the invite target.
SELECT is(current_setting('test.inva_dn', true), 'Dora Pending',
  'A-8.2: pending-invite display_name = the target user PI (LEFT JOIN users)');

-- (54) A-8.2 null-PI — an invite whose target has NULL display_name STILL returns
--     (LEFT JOIN yields NULL display_name; the row is not dropped).
SELECT is(current_setting('test.invnull_dn', true), 'NULL',
  'A-8.2: a pending invite whose target has NULL PI still returns (display_name NULL, row not dropped)');


-- ###########################################################################
-- Cross-cutting F-178 mitigations
-- ###########################################################################

-- (55) F-178 — the roster reads are UNAUDITED (sibling of concern_list_default /
--     committee_key_state_for_self; they disclose grant-state BOOLEANS, not key
--     bytes). Between the audit baseline and here, the ONLY function calls are
--     the two happy read DO-blocks — so a zero delta proves neither read emitted
--     an audit_log row.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log) - (SELECT n FROM _audit_base_reads),
  0,
  'F-178: committee_roster_list + committee_invite_list_pending emit NO audit_log row (unaudited list read)');

-- (56) F-178 — the raw-uid decision (A-8.1) rests on the audit-pseudonym boundary
--     holding: an `authenticated` co-chair holding a roster uid CANNOT invoke
--     _committee_pseudonym (REVOKE ALL FROM PUBLIC, 0002:205), so the roster uid
--     is NOT a uid→audit-actor deanonymization pivot. (GREEN-now regression guard.)
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1'::uuid)$$,
  '42501', NULL,
  'F-178: an authenticated caller CANNOT invoke _committee_pseudonym (raw roster uid is not an audit-actor pivot; 0002:205 REVOKE-ALL holds)');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
