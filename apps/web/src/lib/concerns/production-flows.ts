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
import {
  unwrapAllCommitteeKeysViaProduction,
  unwrapCommitteeDataKeyViaProduction
} from '../crypto';
import { openUtf8, sealUtf8Sync } from './seal';
import { ready } from '../crypto/sodium';
import { log } from '../log';
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
 * F182-9 / ADR-0031 Decision 4 — the once-per-read-op escalation guard. A single
 * mutable `{ used }` is created at the top of each READ composition and passed BY
 * REFERENCE into BOTH `ensureHolderPopulated` (the retired-only read branch) and
 * the read-loop `escalateToAllEpochs`, so `get_all_committee_key_wraps_for_self`
 * (the N-audit-row disclosure RPC) fires AT MOST ONCE per read op — even on a
 * hostile all-miss page. `used` is spent SYNCHRONOUSLY before the fetch `await`.
 */
interface EscalationGuard {
  used: boolean;
}

type EscalationOutcome =
  | { status: 'escalated' } // load-all ok; holder now holds every ADDED epoch
  | { status: 'already' } // guard already spent this op → caller treats the miss as terminal
  | { status: 'needs_recovery' }
  | { status: 'session_expiry' }
  | { status: 'failed'; reason: string; http: number };

/**
 * F182-9 / ADR-0031 Decision 2 — the bounded escalate-to-all-epochs seam. READ
 * PATH ONLY: it is NEVER wired into a seal path (re-pass trigger #15 / Decision 6
 * — the seal gate stays on the single LIVE key and never pays the load-all cost).
 * Runs the multi-epoch load AT MOST ONCE per read op; the guard is spent BEFORE
 * the `await` so a re-entrant miss cannot double-fetch.
 *
 * Fetch-fault typing (AC-9): a 401 wipes the holder → `session_expiry`; a non-401
 * HTTP fault is surfaced verbatim as `failed` (the caller keeps it OUT of
 * `decrypt_failed`, which is reserved for a genuine crypto miss). A thrown /
 * no-HTTP-verdict transport (`http:0`) is NOT a server/session fault the caller
 * can type — it falls through to the persistent-miss `decrypt_failed`, fail-closed.
 *
 * F-145-C (Decision 6, ADD-not-wipe): `populate()` runs ONLY when the fetched set
 * ADDS an epoch the holder does not already hold. A no-new-epoch escalation leaves
 * the map (and every retained read buffer) untouched — populate()'s identity-
 * compare orphan-wipe must not zeroize a still-valid retained key for nothing.
 */
async function escalateToAllEpochs(
  args: EnsureHolderArgs,
  guard: EscalationGuard
): Promise<EscalationOutcome> {
  if (guard.used) return { status: 'already' };
  guard.used = true; // BOUND: spent synchronously BEFORE the await (no re-entry)
  const { client, localIdentity, keyHolder, user_id } = args;
  // F-VAL-1(b) — snapshot the wipe generation at entry, BEFORE the fetch `await`,
  // re-checked immediately before the populate() install below.
  const gen = keyHolder.wipeGeneration();
  const all = await unwrapAllCommitteeKeysViaProduction({ client, localIdentity, user_id });
  if (all.status === 'needs_recovery') return { status: 'needs_recovery' };
  if (all.status === 'failed') {
    if (all.http === 401) {
      keyHolder.onSessionRevoked();
      return { status: 'session_expiry' };
    }
    return { status: 'failed', reason: all.reason, http: all.http };
  }
  // F-VAL-1(b) — re-check the wipe latch immediately before installing. A
  // session-end wipe (panic / 401 / page-unload) that landed during the fetch
  // `await` above advanced #wipeGeneration; letting populate() resume would
  // RESURRECT the just-wiped key map. Fail closed to session_expiry, do NOT
  // install, and leave the holder empty (never half-populated).
  if (keyHolder.wipeGeneration() !== gen) return { status: 'session_expiry' };
  // status === 'ok'. Re-populate ONLY when the fetch brings in a not-yet-held
  // epoch (F-145-C ADD-not-wipe); a no-new-epoch fetch is a pure no-op.
  const addsNewEpoch = all.entries.some((e) => !keyHolder.holdsKeyId(e.key_id));
  if (addsNewEpoch) keyHolder.populate(all.entries);
  return { status: 'escalated' };
}

