/**
 * Production composition layer — high-level onboarding/restore flows
 * routed through `SupabaseT07Client` + `BrowserLocalIdentityStore` +
 * libsodium (T07.1 / G-T07-2 follow-up).
 *
 * Three flows mirror the test-orchestrator entry points in `./index.ts`
 * (`enrollIdentityKeypair`, `storeRecoveryBlob`, `restoreFromRecoveryBlob`)
 * but route through the production client instead of `MemoryKeyStore`:
 *
 *   - enrollIdentityViaProduction:
 *       generate keypair → F-02 self-test → drive the sealed-box
 *       challenge (init → unseal → finalize); on success the public half
 *       lands in `identity_keys` server-side and the private half lands
 *       in IndexedDB device-side.
 *
 *   - storeRecoveryBlobViaProduction:
 *       read privkey from `localIdentity` → Argon2id-KDF +
 *       secretbox-seal under the passphrase → envelope as
 *       [salt][nonce][ciphertext] → POST via
 *       `client.storeRecoveryBlob`. F-08 floor enforced by
 *       `encryptRecoveryBlob`.
 *
 *   - restoreRecoveryBlobViaProduction:
 *       `client.getRecoveryBlob` (migration 0010, PR #33) → slice the
 *       envelope back → `decryptRecoveryBlob` under the passphrase → on
 *       success, persist the recovered privkey to `localIdentity` and
 *       POST `client.recordRecoveryBlobRestored` so the server-side
 *       audit-trail records the restore. The device-fingerprint hashing
 *       happens here (libsodium BLAKE2b-32) so the production callers
 *       just pass the raw fingerprint string and we forward only the
 *       hash.
 *
 * Every flow is wire-shaped: failures route through a discriminated
 * union return so UI callers can pattern-match on a single value.
 * Test surface: hermetic with a mock transport + a real
 * BrowserLocalIdentityStore (SSR-fallback Map) + real libsodium.
 */

import { decryptRecoveryBlob, encryptRecoveryBlob, KDF_PARAMS } from './recovery-blob';
import { generateIdentityKeypair, pubkeyFingerprint, selfTestKeypair } from './identity-keys';
import { ready } from './sodium';
import { SupabaseT07Client, type T07OpReason } from './supabase-t07-client';
import { CommitteeKeyHolder } from './committee-key-holder';
import type { LocalIdentityStore } from './key-store';
import type { KdfParams } from './types';

// ---------------------------------------------------------------------------
// Enrollment (F-02 sealed-box challenge end-to-end)
// ---------------------------------------------------------------------------

export type EnrollProductionResult =
  | { status: 'ok'; user_id: string; public_key: Uint8Array; fingerprint: string }
  | { status: 'rejected'; reason: 'pairing_self_test_failed' }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * End-to-end production enrollment.
 *
 * 1. Generate identity keypair (libsodium `crypto_box_keypair` —
 *    Invariant 4: libsodium only; never `Math.random` etc.).
 * 2. F-02 client-side self-test (`selfTestKeypair`). On failure we
 *    REFUSE to touch the server (the keypair is internally inconsistent;
 *    no audit row should land for a doomed enrollment).
 * 3. Drive the sealed-box challenge through `client.enrollIdentityViaChallenge`,
 *    supplying a libsodium `crypto_box_seal_open` callback. The client
 *    persists the privkey to `localIdentity` only after the server
 *    accepts the unsealed nonce.
 */
export async function enrollIdentityViaProduction(opts: {
  client: SupabaseT07Client;
  user_id: string;
}): Promise<EnrollProductionResult> {
  const kp = await generateIdentityKeypair();
  const passes = await selfTestKeypair(kp);
  if (!passes) return { status: 'rejected', reason: 'pairing_self_test_failed' };
  const fp = await pubkeyFingerprint(kp.public_key);

  const r = await opts.client.enrollIdentityViaChallenge({
    user_id: opts.user_id,
    public_key: kp.public_key,
    private_key: kp.private_key,
    pubkey_fingerprint: fp,
    unsealNonce: async (sealed, pk, sk) => {
      const s = await ready();
      return s.crypto_box_seal_open(sealed, pk, sk);
    }
  });
  if (!r.ok) return { status: 'failed', reason: r.reason, http: r.status };
  return { status: 'ok', user_id: r.user_id, public_key: kp.public_key, fingerprint: fp };
}

// ---------------------------------------------------------------------------
// Recovery blob — store (write the sealed envelope)
// ---------------------------------------------------------------------------

