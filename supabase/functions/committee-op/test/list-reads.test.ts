/**
 * committee-op / list_roster + list_pending_invites ops (Deno-native) —
 * ADR-0029 P1-8a (Amendment A-8.3).
 *
 * Run: `deno test supabase/functions/committee-op/test/list-reads.test.ts`.
 *
 * Sibling to issue-invite.test.ts / core.test.ts (both UNTOUCHED). This file
 * pins the TWO NEW co-chair-gated READ arms P1-8a wires into committee-op:
 *   - `listRoster(rpc)`         → RPC `committee_roster_list`         (B1, A-8.1)
 *   - `listPendingInvites(rpc)` → RPC `committee_invite_list_pending` (B2, A-8.2)
 * Both underlying RPCs are SETOF, so the core surface returns an ARRAY on `data`
 * (contrast the scalar/single-row ops). The two `Op` union entries + dispatch
 * cases (index.ts) ride the EXISTING serve handler unchanged — method-not-
 * allowed / key-parity / session-live prechecks are pre-dispatch infra covered
 * by the existing committee-op suite; per A-8.3 P1-8a adds NO new EF-level
 * gate, only the two arms. Mirroring issue-invite.test.ts, this file pins the
 * arm at the CORE level (the testable heart the handler composes).
 *
 * RED-FIRST: neither `listRoster` nor `listPendingInvites` exists on `main`
 * (core.ts today exports inviteMember / issueInvite / reissueTotp / setRoles /
 * removeMember / reactivateMember / activateMembership / mapRpcError). The
 * import below fails to resolve until P1-8a lands — the intended red
 * ("no exported member 'listRoster'").
 *
 * Style matches issue-invite.test.ts verbatim: Deno-native asserts, a fakeRpc
 * that records (fn, args), no remote import, offline-clean, no real clock/RNG.
 *
 * Findings covered (threat-model §3.18):
 *   F-178 — the roster/pending-invite read is co-chair-gated SQL-side
 *           (phase1_roster_list_rls.sql). HERE we pin the EF core forwards to
 *           the EXACT RPC name with NO args (both reads are parameterless), maps
 *           the SQL RAISE `rls_denied`→403, and passes the SETOF through as an
 *           array WITHOUT reshaping.
 *   F-176 — no member PI (display_name / off_employer_contact) and no raw uid
 *           ever reaches a structured-log line emitted by the core (the EF logs
 *           route + outcome ONLY). Swept on happy + denial + unknown branches.
 */

// RED-FIRST: P1-8a adds `listRoster` + `listPendingInvites` to core.ts. The
// existing exports stay as-is; we re-import mapRpcError to prove this file does
// NOT regress the shared error-mapping surface.
import {
  listPendingInvites,
  listRoster,
  mapRpcError,
  type RpcError,
  type RpcPort
} from '../core.ts';
import { log, type LogLine } from '../../_shared/log.ts';

// ---- tiny assert helpers (mirrors issue-invite.test.ts) ---------------------
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
    throw new Error(`${where}: forbidden PI "${needle}" leaked into: ${haystack}`);
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

// The PI canaries — the roster projects users.display_name /
// users.off_employer_contact (PI) + the RAW user_id (A-8.1). None of these may
// reach a log line. Values are synthetic (no real PI in fixtures).
const CANARY_DISPLAY_NAME = 'Nadia Privacy';
const CANARY_EMPLOYER_CONTACT = 'nadia@home.example';
const CANARY_UID = '00000000-0000-0000-0000-000000000a01';

// A canonical SETOF roster response (B1 shape — the 11 pinned columns).
const ROSTER_ROWS = [
  {
    user_id: CANARY_UID,
    roles: ['worker_member'],
    active: true,
    invited_at: '2026-01-01T00:00:00.000Z',
    activated_at: '2026-01-02T00:00:00.000Z',
    deactivated_at: null,
    grace_until: null,
    display_name: CANARY_DISPLAY_NAME,
    off_employer_contact: CANARY_EMPLOYER_CONTACT,
    has_identity_key: true,
    has_live_wrap: false
  }
];

// A canonical SETOF pending-invite response (B2 shape — the 6 pinned columns).
const PENDING_ROWS = [
  {
    invite_id: '00000000-0000-0000-0000-00000000a001',
    target_user_id: CANARY_UID,
    display_name: CANARY_DISPLAY_NAME,
    roles: ['worker_member'],
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-08T00:00:00.000Z'
  }
];

// ===========================================================================
// HAPPY PATH — dispatch + forwarding to the read RPCs (SETOF → array).
// ===========================================================================

Deno.test('listRoster forwards the committee_roster_list RPC with NO args (A-8.1/A-8.3)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: ROSTER_ROWS, error: null }, calls);

  const res = await listRoster(rpc);

  assert(res.ok, 'listRoster happy path must return ok');
  // SETOF passes through verbatim as an array — the core does NOT reshape rows.
  assertEquals(res.data, ROSTER_ROWS);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.fn, 'committee_roster_list');
  // The RPC is parameterless (co-chair identity comes from the JWT-bound
  // auth.uid(), not an argument) — the args object MUST be empty.
  assertEquals(calls[0]?.args, {});
});

