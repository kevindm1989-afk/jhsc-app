/**
 * t07-op / get_member_pubkey op tests (Deno-native) — ADR-0029 P1-4 / P1-5
 * (the EF half of the co-chair pubkey-disclosure surface that pairs with
 * the new SQL `get_member_identity_pubkey_for_wrap` RPC).
 *
 * Run: `deno test supabase/functions/t07-op/test/get-member-pubkey.test.ts`.
 *
 * Sibling to core.test.ts (the existing dispatch / error-mapping / forward
 * suite). That file remains UNTOUCHED. This file pins the NEW `getMemberPubkey`
 * core fn + the new `get_member_pubkey` op-arm in index.ts that the P1-5
 * implementer wires up to delegate to the already-pgTAP-pinned SQL keystone
 * (supabase/test/phase1_get_pubkey_rls.sql).
 *
 * RED-FIRST: `getMemberPubkey` does NOT exist on `main` (the imports below
 * fail to resolve until P1-5 lands; "no exported member 'getMemberPubkey'").
 * Style matches t07-op/test/core.test.ts verbatim: Deno-native asserts, a
 * fakeRpc helper that records (fn, args), no remote import, offline-clean.
 *
 * Contract pinned here (mirrors get_member_identity_pubkey_for_wrap per
 * ADR-0029 Decision 4):
 *
 *   getMemberPubkey(rpc, { target_user_id }) →
 *     OpResult<{ public_key_hex: string; fingerprint: string }>
 *
 *   - Forwards `p_target_user_id` (NOT p_member_user_id — the SQL arg name
 *     in Decision 4 is `p_target_user_id`; pin this so a refactor that
 *     "harmonizes" arg names with wrap_member silently breaks the bind).
 *   - Calls the SQL fn name `get_member_identity_pubkey_for_wrap`.
 *   - Returns the row pubkey AS HEX (PostgREST bytea is `\x…`) and the
 *     fingerprint AS TEXT. The bytes come back through the same hex shim
 *     the existing get_key_wrap op uses (so the apps/web SupabaseT07Client
 *     reads them with pgHexToBytes the same way).
 *
 * NOTE — ambiguity flagged (see end-of-test report):
 *
 *   ADR-0029 leaves the OP NAME open between `get_member_pubkey` and
 *   `grant_member_key`. This file pins `get_member_pubkey` because:
 *   (1) Decision 5 splits disclosure (Decision 4) from the wrap call
 *       (the existing `wrap_member` op) — the EF op for Decision 4 is a
 *       READ, not a grant; a "grant_member_key" name would conflate the two.
 *   (2) The op names elsewhere on t07-op are verb-on-noun reads
 *       (get_recovery_blob, get_key_wrap, committee_key_state).
 *   If the orchestrator pins a different name on resolution, the
 *   implementer renames in ONE place (the dispatch arm + this test); the
 *   contract is otherwise unchanged.
 *
 * Findings covered (threat-model §3.18):
 *   F-174 — co-chair-gate + target-gate denials map to the SAME closed
 *           literal across the four uid-classes (the SQL-side normalized
 *           oracle, surfaced verbatim through mapRpcError).
 *   F-172 — the EF NEVER accepts a caller-supplied pubkey on the disclosure
 *           op (no `attacker_pubkey_hex` field; the server is the only source
 *           of pubkey bytes for the wrap composition).
 *   F-176 — the returned pubkey hex + fingerprint + target_user_id never
 *           appear in any structured-log line / log attribute / error body.
 */

// RED-FIRST: P1-5 adds `getMemberPubkey` to core.ts. The existing exports
// (mapRpcError, RpcPort, RpcError, OpStatus, OpResult, the T07Reason union)
// stay as-is — we re-import to prove this file does NOT regress core.test.ts.
import {
  getMemberPubkey,
  mapRpcError,
  type OpResult,
  type RpcError,
  type RpcPort,
  type T07Reason
} from '../core.ts';
import { log, type LogLine } from '../../_shared/log.ts';

// ---- tiny assert helpers (mirror core.test.ts) ------------------------------
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
    throw new Error(`${where}: forbidden value "${needle}" leaked into: ${haystack}`);
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

