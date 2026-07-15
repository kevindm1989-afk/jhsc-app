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
import {
  unwrapAllCommitteeKeysViaProduction,
  unwrapCommitteeDataKeyViaProduction
} from '../crypto';
import type { UnwrapCommitteeDataKeyResult } from '../crypto';
import { openUtf8, sealUtf8Sync } from '../concerns/seal';
import { ready } from '../crypto/sodium';
import { log } from '../log';
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
 * F182-9 / ADR-0031 Decision 4 — the once-per-read-op escalation guard (reprisal
 * mirror). One `{ used }` is shared BY REFERENCE across `ensureHolderPopulated`
 * (retired-only read branch) + `escalateToAllEpochs`, so the multi-epoch
 * disclosure RPC fires AT MOST ONCE per read op.
 */
interface EscalationGuard {
  used: boolean;
}

type EscalationOutcome =
  | { status: 'escalated' }
  | { status: 'already' }
  | { status: 'needs_recovery' }
  | { status: 'session_expiry' }
  | { status: 'failed'; reason: string; http: number };

/**
 * F182-9 / ADR-0031 Decision 2 — the bounded escalate-to-all-epochs seam (reprisal
 * mirror). READ PATH ONLY: NEVER wired into a seal path (re-pass trigger #15 /
 * F-190 envelope not widened). The guard is spent BEFORE the `await` so a
 * re-entrant miss cannot double-fetch.
 *
 * Fetch-fault typing (AC-9): 401 → wipe + `session_expiry`; a non-401 HTTP fault
 * → `failed` (kept OUT of `decrypt_failed`); a thrown / no-HTTP-verdict transport
 * (`http:0`) falls through to the persistent-miss `decrypt_failed`, fail-closed.
 *
 * F-145-C (Decision 6, ADD-not-wipe): `populate()` runs ONLY when the fetch ADDS
 * a not-yet-held epoch, so a no-new-epoch escalation never orphan-wipes a retained
 * read buffer.
 */
async function escalateToAllEpochs(
  args: EnsureHolderArgs,
  guard: EscalationGuard
): Promise<EscalationOutcome> {
  if (guard.used) return { status: 'already' };
  guard.used = true; // BOUND: spent synchronously BEFORE the await (no re-entry)
  const { t07Client, localIdentity, keyHolder, user_id } = args;
  const all = await unwrapAllCommitteeKeysViaProduction({
    client: t07Client,
    localIdentity,
    user_id
  });
  if (all.status === 'needs_recovery') return { status: 'needs_recovery' };
  if (all.status === 'failed') {
    if (all.http === 401) {
      keyHolder.onSessionRevoked();
      return { status: 'session_expiry' };
    }
    return { status: 'failed', reason: all.reason, http: all.http };
  }
  // F-VAL-1(b) (accepted pre-existing residual): a panic-wipe / 401 / unload
  // firing during the escalation fetch `await` above can resurrect the just-
  // wiped key map when this populate() resumes. The tracked fast-follow is a
  // uniform wipe-generation latch; do NOT paper over it with an `isPopulated()`
  // re-check here (a boolean is a FALSE-negative once populate() re-installs).
  const addsNewEpoch = all.entries.some((e) => !keyHolder.holdsKeyId(e.key_id));
  if (addsNewEpoch) keyHolder.populate(all.entries);
  return { status: 'escalated' };
}

/**
 * F182-9 / ADR-0031 Decision 5 (F-183-B-OBS, reprisal mirror) — key-material-free
 * missing-epoch-vs-corrupt telemetry on a persistent post-escalation read miss. A
 * COUNT of held epochs + `escalated`; NEVER a key_id VALUE / key bytes / plaintext
 * (F-148). The reprisal read carries no per-record key_id hint (ADR-0028 option
 * (a)), so `row_epoch_held` is omitted (classified corrupt/tamper by telemetry).
 */
function emitBaselineMissDiagnostic(opts: {
  keyHolder: CommitteeKeyHolder;
  escalated: boolean;
}): void {
  log.warn({
    event: 'reprisal.baseline_multiepoch_read_miss',
    attributes: { escalated: opts.escalated, epochs_held: opts.keyHolder.size() }
  });
}

/**
 * Probe-first guard + lazy unwrap (Decision 7 / F-163). Always consults the
 * cheap metadata probe BEFORE touching the disclosure RPC — a no-wrap actor
 * never reaches `get_key_wrap`. When the holder is already populated AND the
 * probe reports the SAME key_id, we skip the disclosure RPC entirely (Decision
 * 1 dwell policy: one unwrap per session). When the probe reports a NEWER
 * key_id than the cached one, the probe-driven self-heal DEMOTES the stale live
 * key and re-populates ALL wraps under the new epoch (F-162 / F-183-R /
 * A-8.10-R).
 *
 * `mode` is a STATIC per-call-site literal (never derived from wire input):
 *   - `'seal'` (submit / update) — UNCHANGED, fail-closed. A retired-only member
 *     returns `needs_setup`; the seal path NEVER escalates (re-pass trigger #15).
 *   - `'read'` (read) — a retired-only member is ESCALATED to READ (Decision 3)
 *     via the shared once-per-op `guard`.
 */
