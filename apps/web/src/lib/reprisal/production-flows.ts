/**
 * Reprisal production compositions (ADR-0028 Decision 3 / P2b-2 — the core
 * C4 reprisal E2EE workflow).
 *
 * Four high-level operations the /reprisal route drives end-to-end:
 *
 *   - submitReprisalViaProduction:
 *       probe-first guard → ensure holder populated (lazy unwrap; PR1 infra)
 *       → sealUtf8 title + body → POST submit → typed discriminated-union
 *       result. Reprisal has NO anonymous mode (F-17 / ADR-0028 Findings):
 *       the author is ALWAYS recorded server-side from auth.uid(); there is
 *       no source-name seal. The per-record `intake.passphrase` is the F-164
 *       FRICTION gate — forwarded VERBATIM to the wire, NEVER a decrypt key,
 *       NEVER logged (F-161).
 *
 *   - readReprisalViaProduction (the LOAD-BEARING composition):
 *       probe-first → ensure holder populated → AWAIT the read RPC (the SERVER
 *       emits `reprisal.read` BEFORE returning ciphertext — F-165 audit-before-
 *       decrypt) → ONLY THEN openUtf8 title/body under the cached key. The wire
 *       collapses wrong-passphrase AND not-found to `data:null`; a null read is
 *       a single typed `unavailable` and the decrypt path is NEVER entered
 *       (never-decrypt-on-null, F-165). A null is NOT an invented
 *       `invalid_passphrase` — the wire cannot substantiate that.
 *
 *   - updateReprisalViaProduction:
 *       probe-first → ensure holder populated → seal only the provided
 *       field(s) → POST update → typed result. NULL field = unchanged.
 *
 *   - listReprisalFeedViaProduction (F-166 / C3 trivial):
 *       reads the ALREADY-pseudonymized `reprisal_feed` view — NO actor, NO
 *       ciphertext, ts bucketed to the hour. So it does NOT run the probe, does
 *       NOT hold a key, NEVER touches the disclosure RPC, NEVER openUtf8s. It
 *       accepts-and-ignores the holder/t07/localIdentity args so the route can
 *       call all four compositions uniformly.
 *
 * The key-using compositions consume the session-scoped `CommitteeKeyHolder`
 * (Decision 1) so the plaintext committee data key is unwrapped at most once
 * per session and reused — never re-unwrapped per op. Each observes any
 * `key_id` the server returns and routes it through
 * `keyHolder.onKeyRotationObserved(...)` BEFORE the next op (F-162 stale-key
 * self-heal). The defensive read-response `key_id?` passthrough is wired but
 * INERT under option (a) — the reprisal_read RPC carries no key_id (ADR-0028
 * Decision 1; proves the option-(b) upgrade path is ready).
 *
 * Hard guarantees:
 *   - libsodium-only (ADR-0003 Invariant 4).
 *   - NEVER logs key material, reprisal plaintext, or the passphrase (F-161).
 *     Every decrypt is wrapped in try/catch so a libsodium error carrying
 *     buffer bytes in its message/stack cannot propagate; failures surface as
 *     typed `decrypt_failed` union values (F-148 / F-167).
 *   - The submit wire body NEVER carries a client-supplied actor_id; the
 *     server reads `actor_id = auth.uid()` (F-164).
 *   - A 401 wipes the holder (the session-event triggers in Decision 1); a
 *     403/429 does NOT (those are not session events — AC-6 / AC-7).
 */

import type { CommitteeKeyHolder, LocalIdentityStore, SupabaseT07Client } from '../crypto';
import { unwrapCommitteeDataKeyViaProduction } from '../crypto';
import type { UnwrapCommitteeDataKeyResult } from '../crypto';
import { openUtf8, sealUtf8 } from '../concerns/seal';
import type {
  ReprisalFeedRow,
  ReprisalOpResult,
  SupabaseReprisalClient
} from './supabase-reprisal-client';
import type { ReprisalIntake } from './types';

// ---------------------------------------------------------------------------
// Discriminated-union return shapes
// ---------------------------------------------------------------------------

export type SubmitReprisalViaProductionResult =
  | { status: 'ok'; id: string }
  | { status: 'rate_limited' }
  | { status: 'rls_denied' }
  | { status: 'session_expiry' }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'failed'; reason: string; http: number };

export type ReadReprisalViaProductionResult =
  | { status: 'ok'; title: string; body: string }
  | { status: 'unavailable' }
  | { status: 'rls_denied' }
  | { status: 'session_expiry' }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'failed'; reason: string; http: number };

export type UpdateReprisalViaProductionResult =
  | { status: 'ok' }
  | { status: 'rate_limited' }
  | { status: 'rls_denied' }
  | { status: 'session_expiry' }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'failed'; reason: string; http: number };

