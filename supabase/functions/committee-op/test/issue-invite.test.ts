/**
 * committee-op / issue_invite op tests (Deno-native) — ADR-0029 P1-3.
 *
 * Run: `deno test supabase/functions/committee-op/test/issue-invite.test.ts`.
 *
 * Sibling to core.test.ts (the existing dispatch/error-mapping/forward suite).
 * That file remains UNTOUCHED; this one pins the NEW `issue_invite` op the
 * P1-3 implementer wires into committee-op (a new core fn `issueInvite` + a
 * new `Op` arm in index.ts) that delegates to the already-merged
 * `issue_member_invite(text[],text,integer)` SQL keystone (PR #311,
 * supabase/migrations/00000000000041_adr0029_phase1_keystone.sql).
 *
 * RED-FIRST: neither `issueInvite` (core) nor the `issue_invite` op arm
 * (index) exists on `main`. The imports below resolve only after P1-3 lands
 * — the failing reason at run time is "no exported member 'issueInvite'"
 * (the keystone EF wiring gap this test pins).
 *
 * Style matches committee-op/test/core.test.ts verbatim: Deno-native asserts,
 * a fakeRpc helper that records (fn, args), no remote import, offline-clean.
 *
 * Findings covered (threat-model §3.18):
 *   F-168 / F-173 — the co-chair gate + role validation live SQL-side
 *                   (`phase1_issue_invite_rls.sql`); HERE we pin the EF
 *                   delegates to that exact RPC with the args the keystone
 *                   expects, and that RAISE-message → reason mapping holds.
 *   F-175         — TOTP issuance/re-send abuse: the EF must NEVER round-trip
 *                   the raw 6-digit code through a log line (a leaked code
 *                   re-opens the unauthenticated redeem path within the 15-min
 *                   TOTP window). Pinned by the F-176 sweep below.
 *   F-176         — the raw 6-digit code, the raw TOTP (same value, the EF
 *                   issues it), and the response-body payload never reach
 *                   ANY structured log line / error body / log attribute.
 *                   (The s.10.1 trip-wire — see ADR-0029 Decision 8.)
 */

// RED-FIRST: P1-3 adds `issueInvite` to core.ts. The existing exports
// (inviteMember, setRoles, removeMember, mapRpcError, RpcPort, RpcError)
// stay as-is — we re-import them to prove this file does NOT regress the
// existing committee-op surface that core.test.ts pins.
import {
  inviteMember,
  issueInvite,
  mapRpcError,
  type RpcPort,
  type RpcError
} from '../core.ts';
import { log, type LogLine } from '../../_shared/log.ts';

// ---- tiny assert helpers (mirrors core.test.ts) -----------------------------
function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}
function assertStringAbsent(haystack: string, needle: string, where: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`${where}: forbidden secret "${needle}" leaked into: ${haystack}`);
  }
}

/** An RpcPort that returns a fixed result and records every call (fn + args). */
function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>
): RpcPort {
  return (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(result);
  };
}

// A canonical successful keystone response. The SQL fn (PR #311) returns ONE
// row: { invite_id, invitee_user_id, bootstrap_id }. supabase-js delivers the
// single-row RETURNING TABLE as the row object directly (matching how
// inviteMember reads its scalar result — see core.ts:112).
const SQL_OK_PAYLOAD = {
  invite_id: '00000000-0000-0000-0000-000000000a11',
  invitee_user_id: '00000000-0000-0000-0000-000000000b22',
  bootstrap_id: '00000000-0000-0000-0000-000000000c33'
};

// A fixed 6-digit code the test uses as the F-176 canary (assertions verify
// it never appears in any captured log line / error body).
const CANARY_CODE = '424242';

// ===========================================================================
// HAPPY PATH — dispatch + forwarding to the keystone RPC.
// ===========================================================================