// A canonical successful response. The SQL fn returns TABLE(public_key bytea,
// fingerprint text) — supabase-js delivers the single row as an array of one
// object. The pubkey crosses the wire as PostgREST hex (`\x…`); the JS-side
// SupabaseT07Client converts to Uint8Array via pgHexToBytes in P1-5.
const TARGET_UID = '00000000-0000-0000-0000-0000000000b2';
const ACTOR_COCHAIR_UID = '00000000-0000-0000-0000-0000000000f1';
const TARGET_PUBKEY_HEX = '\\x' + 'b2'.repeat(32);
// The BLAKE2b-32 hex of the pubkey (the JS lib's pubkeyFingerprint format —
// 64 hex chars / 32 bytes). The exact value is opaque here; we only assert
// the field is forwarded verbatim. F-176 leak-sweep will check this string
// is never logged.
const TARGET_FINGERPRINT = 'beefcafe'.repeat(8); // 64 hex chars

const SQL_OK_PAYLOAD = [
  { public_key: TARGET_PUBKEY_HEX, fingerprint: TARGET_FINGERPRINT }
];

// ===========================================================================
// HAPPY PATH — dispatch + forwarding to the keystone RPC + return shape
// ===========================================================================

Deno.test('getMemberPubkey forwards to get_member_identity_pubkey_for_wrap with p_target_user_id', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  const res = await getMemberPubkey(rpc, { target_user_id: TARGET_UID });

  assert(res.ok, 'getMemberPubkey happy path must return ok');
  // The SQL fn name is pinned — a rename here breaks the FK to the
  // ADR-0029 SQL contract.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.fn, 'get_member_identity_pubkey_for_wrap');
  // The arg name is pinned — `p_target_user_id` (NOT `p_member_user_id`,
  // which is the wrap_member arg). A "harmonize" refactor that changes
  // either side without the other would silently fail at runtime.
  assertEquals(calls[0]?.args, { p_target_user_id: TARGET_UID });
});

Deno.test('getMemberPubkey returns {public_key_hex, fingerprint} (the wire shape the apps/web client consumes)', async () => {
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, []);
  const res = await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
  assert(res.ok);
  // The bytea crosses the wire as PostgREST hex; the EF preserves the hex
  // shape (SupabaseT07Client.getMemberPubkey converts to Uint8Array via
  // pgHexToBytes in P1-5 — same pattern as getCommitteeKeyWrapForSelf).
  // The field name is `public_key_hex`, mirroring `wrapped_ciphertext_hex`.
  assertEquals(res.data, {
    public_key_hex: TARGET_PUBKEY_HEX,
    fingerprint: TARGET_FINGERPRINT
  });
});

Deno.test('getMemberPubkey unwraps the SQL TABLE result (one row → one object, not array)', async () => {
  // The SQL fn returns TABLE(...). supabase-js delivers it as array-of-1;
  // the core fn unwraps to a single object (mirrors getCommitteeKeyWrapForSelf
  // at core.ts:388-401). If the EF leaks the array shape through, the client
  // would .data[0]?.public_key everywhere — a contract drift this test pins.
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, []);
  const res = await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
  assert(res.ok);
  // Negative shape: the returned value is NOT an array.
  assert(!Array.isArray(res.data), 'returned data must NOT be the raw TABLE array');
});

// ===========================================================================
// F-174 — error mapping for the SQL-side denial set
// ===========================================================================

Deno.test('F-174 / co-chair gate: rls_denied (42501) maps to rls_denied + 403', async () => {
  // The SQL keystone raises `rls_denied` with ERRCODE 42501 when the caller
  // is not a co-chair, session is dead, or auth is missing. mapRpcError
  // (core.ts:110-162) surfaces 42501→rls_denied / 403 verbatim.
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
  assert(!res.ok);
  assertEquals(res.reason, 'rls_denied');
  assertEquals(res.status, 403);
});

Deno.test('F-174 / target gate: target_not_member / not_found / member_not_enrolled map to a closed-literal denial (NOT a 5xx)', async () => {
  // ADR-0029 leaves the exact literal open (target_not_member per Decision 4
  // // F-174, or not_found per Decision 5's `member_not_enrolled` fallback —
  // see the pgTAP companion's (15) assertion). The EF must surface ANY of
  // them as a CLIENT-side mappable typed failure (404 or 422), NEVER as a
  // 5xx (which would leak that the target uid is "interestingly" wrong).
  //
  // We assert mapRpcError's contract: for the three pinned literals it must
  // produce a non-`unknown` reason at status 404 or 422 — never `unknown`
  // and never 500.
  for (const literal of ['target_not_member', 'not_found', 'member_not_enrolled']) {
    const mapped = mapRpcError({ code: 'P0001', message: literal });
    // Pinned: NEVER unknown / 400 — the implementer MUST add a closed
    // mapping for whichever literal the SQL ratifies. (The current
    // mapRpcError already maps `not_found` to not_found/404; the other two
    // need to be added at P1-5 — the assertion fails red until then.)
    assert(
      mapped.reason !== 'unknown',
      `F-174 literal ${literal} must map to a closed-set T07Reason (not 'unknown'), got: ${mapped.reason}`
    );
    assert(
      mapped.status === 404 || mapped.status === 422,
      `F-174 literal ${literal} must map to 404 or 422 (a client-mappable typed denial), got: ${mapped.status}`
    );
  }
});

