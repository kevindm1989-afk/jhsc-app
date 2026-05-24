# Adversarial Review — T19 identity-recovery onboarding

**Verdict: FAIL — BLOCK ON FINDINGS.**

Coverage: large change (~14 source files reviewed; 9 test files cross-referenced; ADR-0020 + threat-model §8.T19 consumed in full). 236 passing tests is misleading; the suite measures what the implementer thought to test, not what the contract requires.

**Findings count:** 13 BLOCKING, 7 ADVISORY, 3 NIT.

**Scope:** commit `4e9d1a0`.

---

## Top three BLOCKING findings (most consequential)

### A-T19-1 [BLOCKING] Downloaded recovery blob is structurally undecryptable — nonce dropped from JSON serializer

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/recovery-blob-download.ts:27-69` + `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte:49-65`
- **Trigger:** Any user who downloads the JSON blob (Option C, ADR-0020 §C) and later tries to recover on another device.
- **Failure mode:** `encryptRecoveryBlob` returns `{salt, nonce, ciphertext, kdf_params}` (`apps/web/src/lib/crypto/recovery-blob.ts:166-171`). `RecoveryBlobJsonInput` accepts only `{ciphertext, kdf_params: {ops, mem, salt}}` — no `nonce` field. `serializeRecoveryBlobJson` therefore writes JSON with no nonce. libsodium `secretbox_open_easy` cannot decrypt without the nonce; the downloaded blob is dead bytes. The user's "secondary off-device custody" (ADR-0020 Option C) is non-functional. **The downloaded file CANNOT recover the identity.**
- **Why tests didn't catch it:** `d4-recovery-passphrase.test.ts` lines 147-227 only assert the closed-allowlist (`{ciphertext, kdf_params, version, blob_id}`) and absence of PI keys. There is no round-trip test that serializes → re-parses → decrypts. M-105a explicitly says "tampered ciphertext fails MAC verification on decrypt" but no test exercises decrypt at all. The closed-allowlist is enforced AT THE EXPENSE OF correctness.
- **Missing test:** `it('serialized JSON round-trips through encryptRecoveryBlob → JSON.stringify → JSON.parse → decryptRecoveryBlob and yields the original privkey', ...)` — wire `encryptRecoveryBlob(privkey, passphrase)` → `serializeRecoveryBlobJson(...)` → `JSON.parse(JSON.stringify(out))` → `decryptRecoveryBlob({...parsed, salt:..., nonce: ???}, passphrase)`. This test cannot even be written against the current API, which is the smoking gun.

### A-T19-2 [BLOCKING] OnboardingFlow encrypts an all-zeros key as the "recovery blob"

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte:51`
- **Trigger:** Any user clicks the "Download" button on D.4.
- **Failure mode:** `await encryptRecoveryBlob(new Uint8Array(32), passphrase)` — the FIRST argument is the identity private key. The implementer hardcoded a 32-byte zero buffer. The "encrypted recovery blob" the user downloads contains the AEAD of zeros, not the user's real privkey. Recovery is impossible because the blob doesn't carry the secret it claims to.
- **Plus:** the resulting `json` is computed then immediately discarded (`void json;` line 60) — even if the key were correct, the file is never actually written. No `URL.createObjectURL` / `<a download>` call fires. The button is theatre.
- **Why tests didn't catch it:** The serializer test (d4-recovery-passphrase.test.ts:147-227) calls `serializeRecoveryBlobJson` directly with a fixture `Uint8Array([1,2,3,4])`. No test renders D.4 + clicks download + verifies a file was generated or that the encrypted privkey matches the in-memory identity privkey.
- **Missing test:** Integration test: render `OnboardingFlow` at D.4 with a known privkey seeded via the test-only `__d4_identity_privkey` prop; click download; capture the `Blob` written; parse; decrypt; assert byte equality.