export type StoreRecoveryProductionResult =
  | { status: 'ok'; kdf_params: KdfParams }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * Read the privkey from the device-local store, encrypt it under the
 * passphrase, and post the envelope. The on-wire format is
 * `[salt(16)][nonce(24)][ciphertext]` — matching the slice arithmetic in
 * the restore flow below.
 */
export async function storeRecoveryBlobViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
  passphrase: string;
}): Promise<StoreRecoveryProductionResult> {
  const priv = await opts.localIdentity.getIdentityPrivateKey(opts.user_id);
  const blob = await encryptRecoveryBlob(priv, opts.passphrase);
  const envelope = new Uint8Array(blob.salt.length + blob.nonce.length + blob.ciphertext.length);
  envelope.set(blob.salt, 0);
  envelope.set(blob.nonce, blob.salt.length);
  envelope.set(blob.ciphertext, blob.salt.length + blob.nonce.length);

  const r = await opts.client.storeRecoveryBlob({
    blob_ciphertext: envelope,
    kdf_params: blob.kdf_params as unknown as Record<string, unknown>
  });
  if (!r.ok) return { status: 'failed', reason: r.reason, http: r.status };
  return { status: 'ok', kdf_params: blob.kdf_params };
}

// ---------------------------------------------------------------------------
// Recovery blob — restore (decrypt on a new device + audit)
// ---------------------------------------------------------------------------

export type RestoreRecoveryProductionResult =
  | {
      status: 'ok';
      public_key: Uint8Array;
      private_key: Uint8Array;
    }
  | { status: 'not_found' }
  | { status: 'wrong_passphrase' }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * Restore an identity from a server-stored recovery blob.
 *
 * 1. `client.getRecoveryBlob()` — structurally self-only (migration 0010).
 *    Null → `{ status: 'not_found' }`.
 * 2. Slice the envelope into `{ salt, nonce, ciphertext }`.
 * 3. `decryptRecoveryBlob` under the passphrase.
 *    Null → `{ status: 'wrong_passphrase' }`.
 * 4. On success: persist the recovered privkey to `localIdentity`,
 *    BLAKE2b-hash the device-fingerprint argument, post
 *    `client.recordRecoveryBlobRestored` so the audit row lands with
 *    a hashed device fingerprint (Amendment A: no raw UA).
 */
export async function restoreRecoveryBlobViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
  passphrase: string;
  device_fingerprint_raw: string;
}): Promise<RestoreRecoveryProductionResult> {
  const fetched = await opts.client.getRecoveryBlob();
  if (!fetched.ok) {
    return { status: 'failed', reason: fetched.reason, http: fetched.status };
  }
  if (!fetched.data) return { status: 'not_found' };

  const envelope = fetched.data.blob_ciphertext;
  const SALT = 16;
  const NONCE = 24;
  if (envelope.length < SALT + NONCE + 1) {
    // Envelope shape violation — treat as not_found so the UI surfaces a
    // useful "no recovery blob" path instead of a stack trace.
    return { status: 'not_found' };
  }
  const recovered = await decryptRecoveryBlob(
    {
      salt: envelope.slice(0, SALT),
      nonce: envelope.slice(SALT, SALT + NONCE),
      ciphertext: envelope.slice(SALT + NONCE),
      kdf_params: fetched.data.kdf_params as unknown as KdfParams
    },
    opts.passphrase
  );
  if (!recovered) return { status: 'wrong_passphrase' };

  // Persist the recovered privkey to the device-local store BEFORE
  // posting the restore audit row — so the audit row only fires when the
  // on-device state is consistent with the server-side claim.
  await opts.localIdentity.storeIdentityPrivateKey(opts.user_id, recovered.private_key);

  const s = await ready();
  // Browser-native UTF-8 encode (TextEncoder is a global in browsers, Node
  // 11+, jsdom, and Deno; `Buffer` is undefined in the Vite browser bundle).
  // The `new Uint8Array(...)` re-wrap normalises the encoder output into the
  // runtime's own Uint8Array constructor for the libsodium wasm bridge.
  const fpBytes = s.crypto_generichash(
    32,
    new Uint8Array(new TextEncoder().encode(opts.device_fingerprint_raw))
  );
  const fpHex = s.to_hex(fpBytes);

  const audit = await opts.client.recordRecoveryBlobRestored({
    device_fingerprint_hashed: fpHex
  });
  if (!audit.ok) {
    return { status: 'failed', reason: audit.reason, http: audit.status };
  }

  return {
    status: 'ok',
    public_key: recovered.public_key,
    private_key: recovered.private_key
  };
}

// ---------------------------------------------------------------------------
// Committee data key — init + self-wrap (ADR-0026 Decision 2 + Amendment A)
// ---------------------------------------------------------------------------