Deno.test('F-174 / unknown SQLSTATE (08006 connection failure) maps to unknown + 400 (NOT a 5xx, NOT a silent ok)', async () => {
  // A transient infra failure must NEVER silently succeed (would leak the
  // empty "we didn't find anything" branch as a successful disclosure) and
  // must NEVER mis-classify as a security denial. The existing mapRpcError
  // fallback is the right contract.
  const rpc = fakeRpc({ data: null, error: { code: '08006', message: 'connection failure' } }, []);
  const res = await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
  assertEquals(res, { ok: false, reason: 'unknown', status: 400 });
});

// ===========================================================================
// F-172 — the disclosure op MUST NOT accept a caller-supplied pubkey
// ===========================================================================

Deno.test('F-172: the disclosure op accepts ONLY target_user_id (no caller-supplied pubkey field)', async () => {
  // The wrap-to-attacker-pubkey threat (F-172) rests on the server being the
  // ONLY source of the pubkey bytes that wrapMemberInViaProduction seals to.
  // If the EF op accepted a caller-supplied pubkey ("the co-chair already
  // has it, optimization"), a compromised co-chair client could substitute
  // an attacker pubkey. Pin structurally: the typescript Op definition
  // visible from the test surface MUST have NO pubkey/sealed/key field on
  // the disclosure op input. We assert via runtime behavior — if the EF
  // accepts and forwards a smuggled pubkey, that's a contract break.
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls);

  // Smuggle attacker fields into the input; the core fn MUST drop them.
  await getMemberPubkey(
    rpc,
    // deno-lint-ignore no-explicit-any
    {
      target_user_id: TARGET_UID,
      // Each of these would be a F-172 violation if the EF forwarded them.
      attacker_pubkey_hex: '\\x' + 'aa'.repeat(32),
      public_key_hex: '\\x' + 'aa'.repeat(32),
      wrapped_ciphertext_hex: '\\x' + 'aa'.repeat(64),
      pubkey: '\\x' + 'aa'.repeat(32)
    } as any
  );

  // The forwarded RPC args MUST NOT carry any pubkey/sealed field — the
  // SQL fn signature is single-arg (uuid), and the EF MUST forward only
  // p_target_user_id.
  const args = calls[0]?.args ?? {};
  for (const k of Object.keys(args)) {
    assert(
      !/pub.?key|sealed|cipher|wrap/i.test(k),
      `F-172: disclosure op MUST NOT forward any pubkey/sealed/cipher/wrap field (got: ${k})`
    );
  }
  // And the only key present is p_target_user_id.
  assertEquals(Object.keys(args).sort(), ['p_target_user_id']);
});

// ===========================================================================
// F-176 — leak sweep: target_user_id + returned pubkey hex + fingerprint
// MUST NEVER appear in any structured-log line / log attribute / error body.
// ===========================================================================