/**
 * F182-9 / ADR-0031 Decision 5 (F-183-B-OBS) — emit the missing-epoch-vs-corrupt
 * telemetry on a PERSISTENT post-escalation read miss (never from `trialOpen`,
 * which stays a pure fail-closed primitive). Key-material-FREE: a COUNT of held
 * epochs + booleans ONLY — NEVER a key_id VALUE, key bytes, or plaintext (F-148).
 * `row_epoch_held` is emitted only when the row carries a key_id hint:
 *   - `escalated:true` + `row_epoch_held:false` ⇒ missing-epoch (benign boundary).
 *   - `escalated:true` + `row_epoch_held:true`  ⇒ corrupt / tampered (alertable).
 * The returned union stays `decrypt_failed` in ALL cases — the class split lives
 * in telemetry only and never reaches the UI or the browser.
 */
function emitBaselineMissDiagnostic(opts: {
  keyHolder: CommitteeKeyHolder;
  escalated: boolean;
  rowKeyId?: string | undefined;
}): void {
  const attributes: Record<string, unknown> = {
    escalated: opts.escalated,
    epochs_held: opts.keyHolder.size()
  };
  if (typeof opts.rowKeyId === 'string' && opts.rowKeyId.length > 0) {
    attributes.row_epoch_held = opts.keyHolder.holdsKeyId(opts.rowKeyId);
  }
  log.warn({ event: 'concern.baseline_multiepoch_read_miss', attributes });
}

/**
 * Probe-first guard + lazy unwrap (Decision 7 / F-144). Always consults the
 * cheap metadata probe BEFORE touching the disclosure RPC — a no-wrap actor
 * never reaches `get_key_wrap`. When the holder is already populated AND the
 * probe reports the SAME key_id, we skip the disclosure RPC entirely (Decision
 * 1 dwell policy: one unwrap per session). When the probe reports a NEWER
 * key_id than the cached one, the probe-driven self-heal DEMOTES the stale live
 * key and re-populates ALL wraps under the new epoch (F-183-R / A-8.10-R).
 *
 * `mode` is a STATIC per-call-site literal (never derived from wire input):
 *   - `'seal'` (submit / update) — UNCHANGED, fail-closed. A retired-only member
 *     (single-live unwrap → `no_wrap`) returns `needs_setup`; the seal path NEVER
 *     escalates (re-pass trigger #15 / F-190 envelope not widened).
 *   - `'read'` (list / reveal) — a retired-only member is ESCALATED to READ
 *     (Decision 3) instead of misrouted to `needs_setup`, via the shared once-
 *     per-op `guard`.
 */
