-- ===========================================================================
-- T13.1 — pgTAP: reprisal_log RLS + 4-eyes + forensic reveal + feed.
--   F-17  actor_id always recorded; audit carries the submitter pseudonym
--   F-15  active-member gate on submit (non-member denied)
--   HG-6  reprisal_read audits BEFORE returning ciphertext; wrong per-record
--         passphrase emits sensitive.access_attempt + returns no ciphertext (G-T13-6)
--   F-31  reprisal_update emits reprisal.update with prev_field_hashes
--   HG-7  status-flip 4-eyes: self-approve denied, role-pair enforced
--   Am.E  forensic reveal: 24h expiry, role-pair, reveals the audit actor pseudonym
--   Am.D  reprisal_feed: pseudonymized (no actor), ts bucketed to the hour, reprisal.* only
--   F-35  consume_reprisal_rate_budget two-window ceiling
-- Run: pg_prove -d <db> supabase/test/reprisal_rls.sql  (migrations 0-5 + shim).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(37);

-- Actors: two co-chairs, a certified member, a plain member, a non-member.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000c1', true),
  ('00000000-0000-0000-0000-0000000000c2', true),
  ('00000000-0000-0000-0000-0000000000e1', true),
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000b1', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000c1', ARRAY['worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000c2', ARRAY['worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000e1', ARRAY['certified_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111c1', '00000000-0000-0000-0000-0000000000c1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c2', '00000000-0000-0000-0000-0000000000c2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111e1', '00000000-0000-0000-0000-0000000000e1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b1', '00000000-0000-0000-0000-0000000000b1', now() + interval '5 min');

-- (1)-(6) protections + roles.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='reprisal_log'), 'reprisal_log RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='pending_four_eyes_ops'), 'pending_four_eyes_ops RLS enabled');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
     WHERE table_name='reprisal_log' AND grantee IN ('authenticated','anon')
       AND privilege_type IN ('INSERT','UPDATE','DELETE')$$,
  $$VALUES (0)$$, 'reprisal_log write grants empty for authenticated/anon');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
     WHERE table_name='reprisal_log' AND grantee IN ('authenticated','anon') AND privilege_type='SELECT'$$,
  $$VALUES (0)$$, 'HG-6: direct SELECT on reprisal_log denied (reads go via reprisal_read)');
SELECT has_role('c4_read_service', 'c4_read_service role exists');
SELECT has_role('forensic_read_service', 'forensic_read_service role exists');

-- Act as co-chair cc1.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';

-- (7)-(10) submit.
CREATE TEMP TABLE _r AS
  SELECT 'r1'::text AS tag, public.reprisal_submit('\xA1'::bytea, '\xBEEF'::bytea, 'r-pass') AS id;
SELECT isnt((SELECT id FROM _r WHERE tag='r1'), NULL, 'reprisal_submit returns an id');
SELECT is((SELECT actor_id FROM public.reprisal_log WHERE id=(SELECT id FROM _r WHERE tag='r1')),
  '00000000-0000-0000-0000-0000000000c1'::uuid, 'F-17: actor_id is the submitter');
SELECT ok((SELECT per_record_passphrase_hash IS NOT NULL FROM public.reprisal_log WHERE id=(SELECT id FROM _r WHERE tag='r1')),
  'G-T13-6: per-record passphrase hash stored');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='reprisal.created' AND target_id=(SELECT id FROM _r WHERE tag='r1')),
  'F-17: reprisal.created audit row emitted');

-- (11) F-15 non-member denial.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","session_id":"11111111-1111-1111-1111-1111111111b1","role":"authenticated"}';
SELECT throws_like($$SELECT public.reprisal_submit('\x01'::bytea,'\x02'::bytea, NULL)$$, '%rls_denied%',
  'F-15: a non-member cannot submit a reprisal');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';

-- (12)-(16) HG-6 read + passphrase gate.
SELECT is((SELECT body_ct FROM public.reprisal_read((SELECT id FROM _r WHERE tag='r1'), 'r-pass')),
  '\xBEEF'::bytea, 'HG-6: reprisal_read returns the body ciphertext with the correct passphrase');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='reprisal.read' AND target_id=(SELECT id FROM _r WHERE tag='r1')),
  'HG-6: reprisal.read audit row emitted');
SELECT is((SELECT count(*)::int FROM public.reprisal_read((SELECT id FROM _r WHERE tag='r1'), 'wrong')), 0,
  'G-T13-6: wrong passphrase returns no ciphertext');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='sensitive.access_attempt' AND target_id=(SELECT id FROM _r WHERE tag='r1')),
  'wrong passphrase emits sensitive.access_attempt (persisted, not rolled back)');
SELECT is((SELECT count(*)::int FROM public.reprisal_read('00000000-0000-0000-0000-0000000000ff'::uuid, 'r-pass')), 0,
  'reprisal_read on a missing id returns no rows');

-- (17) F-31 update + prev_field_hashes.
SELECT lives_ok(format($$SELECT public.reprisal_update(%L::uuid, NULL, '\xCAFE'::bytea)$$, (SELECT id FROM _r WHERE tag='r1')),
  'reprisal_update re-encrypts the body');
SELECT is(
  (SELECT meta->'prev_field_hashes'->>'body_ct' FROM public.audit_log
     WHERE event_type='reprisal.update' AND target_id=(SELECT id FROM _r WHERE tag='r1')),
  encode(digest('\xBEEF'::bytea,'sha256'),'hex'),
  'F-31: prev_field_hashes.body_ct is the SHA-256 of the prior ciphertext');