export type ListReprisalFeedViaProductionResult =
  | { status: 'ok'; items: ReprisalFeedRow[] }
  | { status: 'session_expiry' }
  | { status: 'failed'; reason: string; http: number };

// ---------------------------------------------------------------------------
// Internal helpers — holder lifecycle / probe-first guard / rotation observe
// ---------------------------------------------------------------------------

interface EnsureHolderArgs {
  t07Client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  keyHolder: CommitteeKeyHolder;
  user_id: string;
}

type EnsureHolderResult =
  | { status: 'ok' }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'session_expiry' }
  | { status: 'failed'; reason: string; http: number };

/**
 * Probe-first guard + lazy unwrap (Decision 7 / F-163). Always consults the
 * cheap metadata probe BEFORE touching the disclosure RPC — a no-wrap actor
 * never reaches `get_key_wrap`. When the holder is already populated AND the
 * probe reports the SAME key_id, we skip the disclosure RPC entirely (Decision
 * 1 dwell policy: one unwrap per session). When the probe reports a NEWER
 * key_id than the cached one, `onKeyRotationObserved` wipes the holder and the
 * unwrap composition runs to re-populate under the new key (F-162 stale-key
 * self-heal).
 */
async function ensureHolderPopulated(args: EnsureHolderArgs): Promise<EnsureHolderResult> {
  const { t07Client, localIdentity, keyHolder, user_id } = args;

  // Probe FIRST (Decision 7 / F-163). Metadata-only — no key material.
  const probe = await t07Client.getCommitteeKeyState({ actor_user_id: user_id });
  if (!probe.ok) {
    if (probe.status === 401) {
      keyHolder.onSessionRevoked();
      return { status: 'session_expiry' };
    }
    return { status: 'failed', reason: probe.reason, http: probe.status };
  }
  if (!probe.data || !probe.data.actor_has_wrap) {
    return { status: 'needs_setup' };
  }

  // F-162 — rotation observed on probe. If the holder cached an older key_id,
  // the .set() invariant we relied on is stale; wipe so the unwrap below
  // repopulates under the new key. Same-key_id is a no-op (no spurious unwrap
  // churn).
  if (keyHolder.isPopulated()) {
    keyHolder.onKeyRotationObserved(probe.data.key_id);
  }

  if (keyHolder.isPopulated()) {
    // Reuse the cached key — Decision 1 dwell policy.
    return { status: 'ok' };
  }

  // Lazy unwrap (Decision 2 / PR1). The unwrap composition probes again, which
  // is fine — the probe is cheap + the server emits no audit on the metadata
  // read. The disclosure RPC fires here for the first time this session.
  const unwrap: UnwrapCommitteeDataKeyResult = await unwrapCommitteeDataKeyViaProduction({
    client: t07Client,
    localIdentity,
    user_id
  });
  if (unwrap.status === 'no_wrap') return { status: 'needs_setup' };
  if (unwrap.status === 'needs_recovery') return { status: 'needs_recovery' };
  if (unwrap.status === 'failed') {
    if (unwrap.http === 401) {
      keyHolder.onSessionRevoked();
      return { status: 'session_expiry' };
    }
    return { status: 'failed', reason: unwrap.reason, http: unwrap.http };
  }
  // status === 'ok' — hand the plaintext key to the holder BY REFERENCE
  // (Decision 1: single buffer; the holder owns the wipe lifecycle).
  keyHolder.set({
    data_key: unwrap.data_key,
    key_id: unwrap.key_id,
    epoch: unwrap.epoch
  });
  return { status: 'ok' };
}

/**
 * Surface a wire-level reprisal-op failure into a categorisation the
 * compositions map onto their own union.
 *
 * Holder lifecycle (ADR-0028 PR1 — only the 401/403 split is needed here;
 * governance-403 reason discrimination is PR2):
 *   - 401 (session_expiry) → ALWAYS wipe the holder + signal session_expiry.
 *   - 403 (rls_denied) → holder UNCHANGED (a 403 is not a session event).
 *   - 429 (rate_limited) → holder UNCHANGED.
 *   - everything else → holder unchanged; categorised as `failed`.
 */
type WireFailureKind =
  | { kind: 'session_expiry' }
  | { kind: 'rate_limited' }
  | { kind: 'rls_denied' }
  | { kind: 'failed'; reason: string; http: number };

function classifyWireFailure(
  res: { ok: false; reason: string; status: number },
  keyHolder: CommitteeKeyHolder
): WireFailureKind {
  if (res.status === 401) {
    keyHolder.onSessionRevoked();
    return { kind: 'session_expiry' };
  }
  if (res.status === 429 || res.reason === 'rate_limited') {
    return { kind: 'rate_limited' };
  }
  if (res.status === 403 || res.reason === 'rls_denied') {
    return { kind: 'rls_denied' };
  }
  return { kind: 'failed', reason: res.reason, http: res.status };
}