### A-T19-3 [BLOCKING] D.4 passphrase is HARDCODED — every user gets "horse battery staple correct shuffle window planet harbor stone river"

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte:167-178`
- **Trigger:** Any user reaches D.4 or D.6.
- **Failure mode:** `__d4_passphrase = 'horse battery staple correct shuffle window planet harbor stone river'`. There is no call to `generatePassphrase()` from `lib/crypto/passphrase.ts` (which ADR-0020 §2.d step 2 binds). Every onboarding user, every browser, every workplace, gets the SAME passphrase. The entire recovery posture collapses: F-08 brute-force surface is reduced from `~2^128` to `1`. The type-back at D.6 passes for any user typing the literal string; the recovery blob (if it ever worked, see A-T19-1/2) would be decryptable by anyone.
- **Why tests didn't catch it:** D.4 tests assert the passphrase is rendered in a `<code data-testid="recovery-passphrase">` element (`d4-recovery-passphrase.test.ts:310-319`). They never assert two independent renders produce different strings. They never assert the string is high-entropy. The integration test in the scaffold (per ADR §11) was supposed to exercise `__test_only_get_passphrase_ref()`, but `OnboardingFlow.svelte` just seeds the SAME string into that seam.
- **Missing test:** `it('two independent OnboardingFlow mounts at D.4 generate DIFFERENT passphrases', ...)` and `it('the D.4 passphrase contains at least 80 bits of entropy (e.g., ≥10 word-tokens from a 7776-entry list)', ...)`.

---

## Remaining BLOCKING findings

### A-T19-4 [BLOCKING] `BrowserWipeStore.emitAudit` is a no-op stub returning `{ok:true}` — the F-106 audit-BEFORE-side-effect contract is structurally voided in production

- **Location:** `/home/user/agent-os/apps/web/src/lib/lock/wipe-store.ts:230-237`
- **Failure mode:** In production, `panicWipe()` calls `store.emitAudit(...)` → returns `{ok:true}` → proceeds to clear IndexedDB / caches / etc. No audit row is ever persisted server-side. F-106 / M-106a is satisfied only in tests (via `MemoryWipeStore` which actually pushes into `emittedRows`). The very repudiation surface F-106 is supposed to close — "user claims I did not invoke panic-wipe" — is wide open in production because the row never exists. The comment ("returns ok=true so the local destruction proceeds; the production wire-up swaps this for the real emitter") is an aspirational TODO masquerading as an implementation.
- **Why tests didn't catch it:** Every panic-wipe test in `d6-panic-wipe.test.ts` instantiates `MemoryWipeStore`, never `BrowserWipeStore`. There is no test exercising `BrowserWipeStore.emitAudit()` against a real (or mocked) audit-emit transport.
- **Fix:** Wire `emitAudit` to the existing T05.1 audit-emit path now, or make `BrowserWipeStore.emitAudit` return `{ok:false}` so production panic-wipe fail-closes per M-106a (better to abort the wipe than lose the trace).
- **Missing test:** `it('BrowserWipeStore.emitAudit on a network failure returns {ok:false}', ...)` and `it('BrowserWipeStore.emitAudit posts to the audit-emit transport', ...)`.

### A-T19-5 [BLOCKING] Recovery passphrase is rendered with `aria-live="polite"` on its parent — F-108 M-108c violation

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte:155`
- **Failure mode:** `<div data-testid="recovery-passphrase-onscreen" role="region" aria-live="polite"><code>{passphrase}</code></div>`. The passphrase IS in a live-region — when it appears in DOM (revealed state), the screen reader announces every word aloud. M-108c explicitly forbids this exact pattern (ambient-mic / in-earshot recording vector).
- **Why tests didn't catch it:** `d4-recovery-passphrase.test.ts:312` queries only `code[data-testid="passphrase-reveal"], code[data-testid="recovery-passphrase"]` and checks for `aria-live` on the `<code>` itself. The live attribute is on the PARENT `<div>`, not the `<code>`. The G-T19-6 lint script doesn't check `aria-live` at all (see A-T19-9).
- **Missing test:** assert NO ancestor of the passphrase node up to the section root carries `aria-live`, `role="alert"`, or `role="status"`.

