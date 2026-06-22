/**
 * Concern production compositions (ADR-0027 Decision 3 / P2a-7).
 *
 * Three high-level operations the /concerns route drives end-to-end:
 *
 *   - submitConcernViaProduction:
 *       probe-first guard → ensure holder populated (lazy unwrap; PR1
 *       infra) → sealUtf8 title + body (+ optional source_name iff named)
 *       → POST submit → typed discriminated-union result.
 *
 *   - listConcernsViaProduction:
 *       probe-first → ensure holder populated → fetch the default view →
 *       openUtf8 title + body per row → return ONLY the rendered shape
 *       (NO actor_id, NO status, NO source_name_ct; F-149 / F-150 / F-18
 *       carry-forward).
 *
 *   - revealConcernSourceViaProduction:
 *       probe-first → ensure holder populated → AWAIT the reveal RPC (the
 *       SERVER emits concern.source_revealed BEFORE returning the
 *       ciphertext — F-150 audit-before-decrypt) → ONLY then openUtf8 the
 *       returned source_name_ct under the cached data key.
 *
 * The compositions consume the session-scoped `CommitteeKeyHolder`
 * (Decision 1) so the plaintext committee data key is unwrapped at most
 * once per session and reused — never re-unwrapped per op.
 *
 * Every composition observes any `key_id` the server returns and routes
 * it through `keyHolder.onKeyRotationObserved(...)` BEFORE the next op
 * (C2 carry-forward). The holder's contract is no-op on the same key_id
 * and wipe-on-different — sealing/opening under a stale key (F-137 /
 * F-154 hazard) is prevented structurally.
 *
 * Hard guarantees:
 *   - libsodium-only (ADR-0003 Invariant 4).
 *   - NEVER logs key material or concern plaintext (F-148 / AC-9). Every
 *     decrypt is wrapped in try/catch so libsodium errors carrying buffer
 *     bytes in their message/stack cannot propagate; failures surface as
 *     typed union values.
 *   - The submit wire body NEVER carries a client-supplied actor_id; the
 *     server reads `actor_id = auth.uid()` (F-149).
 *   - A 401 wipes the holder (the session-event triggers in Decision 1);
 *     a 403/429 does NOT (those are not session events — AC-6 / AC-8).
 */

import type {
  CommitteeKeyHolder,
  LocalIdentityStore,
  SupabaseT07Client,
  UnwrapCommitteeDataKeyResult
} from '../crypto';
import { unwrapCommitteeDataKeyViaProduction } from '../crypto';
import { openUtf8, sealUtf8 } from './seal';
import type { ConcernOpResult, SupabaseConcernClient } from './supabase-concern-client';
import type { ConcernIntake } from './types';

// ---------------------------------------------------------------------------
// Discriminated-union return shapes
// ---------------------------------------------------------------------------

export type SubmitConcernViaProductionResult =
  | { status: 'ok'; id: string }
  | { status: 'rate_limited' }
  | { status: 'rls_denied' }
  | { status: 'session_expiry' }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'failed'; reason: string; http: number };

export interface ListedConcern {
  id: string;
  title: string;
  body: string;
  hazard_class: string;
  severity: string;
  location_id: string;
  created_at: string;
  updated_at?: string;
  actor_pseudonym: string;
  has_named_source: boolean;
  anonymous_default_kept: boolean;
  days_since_filed: number;
}

export type ListConcernsViaProductionResult =
  | { status: 'ok'; items: ListedConcern[] }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'session_expiry' }
  | { status: 'failed'; reason: string; http: number };

export type RevealConcernSourceViaProductionResult =
  | { status: 'ok'; source_name: string }
  | { status: 'anonymous' }
  | { status: 'invalid_passphrase' }
  | { status: 'rls_denied' }
  | { status: 'session_expiry' }
  | { status: 'needs_setup' }
  | { status: 'needs_recovery' }
  | { status: 'failed'; reason: string; http: number };

// ---------------------------------------------------------------------------
// Internal helpers — holder lifecycle / probe-first guard / rotation observe
// ---------------------------------------------------------------------------