// ---------------------------------------------------------------------------
// submitReprisalViaProduction
// ---------------------------------------------------------------------------

export interface SubmitReprisalViaProductionArgs extends EnsureHolderArgs {
  reprisalClient: SupabaseReprisalClient;
  intake: ReprisalIntake;
}

export async function submitReprisalViaProduction(
  args: SubmitReprisalViaProductionArgs
): Promise<SubmitReprisalViaProductionResult> {
  const { reprisalClient, intake, keyHolder } = args;

  // Probe-first (F-163). A no-wrap actor short-circuits to needs_setup BEFORE
  // any disclosure RPC OR submit POST.
  const holderRes = await ensureHolderPopulated(args);
  if (holderRes.status !== 'ok') return holderRes;

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    // Defensive — the holder vanished between ensure + use (a concurrent wipe).
    // Surface as session_expiry so the UI routes to re-sign-in.
    return { status: 'session_expiry' };
  }

  // Seal title + body. Wrap in try/catch so a libsodium failure cannot
  // propagate with buffer bytes in its message/stack (F-161 / F-167).
  let title_ct: Uint8Array;
  let body_ct: Uint8Array;
  try {
    title_ct = await sealUtf8(intake.title, dataKey);
    body_ct = await sealUtf8(intake.body, dataKey);
  } catch {
    return { status: 'failed', reason: 'seal_failed', http: 0 };
  }

  // F-164 — the per-record passphrase is forwarded VERBATIM as the friction
  // gate; it is never derived into a key and never logged.
  const submit = await reprisalClient.submitReprisal({
    title_ct,
    body_ct,
    passphrase: intake.passphrase ?? null
  });

  if (!submit.ok) {
    const f = classifyWireFailure(submit, keyHolder);
    switch (f.kind) {
      case 'session_expiry':
        return { status: 'session_expiry' };
      case 'rate_limited':
        return { status: 'rate_limited' };
      case 'rls_denied':
        return { status: 'rls_denied' };
      default:
        return { status: 'failed', reason: f.reason, http: f.http };
    }
  }

  // F-162 — surface any observed key_id the submit response returned (no-op if
  // absent; same-key_id => no-op; different => wipe + next op re-unwraps).
  observeKeyId(submit.data, keyHolder);

  return { status: 'ok', id: submit.data.id };
}

// ---------------------------------------------------------------------------
// readReprisalViaProduction — the audited C4 read (F-165 LOAD-BEARING)
// ---------------------------------------------------------------------------

export interface ReadReprisalViaProductionArgs extends EnsureHolderArgs {
  reprisalClient: SupabaseReprisalClient;
  id: string;
  passphrase?: string | null;
}

export async function readReprisalViaProduction(
  args: ReadReprisalViaProductionArgs
): Promise<ReadReprisalViaProductionResult> {
  const { reprisalClient, keyHolder } = args;

  const holderRes = await ensureHolderPopulated(args);
  if (holderRes.status !== 'ok') return holderRes;

  // F-165 audit-before-decrypt: the SERVER's `reprisal_read` emits the
  // `reprisal.read` audit row inside the same SECURITY DEFINER txn BEFORE
  // returning the ciphertext (migration 0005:222-226). The client MUST NOT
  // openUtf8 anything until this await resolves — straight async/await, no
  // eager decrypt of cached/sniffed ct. The data key is not read until below.
  const read = await reprisalClient.readReprisal({
    id: args.id,
    passphrase: args.passphrase ?? null
  });

  if (!read.ok) {
    const f = classifyWireFailure(read, keyHolder);
    switch (f.kind) {
      case 'session_expiry':
        return { status: 'session_expiry' };
      case 'rls_denied':
        return { status: 'rls_denied' };
      case 'rate_limited':
        return { status: 'failed', reason: 'rate_limited', http: read.status };
      default:
        return { status: 'failed', reason: f.reason, http: f.http };
    }
  }

  // F-165 never-decrypt-on-null: the wire collapses wrong-passphrase AND
  // not-found to data:null (supabase-reprisal-client.ts). Return the single
  // honest typed `unavailable` and NEVER call openUtf8 (the holder's key is
  // not consulted). NOT an invented `invalid_passphrase` the wire can't
  // substantiate.
  if (!read.data) {
    return { status: 'unavailable' };
  }

  // F-162 defensive passthrough — route any key_id the read response carried
  // through the holder. INERT under option (a) (the read RPC carries none);
  // wired so the option-(b) upgrade path works without a code change.
  observeKeyId(read.data, keyHolder);

  // Audit has committed — only now read the holder's data key and open the
  // returned ciphertext.
  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    return { status: 'session_expiry' };
  }

  let title: string;
  let body: string;
  try {
    // F-148 / F-167 — secretbox is AEAD; a wrong/stale key or tampered ct
    // THROWS. Wrap so the libsodium error (which carries buffer bytes in its
    // message/stack) never propagates; surface a typed decrypt_failed and the
    // opened plaintext is never returned on failure.
    title = await openUtf8(read.data.title_ct, dataKey);
    body = await openUtf8(read.data.body_ct, dataKey);
  } catch {
    return { status: 'failed', reason: 'decrypt_failed', http: 0 };
  }

  return { status: 'ok', title, body };
}