Deno.test('F-176: the target_user_id NEVER appears in a log line on the happy path', async () => {
  // The target uid is not a "secret" per se but IS a re-identification aid
  // (F-174 deanonymization vector). The reason-only logging posture
  // (precedent: bootstrap-first-co-chair, committee-op/issue-invite) means
  // operators see the OP NAME + outcome, not the uid. A leaked uid in logs
  // would let log-readers reconstruct the uid↔(pubkey-was-disclosed) edge
  // without the audit trail's pseudonymization.
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, []);
    await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, TARGET_UID, 'F-176 (target_user_id in log on happy path)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: the returned pubkey hex NEVER appears in a log line on the happy path', async () => {
  // The pubkey is pseudonymous but logging it would re-leak the disclosure
  // into the operator's log surface (the audit row deliberately carries NO
  // pubkey bytes — pgTAP F-174 assertion 12). A core fn that "logs the
  // result for debugging" would defeat the design.
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, []);
    await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
    const blob = JSON.stringify(captured);
    // The PostgREST hex form …
    assertStringAbsent(blob, TARGET_PUBKEY_HEX, 'F-176 (pubkey hex in log on happy path)');
    // … and the underlying byte-repeat pattern (a permissive search so any
    // re-encoding of the same bytes also fails).
    assertStringAbsent(blob, 'b2'.repeat(32), 'F-176 (pubkey raw hex in log on happy path)');
    // The fingerprint too (the JS lib's BLAKE2b-32 hex — another identifier
    // that pins the disclosed member's identity).
    assertStringAbsent(blob, TARGET_FINGERPRINT, 'F-176 (pubkey fingerprint in log on happy path)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: the target_user_id NEVER appears in a log line on a denial branch (rls_denied)', async () => {
  // Sweep the cold/error branches — a "log the args on error for forensics"
  // implementer would round-trip the uid into Sentry/logs (the EXACT defect
  // the bootstrap/issue-invite pattern exists to prevent).
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
    await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
    const blob = JSON.stringify(captured);
    assertStringAbsent(blob, TARGET_UID, 'F-176 (target_user_id in log on rls_denied branch)');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: a denial result body NEVER echoes target/pubkey/fingerprint back (closed reason+status only)', async () => {
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await getMemberPubkey(rpc, { target_user_id: TARGET_UID });
  const blob = JSON.stringify(res);
  assertStringAbsent(blob, TARGET_UID, 'F-176 (target_user_id in returned OpResult)');
  assertStringAbsent(blob, TARGET_PUBKEY_HEX, 'F-176 (pubkey hex in returned OpResult)');
  assertStringAbsent(blob, TARGET_FINGERPRINT, 'F-176 (fingerprint in returned OpResult)');
});

// ===========================================================================
// CARRY-FORWARD — the existing wrap_member surface still pins F-172's audit
// + bind contract. (We only spot-check the dispatch boundary here; the
// detailed checks live in core.test.ts at the existing wrap_member test.)
// ===========================================================================

Deno.test('CARRY-FORWARD: getMemberPubkey is DISTINCT from wrapCommitteeDataKeyForMember (no merging in P1-5)', async () => {
  // ADR-0029 Decision 4 explicitly REJECTS folding the disclosure into a
  // single grant op (Rejected (c): "the co-chair needs the pubkey BEFORE
  // they can compute the sealed ciphertext"). The two ops MUST stay
  // distinct: a P1-5 PR that "simplifies" by merging would re-open the
  // F-172 wrap-to-attacker-pubkey vector (the client could skip the
  // disclosure read and supply its own pubkey to a combined op).
  //
  // Structural pin: getMemberPubkey is exported AND its forward RPC name
  // is distinct from wrap_committee_data_key_for_member.
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await getMemberPubkey(
    fakeRpc({ data: SQL_OK_PAYLOAD, error: null }, calls),
    { target_user_id: TARGET_UID }
  );
  assertEquals(calls[0]?.fn, 'get_member_identity_pubkey_for_wrap');
  // Sanity: it is NOT calling the wrap fn.
  assert(
    calls[0]?.fn !== 'wrap_committee_data_key_for_member',
    'F-172 / Decision 4 Rejected (c): the disclosure op MUST NOT call wrap_committee_data_key_for_member'
  );
});

// ===========================================================================
// mapRpcError extension — P1-5 may need to teach mapRpcError about the new
// closed literal (target_not_member / member_not_enrolled). The existing
// 'not_found' literal already round-trips; if the implementer adds a new
// literal it MUST extend MESSAGE_LITERALS + the T07Reason union + the STATUS
// table — same six-mirror discipline as the audit-log enum (the closed-set
// invariant: nothing maps to 'unknown' for a SQL-defined denial literal).
// ===========================================================================

Deno.test('mapRpcError: any newly-pinned P1-4 denial literal lands in the closed reason set (not unknown)', () => {
  // ADR-0029 has not yet pinned the exact literal. Whichever the
  // migration-handler picks, mapRpcError MUST learn it: an `unknown` here
  // means a client got a 400 with no actionable reason for a deliberate
  // server denial. Closed-set discipline is the test.
  for (const literal of ['target_not_member', 'member_not_enrolled']) {
    const r = mapRpcError({ code: 'P0001', message: literal });
    // If the literal is intentionally folded into 'not_found' / 'invalid_input',
    // that is acceptable — both are non-`unknown` closed reasons. The only
    // failure mode is `unknown`.
    assert(
      r.reason !== 'unknown',
      `P1-5 contract: mapRpcError must map the F-174 literal "${literal}" to a closed T07Reason (not 'unknown')`
    );
  }
});

// ===========================================================================
// METHOD / DISPATCH carry-forward — the existing t07-op gate stack
// (method-not-allowed → key-parity → auth bearer → session_is_live → dispatch)
// is enforced by index.ts (NOT core.ts). We do NOT re-test those here;
// core.test.ts pins the dispatch boundary, and the gate stack is the same
// for every op (this op MUST not opt out of any of them — flagged for the
// P1-5 implementer to thread the new op-arm INTO the existing dispatch,
// NOT around it).
// ===========================================================================