Deno.test('issueInvite forwards the keystone RPC name + arg shape (issue_member_invite signature)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  const res = await issueInvite(rpc, {
    roles: ['worker_member'],
    code: CANARY_CODE,
    ttl_minutes: 10080
  });

  assert(res.ok, 'issueInvite happy path must return ok');
  // The keystone returns the three identifiers the co-chair needs; the core
  // surface forwards them verbatim (mirroring inviteMember which lifts the
  // scalar invite_id; here we lift the three-key object).
  assertEquals(res.data, SQL_OK_PAYLOAD);

  // Exactly one RPC call to the keystone fn.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.fn, 'issue_member_invite');
  // The args MUST match the keystone signature
  // (00000000000041:54-58, ADR-0029 "NEW hosted artifacts"):
  //   issue_member_invite(p_roles text[], p_totp_code text, p_ttl_minutes int)
  // Field names are pinned: anything else breaks the FK to the merged SQL.
  assertEquals(calls[0]?.args, {
    p_roles: ['worker_member'],
    p_totp_code: CANARY_CODE,
    p_ttl_minutes: 10080
  });
});

Deno.test('issueInvite forwards a multi-role array verbatim (F-173 facet i — 2nd co-chair invite)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  const res = await issueInvite(rpc, {
    roles: ['worker_member', 'worker_co_chair'],
    code: '535353',
    ttl_minutes: 10080
  });

  assert(res.ok);
  // The role array MUST be forwarded verbatim (the SQL `_committee_norm_roles`
  // normalizer takes it from here; the EF MUST NOT pre-sort / pre-dedupe).
  assertEquals(calls[0]?.args.p_roles, ['worker_member', 'worker_co_chair']);
});

Deno.test('issueInvite does NOT touch committee_invite_member directly (delegation lives in the SQL keystone)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  await issueInvite(rpc, { roles: ['worker_member'], code: CANARY_CODE, ttl_minutes: 10080 });

  // The bootstrap_id / TTL linkage is wired SQL-side
  // (issue_member_invite → committee_invite_member with named params); the
  // EF MUST NOT double-call committee_invite_member, else we re-open the
  // ADR-0029 GAP the keystone closes (and would produce orphan rows).
  for (const c of calls) {
    if (c.fn === 'committee_invite_member') {
      throw new Error(
        'issueInvite must NOT call committee_invite_member directly — the keystone delegates from SQL'
      );
    }
  }
});

// ===========================================================================
// ERROR MAPPING — the existing CommitteeReason set holds (no enum extension
// in P1-3; P1-3 only adds the new dispatch arm + new core fn).
// ===========================================================================

Deno.test('a non-co-chair issue (RAISE rls_denied / 42501) maps to rls_denied + 403', async () => {
  // The SQL keystone raises `rls_denied` with ERRCODE 42501 when
  // _committee_is_active_co_chair(auth.uid()) is false or session_is_live is
  // false (00000000000041:74-79). The EF must surface that as
  // {ok:false, reason:'rls_denied', status:403} — same shape as inviteMember.
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await issueInvite(rpc, {
    roles: ['worker_member'],
    code: CANARY_CODE,
    ttl_minutes: 10080
  });
  assertEquals(res, { ok: false, reason: 'rls_denied', status: 403 });
});

Deno.test('an invalid_role RAISE maps to invalid_role + 422 (F-173 — out-of-enum role rejected)', async () => {
  // The keystone raises `invalid_role` on an out-of-enum role array
  // (00000000000041:85-88). CommitteeReason.invalid_role → 422 (core.ts:67).
  const rpc = fakeRpc({ data: null, error: { code: 'P0001', message: 'invalid_role' } }, []);
  const res = await issueInvite(rpc, {
    roles: ['superuser'],
    code: CANARY_CODE,
    ttl_minutes: 10080
  });
  assertEquals(res, { ok: false, reason: 'invalid_role', status: 422 });
});

Deno.test('an invite_invalid RAISE maps to invite_invalid + 422', async () => {
  // The keystone (and the underlying committee_invite_member) can surface
  // invite_invalid in defensive paths; the existing reason set covers it.
  const rpc = fakeRpc({ data: null, error: { code: 'P0001', message: 'invite_invalid' } }, []);
  const res = await issueInvite(rpc, {
    roles: ['worker_member'],
    code: CANARY_CODE,
    ttl_minutes: 10080
  });
  assertEquals(res, { ok: false, reason: 'invite_invalid', status: 422 });
});