// ---------------------------------------------------------------------------
// updateReprisalViaProduction
// ---------------------------------------------------------------------------

export interface UpdateReprisalViaProductionArgs extends EnsureHolderArgs {
  reprisalClient: SupabaseReprisalClient;
  id: string;
  title?: string;
  body?: string;
}

export async function updateReprisalViaProduction(
  args: UpdateReprisalViaProductionArgs
): Promise<UpdateReprisalViaProductionResult> {
  const { reprisalClient, keyHolder, id, title, body } = args;

  const holderRes = await ensureHolderPopulated(args);
  if (holderRes.status !== 'ok') return holderRes;

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    return { status: 'session_expiry' };
  }

  // Seal only the provided field(s). A field left undefined is omitted from the
  // wire body so the SQL treats it as NULL = unchanged (F-31). Wrap the seal in
  // try/catch so a libsodium failure surfaces typed (F-161 / F-167).
  const sealInput: { id: string; title_ct?: Uint8Array; body_ct?: Uint8Array } = { id };
  try {
    if (title !== undefined) sealInput.title_ct = await sealUtf8(title, dataKey);
    if (body !== undefined) sealInput.body_ct = await sealUtf8(body, dataKey);
  } catch {
    return { status: 'failed', reason: 'seal_failed', http: 0 };
  }

  const update = await reprisalClient.updateReprisal(sealInput);

  if (!update.ok) {
    const f = classifyWireFailure(update, keyHolder);
    switch (f.kind) {
      case 'session_expiry':
        return { status: 'session_expiry' };
      case 'rate_limited':
        return { status: 'rate_limited' };
      case 'rls_denied':
        return { status: 'rls_denied' };
      default:
        return { status: 'failed', reason: f.reason, http: f.http };
    }
  }

  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// listReprisalFeedViaProduction — pseudonymized feed, NO key (F-166 / C3)
// ---------------------------------------------------------------------------

export interface ListReprisalFeedViaProductionArgs {
  reprisalClient: SupabaseReprisalClient;
  // The feed needs no committee key (F-166 — the reprisal_feed view is already
  // pseudonymized and carries NO ciphertext). These are accepted-and-ignored
  // so the route can call all four compositions with one uniform arg bag.
  t07Client?: SupabaseT07Client;
  localIdentity?: LocalIdentityStore;
  keyHolder?: CommitteeKeyHolder;
  user_id?: string;
}

export async function listReprisalFeedViaProduction(
  args: ListReprisalFeedViaProductionArgs
): Promise<ListReprisalFeedViaProductionResult> {
  const { reprisalClient } = args;

  // F-166 — NO ensureHolderPopulated, NO probe, NO disclosure RPC, NO openUtf8.
  // The feed is pseudonymized + ciphertext-free; touching the key surface would
  // be a privacy regression (asserted by the throwing-t07 transport in the
  // feed test). Fetch the view and return the rows as-is (the ReprisalFeedRow
  // shape structurally has no actor_id / no *_ct column).
  const feed = await reprisalClient.listReprisalFeed();
  if (!feed.ok) {
    if (feed.status === 401) {
      return { status: 'session_expiry' };
    }
    return { status: 'failed', reason: feed.reason, http: feed.status };
  }

  const items = Array.isArray(feed.data) ? feed.data : [];
  return { status: 'ok', items };
}

// ---------------------------------------------------------------------------
// shared helper
// ---------------------------------------------------------------------------

/**
 * F-162 — route any server-observed `key_id` through the holder's rotation
 * seam. Same-key_id is a no-op; a newer key_id wipes the holder so the next op
 * re-unwraps under the new key. The defensive `key_id?` read uses the
 * concerns-style raw cast (forward-compat per ADR-0028 Decision 1).
 */
function observeKeyId(data: unknown, keyHolder: CommitteeKeyHolder): void {
  const observedKeyId = (data as { key_id?: string } | null)?.key_id;
  if (typeof observedKeyId === 'string' && observedKeyId.length > 0) {
    keyHolder.onKeyRotationObserved(observedKeyId);
  }
}

// Keep the ReprisalOpResult type referenced for the public surface (the
// compositions consume it transitively via the client return types).
export type { ReprisalOpResult };