Deno.test('listPendingInvites forwards the committee_invite_list_pending RPC with NO args (A-8.2/A-8.3)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: PENDING_ROWS, error: null }, calls);

  const res = await listPendingInvites(rpc);

  assert(res.ok, 'listPendingInvites happy path must return ok');
  assertEquals(res.data, PENDING_ROWS);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.fn, 'committee_invite_list_pending');
  assertEquals(calls[0]?.args, {});
});

Deno.test('listRoster passes an EMPTY SETOF through as [] (a genuinely-empty committee is 0 rows, not an error)', async () => {
  // F-178: RAISE-not-silent-empty is the SQL contract; the EF's job on the
  // SUCCESS path is to pass the (possibly empty) array through unchanged. An
  // empty array is a genuinely-empty committee, distinct from the rls_denied
  // RAISE a non-co-chair gets (asserted below).
  const rpc = fakeRpc({ data: [], error: null }, []);
  const res = await listRoster(rpc);
  assert(res.ok);
  assertEquals(res.data, []);
});

Deno.test('listPendingInvites passes an EMPTY SETOF through as []', async () => {
  const rpc = fakeRpc({ data: [], error: null }, []);
  const res = await listPendingInvites(rpc);
  assert(res.ok);
  assertEquals(res.data, []);
});

// ===========================================================================
// ERROR MAPPING — the existing CommitteeReason set holds (A-8.3 adds NO new
// reason for the reads; rls_denied→403 and unknown→400 are reused verbatim).
// ===========================================================================

Deno.test('a non-co-chair roster read (RAISE rls_denied / 42501) maps to rls_denied + 403', async () => {
  // committee_roster_list RAISEs `rls_denied` ERRCODE 42501 for a non-co-chair /
  // dead-session caller (A-8.1). The EF must surface {ok:false, reason:'rls_denied', status:403}.
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await listRoster(rpc);
  assertEquals(res, { ok: false, reason: 'rls_denied', status: 403 });
});

Deno.test('a non-co-chair pending-invite read maps to rls_denied + 403', async () => {
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await listPendingInvites(rpc);
  assertEquals(res, { ok: false, reason: 'rls_denied', status: 403 });
});

Deno.test('an unknown SQLSTATE (e.g. 08006 connection failure) maps to unknown + 400 for both reads', async () => {
  // A transient failure must NOT be mis-classified as a security denial; the
  // reads inherit mapRpcError's {unknown, 400} default.
  const e = { code: '08006', message: 'connection failure' };
  assertEquals(await listRoster(fakeRpc({ data: null, error: e }, [])), {
    ok: false,
    reason: 'unknown',
    status: 400
  });
  assertEquals(await listPendingInvites(fakeRpc({ data: null, error: e }, [])), {
    ok: false,
    reason: 'unknown',
    status: 400
  });
});

Deno.test('A-8.3: the reads need NO new CommitteeReason — mapRpcError still resolves rls_denied/unknown from the existing set', async () => {
  // Guard: if an implementer extended CommitteeReason for the reads, the two
  // reasons the reads actually use must STILL be the pre-existing literals.
  assertEquals(mapRpcError({ code: '42501', message: 'rls_denied' }), {
    reason: 'rls_denied',
    status: 403
  });
  assertEquals(mapRpcError({ code: '08006', message: 'connection failure' }), {
    reason: 'unknown',
    status: 400
  });
});

// ===========================================================================
// F-176 / F-178 — no member PI (display_name / off_employer_contact) and no raw
// uid ever reaches a structured-log line emitted by the core. The EF logs
// route + outcome ONLY. Capture the shared log sink and sweep every branch.
// ===========================================================================

Deno.test('F-176/F-178: roster PI + raw uid NEVER appear in any log line on the happy listRoster path', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    await listRoster(fakeRpc({ data: ROSTER_ROWS, error: null }, []));
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_DISPLAY_NAME, 'F-178 (display_name in log, happy)');
    assertStringAbsent(blob, CANARY_EMPLOYER_CONTACT, 'F-178 (off_employer_contact in log, happy)');
    assertStringAbsent(blob, CANARY_UID, 'F-178 (raw uid in log, happy)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176/F-178: pending-invite PI + uid NEVER appear in any log line on the happy listPendingInvites path', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    await listPendingInvites(fakeRpc({ data: PENDING_ROWS, error: null }, []));
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_DISPLAY_NAME, 'F-178 (display_name in log, pending happy)');
    assertStringAbsent(blob, CANARY_UID, 'F-178 (target uid in log, pending happy)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176/F-178: no PI leaks on a denial branch (rls_denied) for listRoster', async () => {
  // The denial body carries no PI, but sweep anyway — an implementer that
  // "logs the attempted read for debugging" would round-trip nothing sensitive
  // only if the core stays PI-free on the cold path too.
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    await listRoster(fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []));
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_DISPLAY_NAME, 'F-178 (display_name in log, denial)');
    assertStringAbsent(blob, CANARY_UID, 'F-178 (raw uid in log, denial)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176/F-178: a denial result body NEVER echoes roster PI back to the caller', async () => {
  const res = await listRoster(fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []));
  const blob = JSON.stringify(res);
  assertStringAbsent(blob, CANARY_DISPLAY_NAME, 'F-178 (display_name in returned OpResult)');
  assertStringAbsent(blob, CANARY_UID, 'F-178 (raw uid in returned OpResult)');
});
