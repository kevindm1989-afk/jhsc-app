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
// Committee data key — unwrap ALL epochs (ADR-0030 Decision 6 / F182-2; the
// multi-epoch POPULATE flow behind the anti-lockout key-map, threat-model
// §3.18 A-8.10 F-183).
// ---------------------------------------------------------------------------

/** One opened multi-epoch entry the holder's `populate()` installs by reference. */
export interface UnwrapAllCommitteeKeyEntry {
  data_key: Uint8Array;
  key_id: string;
  epoch: number;
  is_live: boolean;
}

export type UnwrapAllCommitteeKeysResult =
  // Every wrap the caller holds across live + retired epochs, opened with the
  // device-local identity privkey. The caller hands `entries` to
  // `CommitteeKeyHolder.populate()`, which takes ownership of each `data_key` BY
  // REFERENCE and owns its zeroization lifecycle — this composition does NOT
  // `.fill(0)` here. An EMPTY array is a valid holding state (a purged /
  // reactivated member mid-window), never a throw.
  | { status: 'ok'; entries: UnwrapAllCommitteeKeyEntry[] }
  // A server-side wrap exists but the device holds no identity privkey to open
  // it. Route to restore-from-recovery (never re-enroll); ADR-0026 AC-7.
  | { status: 'needs_recovery' }
  // A typed failure surface — NEVER a thrown raw exception. Server denial /
  // transport fault surfaced verbatim (401/403 split by the caller).
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * Compose the multi-epoch committee-key unwrap (ADR-0030 Decision 6, F182-2 —
 * the sibling of `unwrapCommitteeDataKeyViaProduction`, which unwraps only the
 * single LIVE wrap). Fetch EVERY wrap the caller holds across live + retired
 * epochs via `getAllCommitteeKeyWrapsForSelf()` (F-183 (i) own-wrap-only, no
 * IDOR — the op carries no id parameter), open each SEALED wrap with the
 * device-local identity privkey via `crypto_box_seal_open` (public half derived
 * from the privkey via `crypto_scalarmult_base`), and return the decrypted
 * entries for the holder's `populate()`.
 *
 * Fail-closed discipline (F-183 / F-148):
 *  - `{ ok:false }` server denial ⇒ `{ status:'failed', reason, http }` (verbatim).
 *  - EMPTY SETOF ⇒ `{ status:'ok', entries:[] }` (holding state — never a throw).
 *  - No device privkey ⇒ `{ status:'needs_recovery' }` (route to restore).
 *  - A wrap that FAILS to open (sealed to a different device / corrupt bytes) is
 *    SKIPPED from the entries — never a partial-garbage key in the map; the good
 *    wraps still land. The method NEVER rejects and NEVER logs key material.
 *
 * libsodium-only (ADR-0003 Invariant 4). NEVER logs key material (F-148): no
 * `console.*`, no thrown exception carrying bytes — every outcome is a typed
 * union value.
 */
export async function unwrapAllCommitteeKeysViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
}): Promise<UnwrapAllCommitteeKeysResult> {
  // 1. Fetch ALL wraps (F-183 (i) own-wrap-only). The client method never
  //    rejects — a transport fault resolves to a typed `{ ok:false }`.
  const all = await opts.client.getAllCommitteeKeyWrapsForSelf();
  if (!all.ok) return { status: 'failed', reason: all.reason, http: all.status };

  // 2. Empty SETOF ⇒ holding state. Nothing to open, so the device privkey is
  //    not even consulted — return the empty entry set (never a throw).
  if (all.data.length === 0) return { status: 'ok', entries: [] };

  // 3. Read the device-local identity privkey. Absent → needs_recovery (the
  //    wraps exist server-side but cannot be opened on this device; route to
  //    restore-from-recovery, ADR-0026 AC-7). `getIdentityPrivateKey` throws
  //    when no key is stored — catch and map, never propagate (F-148).
  let priv: Uint8Array;
  try {
    priv = await opts.localIdentity.getIdentityPrivateKey(opts.user_id);
  } catch {
    return { status: 'needs_recovery' };
  }

  // 4. Open each sealed wrap. `crypto_box_seal` is sender-anonymous, so opening
  //    needs BOTH halves of the recipient keypair; the public half is derived
  //    from the privkey via crypto_scalarmult_base (X25519 base-point mult). A
  //    wrap that fails AEAD verification (wrong device / tampered ciphertext)
  //    THROWS — caught and SKIPPED (fail-closed per-wrap, never a garbage key in
  //    the map), never propagated (F-142 / F-148).
  const s = await ready();
  const pub = s.crypto_scalarmult_base(priv);
  const entries: UnwrapAllCommitteeKeyEntry[] = [];
  for (const row of all.data) {
    try {
      const data_key = s.crypto_box_seal_open(row.wrapped_ciphertext, pub, priv);
      entries.push({
        data_key,
        key_id: row.key_id,
        epoch: row.epoch,
        is_live: row.is_live
      });
    } catch {
      // Fail-closed per-wrap: skip an unopenable wrap; the good wraps still land.
    }
  }
  return { status: 'ok', entries };
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
 *          bytes. `rotation_id` is threaded from opts (B1 — associate a re-wrap
 *          with its rotation event); omitted → null (byte-identical grant).
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
 * F-172 attempted-bypass: only the named fields cross into the composition;
 * any OTHER smuggled pubkey field in opts is dropped by the destructure. The
 * seal target is always `disclosed.public_key`, which is re-checked against its
 * own confirmed fingerprint before it is used. B1 threads a `rotation_id`
 * (audit-association metadata only) — it never influences the seal target.
 */
export async function wrapMemberInViaProduction(opts: {
  client: SupabaseT07Client;
  holder: CommitteeKeyHolder;
  localIdentity: LocalIdentityStore;
  user_id: string;
  target_user_id: string;
  disclosed: { public_key: Uint8Array; fingerprint: string };
  // B1 — thread rotation_id so a re-wrap can be associated with its rotation
  // event. Optional; omitted → null (byte-identical grant, unchanged wire).
  rotation_id?: string | null;
}): Promise<WrapMemberInResult> {
  // A-8.6 single-disclosure: the caller (the F-172 confirm screen) disclosed the
  // target pubkey ONCE and hands the confirmed `{public_key, fingerprint}` down
  // as `disclosed`. The composition no longer reads `getMemberPubkey` itself — so
  // the human-compared bytes ARE the bytes we seal to (TOCTOU closed). Only the
  // named fields cross in; any other smuggled pubkey field is dropped here.
  // B1 — `rotation_id` also crosses in (default null) so a re-wrap can be
  // associated with its rotation event; it never re-points the seal target.
  const { client, holder, localIdentity, user_id, target_user_id, disclosed, rotation_id } = opts;

  // Step 1 — ensure the holder holds a LIVE key to seal with. The unwrap
  // composition is the single source of truth for the probe + disclosure +
  // AEAD-open sequence (Decision 5 step 1; Decision 2 step 5 hands back live
  // bytes by reference, so re-populating via .set() is safe — the buffer is the
  // same one). Gate on hasLiveKey, NOT mere population: a multi-epoch holding
  // state can be populated with retired-only keys and still have no live sealing
  // key (F182-2 fail-closed seal gate).
  if (!holder.hasLiveKey()) {
    // F-VAL-1(b) Finding 1 — snapshot the monotonic wipe-generation latch BEFORE
    // the Step-1 unwrap fetch. A session-end wipe (panic / 401 / sign-out /
    // page-unload) landing during the await below empties the holder and ticks
    // this counter (even on an EMPTY holder). The counter — NOT isPopulated() —
    // is the discriminator: a mid-await-wiped EMPTY holder is byte-identical to a
    // never-populated one, so only the counter can tell them apart.
    const gen = holder.wipeGeneration();
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
        // F-VAL-1(b) Finding 1 — re-check the latch immediately before install
        // (NO `await` between this check and the set() below). A changed value
        // means a session-end wipe landed mid-unwrap: set() would RESURRECT the
        // just-wiped live key, which is then sealed + POSTed off-device. Fail
        // closed to `data_key_unwrap_failed` (the same typed failure this branch
        // returns on unwrap failure) — do NOT set(), do NOT proceed to seal/POST.
        if (holder.wipeGeneration() !== gen) {
          return { status: 'failed', reason: 'data_key_unwrap_failed' };
        }
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
  let freshKeyId: string;
  try {
    const s = await ready();
    // ADV-2: re-check the holder still holds a LIVE key (not wiped during the
    // awaits above). `getDataKey()` handed out the live data-key buffer BY
    // REFERENCE (:688); a wipe trigger (401 / panic / sign-out) firing during the
    // `pubkeyFingerprint` / `ready` window zeroizes that buffer in place and
    // empties the map. NEVER seal + POST a zeroized/retired key — typed-fail
    // before crypto_box_seal touches it (F182-2 fail-closed seal gate).
    if (!holder.hasLiveKey()) {
      return { status: 'failed', reason: 'data_key_unwrap_failed' };
    }
    // F-190 Finding-2 / re-pass trigger #13: the boolean `hasLiveKey()` re-check
    // above is INSUFFICIENT on its own. A rotation-observing self-heal
    // `populate([...fresh])` firing in the await window installs a FRESH live
    // buffer (hasLiveKey() stays TRUE) while F-145-C's identity-compare orphan-
    // wipe ZEROES the captured `dataKey` (:792). Re-reading it here (with NO
    // `await` before the synchronous crypto_box_seal) fetches the CURRENT live
    // buffer afresh — never the stale/zeroed captured reference.
    // F-190 Finding-1 — the distributed wrap must never straddle a rotation;
    // re-read key_id atomically with the data key so the (key_id, ciphertext-
    // epoch) pair is always consistent (re-pass trigger #13). A mid-seal
    // self-heal populate([...fresh]) seals the NEW epoch's key; the pre-await
    // `keyId` (:793) still labels the STALE, pre-rotation epoch — an epoch-
    // mislabeled wrap. Fetch both from the CURRENT live buffer with NO `await`
    // before the synchronous crypto_box_seal / POST.
    const freshDataKey = holder.getDataKey();
    const freshId = holder.getKeyId();
    if (!freshDataKey || !freshId) {
      return { status: 'failed', reason: 'data_key_unwrap_failed' };
    }
    freshKeyId = freshId;
    sealed = s.crypto_box_seal(freshDataKey, targetPubkey);
  } catch {
    // libsodium throws on invalid input (e.g. pubkey wrong length, even
    // though we guarded above). F-148 / F-176: NEVER propagate the raw
    // exception (its .message / .stack could carry buffer bytes); map to
    // a typed failure.
    return { status: 'failed', reason: 'invalid_pubkey' };
  }

  // Step 4 — POST the wrap. `rotation_id` is threaded from opts (B1 — associate
  // a re-wrap with its rotation event); omitted → null (byte-identical non-
  // rotation grant). The existing wrap_committee_data_key_for_member RPC
  // re-asserts active-member on the target (F-172 mitigation #2; the :502-503
  // contract).
  let wrap: Awaited<ReturnType<typeof client.wrapCommitteeDataKeyForMember>>;
  try {
    wrap = await client.wrapCommitteeDataKeyForMember({
      member_user_id: target_user_id,
      // F-190 Finding-1 — POST the freshly re-read key_id (atomic with the
      // sealed data key), NEVER the pre-await `keyId` (:793) which may label a
      // stale, pre-rotation epoch under a mid-seal self-heal.
      key_id: freshKeyId,
      wrapped_ciphertext: sealed,
      // B1 — thread the caller-supplied rotation_id so a re-wrap can be
      // associated with its rotation event; omitted → null (byte-identical).
      // F182-4a threads the id ONLY — the sealed key stays the LIVE data key.
      rotation_id: rotation_id ?? null
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

// ---------------------------------------------------------------------------
// F182-4b / ADR-0030 Amendment B — `rotateCommitteeKeyOnRemovalViaProduction`,
// the client-side key-rotation-on-removal composition (Decisions B2–B6;
// threat-model §3.18 F-185 + the F182-4 DESIGN VALIDATION TM-1…TM-13 / R1/R2/R3
// / re-pass triggers #21–#25). Pure ADDITIVE composition over already-co-signed
// primitives — invents NO new crypto (ADR-0030 "no new grant crypto").
// ---------------------------------------------------------------------------

/**
 * The fail-LOUD discriminated union (Decision B5). NEVER `ok` unless BOTH the
 * co-chair self-wrap landed AND `finalize` succeeded — no silent dead key, no
 * silent half-rotation (F-138 NO-GO; re-pass trigger #22).
 *
 *   ok                       — self-wrap + every remaining member re-wrapped +
 *                              `finalize` OK; `pending_members: []`.
 *   ok_with_pending          — finalized, but ≥1 remaining member was offline /
 *                              `member_not_enrolled` → SKIPPED into
 *                              `pending_members` (honest edge; they keep
 *                              historical reads via their retained old-epoch wrap
 *                              and are grantable later — NOT an error; AC-B11).
 *   orphaned                 — `rotate` landed but the self-wrap did NOT (the new
 *                              epoch has zero wraps) → LOUD; route to abandon via
 *                              `rotate('incident')` + re-drive; NEVER re-generate
 *                              under `new_key_id` (F-137). Zero data beneath it.
 *   incomplete               — self-wrap OK but a re-wrap / `finalize` failed, or
 *                              a session-end wipe abandoned the step-5 install →
 *                              LOUD "resume"; carries `{rotation_id, new_key_id}` +
 *                              the still-missing member set. Existing data stays
 *                              readable (old wraps retained + trial-decrypt).
 *   cannot_resume_not_holder — a resumer who holds NO new-epoch wrap: after the
 *                              step-5 `populate()` the holder has no live key, so
 *                              there is no key to seal under → route to
 *                              abandon+re-drive (Decision B5; TM-5; re-pass #24).
 *   failed                   — precondition / rotate-denied / revoke-denied, with
 *                              `reason` + `http`.
 */
export type RotateCommitteeKeyOnRemovalResult =
  | {
      status: 'ok';
      rotation_id: string;
      new_key_id: string;
      members_rewrapped_count: number;
      pending_members: string[];
    }
  | {
      status: 'ok_with_pending';
      rotation_id: string;
      new_key_id: string;
      members_rewrapped_count: number;
      pending_members: string[];
    }
  | { status: 'orphaned'; rotation_id: string; new_key_id: string }
  | { status: 'incomplete'; rotation_id: string; new_key_id: string; pending_members: string[] }
  | { status: 'cannot_resume_not_holder'; rotation_id: string; new_key_id: string }
  | {
      status: 'failed';
      reason: T07OpReason | 'no_wrap' | 'needs_recovery' | 'session_expiry' | 'decrypt_failed';
      http?: number;
    };

/**
 * ADR-0030 Amendment B — the `rotate → revoke → self-wrap-FIRST → populate →
 * re-wrap → finalize → zeroize` composition (Decision B3). The removal DECISION
 * (the `committee_remove_member` membership flip + its 4-eyes / last-co-chair
 * governance) is OUTSIDE this composition — it is F182-6, run BEFORE this, which
 * supplies the `remaining_members` roster. F182-4 fetches no roster (hermetic).
 *
 * The concrete sequence (fresh path):
 *   1. Precondition (fail-FAST). If `!holder.hasLiveKey()`, a latch-guarded
 *      single-live `unwrapCommitteeDataKeyViaProduction` + `holder.set(...)`.
 *      `no_wrap` / `needs_recovery` / `failed` → typed `failed` BEFORE any
 *      state-mutating RPC (a co-chair who cannot recover a key must not open a
 *      rotation they cannot complete/read).
 *   2. Rotate — `rotate_committee_data_key('member_removal')` → `{rotation_id,
 *      new_key_id}`. `rotation_in_progress` (55P03) → typed `failed` retry/resume
 *      signal (AC-B12); `no_active_members` (P0001) / 401 / 403 surfaced.
 *   3. Revoke (purge-EARLY, Ordering-A / re-pass #21) — BEFORE any wrap so the
 *      removed member's F-186 reactivation window closes immediately.
 *   4. Self-wrap FIRST (the no-orphan pin, F-185 (i)) — generate `newKey =
 *      randombytes_buf(32)`, `crypto_box_seal(newKey, actor_public_key)`, POST it
 *      as the actor's own wrap under `new_key_id`. The instant it lands the new
 *      epoch has ≥1 wrap → never a zero-wrap orphan. `.fill(0)` `newKey` in a
 *      `finally` immediately (it is re-derived from the server wrap in step 5).
 *      A self-wrap that does NOT land → `orphaned` (NO finalize; F-137).
 *   5. Install new epoch as LIVE (Decision B2, latch-guarded) — reuse the merged
 *      `unwrapAllCommitteeKeysViaProduction` → `holder.populate(...)`. The new row
 *      is `is_live:true` (`rotated_at IS NULL`); the old row is retired but
 *      RETAINED for reads (anti-lockout). This fetch-then-install site carries the
 *      F-VAL-1(b) latch + F-196 zeroize-on-abandon (Decision B4). R3/F-192 diag:
 *      the new epoch MUST be the holder's live key after populate, else LOUD.
 *   6. Re-wrap loop (fan-out, F-188) — per `remaining_members` entry: ONE
 *      `getMemberPubkey` disclosure → `wrapMemberInViaProduction({…, rotation_id})`
 *      (B1; seals the NEW live key via its own F-190 re-read guard).
 *      `member_not_enrolled` → SKIP into `pending_members` (AC-B11). A hard
 *      failure → `incomplete` (resumable).
 *   7. Finalize — `finalize_committee_data_key_rotation(rotation_id, new_key_id,
 *      count = 1 self + re-wrapped)`. A concurrent rotation that retired this
 *      epoch mid-tail (R1) → `invalid_new_key` → `incomplete`, never a wrong-key
 *      open.
 *   8. Zeroize / dwell — `newKey` already zeroized (step-4 finally); the holder
 *      RETAINS {old:retired, new:live} per the dwell policy.
 *
 * Resume path (`resume:{rotation_id,new_key_id}`, Decision B5): skip steps 2–4
 * and continue from step 5. A resumer can only complete if they ALREADY hold a
 * wrap on the new epoch (the new key is random + unrecoverable without a wrap):
 * if the step-5 `populate()` leaves no live `new_key_id`, return
 * `cannot_resume_not_holder` (never a seal-under-absent-key; re-pass #24). Idempotent
 * (`ON CONFLICT DO NOTHING`) so re-running over already-wrapped members is a no-op.
 *
 * F-148: every wire error is typed-failed (no raw throw); NO key material is ever
 * logged (no `console.*`, no structured log, no serializing store).
 */
export async function rotateCommitteeKeyOnRemovalViaProduction(opts: {
  client: SupabaseT07Client;
  holder: CommitteeKeyHolder;
  localIdentity: LocalIdentityStore;
  user_id: string;
  actor_public_key: Uint8Array;
  removed_member_id: string;
  remaining_members: ReadonlyArray<{ user_id: string }>;
  resume?: { rotation_id: string; new_key_id: string };
}): Promise<RotateCommitteeKeyOnRemovalResult> {
  const {
    client,
    holder,
    localIdentity,
    user_id,
    actor_public_key,
    removed_member_id,
    remaining_members,
    resume
  } = opts;

  // F-138 (fail-before-mutate) — a non-32-byte actor pubkey can NEVER be sealed
  // by `crypto_box_seal`; it would throw only AFTER the step-2 `rotate` + step-3
  // `revoke` already landed, minting + stranding a fresh orphan epoch on EVERY
  // re-drive (a persistent bad pubkey is an epoch-churn livelock). Validate at
  // composition ENTRY — for BOTH the fresh and resume paths — BEFORE any
  // state-mutating RPC, mirroring the sibling init's F-138 guard (:277/:328/:397).
  if (actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  // F-VAL-1(b) / F-195 — snapshot the wipe-generation baseline at composition
  // ENTRY (before any `await`) so a session-end wipe during an earlier await is
  // never absorbed into the step-1 baseline.
  const entryGen = holder.wipeGeneration();
  const s = await ready();

  let rotation_id: string;
  let new_key_id: string;
  // The self-wrap (fresh path) / the resumer's own held new-epoch wrap counts as
  // 1 toward `finalize`'s `members_rewrapped_count`.
  let count = 1;

  if (resume) {
    rotation_id = resume.rotation_id;
    new_key_id = resume.new_key_id;
  } else {
    // Step 1 — precondition (fail-FAST, BEFORE any state-mutating RPC).
    if (!holder.hasLiveKey()) {
      let unwrapped: UnwrapCommitteeDataKeyResult;
      try {
        unwrapped = await unwrapCommitteeDataKeyViaProduction({ client, localIdentity, user_id });
      } catch {
        // F-148 — the unwrap composition should never throw; a hostile transport
        // could. Fail-fast typed, never propagate.
        return { status: 'failed', reason: 'decrypt_failed' };
      }
      if (unwrapped.status === 'no_wrap') return { status: 'failed', reason: 'no_wrap' };
      if (unwrapped.status === 'needs_recovery') {
        return { status: 'failed', reason: 'needs_recovery' };
      }
      if (unwrapped.status === 'failed') {
        return { status: 'failed', reason: unwrapped.reason, http: unwrapped.http };
      }
      // F-VAL-1(b) — re-check the latch immediately before `set()` (NO `await`
      // between). A session-end wipe landed mid-unwrap → resurrecting the key map
      // would seal + POST a just-wiped key. Fail closed + F-196 zeroize the
      // in-flight buffer the fetch handed back.
      if (holder.wipeGeneration() !== entryGen) {
        unwrapped.data_key.fill(0);
        return { status: 'failed', reason: 'session_expiry' };
      }
      holder.set({
        data_key: unwrapped.data_key,
        key_id: unwrapped.key_id,
        epoch: unwrapped.epoch
      });
    }

    // Step 2 — rotate (the first state-mutating RPC).
    const rot = await client.rotateCommitteeDataKey({ trigger: 'member_removal' });
    if (!rot.ok) {
      // `rotation_in_progress` (55P03) → typed retry/resume; `no_active_members`
      // (P0001) / 401 / 403 surfaced verbatim. No epoch minted by the loser.
      return { status: 'failed', reason: rot.reason, http: rot.status };
    }
    rotation_id = rot.data.rotation_id;
    new_key_id = rot.data.new_key_id;

    // Step 3 — revoke (purge-EARLY; Ordering-A, re-pass #21). Runs BEFORE any
    // wrap so the removed member's reactivation window closes at once (F-186).
    const rev = await client.revokeCommitteeMember({ removed_member_id, rotation_id });
    if (!rev.ok) {
      // Step 2 already minted a live zero-wrap epoch → the exact `orphaned`
      // state, and this failed revoke did NOT purge the removed member's
      // old-epoch wraps (the F-186 window is still open). Carry the orphan
      // context (rotation_id + new_key_id) so the caller can abandon+re-drive —
      // which re-runs the revoke — instead of a bare `failed` that strands the
      // zero-wrap epoch. Matches the self-wrap-failure `orphaned` shape below
      // (F-137).
      return { status: 'orphaned', rotation_id, new_key_id };
    }

    // Step 4 — self-wrap FIRST (the no-orphan pin). Seal a LOCAL fresh 32-byte key
    // to the actor's own pubkey and POST it as the actor's wrap under
    // `new_key_id`. `newKey` is a local buffer (NOT holder-managed) → outside the
    // F-190 holder-seal class; `.fill(0)` it in a `finally` on EVERY exit
    // (AC-B9 / re-pass #25).
    const newKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
    try {
      let sealed: Uint8Array;
      try {
        sealed = s.crypto_box_seal(newKey, actor_public_key);
      } catch {
        // A malformed actor pubkey after a landed `rotate` leaves a zero-wrap
        // epoch → LOUD `orphaned`, NEVER a finalize (F-137/F-138).
        return { status: 'orphaned', rotation_id, new_key_id };
      }
      const selfWrap = await client.wrapCommitteeDataKeyForMember({
        member_user_id: user_id,
        key_id: new_key_id,
        wrapped_ciphertext: sealed,
        rotation_id
      });
      if (!selfWrap.ok) {
        // Self-wrap did NOT land → zero-wrap orphan epoch → LOUD `orphaned`; no
        // finalize, no remaining re-wrap; route to abandon+re-drive (F-137).
        return { status: 'orphaned', rotation_id, new_key_id };
      }
    } finally {
      newKey.fill(0);
    }
  }

  // Step 5 — install the new epoch as the holder's LIVE key (Decision B2),
  // latch-guarded against the composition-ENTRY baseline (F-VAL-1(b)) + F-196
  // zeroize-on-abandon. The latch re-checks `entryGen` (:1077), NOT a fresh
  // post-steps-2-4 snapshot: a session-end wipe landing DURING the steps-2-4
  // (rotate/revoke/self-wrap) awaits advances `#wipeGeneration` BEFORE a fresh
  // snapshot would be read, so it would be absorbed and missed. Only `wipe()`
  // advances `#wipeGeneration` (the composition's own set()/populate() never
  // move it), so `entryGen` detects a wipe at ANY point in the ceremony —
  // provided EVERY post-install async boundary re-checks it too. It does: the
  // step-1 latch re-checks `entryGen` before its `set()`, and the same baseline
  // is re-checked inside the step-6 re-wrap loop (after each `getMemberPubkey`
  // disclosure, before delegating to `wrapMemberInViaProduction`) and once more
  // immediately before the step-7 `finalize`. So a session-end wipe at ANY
  // ceremony point — pre-step-1, mid-steps-2-4, mid-loop, or pre-finalize — is
  // caught and fails LOUD, never resurrected into a post-wipe seal/POST/finalize.
  const all = await unwrapAllCommitteeKeysViaProduction({ client, localIdentity, user_id });
  if (all.status === 'needs_recovery') {
    // The actor's wraps exist server-side but this device has no identity
    // privkey to open them. On the FRESH path the rotation has already landed
    // (rotate+revoke+self-wrap committed) → `incomplete` is resumable. On the
    // RESUME path there is NOTHING to resume into for THIS device: the honest
    // surface is `needs_recovery` (restore-from-recovery, ADR-0026 AC-7),
    // mirroring the step-1 fresh-path handling (:1111-1113). `cannot_resume_not_holder`
    // would be a MISROUTE — its "abandon + re-drive" guidance ALSO needs a
    // privkey to open a wrap and is equally impossible here, so the actionable
    // recovery signal would be lost (adversarial Finding 1, round 3).
    return resume
      ? { status: 'failed', reason: 'needs_recovery' }
      : {
          status: 'incomplete',
          rotation_id,
          new_key_id,
          pending_members: missingIds(remaining_members)
        };
  }
  if (all.status === 'failed') {
    return resume
      ? { status: 'failed', reason: all.reason, http: all.http }
      : {
          status: 'incomplete',
          rotation_id,
          new_key_id,
          pending_members: missingIds(remaining_members)
        };
  }
  // F-VAL-1(b) — re-check the latch (vs. the composition-ENTRY `entryGen`)
  // immediately before `populate()` (NO `await` between). On mismatch a
  // session-end wipe landed at SOME point in the ceremony → abandon the install
  // (do NOT resurrect the map) + F-196 zeroize the in-flight buffers.
  if (holder.wipeGeneration() !== entryGen) {
    for (const e of all.entries) e.data_key.fill(0);
    return resume
      ? { status: 'failed', reason: 'session_expiry' }
      : {
          status: 'incomplete',
          rotation_id,
          new_key_id,
          pending_members: missingIds(remaining_members)
        };
  }
  holder.populate(all.entries);

  // R3 / F-192 (re-pass trigger #20 / #21(a)) — the step-5 install MUST make
  // `new_key_id` the holder's live sealing key BEFORE the re-wrap loop, else a
  // re-wrap would seal under the WRONG (retired) epoch. A lying/inconsistent
  // all-wraps set that dropped `new_key_id` leaves the holder retired-only → fail
  // LOUD (never a silent wrong-epoch wrap). For a resumer this is precisely the
  // "holds no new-epoch wrap" case → `cannot_resume_not_holder`.
  if (holder.getKeyId() !== new_key_id) {
    return resume
      ? { status: 'cannot_resume_not_holder', rotation_id, new_key_id }
      : {
          status: 'incomplete',
          rotation_id,
          new_key_id,
          pending_members: missingIds(remaining_members)
        };
  }

  // Step 6 — re-wrap loop (fan-out, F-188). One disclosure per remaining member,
  // then reuse `wrapMemberInViaProduction` (B1 threads `rotation_id`; its F-190
  // re-read of `getDataKey()`/`getKeyId()` seals the NEW live key under
  // `new_key_id`). `member_not_enrolled` → SKIP into pending (not an error).
  const pending: string[] = [];
  for (const [i, member] of remaining_members.entries()) {
    const target = member.user_id;

    const disc = await client.getMemberPubkey({ target_user_id: target });
    if (!disc.ok) {
      if (disc.reason === 'member_not_enrolled') {
        pending.push(target);
        continue;
      }
      // A hard disclosure failure (rls_denied / dead session) → LOUD `incomplete`
      // (resumable); existing data stays readable.
      return {
        status: 'incomplete',
        rotation_id,
        new_key_id,
        pending_members: [...pending, ...restIds(remaining_members, i)]
      };
    }

    // F-VAL-1(b) / RE-REVIEW A — re-check the composition-ENTRY latch AFTER the
    // disclosure `await` and BEFORE delegating to `wrapMemberInViaProduction`. A
    // session-end wipe landing during this loop's `getMemberPubkey` await empties
    // the holder; delegating anyway would let that helper's empty-holder re-fetch
    // (:762) RESURRECT the just-wiped key — its OWN latch snapshots a POST-wipe
    // baseline (:769) so it cannot see THIS earlier wipe, and it would seal + POST
    // a member wrap off-device after the wipe. Abandon LOUD instead: the current +
    // unprocessed members stay pending. This guarantees `wrapMemberInViaProduction`
    // is only ever entered with a LIVE holder, so its F-190 / F-VAL-1(b) guards
    // cover only a wipe landing DURING its own execution.
    if (holder.wipeGeneration() !== entryGen) {
      return resume
        ? { status: 'failed', reason: 'session_expiry' }
        : {
            status: 'incomplete',
            rotation_id,
            new_key_id,
            pending_members: [...pending, ...restIds(remaining_members, i)]
          };
    }

    const rewrap = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id,
      target_user_id: target,
      disclosed: { public_key: disc.data.public_key, fingerprint: disc.data.fingerprint },
      rotation_id
    });
    if (rewrap.status === 'ok') {
      count += 1;
      continue;
    }
    if (rewrap.status === 'member_not_enrolled') {
      pending.push(target);
      continue;
    }
    // A hard re-wrap failure (wrap_post_failed / data_key_unwrap_failed) → LOUD
    // `incomplete` (resumable). NEVER a silent `ok` on a failed re-wrap.
    return {
      status: 'incomplete',
      rotation_id,
      new_key_id,
      pending_members: [...pending, ...restIds(remaining_members, i)]
    };
  }

  // F-VAL-1(b) / RE-REVIEW B — re-check the composition-ENTRY latch immediately
  // BEFORE `finalize` (NO `await` between). A session-end wipe landing in the
  // post-last-re-wrap / pre-finalize window would otherwise never be detected, so
  // a wiped ceremony would finalize and return a clean `ok`. Abandon LOUD instead:
  // do NOT finalize a wiped ceremony. (A wipe DURING the finalize RPC await itself
  // is acceptable-honest — the rotation completed server-side — so it is NOT
  // guarded here; only the before-finalize window is.)
  if (holder.wipeGeneration() !== entryGen) {
    return resume
      ? { status: 'failed', reason: 'session_expiry' }
      : { status: 'incomplete', rotation_id, new_key_id, pending_members: pending };
  }

  // Step 7 — finalize with count = 1 (self) + re-wrapped members.
  const fin = await client.finalizeCommitteeDataKeyRotation({
    rotation_id,
    new_key_id,
    members_rewrapped_count: count
  });
  if (!fin.ok) {
    // A benign finalize fault OR the R1 concurrent-retire `invalid_new_key` →
    // LOUD `incomplete`, never a wrong-key `ok` (fail-loud invariant, TM-6/R1).
    return { status: 'incomplete', rotation_id, new_key_id, pending_members: pending };
  }

  // Step 8 — success. `newKey` already zeroized (step-4 finally); the holder
  // RETAINS {old:retired, new:live} per the dwell policy.
  if (pending.length > 0) {
    return {
      status: 'ok_with_pending',
      rotation_id,
      new_key_id,
      members_rewrapped_count: count,
      pending_members: pending
    };
  }
  return {
    status: 'ok',
    rotation_id,
    new_key_id,
    members_rewrapped_count: count,
    pending_members: []
  };
}

/** The user_ids of every remaining member (all still-missing on an early abort). */
function missingIds(members: ReadonlyArray<{ user_id: string }>): string[] {
  return members.map((m) => m.user_id);
}

/** The user_ids from index `from` onward (the current + unprocessed members). */
function restIds(members: ReadonlyArray<{ user_id: string }>, from: number): string[] {
  return members.slice(from).map((m) => m.user_id);
}

// Re-export the KDF_PARAMS so callers can label persisted blobs without
// importing from `./recovery-blob` directly.
export { KDF_PARAMS };
