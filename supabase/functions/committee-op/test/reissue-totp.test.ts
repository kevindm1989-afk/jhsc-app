/**
 * committee-op / reissue_totp op tests (Deno-native) — ADR-0029 P1-6.
 *
 * Run: `deno test supabase/functions/committee-op/test/reissue-totp.test.ts`.
 *
 * Sibling to issue-invite.test.ts (the P1-3 dispatch/error-mapping/leak suite).
 * That file remains UNTOUCHED; this one pins the NEW `reissue_totp` op the P1-6
 * implementer wires into committee-op (a new core fn `reissueTotp` + a new `Op`
 * arm in index.ts) that delegates to the to-be-merged SQL fn
 * `reissue_member_totp(p_invite_id uuid, p_totp_code text)` (ADR-0029 "NEW
 * hosted artifacts", line 9805 / supabase/test/phase1_reissue_totp_rls.sql).
 *
 * "Re-send code" reissues a FRESH 15-min TOTP against an EXISTING, still-
 * unconsumed invite (the TOTP expires long before the 7-day invite TTL). Like
 * `issue_invite`, the EF generates the cryptographically-random 6-digit code,
 * forwards it to the RPC (which HMACs it at rest), and returns it to the
 * co-chair's browser ONCE for out-of-band conveyance — NEVER logged/persisted
 * (F-176 / Decision 8).
 *
 * RED-FIRST: neither `reissueTotp` (core) nor the `reissue_totp` op arm (index)
 * exists on `main`. The imports below resolve only after P1-6 lands — the
 * failing reason at run time is "no exported member 'reissueTotp'" (the EF
 * wiring gap this test pins).
 *
 * Style matches committee-op/test/issue-invite.test.ts verbatim: Deno-native
 * asserts, a fakeRpc helper that records (fn, args), no remote import.
 *
 * Findings covered (threat-model §3.18):
 *   F-175 — TOTP issuance/re-send abuse: the EF must forward the SAME RPC name
 *           + arg shape the SQL gate expects (co-chair-gate + cap-of-1 +
 *           old-code-dies live SQL-side, phase1_reissue_totp_rls.sql); HERE we
 *           pin the EF delegates correctly + the RAISE-message -> reason
 *           mapping holds (rls_denied for non-co-chair; invite_invalid for a
 *           consumed/expired invite).
 *   F-176 — the raw 6-digit re-send code, AND the response-body payload, NEVER
 *           reach ANY structured-log line / log attribute / error body the core
 *           emits. The single response-body emission to the co-chair is allowed;
 *           every log / error surface is swept. (The s.10.1 trip-wire.)
 */

// RED-FIRST: P1-6 adds `reissueTotp` to core.ts. The existing exports stay
// as-is — we re-import a couple to prove this file does NOT regress the
// committee-op surface that core.test.ts / issue-invite.test.ts pin.
import {
  issueInvite,
  mapRpcError,
  reissueTotp,
  type RpcError,
  type RpcPort,
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
    throw new Error(`${where}: forbidden secret "${needle}" leaked into: ${haystack}`);
  }
}

/** An RpcPort that returns a fixed result and records every call (fn + args). */
function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>,
): RpcPort {
  return (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(result);
  };
}

// The invite a co-chair re-sends against (an opaque id; never the code).
const INVITE_ID = '00000000-0000-0000-0000-000000000a11';

// A canonical successful re-send response. The SQL fn returns the identifiers
// the co-chair needs to convey the fresh code out-of-band. ADR-0029 P1-6 does
// NOT pin the RETURNS column names (CONTRACT-AMBIGUITY-3, flagged in the report):
// the brief's working shape is {invite_id, bootstrap_id} (the new bootstrap),
// mirroring issue_invite's {invite_id, invitee_user_id, bootstrap_id}. If the
// implementer pins a different shape, reconcile it HERE — do not relax the
// forwarding/leak assertions, which are independent of the payload shape.
const SQL_OK_PAYLOAD = {
  invite_id: INVITE_ID,
  bootstrap_id: '00000000-0000-0000-0000-000000000c33',
};

// A fixed 6-digit code the test uses as the F-176 canary (assertions verify it
// never appears in any captured log line / error body).
const CANARY_CODE = '424242';

// ===========================================================================
// HAPPY PATH — dispatch + forwarding to the reissue RPC.
// ===========================================================================

Deno.test('reissueTotp forwards the reissue RPC name + arg shape (reissue_member_totp signature)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  const res = await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });

  assert(res.ok, 'reissueTotp happy path must return ok');
  assertEquals(res.data, SQL_OK_PAYLOAD);

  // Exactly one RPC call to the reissue fn.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.fn, 'reissue_member_totp');
  // The args MUST match the SQL signature (ADR-0029 line 9805):
  //   reissue_member_totp(p_invite_id uuid, p_totp_code text)
  // Field names are pinned; anything else breaks the FK to the merged SQL.
  assertEquals(calls[0]?.args, {
    p_invite_id: INVITE_ID,
    p_totp_code: CANARY_CODE,
  });
});