export type InitCommitteeKeyProductionResult =
  | { status: 'ok'; key_id: string; epoch: number }
  // The live key already carries a confirmed actor wrap — nothing to do
  // (resume success-equivalent; AC-4 / AC-5d).
  | { status: 'already_initialised' }
  // Edge-A sub-case (a): a live key exists, some OTHER member holds a wrap,
  // the actor does not — and the actor holds no key material to self-wrap.
  // Recoverable: another key-holder must grant access, or the actor restores
  // their own prior access (Amendment A Ruling 2; AC-5c).
  | { status: 'foreign_held'; key_id: string }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * The one net-new production composition function (ADR-0026 Decision 2,
 * corrected by Amendment A). Composes `SupabaseT07Client.initCommitteeDataKey`
 * / `wrapCommitteeDataKeyForMember` / `rotateCommitteeDataKey` /
 * `finalizeCommitteeDataKeyRotation` + the client-side data-key generation +
 * seal-to-pubkey that `committee-key.ts:initCommitteeDataKey` does against the
 * test-only `KeyStore`. Unlike that test-only path this one ZEROIZES the
 * plaintext data key before returning (F-132 / AC-8 — the test path omits it)
 * and delegates audit emission to the SECURITY DEFINER SQL (Amendment A
 * single-emission-path).
 *
 * Resume semantics (Amendment A — branch on WRAP COUNT, never actor-wrap
 * presence):
 *  - probe the live (`rotated_at IS NULL`) key FIRST (a pure read):
 *      • no live key            → fresh init (generate → wrap under new key).
 *      • live key, actor wrapped → `already_initialised` (confirmed actor wrap;
 *                                  never reported "done" without one — AC-5d).
 *      • live key, zero wraps    → TRUE edge-A: rotate('incident') retires the
 *                                  dead key, then init-equivalent under the
 *                                  fresh key_id; finalize the rotation (AC-5b).
 *      • live key, foreign-held  → `foreign_held` recoverable error; no init,
 *                                  no rotate, no self-wrap (AC-5c).
 *
 * The plaintext 32-byte data key exists ONLY in this function's local scope,
 * crosses no trust boundary in cleartext, and is `.fill(0)`-zeroized on every
 * exit path that generated one.
 *
 * `actor_public_key` is passed in (not re-fetched) — the orchestrator already
 * holds the freshly-enrolled pubkey from the enroll step. The sealed-box wrap
 * needs only the recipient PUBLIC key, so no privkey read happens here;
 * `localIdentity` is threaded for symmetry with the sibling flows.
 */