async function ensureHolderPopulated(
  args: EnsureHolderArgs,
  mode: 'read' | 'seal',
  guard: EscalationGuard
): Promise<EnsureHolderResult> {
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

  // C2 / ADR-0030 Decision 6.3 / A-8.10-R — probe-driven rotation self-heal.
  // Gate the re-populate on the LIVE key_id MISMATCH (getKeyId() !== probe
  // key_id), NOT merely `!hasLiveKey()`: while a stale key is still designated
  // live, `!hasLiveKey()` is a FALSE POSITIVE and the re-populate would never
  // fire (the F-183-R stuck session). When the probe (authoritative) reports a
  // live key_id different from the one we hold, `onKeyRotationObserved` DEMOTES
  // the stale live key (fail-closed seal gate; buffer RETAINED for reads), then
  // we re-fetch EVERY wrap and `populate()` — so the retained old-epoch read
  // keys SURVIVE the re-fetch. `.set()` would REPLACE the map and discard them,
  // re-introducing the F-183 historical-read lockout.
  if (keyHolder.isPopulated() && keyHolder.getKeyId() !== probe.data.key_id) {
    keyHolder.onKeyRotationObserved(probe.data.key_id);
    // F-183-B adversarial (Finding 3 / re-pass trigger #16) — this self-heal
    // fetch IS the op's once-per-op multi-epoch disclosure. Spend the shared
    // guard SYNCHRONOUSLY before the await so a later read-loop
    // `escalateToAllEpochs` in the SAME op sees a spent guard and does NOT fire
    // a second `get_all_key_wraps` (the "exactly one all-wraps RPC per op"
    // bound). In seal mode the guard is a throwaway, so this is a harmless set.
    guard.used = true;
    // F-VAL-1(b) — snapshot the wipe generation BEFORE the self-heal fetch
    // `await`, re-checked immediately before the populate() install below.
    const gen = keyHolder.wipeGeneration();
    const all = await unwrapAllCommitteeKeysViaProduction({ client, localIdentity, user_id });
    if (all.status === 'needs_recovery') return { status: 'needs_recovery' };
    if (all.status === 'failed') {
      if (all.http === 401) {
        keyHolder.onSessionRevoked();
        return { status: 'session_expiry' };
      }
      return { status: 'failed', reason: all.reason, http: all.http };
    }
    // F-VAL-1(b) — re-check before install: a session-end wipe (401 / panic /
    // page-unload) that landed during the self-heal fetch advanced
    // #wipeGeneration; do NOT let populate() resurrect the just-wiped map. Fail
    // closed to session_expiry, leaving the holder empty (never half-populated).
    if (keyHolder.wipeGeneration() !== gen) return { status: 'session_expiry' };
    // status === 'ok' — hand every epoch's plaintext key to the holder BY
    // REFERENCE (multi-epoch: retained + new-live). populate(), never set().
    keyHolder.populate(all.entries);
  }

  if (keyHolder.hasLiveKey()) {
    // Reuse the cached LIVE key — Decision 1 dwell policy. Seal-gating is on the
    // LIVE key, not mere population: a retired-only holding state (isPopulated
    // true, no live key) falls through to unwrap a live wrap (F182-2 fail-closed
    // seal gate).
    return { status: 'ok' };
  }

  // Lazy unwrap (Decision 2 / PR1). The unwrap composition probes again, which
  // is fine — the probe is cheap + the server emits no audit on the metadata
  // read. The disclosure RPC fires here for the first time this session.
  //
  // F-VAL-1(b) — snapshot the wipe generation BEFORE the single-live fetch
  // `await`, re-checked immediately before the set() install below. This is the
  // CRITICAL counter-not-isPopulated case: the holder is EMPTY before AND right
  // after a mid-await wipe, so only the monotonic counter can distinguish
  // "never populated" from "wiped".
  const gen = keyHolder.wipeGeneration();
  const unwrap: UnwrapCommitteeDataKeyResult = await unwrapCommitteeDataKeyViaProduction({
    client,
    localIdentity,
    user_id
  });
  if (unwrap.status === 'no_wrap') {
    // F182-9 / ADR-0031 Decision 3 — a retired-only remaining member: the probe
    // reported `actor_has_wrap` (checked above) but the single-LIVE disclosure
    // returned null (they hold only a RETIRED wrap). READ mode escalates so the
    // retired-sealed record still opens; SEAL mode stays fail-closed to
    // `needs_setup` (they hold no live key to seal with — re-pass trigger #15).
    if (mode === 'read') {
      const esc = await escalateToAllEpochs(args, guard);
      if (esc.status === 'needs_recovery') return { status: 'needs_recovery' };
      if (esc.status === 'session_expiry') return { status: 'session_expiry' };
      if (esc.status === 'failed') return { status: 'failed', reason: esc.reason, http: esc.http };
      // 'escalated' / 'already': the holder now holds the retired key iff the
      // load returned any entry. isPopulated() → ok (reads via trialOpen);
      // still empty (a genuinely purged member mid-window) → needs_setup.
      return keyHolder.isPopulated() ? { status: 'ok' } : { status: 'needs_setup' };
    }
    return { status: 'needs_setup' };
  }
  if (unwrap.status === 'needs_recovery') return { status: 'needs_recovery' };
  if (unwrap.status === 'failed') {
    if (unwrap.http === 401) {
      keyHolder.onSessionRevoked();
      return { status: 'session_expiry' };
    }
    return { status: 'failed', reason: unwrap.reason, http: unwrap.http };
  }
  // F-VAL-1(b) — re-check before install: a session-end wipe (page-unload /
  // panic / 401) that landed during the single-live fetch advanced
  // #wipeGeneration. set() would resurrect the just-wiped key on an EMPTY holder
  // (isPopulated() is false in BOTH the never-populated and the wiped-mid-await
  // cases, so only the counter can tell them apart). Fail closed to
  // session_expiry, leaving the holder empty (never half-populated).
  if (keyHolder.wipeGeneration() !== gen) return { status: 'session_expiry' };
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

  // SEAL mode — fail-closed, NEVER escalates (re-pass trigger #15 / F-190). The
  // guard is a throwaway here: the seal path never calls escalateToAllEpochs.
  const holderRes = await ensureHolderPopulated(args, 'seal', { used: false });
  if (holderRes.status !== 'ok') return holderRes;

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    // Defensive — the holder vanished between ensure + use (a concurrent wipe).
    // Surface as session_expiry so the UI routes to re-sign-in; this is the
    // safe-by-default branch.
    return { status: 'session_expiry' };
  }

  // F-190 / re-pass trigger #13 (mid-seal liveness TOCTOU). Resolve libsodium
  // ONCE up front so the seal itself carries NO `await` between the liveness
  // re-check and the synchronous secretbox — the gap `sealUtf8`'s internal
  // `await ready()` used to open. A wipe (panic/401/unload) OR a rotation-
  // observing self-heal `populate([...fresh])` firing in that gap would zero the
  // captured `dataKey` BY REFERENCE, and the resuming secretbox would seal under
  // an all-zero key (world-readable post-F-145-C). Seal title + body (+ source
  // name) in a try/catch so a libsodium failure cannot propagate with buffer
  // bytes in its message/stack (F-148).
  let title_ct: Uint8Array;
  let body_ct: Uint8Array;
  let source_name_ct: Uint8Array | null = null;
  try {
    const s = await ready();
    // NO `await` from here to the last secretbox: re-check liveness, then
    // RE-READ getDataKey() (a boolean hasLiveKey() re-check is INSUFFICIENT —
    // post-self-heal-populate it is TRUE while the captured buffer is zeroed;
    // never reuse the earlier `dataKey`), then seal every field synchronously.
    if (!keyHolder.hasLiveKey()) {
      return { status: 'session_expiry' };
    }
    const liveKey = keyHolder.getDataKey();
    if (!liveKey) {
      return { status: 'session_expiry' };
    }
    title_ct = sealUtf8Sync(intake.title, liveKey, s);
    body_ct = sealUtf8Sync(intake.body, liveKey, s);
    if (intake.anonymous === false && intake.source_name_plaintext) {
      source_name_ct = sealUtf8Sync(intake.source_name_plaintext, liveKey, s);
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

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  // F-183-B adversarial (Finding 2) — an untrusted server row may carry a
  // null / non-string title_ct or body_ct (contract violation). Return an
  // EMPTY buffer for any non-string input so the per-row decode NEVER throws a
  // raw TypeError out of the composition (F-148: failures surface as a typed
  // union, never a throw). An empty buffer fails the AEAD length/MAC check in
  // openUtf8 → the row falls through to the typed `decrypt_failed` miss path,
  // identical to any other undecryptable row.
  if (typeof v !== 'string') return new Uint8Array(0);
  if (isHexString(v)) return pgHexToBytesLocal(v);
  // Fallback — treat as already-decoded hex without prefix.
  return pgHexToBytesLocal(v);
}

export async function listConcernsViaProduction(
  args: ListConcernsViaProductionArgs
): Promise<ListConcernsViaProductionResult> {
  const { concernClient, keyHolder } = args;

  // F182-9 / ADR-0031 Decision 4 — one guard per read op, shared by
  // ensureHolderPopulated (retired-only read escalation) AND the read-loop
  // escalate-on-miss below: at most ONE all-wraps fetch across the whole op.
  const guard: EscalationGuard = { used: false };
  const holderRes = await ensureHolderPopulated(args, 'read', guard);
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

  // Reads trial-decrypt over EVERY held epoch key (F182-2), so only require the
  // holder to hold SOME key material — a retired-only holding state still reads.
  if (!keyHolder.isPopulated()) {
    return { status: 'session_expiry' };
  }

  const rows = Array.isArray(list.data) ? (list.data as ListRowFromServer[]) : [];
  const now = Date.now();
  const items: ListedConcern[] = [];

  for (const row of rows) {
    // C2 / A-8.10-R — observe a per-row key_id hint if present. This is the
    // ADD-only path (`redesignateLiveIfHeld`), NEVER the demoting
    // `onKeyRotationObserved`: a list row can carry an OLDER epoch's key_id (a
    // pre-rotation row), and demoting on a stale row hint would wrongly clear
    // the live designation. Re-designate live only if the hinted key is held;
    // otherwise no-op. Demote is driven exclusively by the authoritative probe.
    if (typeof row.key_id === 'string' && row.key_id.length > 0) {
      keyHolder.redesignateLiveIfHeld(row.key_id);
    }
    // F182-2 trial-decrypt: a pre-rotation row opens under its own retired-epoch
    // key; the AEAD MAC is the sole authority (no epoch tag). A wrong key throws
    // → try the next; no held key authenticates → typed decrypt_failed (F-148,
    // the thrown libsodium error never propagates with buffer bytes).
    const titleBytes = toBytes(row.title_ct);
    const bodyBytes = toBytes(row.body_ct);
    const doOpen = () =>
      keyHolder.trialOpen(async (k) => ({
        title: await openUtf8(titleBytes, k),
        body: await openUtf8(bodyBytes, k)
      }));
    // F182-9 / ADR-0031 Decision 2 — escalate-on-miss. On the FIRST trialOpen
    // miss escalate ONCE (bounded by the shared guard), then RETRY; a miss that
    // PERSISTS after escalation is a genuine `decrypt_failed` (no wrong-key
    // plaintext ever surfaced, F-148). A real fetch fault is typed by AC-9.
    let opened = await doOpen();
    if (opened.status !== 'ok') {
      const esc = await escalateToAllEpochs(args, guard);
      if (esc.status === 'needs_recovery') return { status: 'needs_recovery' };
      if (esc.status === 'session_expiry') return { status: 'session_expiry' };
      if (esc.status === 'failed' && esc.http !== 0) {
        return { status: 'failed', reason: esc.reason, http: esc.http };
      }
      // F-183-B adversarial (Finding 1) — re-open on 'already' too, not just
      // 'escalated'. A concurrent op may have re-populated the SHARED holder
      // after this op's guard was spent (→ 'already'), so the row is now
      // openable; without the retry op A would spuriously lock out the whole
      // page. A genuinely never-held row still re-misses → decrypt_failed, and
      // 'already' fires NO new fetch, so the once-per-op RPC bound holds.
      if (esc.status === 'escalated' || esc.status === 'already') opened = await doOpen();
      if (opened.status !== 'ok') {
        emitBaselineMissDiagnostic({ keyHolder, escalated: guard.used, rowKeyId: row.key_id });
        return { status: 'failed', reason: 'decrypt_failed', http: 0 };
      }
    }
    const title = opened.value.title;
    const body = opened.value.body;

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

  // F182-9 / ADR-0031 Decision 4 — one guard per read op, shared by
  // ensureHolderPopulated + the single-record escalate-on-miss below.
  const guard: EscalationGuard = { used: false };
  const holderRes = await ensureHolderPopulated(args, 'read', guard);
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

  // Audit has committed — only now open the returned ciphertext. Reads
  // trial-decrypt over EVERY held epoch key (F182-2): a source_name sealed under
  // a retired epoch still opens. Require only that the holder holds SOME key
  // material (a mid-flight wipe empties it → session_expiry).
  if (!keyHolder.isPopulated()) {
    return { status: 'session_expiry' };
  }

  const sourceCt = reveal.data.source_name_ct;
  const doOpen = () => keyHolder.trialOpen((k) => openUtf8(sourceCt, k));
  // F182-9 / ADR-0031 Decision 2 — escalate-on-miss (single record). A retired-
  // epoch-sealed source_name opens after the once-per-op multi-epoch load; a
  // persistent post-escalation miss is a genuine `decrypt_failed`.
  let opened = await doOpen();
  if (opened.status !== 'ok') {
    const esc = await escalateToAllEpochs(args, guard);
    if (esc.status === 'needs_recovery') return { status: 'needs_recovery' };
    if (esc.status === 'session_expiry') return { status: 'session_expiry' };
    if (esc.status === 'failed' && esc.http !== 0) {
      return { status: 'failed', reason: esc.reason, http: esc.http };
    }
    // F-183-B adversarial (Finding 1) — re-open on 'already' too, not just
    // 'escalated'. A concurrent op may have re-populated the SHARED holder
    // after this op's guard was spent (→ 'already'), so the record is now
    // openable; a persistent miss still re-misses → decrypt_failed, and
    // 'already' fires NO new fetch (the once-per-op RPC bound holds).
    if (esc.status === 'escalated' || esc.status === 'already') opened = await doOpen();
    if (opened.status !== 'ok') {
      emitBaselineMissDiagnostic({ keyHolder, escalated: guard.used });
      return { status: 'failed', reason: 'decrypt_failed', http: 0 };
    }
  }
  return { status: 'ok', source_name: opened.value };
}