### A-T19-6 [BLOCKING] `runExtendedBaseline` doesn't actually run the per-capability feature detection — `uaPass` short-circuits everything

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/browser-baseline.ts:71-102`
- **Failure mode:** Every check except `webcrypto` is `pass: uaPass`. `argon2id` is hardcoded `pass: true`. ADR-0020 Decision 1 + Option D explicitly require runtime detection of `PublicKeyCredential`, `crypto.subtle`, `indexedDB`, `serviceWorker`, `navigator.locks`, `crypto_pwhash`. A Firefox 122 with `dom.serviceWorkers.enabled=false`, a Tor Browser, a Brave shield-up, or any privacy-resist UA passes baseline → fails mid-D.3 with a worse UX than the architect promised (Option D rejects warn-and-continue specifically because it strands users mid-ceremony). The `argon2id` hardcode is the most egregious — ADR-0003 Amendment G structurally requires fail-closed on missing `crypto_pwhash`, and this badge LIES that it's available.
- **Why tests didn't catch it:** `d2-browser-baseline.test.ts` likely tests UA-only paths against fake UAs; jsdom doesn't expose real `PublicKeyCredential`/`navigator.locks` to detect, so the implementer rationalized the short-circuit as "jsdom workaround" — see lines 62-69 comment. The workaround leaks into production semantics.
- **Missing test:** mock `globalThis.PublicKeyCredential = undefined` while UA = Chrome 130; assert `baseline.ok === false` and `baseline.failed.includes('passkey')`.

### A-T19-7 [BLOCKING] Test-only seams export from a Svelte `context="module"` block — production bundle ships `__test_only_get_passphrase_ref` / `__test_advance_through_type_back` / `__setPassphraseRefForTest`

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte:1-33`
- **Failure mode:** ES module exports are statically analyzed; the runtime guard `if (import.meta.env.MODE === 'production') return ''` only changes the return VALUE, not whether the symbol is exported, tree-shaken, or callable. An attacker / browser-extension can call `import('./D4RecoveryPassphrase.svelte').then(m => m.__setPassphraseRefForTest('hijacked'))` in production. The closed-allowlist guard is value-only, not surface-removal. ADR-0020 Decision 8 specified the build-time strip; the implementer downgraded it to a runtime no-op.
- **Why tests didn't catch it:** the G-T19-5 script (`scripts/check-onboarding-test-props-stripped.sh`) only greps for 3 patterns: `__test_step`, `__test_user_agent`, `__test_origin` (see A-T19-9). The five real seams listed in the task prompt are absent from the script.
- **Missing test:** extend `check-onboarding-test-props-stripped.sh` to grep for `__test_only_get_passphrase_ref`, `__test_advance_through_type_back`, `__setPassphraseRefForTest`, `__debugForceAuditFailure`, `__debugForceClearFailure`, `__TEST_PANIC_WIPE_HOOK`, `__resetPanicWipeLockoutForTest`.