Deno.test('a 23514 CHECK violation (role enum) falls back to invalid_role + 422 (mapRpcError carry-forward)', async () => {
  // The role array CHECK on committee_invite_member's role validation
  // (00000000000002:237-240) surfaces 23514 if it ever fires before our
  // explicit RAISE — mapRpcError must keep its existing fallback so the
  // implementer can rely on it.
  assertEquals(
    mapRpcError({ code: '23514', message: 'new row violates check constraint' }),
    { reason: 'invalid_role', status: 422 }
  );
});

Deno.test('an unknown SQLSTATE (e.g. 08006 connection failure) maps to unknown + 400', async () => {
  // mapRpcError defaults to {unknown, 400} for any code/message it does not
  // recognise. The issueInvite path MUST inherit that fallback so a transient
  // failure does not get mis-classified as a security denial.
  const rpc = fakeRpc({ data: null, error: { code: '08006', message: 'connection failure' } }, []);
  const res = await issueInvite(rpc, {
    roles: ['worker_member'],
    code: CANARY_CODE,
    ttl_minutes: 10080
  });
  assertEquals(res, { ok: false, reason: 'unknown', status: 400 });
});

// ===========================================================================
// F-176 — the raw 6-digit code MUST NEVER reach a structured-log line
// emitted by the core. (The single-emission EF response body is allowed.)
//
// Capture the shared log sink (the canonical capture surface — see
// supabase/functions/redeem-invite/test/core.test.ts:338-368 for the pattern).
// ===========================================================================

Deno.test('F-176: the raw code NEVER appears in any log line on the happy path', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, []);
    await issueInvite(rpc, {
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_CODE, 'F-176 (raw code in log on happy path)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: the raw code NEVER appears in any log line on a denial branch (rls_denied)', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
    await issueInvite(rpc, {
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_CODE, 'F-176 (raw code in log on denial branch)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: the raw code NEVER appears in any log line on an unknown-SQLSTATE branch', async () => {
  // Sweep the cold/error branches too — an implementer that "logs the args
  // on error for debugging" would round-trip the code into Sentry/logs.
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: null, error: { code: '08006', message: 'connection failure' } }, []);
    await issueInvite(rpc, {
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_CODE, 'F-176 (raw code in log on unknown branch)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: a denial result body NEVER echoes the raw code back to the caller (normalized oracle)', async () => {
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await issueInvite(rpc, {
    roles: ['worker_member'],
    code: CANARY_CODE,
    ttl_minutes: 10080
  });
  const blob = JSON.stringify(res);
  assertStringAbsent(blob, CANARY_CODE, 'F-176 (raw code in returned OpResult body)');
});

// ===========================================================================
// DOES-NOT-REGRESS — the existing inviteMember surface still works exactly
// as core.test.ts pins it. (P1-3 must NOT change the back-compat low-level
// invite arm — ADR-0029 Decision 3 explicitly keeps it for reactivate-of-
// existing-user. core.test.ts already pins this; we repeat one assertion
// at the dispatch boundary so a refactor that breaks it shows up here too.)
// ===========================================================================

Deno.test('back-compat: the existing inviteMember surface still forwards committee_invite_member', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: 'invite-uuid-back-compat', error: null }, calls);
  const res = await inviteMember(rpc, { target_user_id: 'u1', roles: ['worker_member'] });
  assert(res.ok);
  assertEquals(calls[0]?.fn, 'committee_invite_member');
  // The back-compat arm does NOT collect a code or a ttl — those are the
  // new issue_invite arm's responsibility. If P1-3 widened inviteMember
  // to also carry a code, this assertion would fail and force the design
  // back to a separate fn (per ADR-0029 Decision 3).
  for (const k of Object.keys(calls[0]?.args ?? {})) {
    if (k === 'p_totp_code' || k === 'p_bootstrap_id') {
      throw new Error(
        `back-compat inviteMember must NOT thread ${k} — that belongs to issueInvite (Decision 3)`
      );
    }
  }
});