interface EnsureHolderArgs {
  client: SupabaseT07Client;
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
 * Probe-first guard + lazy unwrap (Decision 7 / F-144). Always consults the
 * cheap metadata probe BEFORE touching the disclosure RPC — a no-wrap actor
 * never reaches `get_key_wrap`. When the holder is already populated AND the
 * probe reports the SAME key_id, we skip the disclosure RPC entirely (Decision
 * 1 dwell policy: one unwrap per session). When the probe reports a NEWER
 * key_id than the cached one, `onKeyRotationObserved` wipes the holder and
 * the unwrap composition runs to re-populate under the new key (C2 / F-154
 * stale-key guard).
 */
async function ensureHolderPopulated(args: EnsureHolderArgs): Promise<EnsureHolderResult> {
  const { client, localIdentity, keyHolder, user_id } = args;

  // Probe FIRST (Decision 7 / F-144). Metadata-only — no key material.
  const probe = await client.getCommitteeKeyState({ actor_user_id: user_id });
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

  // C2 — rotation observed on probe. If the holder cached an older key_id, the
  // .set() invariant we relied on is stale; wipe so the unwrap below repopulates
  // under the new key. Same-key_id is a no-op (no spurious unwrap churn).
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
    client,
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
 * Surface a wire-level concern-op failure into one of the typed result shapes
 * the compositions return. The compositions vary only by which shape they
 * return (each has its own discriminator), so this helper returns the raw
 * categorisation and the caller maps to its union.
 *
 * Holder lifecycle:
 *   - 401 (session_expiry) → ALWAYS wipe the holder + signal session_expiry.
 *   - everything else → holder unchanged.
 */
type WireFailureKind =
  | { kind: 'session_expiry' }
  | { kind: 'rate_limited' }
  | { kind: 'rls_denied' }
  | { kind: 'invalid_passphrase' }
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
  if (res.status === 422 || res.reason === 'invalid_input') {
    return { kind: 'invalid_passphrase' };
  }
  return { kind: 'failed', reason: res.reason, http: res.status };
}

// ---------------------------------------------------------------------------
// submitConcernViaProduction
// ---------------------------------------------------------------------------

export interface SubmitConcernViaProductionArgs extends EnsureHolderArgs {
  concernClient: SupabaseConcernClient;
  intake: ConcernIntake;
}

export async function submitConcernViaProduction(
  args: SubmitConcernViaProductionArgs
): Promise<SubmitConcernViaProductionResult> {
  const { concernClient, intake, keyHolder } = args;

  // AC-5 defence-in-depth: anonymous=false with empty source_name_plaintext is
  // a programming error that the form's pre-submit gate already catches. The
  // library is the second line — surface a typed rls_denied (NO PI on the
  // wire, NO submit POST) so the UI handles it uniformly with the server's
  // own 403. Mirrors concern-core.ts:139-142.
  if (intake.anonymous === false) {
    const name = intake.source_name_plaintext;
    if (!name || name.length === 0) {
      return { status: 'rls_denied' };
    }
  }

  const holderRes = await ensureHolderPopulated(args);
  if (holderRes.status !== 'ok') return holderRes;

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    // Defensive — the holder vanished between ensure + use (a concurrent wipe).
    // Surface as session_expiry so the UI routes to re-sign-in; this is the
    // safe-by-default branch.
    return { status: 'session_expiry' };
  }

  // Seal title + body. Wrap in try/catch so a libsodium failure cannot
  // propagate with buffer bytes in its message/stack (F-148).
  let title_ct: Uint8Array;
  let body_ct: Uint8Array;
  let source_name_ct: Uint8Array | null = null;
  try {
    title_ct = await sealUtf8(intake.title, dataKey);
    body_ct = await sealUtf8(intake.body, dataKey);
    if (intake.anonymous === false && intake.source_name_plaintext) {
      source_name_ct = await sealUtf8(intake.source_name_plaintext, dataKey);
    }
  } catch {
    return { status: 'failed', reason: 'seal_failed', http: 0 };
  }

