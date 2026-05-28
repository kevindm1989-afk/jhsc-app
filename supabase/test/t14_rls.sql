-- ===========================================================================
-- T14.1 — pgTAP: work_refusal + s51_evidence RLS + audited reads + feed.
--   F-21  certified_member-only INSERT/UPDATE; certified-or-cochair read via the
--         SECURITY DEFINER read fn (co-chair reads, cannot write)
--   F-17  actor_id always recorded (statutory filer)
--   HG-6  *_read audits BEFORE returning ciphertext; wrong per-record passphrase
--         emits sensitive.access_attempt + no ciphertext (G-T14-5/10)
--   F-31  *_update emits *.update with prev_field_hashes
--   Am.D  work_refusal.* / s51_evidence.* events join the pseudonymized feed
--   shared c4_read_service holds the C4 read EXECUTE (HG-6)
-- Run: pg_prove -d <db> supabase/test/t14_rls.sql  (migrations 0-6 + shim).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(30);

-- Actors: a certified member (write+read), a co-chair (read-only), a plain
-- member (neither), a non-member.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000e1', true),
  ('00000000-0000-0000-0000-0000000000c1', true),
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000b1', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', ARRAY['certified_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000c1', ARRAY['worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111e1', '00000000-0000-0000-0000-0000000000e1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c1', '00000000-0000-0000-0000-0000000000c1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b1', '00000000-0000-0000-0000-0000000000b1', now() + interval '5 min');

-- (1)-(6) table protections.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='work_refusal'), 'work_refusal RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='s51_evidence'), 's51_evidence RLS enabled');
SELECT results_eq($$SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_name='work_refusal' AND grantee IN ('authenticated','anon') AND privilege_type IN ('INSERT','UPDATE','DELETE')$$, $$VALUES (0)$$, 'work_refusal write grants empty');
SELECT results_eq($$SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_name='work_refusal' AND grantee IN ('authenticated','anon') AND privilege_type='SELECT'$$, $$VALUES (0)$$, 'work_refusal direct SELECT denied (HG-6)');
SELECT results_eq($$SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_name='s51_evidence' AND grantee IN ('authenticated','anon') AND privilege_type IN ('INSERT','UPDATE','DELETE')$$, $$VALUES (0)$$, 's51_evidence write grants empty');
SELECT results_eq($$SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_name='s51_evidence' AND grantee IN ('authenticated','anon') AND privilege_type='SELECT'$$, $$VALUES (0)$$, 's51_evidence direct SELECT denied (HG-6)');

-- (7)-(10) F-21 predicates.
SELECT ok(public.is_certified_member('00000000-0000-0000-0000-0000000000e1'), 'is_certified_member true for certified');
SELECT ok(NOT public.is_certified_member('00000000-0000-0000-0000-0000000000c1'), 'is_certified_member false for a co-chair (not certified)');
SELECT ok(public.is_certified_or_cochair('00000000-0000-0000-0000-0000000000c1'), 'is_certified_or_cochair true for a co-chair');
SELECT ok(NOT public.is_certified_or_cochair('00000000-0000-0000-0000-0000000000a1'), 'is_certified_or_cochair false for a plain member');

-- Act as the certified member.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1","session_id":"11111111-1111-1111-1111-1111111111e1","role":"authenticated"}';

-- (11)-(16) submit.
CREATE TEMP TABLE _w AS SELECT public.work_refusal_submit('\x71'::bytea, '\xBEEF'::bytea, 'w-pass') AS id;
SELECT isnt((SELECT id FROM _w), NULL, 'work_refusal_submit returns an id');
SELECT is((SELECT actor_id FROM public.work_refusal WHERE id=(SELECT id FROM _w)), '00000000-0000-0000-0000-0000000000e1'::uuid, 'F-17: work_refusal actor_id is the filer');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='work_refusal.created' AND target_id=(SELECT id FROM _w)), 'work_refusal.created audit emitted');
CREATE TEMP TABLE _s AS SELECT public.s51_evidence_submit('\x51'::bytea, '\xCAFE'::bytea, ARRAY['\xAA'::bytea,'\xBB'::bytea], 's-pass') AS id;
SELECT isnt((SELECT id FROM _s), NULL, 's51_evidence_submit returns an id');
SELECT is((SELECT array_length(photos_ct,1) FROM public.s51_evidence WHERE id=(SELECT id FROM _s)), 2, 's51 stores both sealed photos');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='s51_evidence.created' AND target_id=(SELECT id FROM _s)), 's51_evidence.created audit emitted');