export async function initCommitteeDataKeyViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
  actor_public_key: Uint8Array;
}): Promise<InitCommitteeKeyProductionResult> {
  // 0. F-138 / AC-5d load-bearing invariant: a non-32-byte actor pubkey can
  //    NEVER create a server-side key it cannot wrap. libsodium's
  //    `crypto_box_seal` rejects any recipient key whose length !== 32, and it
  //    does so only AFTER we'd already minted (init_key) or rotated a live key
  //    — leaving a permanent zero-wrap dead key + an unrecoverable retry loop.
  //    Validate the pubkey BEFORE any state-mutating RPC (or even the probe):
  //    return the wire-shaped failure, never throw, never call init_key/rotate.
  if (opts.actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  // 1. Probe the live key state FIRST. The wrap COUNT is the discriminator
  //    the resume branch needs (Amendment A Ruling 1); a failed probe (401 /
  //    403) is surfaced verbatim so the card can split session-required from
  //    rls-denied (AC-6 / F-130).
  const probe = await opts.client.getCommitteeKeyState({ actor_user_id: opts.user_id });
  if (!probe.ok) return { status: 'failed', reason: probe.reason, http: probe.status };

  if (probe.data) {
    // A live key already exists — resume branch.
    if (probe.data.actor_has_wrap) {
      // AC-4 / AC-5d: confirmed actor wrap under the current (non-retired)
      // key — success-equivalent. No data key minted, no rotation.
      return { status: 'already_initialised' };
    }
    if (probe.data.wrap_count > 0) {
      // AC-5c: foreign-held. The actor holds no plaintext key to self-wrap.
      // Explicit recoverable error — never init/rotate/self-wrap, never a
      // silent "done".
      return { status: 'foreign_held', key_id: probe.data.key_id };
    }
    // AC-5b — TRUE edge-A: zero wraps for ANY member. The dead key's bytes
    // are irretrievably lost (process died between init_key and the first
    // wrap). Retire it via rotation and re-init under the fresh key_id; never
    // wrap_member against the dead key_id (no divergent key under a stale id).
    return repairZeroWrapKey({ ...opts, dead_epoch: probe.data.epoch });
  }

  // 2. No live key — fresh init.
  return freshInit(opts);
}

/**
 * Fresh-init path (AC-2 / AC-5a): mint the metadata via `init_key`, generate a
 * 32-byte data key client-side, seal it to the actor's pubkey, persist the
 * self-wrap, then zeroize. A concurrent init that already landed surfaces as
 * `already_initialised` (P0001) — mapped to the resume success-equivalent.
 */
async function freshInit(opts: {
  client: SupabaseT07Client;
  user_id: string;
  actor_public_key: Uint8Array;
}): Promise<InitCommitteeKeyProductionResult> {
  // F-138 / AC-5d defense-in-depth: never call init_key toward a wrap we cannot
  // perform. A non-32-byte pubkey would make `crypto_box_seal` throw AFTER
  // init_key already minted a live key — the exact zero-wrap dead key F-138
  // forbids. Validate BEFORE init_key. (The public entry point guards too; this
  // keeps the invariant local to every state-mutating path.)
  if (opts.actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  const init = await opts.client.initCommitteeDataKey();
  if (!init.ok) {
    // A racing init that already initialised the key maps to the resume
    // success-equivalent; everything else (401 / 403 / 422 …) is a failure.
    if (init.reason === 'already_initialised') return { status: 'already_initialised' };
    return { status: 'failed', reason: init.reason, http: init.status };
  }

  const s = await ready();
  const dataKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  try {
    const wrap = s.crypto_box_seal(dataKey, opts.actor_public_key);
    const wrapped = await opts.client.wrapCommitteeDataKeyForMember({
      member_user_id: opts.user_id,
      key_id: init.data.key_id,
      wrapped_ciphertext: wrap,
      rotation_id: null
    });
    if (!wrapped.ok) {
      // F-138 edge-A mitigation at the source: `init_key` minted a key but the
      // self-wrap failed, so we are ONE step from leaving a zero-wrap dead key
      // (the exact F-138 hazard). When the failure is NOT an auth failure
      // (a 401/403 means the session/permission is gone — a follow-on retire
      // would be denied too, and the resume path repairs it), proactively
      // retire the stillborn key so no silent zero-wrap key is left behind.
      // Best-effort: if the retire itself fails we still surface the original
      // wrap failure (the resume path's wrap-count probe is the backstop).
      if (wrapped.status !== 401 && wrapped.status !== 403) {
        try {
          await opts.client.rotateCommitteeDataKey({ trigger: 'incident' });
        } catch {
          // Swallow — the original failure below is the user-facing outcome;
          // the resume probe (Amendment A Ruling 1) is the durable backstop.
        }
      }
      return { status: 'failed', reason: wrapped.reason, http: wrapped.status };
    }
    return { status: 'ok', key_id: init.data.key_id, epoch: init.data.epoch };
  } finally {
    // F-132 / AC-8: the plaintext data key must not linger for GC.
    dataKey.fill(0);
  }
}

/**
 * Edge-A repair (AC-5b / Amendment A Ruling 3): the live key has zero wraps,
 * so its bytes are unrecoverable. Retire it via `rotate('incident')`, generate
 * a FRESH 32-byte key, self-wrap under the NEW key_id, and finalize the
 * rotation. Confirmation that abandoning the dead key loses nothing: in the
 * Phase-0a ceremony no committee data can ever be sealed under a not-yet-
 * wrapped key (Ruling 3's load-bearing invariant), so a zero-wrap key has zero
 * ciphertext beneath it.
 */
async function repairZeroWrapKey(opts: {
  client: SupabaseT07Client;
  user_id: string;
  actor_public_key: Uint8Array;
  dead_epoch: number;
}): Promise<InitCommitteeKeyProductionResult> {
  // F-138 / AC-5d defense-in-depth: never rotate (a state-mutating RPC) toward
  // a wrap we cannot perform. A non-32-byte pubkey would make `crypto_box_seal`
  // throw AFTER the rotate already retired the dead key and minted a new one —
  // a fresh zero-wrap key. Validate BEFORE rotate so the repair can never
  // compound the very condition it exists to clear. (The public entry point
  // guards too; this keeps the invariant local to this state-mutating path.)
  if (opts.actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  // 'incident' is the closest honest trigger value (Amendment A's trigger-gap
  // note); a dedicated 'stillborn_init' value is explicitly out of scope.
  const rotation = await opts.client.rotateCommitteeDataKey({ trigger: 'incident' });
  if (!rotation.ok) return { status: 'failed', reason: rotation.reason, http: rotation.status };

  const s = await ready();
  const dataKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  try {
    const wrap = s.crypto_box_seal(dataKey, opts.actor_public_key);
    const wrapped = await opts.client.wrapCommitteeDataKeyForMember({
      member_user_id: opts.user_id,
      key_id: rotation.data.new_key_id,
      wrapped_ciphertext: wrap,
      rotation_id: rotation.data.rotation_id
    });
    if (!wrapped.ok) return { status: 'failed', reason: wrapped.reason, http: wrapped.status };

    const finalized = await opts.client.finalizeCommitteeDataKeyRotation({
      rotation_id: rotation.data.rotation_id,
      new_key_id: rotation.data.new_key_id,
      members_rewrapped_count: 1
    });
    if (!finalized.ok)
      return { status: 'failed', reason: finalized.reason, http: finalized.status };

    // `rotate_committee_data_key` mints the new key at dead_epoch + 1 (the
    // SQL allocates epoch = max(epoch)+1, and the dead key was the max). The
    // epoch is metadata only (F-135); the card round-trips via the wrap.
    return { status: 'ok', key_id: rotation.data.new_key_id, epoch: opts.dead_epoch + 1 };
  } finally {
    // F-132 / AC-8: zeroize the fresh plaintext key on every exit.
    dataKey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Committee data key — unwrap (ADR-0027 Decision 2 / PR1 / threat-model §3.16
// F-142 / F-144 / F-148 / F-151)
// ---------------------------------------------------------------------------

export type UnwrapCommitteeDataKeyResult =
  // The 32-byte plaintext committee data key, recovered by opening the actor's
  // own sealed wrap with the device-local identity privkey. The caller (the
  // CommitteeKeyHolder, Decision 1) takes ownership of `data_key` BY REFERENCE
  // and owns its zeroization lifecycle — this composition does NOT `.fill(0)`
  // here (a premature wipe would defeat the session cache; Decision 2 step 5).
  | { status: 'ok'; data_key: Uint8Array; key_id: string; epoch: number }
  // The metadata probe says the actor holds no wrap (or the disclosure RPC
  // found no live-key row in a race). Route to Phase 0a setup (Decision 7);
  // the disclosure RPC is NOT hit when the probe already says no (F-144).
  | { status: 'no_wrap' }
  // A server-side wrap exists but the device has no identity privkey to open
  // it. Route to restore-from-recovery (never re-enroll); ADR-0026 AC-7.
  | { status: 'needs_recovery' }
  // A typed failure surface — NEVER a thrown raw exception (which could carry
  // buffer bytes in its message/stack, F-148). `decrypt_failed` is the
  // wrong-privkey / tampered-ciphertext case (AEAD fails open-verify, F-142);
  // 401/403 are surfaced verbatim so the caller can split session-expiry from
  // generic-forbidden (AC-8 / F-130).
  | { status: 'failed'; reason: T07OpReason | 'decrypt_failed'; http: number };

/**
 * Compose the committee-key unwrap (Decision 2). Probe-FIRST (Decision 7 /
 * F-144): read the cheap metadata `getCommitteeKeyState` before any key-material
 * disclosure — a no-wrap actor is routed to setup WITHOUT ever hitting the
 * disclosure RPC. Only when the probe confirms a wrap do we fetch the sealed
 * wrap via `getCommitteeKeyWrapForSelf` (the server emits the
 * `committee_data_key.unwrap` audit row audit-before-return; this composition
 * emits NO client-side audit, F-151), open it with the device-local identity
 * privkey via `crypto_box_seal_open`, and hand the plaintext data key back by
 * reference.
 *
 * libsodium-only (ADR-0003 Invariant 4). NEVER logs key material (F-148): no
 * `console.*`, no thrown exception carrying bytes — every failure is a typed
 * union value.
 */
export async function unwrapCommitteeDataKeyViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
}): Promise<UnwrapCommitteeDataKeyResult> {
  // 1. Probe-FIRST (Decision 7 / F-144): metadata only, no key material. A
  //    no-wrap actor never reaches the disclosure RPC.
  const probe = await opts.client.getCommitteeKeyState({ actor_user_id: opts.user_id });
  if (!probe.ok) return { status: 'failed', reason: probe.reason, http: probe.status };
  if (!probe.data || !probe.data.actor_has_wrap) {
    return { status: 'no_wrap' };
  }

  // 2. Fetch the actor's OWN sealed wrap (the disclosure RPC; F-142). The
  //    server emits committee_data_key.unwrap audit-before-return (F-151).
  const wrap = await opts.client.getCommitteeKeyWrapForSelf();
  if (!wrap.ok) return { status: 'failed', reason: wrap.reason, http: wrap.status };
  if (!wrap.data) {
    // Probe said yes but the disclosure RPC found no row (a race against a
    // concurrent rotation/revoke). Treat as no_wrap → route to setup.
    return { status: 'no_wrap' };
  }

  // 3. Read the device-local identity privkey. Absent → needs_recovery (the
  //    wrap exists server-side but cannot be opened on this device; route to
  //    restore-from-recovery, ADR-0026 AC-7). `getIdentityPrivateKey` throws
  //    when no key is stored — catch and map, never propagate (F-148).
  let priv: Uint8Array;
  try {
    priv = await opts.localIdentity.getIdentityPrivateKey(opts.user_id);
  } catch {
    return { status: 'needs_recovery' };
  }

  // 4. Open the anonymous sealed-box wrap. `crypto_box_seal` is sender-
  //    anonymous, so opening needs BOTH halves of the recipient keypair; the
  //    public half is derived from the privkey via crypto_scalarmult_base
  //    (X25519 base-point mult — the libsodium box-keypair-from-secret path).
  //    A wrong privkey / tampered ciphertext fails AEAD verification and
  //    throws — caught and mapped to a typed decrypt_failed, never propagated
  //    (F-142 sealed-scope / F-148 no-leak).
  const s = await ready();
  let dataKey: Uint8Array;
  try {
    const pub = s.crypto_scalarmult_base(priv);
    dataKey = s.crypto_box_seal_open(wrap.data.wrapped_ciphertext, pub, priv);
  } catch {
    return { status: 'failed', reason: 'decrypt_failed', http: 200 };
  }

  // 5. Hand back the LIVE plaintext key by reference — the holder owns the
  //    zeroization lifecycle (Decision 2 step 5). No .fill(0) here.
  return { status: 'ok', data_key: dataKey, key_id: wrap.data.key_id, epoch: wrap.data.epoch };
}

// ---------------------------------------------------------------------------
// ADR-0029 P1-5 — grant committee-key access to a member (the co-chair-side
// composition; threat-model §3.18 F-172 / F-174 / F-176).
// ---------------------------------------------------------------------------

/**
 * Discriminated-union return for `wrapMemberInViaProduction`.
 *
 *   ok                          — the wrap landed server-side (Decision 5
 *                                 step 4 succeeded; the target now holds a
 *                                 wrap under the live committee key).
 *   member_not_enrolled         — the disclosure RPC reported the target has
 *                                 no enrolled identity (F-174 closed denial
 *                                 collapses pending / unenrolled / non-member /
 *                                 non-existent). UI surfaces "this member
 *                                 isn't ready yet."
 *   failed/pubkey_disclosure_denied — the disclosure RPC denied the caller
 *                                 (non-co-chair / dead session). Distinct
 *                                 from member_not_enrolled — DIFFERENT UI
 *                                 message.
 *   failed/actor_has_no_wrap    — the co-chair holds no live-key wrap and
 *                                 the holder is empty. We do NOT hit the
 *                                 disclosure RPC in this case (F-174
 *                                 information-hiding: no audit row for an
 *                                 aborted grant).
 *   failed/data_key_unwrap_failed — the actor's wrap exists server-side but
 *                                 the device cannot unwrap it (needs_recovery
 *                                 / wrong privkey / decrypt failure).
 *   failed/wrap_post_failed     — wrap_member RPC failed (e.g. F-172 active-
 *                                 member re-assert at 00000000000007:502-503
 *                                 fires because the target deactivated
 *                                 mid-flow).
 *   failed/decrypt_failed       — defensive bridge to UnwrapCommitteeDataKeyResult
 *                                 (the wrap was readable but bytes failed AEAD).
 *   failed/invalid_pubkey       — the server returned a non-32-byte pubkey
 *                                 (a structural defense — crypto_box_seal
 *                                 would throw anyway, but we typed-fail
 *                                 before throwing into libsodium).
 *   failed/unknown              — every other transport / crypto exception
 *                                 (F-148 carry-forward: NEVER propagate a
 *                                 raw thrown error which could carry buffer
 *                                 bytes in its .message / .stack).
 */
export type WrapMemberInResult =
  | { status: 'ok' }
  | { status: 'member_not_enrolled' }
  | {
      status: 'failed';
      reason:
        | 'pubkey_disclosure_denied'
        | 'actor_has_no_wrap'
        | 'data_key_unwrap_failed'
        | 'wrap_post_failed'
        | 'decrypt_failed'
        | 'invalid_pubkey'
        | 'unknown';
      http?: number;
    };

/**
 * Compose the co-chair-side "grant committee-key access to a member" path
 * (ADR-0029 Decision 5 + Amendment A-8.6; threat-model §3.18 F-172 / F-174 /
 * F-176 / F-179).
 *
 * A-8.6 SINGLE-DISCLOSURE: the caller (the F-172 confirm screen) performs the
 * ONE `getMemberPubkey` disclosure and hands the confirmed
 * `disclosed:{public_key, fingerprint}` down; this composition no longer
 * discloses internally (which would be a SECOND disclosure and re-open the
 * TOCTOU the confirm screen closes).
 *
 * Step 1 — Ensure the actor's `CommitteeKeyHolder` is populated. If empty,
 *          run `unwrapCommitteeDataKeyViaProduction` (probe + unwrap). A
 *          no-wrap actor short-circuits to `actor_has_no_wrap` BEFORE any
 *          seal (F-174 information-hiding: no wrap for an aborted grant).
 * Step 2 — Validate the caller's `disclosed` pubkey structurally (32 bytes)
 *          and re-derive `pubkeyFingerprint(disclosed.public_key)`, requiring
 *          it to equal the confirmed `disclosed.fingerprint`. A mismatch (or a
 *          missing/malformed `disclosed`) typed-fails as `invalid_pubkey` with
 *          NO seal and NO POST (F-179 mitigation #3; the confirmed bytes ARE
 *          the sealed bytes — F-172 TOCTOU closed).
 * Step 3 — Seal `holder.data_key` to `disclosed.public_key` via libsodium
 *          `crypto_box_seal` (sender-anonymous; sealed-box, not secretbox —
 *          Decision 5 step 3).
 * Step 4 — POST `client.wrapCommitteeDataKeyForMember(...)` with the sealed
 *          bytes. `rotation_id` is null (non-rotation grant).
 * Step 5 — The composition does NOT zeroize `holder.data_key` (Decision 5
 *          step 5: the co-chair still needs key access; the holder owns its
 *          own lifecycle).
 *
 * F-148 / F-176: every crypto / transport exception is caught and mapped to
 * a typed failure. The plaintext data key, the target pubkey/privkey, the
 * actor privkey, the sealed ciphertext, the target uid, the actor uid, and
 * the fingerprint NEVER appear in any logger / sessionStorage / localStorage
 * / URL. No `console.*` calls in this composition.
 *
 * F-172 attempted-bypass: only the six named fields cross into the
 * composition; any OTHER smuggled pubkey field in opts is dropped by the
 * destructure. The seal target is always `disclosed.public_key`, which is
 * re-checked against its own confirmed fingerprint before it is used.
 */
export async function wrapMemberInViaProduction(opts: {
  client: SupabaseT07Client;
  holder: CommitteeKeyHolder;
  localIdentity: LocalIdentityStore;
  user_id: string;
  target_user_id: string;
  disclosed: { public_key: Uint8Array; fingerprint: string };
}): Promise<WrapMemberInResult> {
  // A-8.6 single-disclosure: the caller (the F-172 confirm screen) disclosed the
  // target pubkey ONCE and hands the confirmed `{public_key, fingerprint}` down
  // as `disclosed`. The composition no longer reads `getMemberPubkey` itself — so
  // the human-compared bytes ARE the bytes we seal to (TOCTOU closed). Only the
  // six named fields cross in; any other smuggled pubkey field is dropped here.
  const { client, holder, localIdentity, user_id, target_user_id, disclosed } = opts;

  // Step 1 — ensure the holder is populated. The unwrap composition is the
  // single source of truth for the probe + disclosure + AEAD-open sequence
  // (Decision 5 step 1; Decision 2 step 5 hands back live bytes by reference,
  // so re-populating via .set() is safe — the buffer is the same one).
  if (!holder.isPopulated()) {
    let unwrapped: UnwrapCommitteeDataKeyResult;
    try {
      unwrapped = await unwrapCommitteeDataKeyViaProduction({
        client,
        localIdentity,
        user_id
      });
    } catch {
      // F-148 carry-forward: the unwrap composition should NEVER throw, but
      // a hostile transport could surface a synchronous throw before that
      // function's own catch. Map to data_key_unwrap_failed; never propagate.
      return { status: 'failed', reason: 'data_key_unwrap_failed' };
    }
    switch (unwrapped.status) {
      case 'ok':
        holder.set({
          data_key: unwrapped.data_key,
          key_id: unwrapped.key_id,
          epoch: unwrapped.epoch
        });
        break;
      case 'no_wrap':
        // F-174 information-hiding: do NOT hit the disclosure RPC if the
        // co-chair cannot proceed anyway. No audit row for an aborted grant.
        return { status: 'failed', reason: 'actor_has_no_wrap' };
      case 'needs_recovery':
        return { status: 'failed', reason: 'data_key_unwrap_failed' };
      case 'failed':
        if (unwrapped.reason === 'decrypt_failed') {
          return { status: 'failed', reason: 'decrypt_failed', http: unwrapped.http };
        }
        return { status: 'failed', reason: 'data_key_unwrap_failed', http: unwrapped.http };
    }
  }

  // After Step 1 the holder MUST be populated.
  const dataKey = holder.getDataKey();
  const keyId = holder.getKeyId();
  if (!dataKey || !keyId) {
    return { status: 'failed', reason: 'actor_has_no_wrap' };
  }

  // Step 2 (A-8.6 single-disclosure) — validate the caller's ONE disclosed
  // `{public_key, fingerprint}`. The composition does NOT call `getMemberPubkey`
  // (that would be a SECOND disclosure, F-179, re-opening the TOCTOU the confirm
  // screen closes). F-148: a malformed / missing `disclosed` (e.g. a cast-omitted
  // caller) MUST NOT throw — map it to a typed failure with NO seal, NO POST.
  if (
    !disclosed ||
    !(disclosed.public_key instanceof Uint8Array) ||
    typeof disclosed.fingerprint !== 'string'
  ) {
    return { status: 'failed', reason: 'invalid_pubkey' };
  }
  const targetPubkey = disclosed.public_key;

  // Defensive structural check (F-172 mitigation #5, re-pointed onto the disclosed
  // pubkey): a 32-byte pubkey is what crypto_box_seal expects. A wrong length is a
  // regression; typed-fail before throwing into libsodium.
  if (targetPubkey.length !== 32) {
    return { status: 'failed', reason: 'invalid_pubkey' };
  }

  // Self-consistency assert (F-179 mitigation #3 / F-172 confirmed==sealed):
  // re-derive `pubkeyFingerprint(disclosed.public_key)` and require it to equal
  // the confirmed `disclosed.fingerprint`. A mismatch means the confirmed
  // fingerprint and the pubkey bytes no longer correspond (a TOCTOU shape) —
  // typed-fail with NO seal, NO POST.
  let derivedFingerprint: string;
  try {
    derivedFingerprint = await pubkeyFingerprint(targetPubkey);
  } catch {
    // F-148 / F-176: never surface a raw crypto exception (its .message / .stack
    // could carry buffer bytes). Map to the structural invalid-pubkey failure.
    return { status: 'failed', reason: 'invalid_pubkey' };
  }
  if (derivedFingerprint !== disclosed.fingerprint) {
    return { status: 'failed', reason: 'invalid_pubkey' };
  }

  // Step 3 — seal the data key to the target's pubkey (libsodium-only;
  // ADR-0003 Invariant 4). crypto_box_seal is sender-anonymous; the result
  // is `plaintext.length + crypto_box_SEALBYTES` bytes of opaque ciphertext
  // (NOT a secretbox — Decision 5 step 3).
  let sealed: Uint8Array;
  try {
    const s = await ready();
    sealed = s.crypto_box_seal(dataKey, targetPubkey);
  } catch {
    // libsodium throws on invalid input (e.g. pubkey wrong length, even
    // though we guarded above). F-148 / F-176: NEVER propagate the raw
    // exception (its .message / .stack could carry buffer bytes); map to
    // a typed failure.
    return { status: 'failed', reason: 'invalid_pubkey' };
  }

  // Step 4 — POST the wrap. `rotation_id` is null (non-rotation grant);
  // the existing wrap_committee_data_key_for_member RPC re-asserts active-
  // member on the target (F-172 mitigation #2; the :502-503 contract).
  let wrap: Awaited<ReturnType<typeof client.wrapCommitteeDataKeyForMember>>;
  try {
    wrap = await client.wrapCommitteeDataKeyForMember({
      member_user_id: target_user_id,
      key_id: keyId,
      wrapped_ciphertext: sealed,
      rotation_id: null
    });
  } catch {
    // F-148 / F-176: a transport throw (network blow-up). NEVER propagate
    // the raw Error; map to wrap_post_failed.
    return { status: 'failed', reason: 'wrap_post_failed' };
  }
  if (!wrap.ok) {
    return { status: 'failed', reason: 'wrap_post_failed', http: wrap.status };
  }

  // Step 5 — Decision 5 step 5: the holder retains the live data key. We do
  // NOT call holder.wipe() / dataKey.fill(0) here; the co-chair still needs
  // key access for subsequent reads/writes. The holder's own six wipe
  // triggers (sign-out / 401 / panic / expiry / unload / rotation) own the
  // lifecycle.
  return { status: 'ok' };
}

// Re-export the KDF_PARAMS so callers can label persisted blobs without
// importing from `./recovery-blob` directly.
export { KDF_PARAMS };