  // Forward the optional per-record passphrase verbatim if the intake carries
  // one (named submissions). The intake type does not formally enumerate it,
  // so read it through a safe cast — never log or echo it.
  const sourcePassphrase = (intake as unknown as { source_passphrase?: string | null })
    .source_passphrase;

  const submit = await concernClient.submitConcern({
    title_ct,
    body_ct,
    hazard_class: intake.hazard_class,
    severity: intake.severity,
    location_id: intake.location_id,
    anonymous: intake.anonymous,
    source_name_ct,
    source_passphrase: sourcePassphrase ?? null
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
      case 'invalid_passphrase':
        // Submit doesn't have a passphrase semantic for itself — map 422 to a
        // generic failed so the UI doesn't confuse it with reveal.
        return { status: 'failed', reason: 'invalid_input', http: submit.status };
      default:
        return { status: 'failed', reason: f.reason, http: f.http };
    }
  }

  // C2 — surface any observed key_id the server returned (the submit response
  // may carry one; if not, this is a no-op). Same-key_id => no-op; different =>
  // wipe + next op re-unwraps under the new key.
  const observedKeyId = (submit.data as unknown as { key_id?: string }).key_id;
  if (typeof observedKeyId === 'string' && observedKeyId.length > 0) {
    keyHolder.onKeyRotationObserved(observedKeyId);
  }

  return { status: 'ok', id: submit.data.id };
}

// ---------------------------------------------------------------------------
// listConcernsViaProduction
// ---------------------------------------------------------------------------

export interface ListConcernsViaProductionArgs extends EnsureHolderArgs {
  concernClient: SupabaseConcernClient;
}

interface ListRowFromServer {
  id: string;
  title_ct: string | Uint8Array;
  body_ct: string | Uint8Array;
  hazard_class: string;
  severity: string;
  location_id: string;
  created_at: string;
  updated_at?: string;
  actor_pseudonym: string;
  anonymous_default_kept: boolean;
  has_named_source: boolean;
  // intentionally unused but typed for completeness
  // (rogue source_name_ct on a list row is stripped — F-150 defence-in-depth)
  source_name_ct?: unknown;
  key_id?: string;
}

function isHexString(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('\\x');
}

function pgHexToBytesLocal(hex: string): Uint8Array {
  // Mirrors lib/server-client/pg-hex.ts behaviour without re-importing — keeps
  // this file's dependency surface lean. Hex begins with `\x`; the rest is
  // pairs of nibble characters.
  const body = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.substr(i * 2, 2), 16);
  }
  return out;
}

function toBytes(v: string | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (isHexString(v)) return pgHexToBytesLocal(v);
  // Fallback — treat as already-decoded hex without prefix.
  return pgHexToBytesLocal(v);
}