Deno.test('reissueTotp does NOT re-issue the invite / user (no issue_member_invite or committee_invite_member call)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });

  // Re-send swaps ONLY the bootstrap (phase1_reissue_totp_rls.sql) — the EF
  // MUST NOT also call the user/invite producers, else it would create a new
  // user / new invite (re-opening the count-invariance contract P1-6 closes).
  for (const c of calls) {
    if (c.fn === 'issue_member_invite' || c.fn === 'committee_invite_member') {
      throw new Error(
        `reissueTotp must NOT call ${c.fn} — re-send swaps only the bootstrap (P1-6)`,
      );
    }
  }
});

// ===========================================================================
// ERROR MAPPING — the existing CommitteeReason set holds (P1-6 adds only the
// new dispatch arm + new core fn; no enum extension).
// ===========================================================================

Deno.test('a non-co-chair re-send (RAISE rls_denied / 42501) maps to rls_denied + 403', async () => {
  // The SQL gate raises `rls_denied` (ERRCODE 42501) when the caller is not an
  // active co-chair or the session is not live (mirrors issue_member_invite,
  // 00000000000041:74-79). The EF surfaces {ok:false, reason:'rls_denied', 403}.
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
  assertEquals(res, { ok: false, reason: 'rls_denied', status: 403 });
});

Deno.test('a consumed/expired invite (RAISE invite_invalid) maps to invite_invalid + 422 (closed oracle)', async () => {
  // AMBIGUITY-1 (see phase1_reissue_totp_rls.sql header): re-send against a
  // consumed/expired/non-existent invite raises the SAME normalized literal the
  // keystone uses — `invite_invalid` (00000000000041:186-189). The existing
  // CommitteeReason set already maps invite_invalid -> 422 (core.ts:68).
  const rpc = fakeRpc({ data: null, error: { code: 'P0001', message: 'invite_invalid' } }, []);
  const res = await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
  assertEquals(res, { ok: false, reason: 'invite_invalid', status: 422 });
});

Deno.test('an unknown SQLSTATE (e.g. 08006 connection failure) maps to unknown + 400', async () => {
  // mapRpcError defaults to {unknown, 400} for any code/message it does not
  // recognise. reissueTotp MUST inherit that fallback so a transient failure is
  // not mis-classified as a security denial.
  const rpc = fakeRpc({ data: null, error: { code: '08006', message: 'connection failure' } }, []);
  const res = await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
  assertEquals(res, { ok: false, reason: 'unknown', status: 400 });
});

Deno.test('reissueTotp inherits the shared mapRpcError 42501 -> rls_denied fallback (carry-forward)', () => {
  // The reissue path leans on the SAME mapper as every other committee op; a
  // refactor that special-cased reissue would surface here.
  assertEquals(
    mapRpcError({ code: '42501', message: 'insufficient_privilege' }),
    { reason: 'rls_denied', status: 403 },
  );
});

// ===========================================================================
// F-176 — the raw 6-digit re-send code MUST NEVER reach a structured-log line
// emitted by the core. (The single-emission EF response body is allowed.)
// Capture the shared log sink (the canonical surface — see issue-invite.test.ts).
// ===========================================================================

Deno.test('F-176: the raw re-send code NEVER appears in any log line on the happy path', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, []);
    await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_CODE, 'F-176 (re-send code in log on happy path)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: the raw re-send code NEVER appears in any log line on a denial branch (rls_denied)', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
    await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_CODE, 'F-176 (re-send code in log on denial branch)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: the raw re-send code NEVER appears in any log line on an unknown-SQLSTATE branch', async () => {
  // Sweep the cold/error branches too — an implementer that "logs args on error
  // for debugging" would round-trip the code into Sentry/logs.
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: null, error: { code: '08006', message: 'connection failure' } }, []);
    await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, CANARY_CODE, 'F-176 (re-send code in log on unknown branch)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: a denial result body NEVER echoes the raw re-send code back to the caller', async () => {
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await reissueTotp(rpc, { invite_id: INVITE_ID, code: CANARY_CODE });
  const blob = JSON.stringify(res);
  assertStringAbsent(blob, CANARY_CODE, 'F-176 (re-send code in returned OpResult body)');
});

// ===========================================================================
// DOES-NOT-REGRESS — the existing issueInvite surface (P1-3) still forwards
// `issue_member_invite`. P1-6 must add a SIBLING op, not change issue_invite.
// ===========================================================================

Deno.test('back-compat: the existing issueInvite surface still forwards issue_member_invite', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({
    data: {
      invite_id: INVITE_ID,
      invitee_user_id: '00000000-0000-0000-0000-000000000b22',
      bootstrap_id: '00000000-0000-0000-0000-000000000c33',
    },
    error: null,
  }, calls);
  const res = await issueInvite(rpc, { roles: ['worker_member'], code: '535353', ttl_minutes: 10080 });
  assert(res.ok);
  assertEquals(calls[0]?.fn, 'issue_member_invite');
  // issueInvite carries a ttl_minutes (it creates the 7-day invite); reissue
  // does NOT (it only re-arms the 15-min TOTP against an existing invite). If
  // P1-6 widened issueInvite to share a path with reissue, this would fail.
  assert('p_ttl_minutes' in (calls[0]?.args ?? {}), 'issueInvite must still thread p_ttl_minutes');
});