async function ensureHolderPopulated(
  args: EnsureHolderArgs,
  mode: 'read' | 'seal',
  guard: EscalationGuard
): Promise<EnsureHolderResult> {
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

  // F-162 / ADR-0030 Decision 6.3 / A-8.10-R — probe-driven rotation self-heal.
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
    const all = await unwrapAllCommitteeKeysViaProduction({
      client: t07Client,
      localIdentity,
      user_id
    });
    if (all.status === 'needs_recovery') return { status: 'needs_recovery' };
    if (all.status === 'failed') {
      if (all.http === 401) {
        keyHolder.onSessionRevoked();
        return { status: 'session_expiry' };
      }
      return { status: 'failed', reason: all.reason, http: all.http };
    }
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
  const unwrap: UnwrapCommitteeDataKeyResult = await unwrapCommitteeDataKeyViaProduction({
    client: t07Client,
    localIdentity,
    user_id
  });
  if (unwrap.status === 'no_wrap') {
    // F182-9 / ADR-0031 Decision 3 — a retired-only remaining member: READ mode
    // escalates so the retired-sealed record still opens; SEAL mode stays
    // fail-closed to `needs_setup` (no live key to seal — re-pass trigger #15).
    if (mode === 'read') {
      const esc = await escalateToAllEpochs(args, guard);
      if (esc.status === 'needs_recovery') return { status: 'needs_recovery' };
      if (esc.status === 'session_expiry') return { status: 'session_expiry' };
      if (esc.status === 'failed') return { status: 'failed', reason: esc.reason, http: esc.http };
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
  // any disclosure RPC OR submit POST. SEAL mode — NEVER escalates (re-pass
  // trigger #15 / F-190); the guard is a throwaway on the seal path.
  const holderRes = await ensureHolderPopulated(args, 'seal', { used: false });
  if (holderRes.status !== 'ok') return holderRes;

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    // Defensive — the holder vanished between ensure + use (a concurrent wipe).
    // Surface as session_expiry so the UI routes to re-sign-in.
    return { status: 'session_expiry' };
  }

  // F-190 / re-pass trigger #13 (mid-seal liveness TOCTOU). Resolve libsodium
  // ONCE up front so the seal carries NO `await` between the liveness re-check
  // and the synchronous secretbox — the gap `sealUtf8`'s internal `await
  // ready()` used to open. A wipe (panic/401/unload) OR a rotation-observing
  // self-heal `populate([...fresh])` firing in that gap would zero the captured
  // `dataKey` BY REFERENCE, and the resuming secretbox would seal under an
  // all-zero key (world-readable post-F-145-C). Seal title + body in a try/catch
  // so a libsodium failure cannot propagate with buffer bytes (F-161 / F-167).
  let title_ct: Uint8Array;
  let body_ct: Uint8Array;
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

  // F182-9 / ADR-0031 Decision 4 — one guard per read op, shared by
  // ensureHolderPopulated (retired-only read) + the escalate-on-miss below.
  const guard: EscalationGuard = { used: false };
  const holderRes = await ensureHolderPopulated(args, 'read', guard);
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

  // Audit has committed — only now open the returned ciphertext. Reads
  // trial-decrypt over EVERY held epoch key (F182-2): a pre-rotation record
  // opens under its own retired-epoch key. Require only that the holder holds
  // SOME key material (a mid-flight wipe empties it → session_expiry).
  if (!keyHolder.isPopulated()) {
    return { status: 'session_expiry' };
  }

  // F-148 / F-167 / F-183 iii — secretbox is AEAD; a wrong/stale key or tampered
  // ct THROWS. trialOpen tries each held key and swallows the throw (never
  // propagates buffer bytes), returning the SAME key's title+body or a typed
  // unavailable; the opened plaintext is never returned on failure.
  const titleCt = read.data.title_ct;
  const bodyCt = read.data.body_ct;
  const doOpen = () =>
    keyHolder.trialOpen(async (k) => ({
      title: await openUtf8(titleCt, k),
      body: await openUtf8(bodyCt, k)
    }));
  // F182-9 / ADR-0031 Decision 2 — escalate-on-miss (single record). A retired-
  // epoch-sealed record opens after the once-per-op multi-epoch load; a
  // persistent post-escalation miss is a genuine `decrypt_failed` (F-148). A real
  // fetch fault is typed by AC-9 (401 → session_expiry; non-401 → failed).
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

  return { status: 'ok', title: opened.value.title, body: opened.value.body };
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

  // SEAL mode — fail-closed, NEVER escalates (re-pass trigger #15 / F-190).
  const holderRes = await ensureHolderPopulated(args, 'seal', { used: false });
  if (holderRes.status !== 'ok') return holderRes;

  const dataKey = keyHolder.getDataKey();
  if (!dataKey) {
    return { status: 'session_expiry' };
  }

  // Seal only the provided field(s). A field left undefined is omitted from the
  // wire body so the SQL treats it as NULL = unchanged (F-31). Wrap the seal in
  // try/catch so a libsodium failure surfaces typed (F-161 / F-167).
  //
  // F-190 / re-pass trigger #13 (mid-seal liveness TOCTOU). Resolve libsodium
  // ONCE up front so the seal carries NO `await` between the liveness re-check
  // and the synchronous secretbox — the gap `sealUtf8`'s internal `await
  // ready()` used to open. A wipe (panic/401/unload) OR a rotation-observing
  // self-heal `populate([...fresh])` firing in that gap would zero the captured
  // `dataKey` BY REFERENCE, and the resuming secretbox would seal under an
  // all-zero key (world-readable post-F-145-C).
  const sealInput: { id: string; title_ct?: Uint8Array; body_ct?: Uint8Array } = { id };
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
    if (title !== undefined) sealInput.title_ct = sealUtf8Sync(title, liveKey, s);
    if (body !== undefined) sealInput.body_ct = sealUtf8Sync(body, liveKey, s);
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