export async function listConcernsViaProduction(
  args: ListConcernsViaProductionArgs
): Promise<ListConcernsViaProductionResult> {
  const { concernClient, keyHolder } = args;

  const holderRes = await ensureHolderPopulated(args);
  if (holderRes.status !== 'ok') return holderRes;

  const list: ConcernOpResult<unknown> =
    (await concernClient.listConcerns()) as ConcernOpResult<unknown>;
  if (!list.ok) {
    const f = classifyWireFailure(list, keyHolder);
    switch (f.kind) {
      case 'session_expiry':
        return { status: 'session_expiry' };
      case 'rate_limited':
      case 'rls_denied':
      case 'invalid_passphrase':
        return { status: 'failed', reason: f.kind, http: list.status };
      default:
        return { status: 'failed', reason: f.reason, http: f.http };
    }
  }

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    return { status: 'session_expiry' };
  }

  const rows = Array.isArray(list.data) ? (list.data as ListRowFromServer[]) : [];
  const now = Date.now();
  const items: ListedConcern[] = [];

  for (const row of rows) {
    // C2 — observe per-row key_id if present.
    if (typeof row.key_id === 'string' && row.key_id.length > 0) {
      keyHolder.onKeyRotationObserved(row.key_id);
    }
    let title: string;
    let body: string;
    try {
      title = await openUtf8(toBytes(row.title_ct), dataKey);
      body = await openUtf8(toBytes(row.body_ct), dataKey);
    } catch {
      // F-147 / F-148 — never let a libsodium error propagate; surface a typed
      // failure that the UI handles uniformly.
      return { status: 'failed', reason: 'decrypt_failed', http: 0 };
    }

    const createdMs = Date.parse(row.created_at);
    const days = Number.isFinite(createdMs)
      ? Math.floor((now - createdMs) / (1000 * 60 * 60 * 24))
      : 0;

    // Build the projection EXACTLY — F-149 / F-150 / Decision 6:
    //   - NO actor_id, NO status, NO source_name_ct, NO *_ct columns.
    //   - days_since_filed derived client-side from created_at.
    const item: ListedConcern = {
      id: row.id,
      title,
      body,
      hazard_class: row.hazard_class,
      severity: row.severity,
      location_id: row.location_id,
      created_at: row.created_at,
      actor_pseudonym: row.actor_pseudonym,
      has_named_source: row.has_named_source === true,
      anonymous_default_kept: row.anonymous_default_kept === true,
      days_since_filed: days
    };
    if (typeof row.updated_at === 'string') item.updated_at = row.updated_at;
    items.push(item);
  }

  return { status: 'ok', items };
}

// ---------------------------------------------------------------------------
// revealConcernSourceViaProduction
// ---------------------------------------------------------------------------

export interface RevealConcernSourceViaProductionArgs extends EnsureHolderArgs {
  concernClient: SupabaseConcernClient;
  id: string;
  passphrase?: string | null;
}

export async function revealConcernSourceViaProduction(
  args: RevealConcernSourceViaProductionArgs
): Promise<RevealConcernSourceViaProductionResult> {
  const { concernClient, keyHolder } = args;

  const holderRes = await ensureHolderPopulated(args);
  if (holderRes.status !== 'ok') return holderRes;

  // F-150 audit-before-decrypt: the SERVER's `reveal_concern_source` emits the
  // `concern.source_revealed` audit row inside the same SECURITY DEFINER txn
  // BEFORE returning the source_name_ct (migration 0004:317-330). The client
  // MUST NOT decrypt anything until this await resolves — straight async/await,
  // no eager .then()-then-decrypt that could fire before the audit commit.
  const reveal = await concernClient.revealConcernSource({
    id: args.id,
    passphrase: args.passphrase ?? null
  });

  if (!reveal.ok) {
    const f = classifyWireFailure(reveal, keyHolder);
    switch (f.kind) {
      case 'session_expiry':
        return { status: 'session_expiry' };
      case 'rls_denied':
        return { status: 'rls_denied' };
      case 'invalid_passphrase':
        return { status: 'invalid_passphrase' };
      case 'rate_limited':
        return { status: 'failed', reason: 'rate_limited', http: reveal.status };
      default:
        return { status: 'failed', reason: f.reason, http: f.http };
    }
  }

  // C2 — observe key_id on the reveal response (if present).
  const observedKeyId = (reveal.data as unknown as { key_id?: string }).key_id;
  if (typeof observedKeyId === 'string' && observedKeyId.length > 0) {
    keyHolder.onKeyRotationObserved(observedKeyId);
  }

  // Anonymous concern → server returned null ciphertext. No decrypt attempt
  // (no key read, no openUtf8 call) — AC-4 invariant.
  if (!reveal.data.source_name_ct) {
    return { status: 'anonymous' };
  }

  // Audit has committed — only now read the holder's data key and open the
  // returned ciphertext.
  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    return { status: 'session_expiry' };
  }

  let source_name: string;
  try {
    source_name = await openUtf8(reveal.data.source_name_ct, dataKey);
  } catch {
    return { status: 'failed', reason: 'decrypt_failed', http: 0 };
  }
  return { status: 'ok', source_name };
}