-- (17)-(18) F-21 write denial (co-chair + plain member cannot write).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
SELECT throws_like($$SELECT public.work_refusal_submit('\x01'::bytea,'\x02'::bytea,NULL)$$, '%rls_denied%', 'F-21: a co-chair cannot file a work refusal (write is certified-only)');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT throws_like($$SELECT public.work_refusal_submit('\x01'::bytea,'\x02'::bytea,NULL)$$, '%rls_denied%', 'F-21: a plain member cannot file a work refusal');

-- (19)-(25) HG-6 read. Co-chair reads (F-21 read); plain member denied.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
SELECT is((SELECT notes_ct FROM public.work_refusal_read((SELECT id FROM _w),'w-pass')), '\xBEEF'::bytea, 'HG-6: a co-chair reads the work_refusal ciphertext');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='work_refusal.read' AND target_id=(SELECT id FROM _w)), 'HG-6: work_refusal.read audit emitted');
SELECT is((SELECT count(*)::int FROM public.work_refusal_read((SELECT id FROM _w),'wrong')), 0, 'wrong passphrase returns no ciphertext');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='sensitive.access_attempt' AND target_id=(SELECT id FROM _w)), 'wrong passphrase emits sensitive.access_attempt');
SELECT is((SELECT array_length(photos_ct,1) FROM public.s51_evidence_read((SELECT id FROM _s),'s-pass')), 2, 'HG-6: s51 read returns both sealed photos');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='s51_evidence.read' AND target_id=(SELECT id FROM _s)), 'HG-6: s51_evidence.read audit emitted');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT throws_like(format($$SELECT public.work_refusal_read(%L::uuid,'w-pass')$$, (SELECT id FROM _w)), '%rls_denied%', 'F-21: a plain member cannot read work_refusal');

-- (26)-(27) F-31 update (certified writes; co-chair denied).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e1","session_id":"11111111-1111-1111-1111-1111111111e1","role":"authenticated"}';
SELECT lives_ok(format($$SELECT public.work_refusal_update(%L::uuid, NULL, '\xD00D'::bytea)$$, (SELECT id FROM _w)), 'work_refusal_update by a certified member');
SELECT is((SELECT meta->'prev_field_hashes'->>'notes_ct' FROM public.audit_log WHERE event_type='work_refusal.update' AND target_id=(SELECT id FROM _w)), encode(digest('\xBEEF'::bytea,'sha256'),'hex'), 'F-31: work_refusal.update prev_field_hashes.notes_ct is the prior SHA-256');

-- (28) grant: the shared c4_read_service holds the C4 read EXECUTE.
SELECT ok(has_function_privilege('c4_read_service', 'public.work_refusal_read(uuid, text)', 'EXECUTE'), 'c4_read_service may execute work_refusal_read (HG-6 shared role)');

-- (29)-(30) Amendment D feed extension.
SELECT cmp_ok((SELECT count(*)::int FROM public.reprisal_feed WHERE event_type LIKE 'work_refusal.%'), '>=', 1, 'Am.D: work_refusal.* events appear in the pseudonymized feed');
SELECT cmp_ok((SELECT count(*)::int FROM public.reprisal_feed WHERE event_type LIKE 's51_evidence.%'), '>=', 1, 'Am.D: s51_evidence.* events appear in the pseudonymized feed');

SELECT * FROM finish();
ROLLBACK;