-- (18)-(24) HG-7 status-flip 4-eyes.
CREATE TEMP TABLE _p AS
  SELECT 'ps1'::text AS tag, public.reprisal_propose_status((SELECT id FROM _r WHERE tag='r1'), 'closed') AS id;
SELECT isnt((SELECT id FROM _p WHERE tag='ps1'), NULL, 'reprisal_propose_status returns a pending id');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='reprisal.status_changed.4eyes_pending' AND target_id=(SELECT id FROM _r WHERE tag='r1')),
  'HG-7: 4eyes_pending audit emitted');
SELECT throws_like(format($$SELECT public.reprisal_approve_status(%L::uuid)$$, (SELECT id FROM _p WHERE tag='ps1')),
  '%self_approve_denied%', 'HG-7: proposer cannot self-approve');  -- still acting as cc1
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT throws_like(format($$SELECT public.reprisal_approve_status(%L::uuid)$$, (SELECT id FROM _p WHERE tag='ps1')),
  '%role_pair_invalid%', 'HG-7: a plain worker_member cannot approve (role-pair)');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","session_id":"11111111-1111-1111-1111-1111111111c2","role":"authenticated"}';
SELECT lives_ok(format($$SELECT public.reprisal_approve_status(%L::uuid)$$, (SELECT id FROM _p WHERE tag='ps1')),
  'HG-7: a distinct co-chair approves');
SELECT is((SELECT status FROM public.reprisal_log WHERE id=(SELECT id FROM _r WHERE tag='r1')), 'closed',
  'HG-7: the status flip is applied on approval');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='reprisal.status_changed.4eyes_completed' AND target_id=(SELECT id FROM _r WHERE tag='r1')),
  'HG-7: 4eyes_completed audit emitted');

-- (25)-(31) Amendment E forensic reveal. Target = the reprisal.created audit row.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
CREATE TEMP TABLE _aud AS
  SELECT (SELECT id::text FROM public.audit_log WHERE event_type='reprisal.created' AND target_id=(SELECT id FROM _r WHERE tag='r1') LIMIT 1) AS audit_id;
INSERT INTO _p SELECT 'pf1', public.reprisal_propose_forensic((SELECT audit_id FROM _aud), 'investigating a tip');
SELECT isnt((SELECT id FROM _p WHERE tag='pf1'), NULL, 'reprisal_propose_forensic returns a pending id');
SELECT ok((SELECT expires_at IS NOT NULL AND expires_at > now() FROM public.pending_four_eyes_ops WHERE id=(SELECT id FROM _p WHERE tag='pf1')),
  'Am.E: forensic reveal has a future 24h expiry');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='audit.forensic_reveal.4eyes_pending'),
  'Am.E: 4eyes_pending forensic audit emitted');
SELECT throws_like(format($$SELECT public.reprisal_approve_forensic(%L::uuid)$$, (SELECT id FROM _p WHERE tag='pf1')),
  '%self_approve_denied%', 'Am.E: proposer cannot self-approve a forensic reveal');
-- certified member approves (co-chair proposer + certified approver = valid pair).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1","session_id":"11111111-1111-1111-1111-1111111111e1","role":"authenticated"}';
SELECT is(public.reprisal_approve_forensic((SELECT id FROM _p WHERE tag='pf1')),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000c1'::uuid),
  'Am.E: approval reveals the target audit row''s actor pseudonym (co-chair+certified pair)');
SELECT is((SELECT revealed_actor_pseudonym FROM public.pending_four_eyes_ops WHERE id=(SELECT id FROM _p WHERE tag='pf1')),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000c1'::uuid),
  'Am.E: revealed_actor_pseudonym persisted on the pending op');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='audit.forensic_reveal.4eyes_completed'),
  'Am.E: 4eyes_completed forensic audit emitted');

-- (32) Am.E expiry — a forensic op past its window is rejected on approve.
INSERT INTO public.pending_four_eyes_ops (id, kind, proposer_id, target_table, target_id, reveal_reason, expires_at)
  VALUES ('00000000-0000-0000-0000-0000000f0002', 'forensic_reveal', '00000000-0000-0000-0000-0000000000c1',
          'audit_log', (SELECT audit_id FROM _aud), 'stale', now() - interval '1 hour');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","session_id":"11111111-1111-1111-1111-1111111111c2","role":"authenticated"}';
SELECT throws_like($$SELECT public.reprisal_approve_forensic('00000000-0000-0000-0000-0000000f0002'::uuid)$$,
  '%expired%', 'Am.E: an expired forensic reveal cannot be approved');

-- (33)-(35) Amendment D feed.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns WHERE table_name='reprisal_feed' AND column_name='actor_pseudonym'$$,
  $$VALUES (0)$$, 'Am.D: reprisal_feed omits actor_pseudonym');
SELECT ok((SELECT bool_and((ts_bucketed_to_hour % 3600000) = 0) FROM public.reprisal_feed),
  'Am.D: feed timestamps are bucketed down to the hour');
SELECT results_eq(
  $$SELECT count(*)::int FROM public.reprisal_feed WHERE event_type LIKE 'audit.forensic_reveal.%'$$,
  $$VALUES (0)$$, 'Am.D: forensic-reveal events are NOT in the reprisal feed (reprisal.* only)');

-- (36) F-35 rate ceiling.
INSERT INTO public.reprisal_rate_log (actor_id, created_at)
  SELECT '00000000-0000-0000-0000-000000000a01', now() - (g || ' minutes')::interval FROM generate_series(1,20) g;
SELECT is(public.consume_reprisal_rate_budget('00000000-0000-0000-0000-000000000a01'), false,
  'F-35: 20 submits within the hour exhausts the hourly budget');

SELECT * FROM finish();
ROLLBACK;