### A-T19-8 [BLOCKING] Svelte `export let __test_step = undefined` emits literal `"__test_step"` in production JS — F-102 M-102b grep gate is bypassed

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte:37-47`, `/home/user/agent-os/apps/web/src/lib/lock/PanicWipeModal.svelte:19-23`
- **Failure mode:** Svelte's compiler emits `$$props.__test_step` and prop-validation code carrying the literal prop name. The decoy `const __probe_test_step = '__test_' + 'step'; void __probe_test_step;` (lines 51-53, 67-69) is dead code that does not replace the prop declaration. ADR-0020 §F + Decision 8 explicitly require the prop NAMES not appear as literals in the bundle. CI gate (G-T19-5) WILL flag the bundle if it runs — but in jsdom test mode the gate isn't invoked, and the script also no-ops when the bundle directory is missing (see A-T19-10). The runtime strip clears the VALUES but cannot remove the symbols from the bundle.
- **Why tests didn't catch it:** No T19 test compiles the SvelteKit production bundle and runs the grep. The script silently passes when `apps/web/build/` doesn't exist (`scripts/check-onboarding-test-props-stripped.sh:34-37`).
- **Fix:** Either drop the test-only props from `export let` (use a separate test-only seam imported only by tests via a Vite alias) or accept that the prop names must appear and update ADR-0020 §F. Cannot have both.

### A-T19-9 [BLOCKING] `check-onboarding-no-passphrase-leak.sh` lies about what it catches AND doesn't scan OnboardingFlow.svelte (where the passphrase actually renders)

- **Location:** `/home/user/agent-os/scripts/check-onboarding-no-passphrase-leak.sh:11-15, 33-50`
- **Failure mode:** Script header documents that it checks `aria-live`, `role="alert"`, `role="status"` on passphrase elements. The `FORBIDDEN` array (lines 45-50) contains ONLY clipboard + TTS patterns. Zero aria-live / role checks. Worse: the file allowlist (`FILES` array) covers `D4RecoveryPassphrase.svelte`, `D6TypeBackVerify.svelte`, and `recovery/*.svelte` — but the actual passphrase render lives in `OnboardingFlow.svelte:422` (`<code data-testid="recovery-passphrase">{__d4_passphrase}</code>`). The script's coverage misses where the bug actually is. Combined with A-T19-5, the lint claims to enforce a contract it doesn't enforce on the file where the violation lives.
- **Missing test:** add `OnboardingFlow.svelte` to FILES; add patterns for `aria-live\s*=\s*['"](polite|assertive)`, `role\s*=\s*['"](alert|status)`, scoped to lines near `passphrase` (with a few lines of context).

### A-T19-10 [BLOCKING] `check-onboarding-test-props-stripped.sh` silently passes when no bundle exists — CI green on a missing bundle

- **Location:** `/home/user/agent-os/scripts/check-onboarding-test-props-stripped.sh:34-37`
- **Failure mode:** `if [ ! -d "$BUNDLE_DIR" ]; then echo "warn: ..."; exit 0; fi`. In CI, if any prior step fails the build, the bundle directory is missing, and this script returns success. The G-T19-5 gate is non-load-bearing in any CI run where the build skipped. ADR-0020 §F explicitly designates this as the structural enforcement of the production-strip contract — a silent pass on missing-bundle inverts the gate.
- **Fix:** `exit 1` (or at least require a `--allow-missing` flag) when bundle dir is absent.

### A-T19-11 [BLOCKING] Hardcoded English strings in OnboardingFlow.svelte bypass the closed-allowlist + break fr-CA

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte:131-138, 379-381, 455, 510, 548-550`
- **Failure mode:** `STEP_LABELS` array hardcodes "Personal device", "Where your data lives", "Passkey", "Recovery sheet", "Sessions", "Confirm phrase", "Done"; line 379-381 hardcodes "Browser version below the supported baseline"; line 455 hardcodes "Next: confirm passphrase"; line 510 hardcodes "Type the passphrase to confirm"; lines 548-549 hardcode "Settings → Sessions lets you sign out other devices..."; PanicWipeModal:149 hardcodes `aria-label="Type WIPE to confirm"`. These strings will never translate (G-T19-1 fr-CA pass cannot find them); they bypass the `copy-keys.ts` closed allowlist; they bypass HG-10 lawyer review. The label "Recovery sheet" specifically diverges from Designer §A canonical "Recovery passphrase ceremony" naming.
- **Why tests didn't catch it:** `i18n-catalog-coverage.test.ts` checks that every key in COPY_KEYS exists in the catalog — but doesn't enforce the inverse (every user-visible string is keyed). Hardcoded strings have no key to reference and are invisible to the gate.
- **Missing test:** static lint walking `lib/onboarding/*.svelte` for string literals inside HTML text nodes / aria-* attributes that don't pass through `t(...)`.

### A-T19-12 [BLOCKING] State-machine gates are not enforced — OnboardingFlow.svelte mutates `currentStep` directly with no precondition checks

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte:143, 147, 159, 191, 217, 222, 259`; `state-machine.ts:78-87` ("Throws when the current step's gate is not satisfied" — comment, not behavior)
- **Failure mode:** The state-machine `advance()` function documents gate enforcement in its JSDoc but the body just blindly indexes `ORDER`. Worse: OnboardingFlow.svelte doesn't even call `advance()` — it reassigns `currentStep = 'D.X'` directly. There is no D.1→D.2 device-confirmed gate check; `onD1Continue` checks `deviceConfirmed` but `onD2Continue`, `onD3Start`, etc., transition unconditionally. `onD3Start` checks `PublicKeyCredential` presence but only catches and sets an error — line 159 sets `currentStep = 'D.4'` whether or not enrollment actually succeeded (it never calls `enrollFirstDevicePasskey`). The wizard advances on click, regardless of contract.
- **Why tests didn't catch it:** `state-completeness.test.ts` likely exercises step rendering, not transition gate semantics. Tests jump in via `__test_step` and never traverse a real gate.
- **Missing test:** `it('clicking D.3 primary button does NOT advance to D.4 if enrollFirstDevicePasskey returns status !== 200', ...)`.

### A-T19-13 [BLOCKING] D.3 never actually enrolls a passkey — `onD3Start` just checks `PublicKeyCredential` exists then advances

- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte:154-163`
- **Failure mode:** No call to `enrollFirstDevicePasskey()`. No TOTP submission. No origin check. No `auth.passkey.enrolled` audit row triggered server-side. The user reaches D.4/D.5/D.6/D.7 without ANY passkey, ANY server-side enrollment, and ANY recovery blob landing in `recovery_blobs`. The entire D.3 contract from ADR-0020 §2.b is theatre. (D3PasskeyEnrollment.svelte exists as a separate file with the real composition, but OnboardingFlow.svelte doesn't render or invoke it — it inlines a fake D.3.)
- **Why tests didn't catch it:** D.3 tests `d3-passkey-enrollment.test.ts` render `OnboardingFlow` and check that catalog keys resolve / rate-limit constant matches — they do not assert `enrollFirstDevicePasskey` was called or that an `auth.passkey.enrolled` row was emitted. The implementer's "inlined D.4-D.6 rendering" deviation widens silently to "inlined D.3 with zero enrollment".

---

## Top three race-condition / test-seam concerns

1. **`__defaultStoreWiped` module-global lockout breaks test isolation** (`panic-wipe.ts:65, 173`). Any test that calls `panicWipe()` with no `opts.store` sets the module-global flag for the rest of the process. Tests must remember to call `__resetPanicWipeLockoutForTest()` between runs. The scaffold's "panicWipe() clears IndexedDB" test (per ADR §11) flows through this path; the next test in the same file inherits a wiped flag. Test pollution that passes for the wrong reason (subsequent assertions become no-ops).
2. **PanicWipeModal `aria-disabled` button still fires onclick** (`PanicWipeModal.svelte:155-162`). The primary button uses `aria-disabled` only (no `disabled` attribute). Click handlers fire regardless. `onConfirm` then checks `!ready || !isPhraseMatched()` — but if a user clicks during the ready-delay (e.g., synthesized programmatic click before `ready` resolves), the guard catches it. However: there's no Cancel-button handler binding (`<button type="button">{t('...cancel_button')}</button>` line 163-165). Cancel does nothing. The user is trapped.
3. **`onPhraseInput` mutates the DOM during the input event then calls `flushSync` inside an event handler** (`PanicWipeModal.svelte:69-79`). The pattern `target.value = ''; typedPhrase = ''; syncFlush();` runs synchronously in the keydown→input cycle. In test harness this works; in real browsers, fast typing during the ready-delay window can race the reactivity — keypresses queued before `ready` resolves can leak through if the gate flips between the `keydown` and `input` dispatch.
4. **Test-seam abuse:** `__TEST_PANIC_WIPE_HOOK` global (`panic-wipe.ts:152-155, 168-171`) is gated only by `import.meta.env.MODE !== 'production'`. The gate is runtime; the symbol name and lookup logic remain in the production bundle (constant-folded `false` branch is normally tree-shaken, but Vite's reactivity around `import.meta.env` is not guaranteed across all build modes — staging, preview, e2e). A staging deploy with `MODE !== 'production'` (very common) ships a working `globalThis.__TEST_PANIC_WIPE_HOOK` injection seam. Combined with the audit-stub (A-T19-4), a staging panic-wipe can be hijacked by setting the global.

---

## Implementer's flagged deviations — disposition

| Deviation | Disposition |
|---|---|
| (a) Svelte 5 esrap TS annotation removal | **VALID-DECISION** (no evidence of regression; comments preserve the rationale). |
| (b) Step-indicator label rename "Recovery passphrase" → "Recovery sheet" | **FINDING-FILED** — diverges from Designer §A canonical "Recovery passphrase ceremony" / `onboarding.recovery.heading` key; the rename is also hardcoded English (A-T19-11) and bypasses HG-10. |
| (c) WeakSet-based per-store lockout vs global default-store flag | **FINDING-FILED** — see race-concern #1 above; module-global `__defaultStoreWiped` is shared across the entire process and pollutes any test that uses the default store, AND in production cannot be reset across the same browser session even after a successful re-enrollment (a user who panic-wipes then re-onboards then needs to panic-wipe again hits `no_op` until full reload). |
| (d) Inlined D.4-D.6 rendering in OnboardingFlow | **FINDING-FILED** — this is the root cause of A-T19-2 (hardcoded zeros key), A-T19-3 (hardcoded passphrase), A-T19-13 (no D.3 enrollment), A-T19-5 (live-region passphrase via the inlined render bypassing RecoveryPassphraseScreen entirely), A-T19-11 (hardcoded English). The "convenience" of inlining created a parallel rendering path that doesn't compose the real library functions. The separate step components (`D4RecoveryPassphrase.svelte`, `D6TypeBackVerify.svelte`, `D3PasskeyEnrollment.svelte`, `D7Complete.svelte`) exist but are NOT mounted by OnboardingFlow — they're dead code that the tests render in isolation while the wizard ships the inline fakes. |

---

## Remaining findings (compact)

- **A-T19-14 [ADVISORY]** PanicWipeModal hardcodes light-mode token in `data-focus-ring-inner-token="color.light.onboarding.panic_overlay_fg"` (line 121) — dark-mode users get inverted-ring failure. Test regex `/onboarding\.panic_overlay_fg/` passes either way.
- **A-T19-15 [ADVISORY]** Two duplicate state-machine files (`state-machine.ts` and `step-machine.ts` are byte-for-byte identical exports). ADR-0020 Decision 1 names only `step-machine.ts`. Divergence risk.
- **A-T19-16 [ADVISORY]** D.7 next-steps copy is hardcoded English: "Settings → Sessions lets you sign out other devices..." (OnboardingFlow.svelte:548-549) — separately from the i18n `next_steps_body` key it ALSO renders on the next line. Duplicated content; one is keyed, one is not.
- **A-T19-17 [ADVISORY]** F-114 M-114a is satisfied (no `committee_membership` / `role.` references in `lib/onboarding/` per `grep`) — VALID-DECISION confirmed.
- **A-T19-18 [ADVISORY]** Rate limiter `tryAttempt` uses `<= cutoff` (off-by-one — attempts at exactly the window boundary are purged) and doesn't validate `now` is monotonic. A non-monotonic clock (`Date.now()` after NTP correction backward) corrupts the queue.
- **A-T19-19 [ADVISORY]** `D3PasskeyEnrollment.svelte:36` silently returns if `auth === undefined` — no error toast, no log; user clicks "Set up passkey" and nothing happens, no feedback.
- **A-T19-20 [ADVISORY]** `device-fingerprint.ts:37` reads `navigator.platform` — this is a deprecated API. On modern Chrome it returns `"Win32"` regardless of actual OS, which is misleading in the user-facing D.1 surface intended for "honest framing". M-101c says UA + platform only; the platform value itself is now informationally degraded.
- **A-T19-21 [NIT]** PanicWipeModal Cancel button has no click handler (`PanicWipeModal.svelte:163-165`).
- **A-T19-22 [NIT]** `bytesToBase64` falls through to `btoa(String.fromCharCode.apply(...))` in browser; test environment uses `Buffer.from(...).toString('base64')`. Different code paths between test and prod (latter is O(n) string concat, OK but untested).
- **A-T19-23 [NIT]** `OnboardingFlow.svelte:266-268` `$:` reactive block creates an enrollment session id only when `currentStep === 'D.1' && enrollment_session_id === ''` — the `===` empty-string check never fires after the initial `generateEnrollmentSessionId()` on line 99, so the F-54 "fresh id on re-entry to D.1" contract is broken. A user who goes D.1→D.2→back→D.1 keeps the same id.

---

## Cross-coverage gaps the test-writer should harden

- **Round-trip recovery:** no test serializes → parses → decrypts → asserts privkey equality.
- **Live-region scope:** assertions check the `<code>` element but not ancestors.
- **Production-bundle grep:** missing 6 of 9 test-seam symbols.
- **State-machine gates:** no test asserts a gate REJECTS an invalid advance; tests only assert successful advance.
- **Per-capability baseline detection:** no test mocks individual capability absence with a passing UA.
- **`BrowserWipeStore` end-to-end:** no integration test instantiates the production store.
- **Two-tab isolation:** no test instantiates two OnboardingFlow components and asserts independent state.
- **Hardcoded-string lint:** no static check for string-literal text nodes in `lib/onboarding/*.svelte` outside `t(...)`.

---

**Recommendation: BLOCK on findings; escalate to security-reviewer + privacy-reviewer.** The audit-emit stub (A-T19-4), the hardcoded passphrase (A-T19-3), the undecryptable blob (A-T19-1, A-T19-2), the live-region passphrase (A-T19-5), the bogus baseline (A-T19-6), and the missing D.3 enrollment (A-T19-13) collectively mean T19 ships a wizard that LOOKS like it does identity recovery but actually performs none of the security-relevant work the ADR promises. 236 passing tests are a complete coverage illusion.
