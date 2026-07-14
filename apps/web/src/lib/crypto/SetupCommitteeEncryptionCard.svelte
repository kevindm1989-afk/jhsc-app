<script>
  /**
   * SetupCommitteeEncryptionCard — Phase 0a first-co-chair crypto-provisioning
   * ceremony on a focused Settings surface (ADR-0026 Decision 1 + Decision 3,
   * corrected by Amendment A).
   *
   * A thin orchestrator over the EXISTING production-flow composition + the
   * REUSED wizard recovery components — NOT a fork of OnboardingFlow (ADR-0026
   * rejects (a)/(b)). It drives the ordered ceremony:
   *   1. enroll identity   — enrollIdentityViaProduction (F-02 sealed-box
   *                          challenge; privkey persisted ONLY after finalize,
   *                          F-129).
   *   2. recovery sheet     — D4RecoveryPassphrase + D6TypeBackVerify (reused
   *                          components) + storeRecoveryBlobViaProduction.
   *   3. committee data key — initCommitteeDataKeyViaProduction (the one
   *                          net-new composition; zeroizes the data key,
   *                          F-132; Amendment A wrap-count resume branching).
   *
   * Resumability (ADR-0020 Option B — in-memory only, server-state is the
   * durable source of truth; the passphrase is regenerated on restart and the
   * user is told). On mount the card probes server + device state and resumes
   * from the first incomplete step. Edge routing:
   *   - server-has-pubkey / device-has-no-privkey → restore_required (edge-B,
   *     F-139 / AC-7 — RESTORE, never a second enroll).
   *   - foreign-held committee key → foreign_held (edge-A sub-case (a),
   *     Amendment A Ruling 2 / AC-5c — recoverable error, never self-wrap).
   *   - zero-wrap dead key → repaired transparently inside
   *     initCommitteeDataKeyViaProduction (Amendment A Ruling 3 / AC-5b).
   *
   * The card self-hides once fully provisioned (idempotent). Visibility is
   * "signed-in member who is not yet provisioned"; co-chair-only-ness is a
   * product convention (ADR-0026: not an SQL constraint), and the server gates
   * (`_t07_gate_active_member`) remain authoritative.
   *
   * Key-material custody (F-132): the identity privkey, the passphrase, and the
   * plaintext committee data key live ONLY in closure scope inside the flow
   * functions / reused components — never on window/globalThis, never logged,
   * never rendered except the passphrase reveal the recovery component owns.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13 (same reason as the sibling
   * Settings cards: the reused recovery components are plain-JS Svelte).
   */
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { getCurrentUserId } from '$lib/auth/jwt-claims';
  import { ready } from '$lib/crypto/sodium';
  import { generateRecoveryPassphrase } from '$lib/crypto/passphrase';
  import { pubkeyFingerprint } from '$lib/crypto/identity-keys';
  import {
    enrollIdentityViaProduction,
    storeRecoveryBlobViaProduction,
    initCommitteeDataKeyViaProduction,
    restoreRecoveryBlobViaProduction
  } from '$lib/crypto/production-flows';
  import D4RecoveryPassphrase from '$lib/onboarding/steps/D4RecoveryPassphrase.svelte';
  import D6TypeBackVerify from '$lib/onboarding/steps/D6TypeBackVerify.svelte';
  import FingerprintCompareBlock from '$lib/crypto/FingerprintCompareBlock.svelte';

  /**
   * The production t07 client (createSupabaseT07Client with a
   * BrowserLocalIdentityStore). Required.
   * @type {import('$lib/crypto/supabase-t07-client').SupabaseT07Client}
   */
  export let client;
  /**
   * The device-local identity store the client was constructed with — used to
   * read back the privkey for the recovery step and to detect edge-B.
   * @type {import('$lib/crypto/key-store').LocalIdentityStore}
   */
  export let localIdentity;
  /** Where the restore-required / foreign-held CTAs route. */
  export let restoreHref = '/settings';

  /**
   * Card phase.
   * @type {'probing' | 'hidden' | 'not_provisioned' | 'enrolling' |
   *        'recovery' | 'recovery_confirm' | 'init' | 'success' |
   *        'restore_required' | 'foreign_held' | 'waiting' | 'error'}
   */
  let phase = 'probing';
  let errorKey = 'settings.setupCommitteeEncryption.error.unknown';

  // Waiting phase (P1-9 / Surface L / F-172). The member has enrolled their
  // identity and holds the privkey on this device, but no co-chair has wrapped
  // them into the committee key yet. We show them their OWN identity fingerprint
  // (SHA-256 of their X25519 pubkey) so they can read it aloud to a co-chair,
  // who re-derives the SAME value via pubkeyFingerprint() and compares it
  // out-of-band before granting access (P1-8d, a later increment).
  /** @type {'computing' | 'shown' | 'derive_error'} sub-state of `waiting`. */
  let waitingState = 'computing';
  /** The contiguous 64-hex fingerprint (canonical lowercase); the PUBLIC copy
   * value the 16 display groups are sliced from. Never key material. */
  let fingerprint = '';
  /** Polite "fingerprint ready" announcement; populated post-render so it lands
   * as a live-region mutation (mirrors OneTimeCodeCard's F6 pattern). */
  let waitingReady = '';
  /** @type {HTMLElement | null} single deliberate focus target on `shown`. */
  let waitingLeadEl = null;
  /** @type {HTMLElement | null} focus target on `derive_error`. */
  let waitingErrorEl = null;

  // In-memory ceremony state (ADR-0020 Option B — never persisted).
  let userId = '';
  /** @type {Uint8Array} the freshly-enrolled (or restored) actor pubkey. */
  let actorPublicKey = new Uint8Array(0);
  /** @type {Uint8Array} the device privkey, read back for the recovery step. */
  let identityPrivkey = new Uint8Array(0);
  /** Live recovery passphrase (closure-scope; regenerated on restart). */
  let passphrase = '';
  let typedBack = '';
  let passphraseRegenerated = false;
  let mismatch = false;

  // Restore (edge-B) state. The card runs this in-place when the server
  // reports actor_has_wrap=true but this device has no privkey — the user
  // already provisioned on another device and is restoring here using the
  // recovery passphrase they saved (the JSON sheet is a separate paper
  // backup; the server holds the canonical encrypted blob).
  let restorePassphrase = '';
  /** @type {'idle' | 'restoring' | 'wrong_passphrase' | 'not_found' | 'failed'} */
  let restoreState = 'idle';
  let restoreErrorKey = 'settings.setupCommitteeEncryption.error.unknown';

  /**
   * Constant-time-ish string compare for the type-back gate (M-104d — no
   * `===` short-circuit on the secret). Walks the full string; length
   * mismatch still walks the longer side to avoid a timing oracle.
   * @param {string} a @param {string} b
   */
  function constantTimeStringEqual(a, b) {
    const max = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;
    for (let i = 0; i < max; i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0;
  }

  /** Map a t07 http status onto the card's error copy. */
  function failureKeyFor(http) {
    if (http === 401) return 'settings.setupCommitteeEncryption.error.signed_out';
    if (http === 403) return 'settings.setupCommitteeEncryption.error.denied';
    return 'settings.setupCommitteeEncryption.error.unknown';
  }

  // The 16-groups-of-4 fingerprint render (split + per-group NATO SR labels) now
  // lives in the shared FingerprintCompareBlock, which the co-chair's P1-8d grant
  // screen also consumes — so the two surfaces byte-match group-for-group by
  // construction rather than by two hand-kept copies (design-system.md §4).

  onMount(probeState);

  /**
   * Probe durable state and route to the first incomplete step. Pure reads —
   * never re-runs a completed step (F-138/F-139 resume contract).
   */
  async function probeState() {
    const uid = getCurrentUserId();
    if (!uid) {
      // Not signed in — nothing to provision here; let the rest of Settings
      // surface the signed-out state.
      phase = 'hidden';
      return;
    }
    userId = uid;

    // Does this DEVICE already hold the identity privkey?
    let hasDevicePrivkey = false;
    try {
      const sk = await localIdentity.getIdentityPrivateKey(uid);
      hasDevicePrivkey = !!sk && sk.length === 32;
      if (hasDevicePrivkey) identityPrivkey = sk;
    } catch {
      // No privkey on this device — leave `hasDevicePrivkey` false; the
      // edge-B / fresh-device routing below handles it.
    }

    // Probe the committee-key state (pure read).
    let state;
    try {
      const probe = await client.getCommitteeKeyState({ actor_user_id: uid });
      if (!probe.ok) {
        errorKey = failureKeyFor(probe.status);
        phase = 'error';
        return;
      }
      state = probe.data;
    } catch {
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }

    if (state && state.actor_has_wrap && hasDevicePrivkey) {
      // Fully provisioned for this actor AND the device holds the privkey →
      // self-hide (idempotent).
      phase = 'hidden';
      return;
    }
    if (state && state.actor_has_wrap && !hasDevicePrivkey) {
      // Edge-B (F-139): the server holds a wrap for this actor (provisioned
      // earlier, likely on another device) but THIS device has no privkey to
      // unwrap it. The recovery passphrase + server-stored encrypted blob
      // recover the privkey onto this device. NEVER re-enroll (would orphan
      // every prior wrap).
      phase = 'restore_required';
      return;
    }
    if (state && state.wrap_count > 0 && !hasDevicePrivkey) {
      // A committee key exists, held by others, and this device has no key
      // material AND this actor has no wrap on it → foreign-held recoverable
      // error (AC-5c).
      phase = 'foreign_held';
      return;
    }
    if (!hasDevicePrivkey) {
      // No device privkey. If a committee key already exists with foreign
      // wraps OR the actor needs to bring an existing identity to this device,
      // restore is the safe route (edge-B / F-139 — never re-enroll).
      if (state && state.wrap_count > 0) {
        phase = 'foreign_held';
        return;
      }
      // Fresh device, no committee key yet — start the ceremony at enroll, but
      // if the server later reports the identity already exists (duplicate-
      // finalize), the enroll step routes to restore (handled in runEnroll).
      phase = 'not_provisioned';
      return;
    }

    // P1-9 / Surface L / F-180 waiting gate. Reached only when
    // `hasDevicePrivkey === true` (every `!hasDevicePrivkey` branch above
    // returned) AND `state.actor_has_wrap === false` (the `actor_has_wrap &&
    // hasDevicePrivkey` branch returned `hidden` at the top), so the only
    // remaining discriminator is `wrap_count`:
    //   - wrap_count > 0 → a committee key exists, held by other members, and
    //     this actor has done their part (identity enrolled + privkey here) but
    //     has no wrap yet → they are WAITING for a co-chair to grant access.
    //     Show their own identity fingerprint for the F-172 out-of-band compare.
    //   - wrap_count === 0 → no committee key exists at all; this member is the
    //     first co-chair and initialises it → falls through to not_provisioned.
    if (state && state.wrap_count > 0) {
      phase = 'waiting';
      waitingState = 'computing';
      // Fire-and-forget so the `computing` render is honoured, exactly how the
      // card kicks off its other async steps.
      void deriveWaitingFingerprint();
      return;
    }

    // Device has the privkey; identity is done device-side. Resume at the
    // committee-key step (recovery may or may not be done server-side — we
    // re-offer it idempotently; storeRecovery is server-cap-of-1 so a second
    // store fails closed and we proceed to init).
    phase = 'not_provisioned';
  }

  function startSetup() {
    if (phase !== 'not_provisioned') return;
    // If the device already holds the privkey, skip enroll (AC-3).
    if (identityPrivkey.length === 32) {
      void resumeWithDeviceKey();
      return;
    }
    void runEnroll();
  }

  /**
   * Resume-skip-enroll path (ADR-0026 AC-3): the device already holds the
   * identity privkey, so enroll is skipped. enroll is the ONLY other place
   * `actorPublicKey` is set, so we must derive it here — otherwise it stays
   * `new Uint8Array(0)` and `runInit` forwards an empty pubkey, which the
   * library guard now rejects but which would also block a legitimate resume
   * from EVER succeeding (F-138 / security-reviewer Finding 1).
   *
   * Identity keys are X25519 (`crypto_box_keypair`, see identity-keys.ts), so
   * the matching public key is `crypto_scalarmult_base(privkey)` — the exact
   * derivation recovery-blob.ts uses to reconstruct the pairing pubkey. This
   * reproduces the pubkey originally enrolled, so the self-wrap is openable
   * with the device privkey on the round-trip.
   */
  async function resumeWithDeviceKey() {
    try {
      const s = await ready();
      actorPublicKey = s.crypto_scalarmult_base(identityPrivkey);
    } catch {
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }
    await beginRecovery();
  }

  /**
   * Derive the member's OWN identity fingerprint for the waiting phase — the
   * F-172 human-augment compare value (analogous to resumeWithDeviceKey's pubkey
   * re-derivation). CLIENT-SIDE ONLY: no server RPC fires; the in-memory
   * `identityPrivkey` (already read in probeState) is reused — we do NOT re-read
   * the key. The result is byte-identical to the co-chair's
   * getMemberPubkey().fingerprint because both call the same pubkeyFingerprint()
   * over crypto_scalarmult_base(privkey).
   *
   * The WHOLE computation is wrapped so any throw fails closed to `derive_error`
   * (never render a fingerprint from an absent/short key). In the gated branch
   * the privkey is guaranteed 32 bytes, so this is defense-in-depth.
   */
  async function deriveWaitingFingerprint() {
    try {
      const s = await ready();
      const pub = s.crypto_scalarmult_base(identityPrivkey);
      fingerprint = await pubkeyFingerprint(pub);
      // Populate the (already-mounted, previously-empty) polite region in the
      // same batch as the shown transition so "ready" announces as a live-region
      // mutation (VoiceOver skips regions inserted already-populated).
      waitingState = 'shown';
      waitingReady = t('a11y.settings.setup.fingerprint.ready');
      // Single deliberate focus move to the lead (mirrors Surface J success).
      await tick();
      if (waitingLeadEl) waitingLeadEl.focus();
    } catch {
      // Fail-safe: no fingerprint is ever rendered from a bad derive.
      fingerprint = '';
      waitingState = 'derive_error';
      await tick();
      if (waitingErrorEl) waitingErrorEl.focus();
    }
  }

  /** Retry the derive in place (no full re-probe — the privkey is unchanged). */
  function retryWaiting() {
    waitingReady = '';
    waitingState = 'computing';
    void deriveWaitingFingerprint();
  }

  async function runEnroll() {
    phase = 'enrolling';
    let r;
    try {
      r = await enrollIdentityViaProduction({ client, user_id: userId });
    } catch {
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }
    if (r.status !== 'ok') {
      // A duplicate-finalize means the server already holds this identity's
      // pubkey but this device minted a NEW privkey that was NOT persisted
      // (enrollIdentityViaChallenge persists only on a clean finalize). The
      // correct route is RESTORE, never a second enroll (F-139 / AC-7).
      if (r.status === 'failed' && r.reason === 'duplicate') {
        phase = 'restore_required';
        return;
      }
      if (r.status === 'failed') {
        errorKey = failureKeyFor(r.http);
        phase = 'error';
        return;
      }
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }
    actorPublicKey = r.public_key;
    try {
      identityPrivkey = await localIdentity.getIdentityPrivateKey(userId);
    } catch {
      // Should not happen on a clean enroll, but if the privkey isn't
      // readable the recovery step would have nothing to seal — route to
      // restore rather than continue with a broken state.
      phase = 'restore_required';
      return;
    }
    await beginRecovery();
  }

  async function beginRecovery() {
    // Regenerate the passphrase on every (re)entry — never persisted across a
    // refresh (ADR-0020 Option B). Tell the user if this is a restart.
    if (passphrase) passphraseRegenerated = true;
    try {
      const gen = await generateRecoveryPassphrase();
      passphrase = gen.passphrase;
    } catch {
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }
    typedBack = '';
    phase = 'recovery';
  }

  function goToConfirm() {
    phase = 'recovery_confirm';
  }

  async function confirmRecovery() {
    if (!constantTimeStringEqual(typedBack, passphrase)) {
      // Surface the mismatch inline; stay on the confirm step.
      mismatch = true;
      return;
    }
    mismatch = false;
    phase = 'init';
    let stored;
    try {
      stored = await storeRecoveryBlobViaProduction({
        client,
        localIdentity,
        user_id: userId,
        passphrase
      });
    } catch {
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }
    // A cap-of-1 duplicate (blob already stored) is success-equivalent for
    // resumption — proceed to init. Only an auth/permission failure stops us.
    if (stored.status !== 'ok' && stored.status === 'failed') {
      if (stored.http === 401 || stored.http === 403) {
        errorKey = failureKeyFor(stored.http);
        phase = 'error';
        return;
      }
      // duplicate / cap_reached → blob already on file; continue to init.
    }
    await runInit();
  }

  async function runInit() {
    phase = 'init';
    let r;
    try {
      r = await initCommitteeDataKeyViaProduction({
        client,
        localIdentity,
        user_id: userId,
        actor_public_key: actorPublicKey
      });
    } catch {
      errorKey = 'settings.setupCommitteeEncryption.error.unknown';
      phase = 'error';
      return;
    }
    if (r.status === 'ok' || r.status === 'already_initialised') {
      phase = 'success';
      return;
    }
    if (r.status === 'foreign_held') {
      phase = 'foreign_held';
      return;
    }
    // status === 'failed'
    errorKey = failureKeyFor(r.http);
    phase = 'error';
  }

  function retry() {
    // Re-probe and resume from the first incomplete step.
    phase = 'probing';
    void probeState();
  }

  /**
   * Edge-B restore (F-139). The user typed their recovery passphrase; we
   * fetch the server-stored encrypted blob, decrypt under the passphrase,
   * and write the recovered privkey to this device's local identity store.
   * The recovery primitive emits the restore audit row server-side.
   *
   * On success, re-probe → the card self-hides (provisioned + privkey).
   * Typed failures map to inline copy without leaking which path was wrong.
   */
  async function runRestore() {
    if (restoreState === 'restoring') return;
    if (restorePassphrase.length === 0) return;
    if (!userId) {
      restoreState = 'failed';
      restoreErrorKey = 'settings.setupCommitteeEncryption.error.signed_out';
      return;
    }
    restoreState = 'restoring';
    try {
      const result = await restoreRecoveryBlobViaProduction({
        client,
        localIdentity,
        user_id: userId,
        passphrase: restorePassphrase,
        device_fingerprint_raw: typeof navigator !== 'undefined' ? navigator.userAgent : ''
      });
      if (result.status === 'wrong_passphrase') {
        restoreState = 'wrong_passphrase';
        return;
      }
      if (result.status === 'not_found') {
        restoreState = 'not_found';
        return;
      }
      if (result.status === 'failed') {
        restoreState = 'failed';
        restoreErrorKey = failureKeyFor(result.http);
        return;
      }
      // Success — privkey now in IndexedDB. Clear the field, re-probe.
      restorePassphrase = '';
      restoreState = 'idle';
      phase = 'probing';
      void probeState();
    } catch {
      restoreState = 'failed';
      restoreErrorKey = 'settings.setupCommitteeEncryption.error.unknown';
    }
  }
</script>

{#if phase !== 'hidden' && phase !== 'probing'}
  <section
    class="setup-committee-section"
    aria-labelledby="setup-committee-heading"
    aria-busy={phase === 'enrolling' ||
    phase === 'init' ||
    (phase === 'waiting' && waitingState === 'computing')
      ? 'true'
      : 'false'}
    data-testid="setup-committee-section"
  >
    <h2 id="setup-committee-heading">{t('settings.setupCommitteeEncryption.heading')}</h2>

    {#if phase === 'not_provisioned'}
      <p class="muted">{t('settings.setupCommitteeEncryption.intro')}</p>
      <button
        type="button"
        class="setup-committee-primary"
        on:click={startSetup}
        data-testid="setup-committee-start"
      >
        {t('settings.setupCommitteeEncryption.start')}
      </button>
    {/if}

    {#if phase === 'enrolling'}
      <p role="status" data-testid="setup-committee-step-identity">
        {t('settings.setupCommitteeEncryption.step.identity')}
      </p>
    {/if}

    {#if phase === 'recovery'}
      <p class="muted">{t('settings.setupCommitteeEncryption.recovery.intro')}</p>
      {#if passphraseRegenerated}
        <p class="setup-committee-note" data-testid="setup-committee-regen-note">
          {t('settings.setupCommitteeEncryption.recovery.regenerated_note')}
        </p>
      {/if}
      <D4RecoveryPassphrase user_id={userId} {passphrase} identity_privkey={identityPrivkey} />
      <button
        type="button"
        class="setup-committee-primary"
        on:click={goToConfirm}
        data-testid="setup-committee-recovery-continue"
      >
        {t('settings.setupCommitteeEncryption.recovery.continue')}
      </button>
    {/if}

    {#if phase === 'recovery_confirm'}
      <p class="muted">{t('settings.setupCommitteeEncryption.recovery.confirm_intro')}</p>
      <D6TypeBackVerify bind:typed_value={typedBack} />
      {#if mismatch}
        <div class="setup-committee-alert" role="alert" data-testid="setup-committee-mismatch">
          {t('settings.setupCommitteeEncryption.recovery.mismatch')}
        </div>
      {/if}
      <button
        type="button"
        class="setup-committee-primary"
        on:click={confirmRecovery}
        data-testid="setup-committee-recovery-confirm"
      >
        {t('settings.setupCommitteeEncryption.recovery.continue')}
      </button>
    {/if}

    {#if phase === 'init'}
      <p role="status" data-testid="setup-committee-step-committee-key">
        {t('settings.setupCommitteeEncryption.step.committee_key')}
      </p>
    {/if}

    {#if phase === 'success'}
      <div class="setup-committee-success" role="status" data-testid="setup-committee-success">
        <strong>{t('settings.setupCommitteeEncryption.success.heading')}</strong>
        <p>{t('settings.setupCommitteeEncryption.success.body')}</p>
      </div>
    {/if}

    {#if phase === 'restore_required'}
      <div
        class="setup-committee-alert"
        role="alert"
        data-testid="setup-committee-restore-required"
      >
        <strong>{t('settings.setupCommitteeEncryption.restore_required.heading')}</strong>
        <p>{t('settings.setupCommitteeEncryption.restore_required.body')}</p>
      </div>
      <label class="setup-committee-restore-label" for="setup-committee-restore-passphrase">
        {t('settings.setupCommitteeEncryption.restore_required.passphrase_label')}
      </label>
      <input
        id="setup-committee-restore-passphrase"
        class="setup-committee-restore-input"
        type="password"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        bind:value={restorePassphrase}
        disabled={restoreState === 'restoring'}
        data-testid="setup-committee-restore-passphrase"
      />
      <button
        type="button"
        class="setup-committee-primary"
        on:click={runRestore}
        disabled={restoreState === 'restoring' || restorePassphrase.length === 0}
        data-testid="setup-committee-restore-button"
      >
        {restoreState === 'restoring'
          ? t('settings.setupCommitteeEncryption.restore_required.restoring')
          : t('settings.setupCommitteeEncryption.restore_required.restore_button')}
      </button>
      {#if restoreState === 'wrong_passphrase'}
        <p class="setup-committee-error" role="alert" data-testid="setup-committee-restore-error">
          {t('settings.setupCommitteeEncryption.restore_required.wrong_passphrase')}
        </p>
      {/if}
      {#if restoreState === 'not_found'}
        <p class="setup-committee-error" role="alert" data-testid="setup-committee-restore-error">
          {t('settings.setupCommitteeEncryption.restore_required.not_found')}
        </p>
      {/if}
      {#if restoreState === 'failed'}
        <p class="setup-committee-error" role="alert" data-testid="setup-committee-restore-error">
          {t(restoreErrorKey)}
        </p>
      {/if}
    {/if}

    {#if phase === 'foreign_held'}
      <div class="setup-committee-alert" role="alert" data-testid="setup-committee-foreign-held">
        <strong>{t('settings.setupCommitteeEncryption.foreign_held.heading')}</strong>
        <p>{t('settings.setupCommitteeEncryption.foreign_held.body')}</p>
      </div>
      <a class="setup-committee-cta" href={restoreHref} data-testid="setup-committee-foreign-cta">
        {t('settings.setupCommitteeEncryption.foreign_held.cta')}
      </a>
    {/if}

    {#if phase === 'waiting'}
      <!-- Polite "fingerprint ready" region: mounted empty (during `computing`),
           populated on `shown` so it announces as a live-region mutation. -->
      <p class="visually-hidden" role="status" aria-live="polite">{waitingReady}</p>
      {#if waitingState === 'computing'}
        <!-- Loading coverage for the waiting phase. SHA-256 of 32 bytes is
             sub-millisecond, so no spinner; the section's aria-busy carries the
             busy state and this polite line names the literal action. -->
        <p
          class="muted"
          role="status"
          aria-live="polite"
          data-testid="setup-committee-waiting-computing"
        >
          {t('settings.setupCommitteeEncryption.waiting.computing')}
        </p>
      {:else if waitingState === 'shown'}
        <div class="setup-committee-waiting" data-testid="setup-committee-waiting">
          <!-- Single deliberate focus target on entry (mirrors Surface J
               success) — the lead paragraph, read first so the SR order teaches
               the mental model: you're set up → the fingerprint → what to do. -->
          <p class="setup-committee-waiting-lead" tabindex="-1" bind:this={waitingLeadEl}>
            {t('settings.setupCommitteeEncryption.waiting.lead')}
          </p>

          <!-- The disclosed-fingerprint block — the SHARED cross-surface mirror
               (design-system.md §4). The co-chair's P1-8d grant screen consumes
               the SAME component, so the two humans compare group-for-group by
               construction. Copy of a PUBLIC value (SHA-256 of the public key) is
               correct here — the CONTIGUOUS 64-hex, the paste-compare target. -->
          <FingerprintCompareBlock
            {fingerprint}
            regionLabel={t('a11y.settings.setup.fingerprint.region_label')}
            label={t('settings.setupCommitteeEncryption.waiting.fingerprint_label')}
            testid="setup-committee-fingerprint"
            showCopy={true}
            copyLabelKey="settings.setupCommitteeEncryption.waiting.copy"
            copiedKey="settings.setupCommitteeEncryption.waiting.copied"
            copyErrorKey="settings.setupCommitteeEncryption.waiting.copy_failed"
            copiedAnnounceKey="a11y.settings.setup.fingerprint.copied"
            errorAnnounceKey="settings.setupCommitteeEncryption.waiting.copy_failed"
          />

          <!-- Compare instruction — calm info callout (icon + text, colour never
               alone). This is a normal, expected step, not a hazard. -->
          <div class="setup-committee-callout setup-committee-callout-info">
            <svg class="setup-committee-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="M12 11v5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
              <path
                d="M12 8h.01"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <h3 class="setup-committee-callout-heading">
                {t('settings.setupCommitteeEncryption.waiting.compare_heading')}
              </h3>
              <p class="setup-committee-callout-body">
                {t('settings.setupCommitteeEncryption.waiting.compare_body')}
              </p>
            </div>
          </div>
        </div>
      {:else if waitingState === 'derive_error'}
        <!-- Fail-safe error coverage. Unreachable in the gated branch (privkey
             guaranteed present); if it fires the honest recovery is retry. -->
        <div class="setup-committee-alert" role="alert" data-testid="setup-committee-waiting-error">
          <strong tabindex="-1" bind:this={waitingErrorEl}>
            {t('settings.setupCommitteeEncryption.waiting.error.heading')}
          </strong>
          <p>{t('settings.setupCommitteeEncryption.waiting.error.body')}</p>
        </div>
        <button
          type="button"
          class="btn-outline"
          on:click={retryWaiting}
          data-testid="setup-committee-waiting-retry"
        >
          {t('settings.setupCommitteeEncryption.waiting.error.retry')}
        </button>
      {/if}
    {/if}

    {#if phase === 'error'}
      <div class="setup-committee-alert" role="alert" data-testid="setup-committee-error">
        {t(errorKey)}
      </div>
      <button
        type="button"
        class="btn-outline"
        on:click={retry}
        data-testid="setup-committee-retry"
      >
        {t('settings.setupCommitteeEncryption.error.retry')}
      </button>
    {/if}
  </section>
{/if}

<style>
  .setup-committee-section {
    margin-block-start: 1.25rem;
  }
  .muted {
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }
  .setup-committee-note {
    margin-block: 0.5rem 0.75rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border, var(--color-border-strong));
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg, var(--color-muted));
    color: var(--color-tint-amber-fg, var(--color-fg));
    font-size: 0.875rem;
  }
  .setup-committee-primary {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .setup-committee-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .setup-committee-primary:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
  .setup-committee-success {
    margin-block: 1rem 0;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-tint-green-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
  }
  .setup-committee-success strong {
    display: block;
    margin-block-end: 0.25rem;
    font-weight: 600;
  }
  .setup-committee-success p {
    margin: 0;
  }
  .setup-committee-alert {
    margin-block: 1rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
  .setup-committee-alert strong {
    display: block;
    margin-block-end: 0.25rem;
    font-weight: 600;
  }
  .setup-committee-alert p {
    margin: 0;
  }
  .setup-committee-cta {
    display: inline-block;
    margin-block-start: 0.75rem;
    min-height: 2.75rem;
    padding: 0.625rem 1rem;
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-accent-fg);
    text-decoration: none;
    font-weight: 500;
  }
  .setup-committee-cta:hover {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }
  .setup-committee-cta:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
  .setup-committee-restore-label {
    display: block;
    margin-block-start: 0.75rem;
    font-weight: 500;
  }
  .setup-committee-restore-input {
    display: block;
    inline-size: 100%;
    margin-block-start: 0.25rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-fg);
    font: inherit;
  }
  .setup-committee-restore-input:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
  .setup-committee-error {
    margin-block-start: 0.5rem;
    color: var(--color-tint-red-fg);
    font-size: 0.875rem;
  }

  /* --- P1-9 waiting phase (Surface L). Colour / border / radius / font all bind
     to the app CSS-variable token palette; spacing + type sizing use rem
     literals matching the sibling OneTimeCodeCard convention (this project
     exposes no spacing-scale custom properties). --- */
  .setup-committee-waiting {
    display: grid;
    gap: 1rem;
    margin-block-start: 1rem;
  }
  .setup-committee-waiting-lead {
    margin: 0;
    color: var(--color-fg);
  }
  .setup-committee-callout {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-inline-start-width: var(--border-width-thick);
    border-radius: var(--radius-md);
  }
  .setup-committee-callout-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .setup-committee-callout-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .setup-committee-callout-body {
    margin-block: 0.25rem 0;
    font-size: 0.875rem;
  }
  .setup-committee-callout-info {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
