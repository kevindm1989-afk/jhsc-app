# Security review — T19 identity-recovery onboarding

## Re-review (2026-05-25)

**Reviewer:** security-reviewer (agent)
**Re-review date:** 2026-05-25
**Diff range:** `d6ce313..4c93eab` (implementer rework)
**Mode:** READ-ONLY (no code modified)

### Per-finding verdict

| Finding | Prior | Verdict | Evidence |
|---|---|---|---|
| S-T19-1 hardcoded passphrase | BLOCKING | **CLOSED** | `OnboardingFlow.svelte` now calls `generateRecoveryPassphrase()` + `generateIdentityKeypair()` in `ensureD4Ready()`. The `'horse battery…'` literal is gone (grep empty). `generateRecoveryPassphrase` uses `sodium.randombytes_buf` → two mounts produce independent passphrases. |
| S-T19-2 aria-live on passphrase | BLOCKING | **CLOSED** | `RecoveryPassphraseScreen.svelte:178` reveal `<div>` no longer carries `role=region`/`aria-live`. The only `aria-live` in onboarding (`OnboardingFlow.svelte:395`) is the SR-only `wizard-step-announce` carrying step-number copy, NOT the passphrase. Strict-lint now covers `aria-live`/`role=alert`/`role=status` on wrapper files (script exit 0). |
| S-T19-3 module-level passphrase ref | BLOCKING | **CLOSED** | `D4RecoveryPassphrase.svelte` is no longer `<script context="module">`; `__module_passphrase_ref` removed (grep empty). Passphrase ref is component-instance closure (`d4_passphrase` in `OnboardingFlow.svelte`). Seam state moved to `__test_seams.ts` (keyed Map; module-throws on production import). |
| S-T19-4 emitAudit no-op stub | BLOCKING | **CLOSED** | `wipe-store.ts` `BrowserWipeStore.emitAudit` now returns `{ok:false}` (fail-closed). `panic-wipe.ts:108-113` aborts with `audit_failed` BEFORE any `clear*` runs when `!auditAck.ok`. Audit-BEFORE-side-effect ordering enforced. |
| S-T19-5 D.3 never enrolls passkey | BLOCKING | **CLOSED** | `OnboardingFlow.svelte:556`/D.3 branch mounts real `<D3PasskeyEnrollment>` which calls `enrollFirstDevicePasskey`. Advance is gated: `onD3Enrolled(ok)` returns early unless `ok`; component fires `onEnrolled(true)` only on `r.status===200`. `canAdvance` requires `passkey_enrolled`. |
| S-T19-7 rate-limiter unwired | ADVISORY | **CLOSED** | `createOnboardingRateLimiter({limit:10, window_ms:60_000})` instantiated per-instance; `onD4Continue()` calls `rateLimiter.tryAttempt(Date.now())` and returns with `d4_rateLimitedKey` before advancing. 11th attempt in 60s rejects. |

(S-T19-6 INVARIANT comment, S-T19-8 duplicate state-machine, S-T19-12 D.5 composition were ADVISORY/NIT in the prior pass; the rework removes `state-machine.ts` (S-T19-8 resolved), composes real `<D7Complete>` and `<D5SessionRevocationPrimer>` wiring `revokeAllSessions`. S-T19-6/S-T19-12 effectively closed.)

### Nonce-recoverability (new-issue watch)

**RECOVERABLE.** `serializeRecoveryBlobJson` concatenates `nonce || ciphertext` (fixed 24-byte `crypto_secretbox_NONCEBYTES` prefix) into the single `ciphertext` field, preserving the 4-key closed allowlist. The nonce bytes are present and length-deterministic, so a re-import deserializer can split them back out. The re-import/decrypt path is explicitly out-of-T19-scope (documented header) and not present in this repo — `decryptRecoveryBlob` still consumes a separate-field `RecoveryBlobShape`, so the deserializer that splits `nonce||ciphertext` MUST be implemented by the re-import sibling. No blocking loss of decryptable input.

### New findings

- **S-T19-RR-1 — ADVISORY (carry-forward of S-T19-10).** No SvelteKit route mounts `OnboardingFlow` (`grep OnboardingFlow apps/web/src/routes` empty; the built bundle under `apps/web/build/_app` contains no `onboarding-wizard` artifact). `check-onboarding-test-props-stripped.sh` therefore passes *vacuously* — the wizard surface is not in the bundle. Fix: add `apps/web/src/routes/onboarding/+page.svelte` importing `OnboardingFlow`, then the G-T19-5 grep gate becomes load-bearing. Not a regression; the test-seam runtime-strip (module-throw on production import + grep gate teeth) is sound.

### Script exit codes

- `check-onboarding-no-passphrase-leak.sh` → **exit 0** (STRICT_FORBIDDEN now includes `aria-live`/`role="alert"`/`role="status"` + `autofocus`; OnboardingFlow added to scope).
- `check-onboarding-test-props-stripped.sh apps/web/build` → **exit 0** (PATTERNS extended with the 6 seam symbols + fail-closed on missing bundle dir). Note S-T19-RR-1: vacuous until the wizard is route-mounted.

### Other checks

- `grep node:crypto apps/web/src/lib/onboarding apps/web/src/lib/lock` → empty (G-T08-10 holds).
- `__test_seams.ts` extraction removes production-callable surface: the module throws on `import.meta.env.MODE === 'production'` import (defense-in-depth) AND the seam symbols are grepped out of the production bundle. Not merely moved.

### Overall verdict: **PASS-WITH-ADVISORIES**

All 5 prior BLOCKING findings (S-T19-1..5) CLOSED; the ADVISORY S-T19-7 CLOSED. One non-blocking carry-forward (S-T19-RR-1) remains: route-mount the wizard so the bundle-strip gate fires. **T19 touches auth + PI + crypto custody — recommend human review before merge** even though findings are clean.

---

## Original review (2026-05-24)


**Reviewer:** security-reviewer (agent)
**Date:** 2026-05-24
**Commit reviewed:** `4e9d1a0` (T19 implementer pass)
**Diff range:** `e0f5d8b..4e9d1a0`
**Mode:** READ-ONLY (no code modified)

## Summary

**Verdict: FAIL.**

The library code in `lib/lock/` and the auxiliary modules in `lib/onboarding/` (state-machine, copy-keys, device-fingerprint, browser-baseline, recovery-blob-download) are largely correct against the ADR-0020 spec and the §8.T19 threat model. The `MemoryWipeStore` + `panicWipe()` audit-BEFORE-side-effect ordering is implemented as specified. The closed-allowlist on the recovery-blob JSON is correct.

**However, `OnboardingFlow.svelte` — the wizard chrome that is the load-bearing deliverable per ADR-0020 Decision 1 — is functionally a test mock, not a real composition.** It bypasses `lib/auth/passkey-enroll.ts` entirely at D.3, bypasses `lib/auth/session.ts` at D.5, ships a HARDCODED literal passphrase in production source as the D.4 reveal value, and breaks the F-104 M-104a closure-scope contract via a `<script context="module">` module-level `let __module_passphrase_ref`. The composed `RecoveryPassphraseScreen.svelte` (D.4 reveal surface) wraps the passphrase `<code>` in an `aria-live="polite"` region — an explicit M-108c violation that the G-T19-6 static-lint script does not catch. The production `BrowserWipeStore.emitAudit` is a no-op stub that returns `{ok:true}` without emitting any audit row, which means F-106 M-106a "audit row commits BEFORE local destruction" is structurally unenforced on the production path even though the audit-BEFORE-side-effect ORDER in `panic-wipe.ts` is correct.

5 BLOCKING findings, 6 ADVISORY findings, 2 NITs.

## Scope reviewed

- `apps/web/src/lib/lock/{panic-wipe,wipe-store,memory-wipe-store,PanicWipeModal.svelte,index}.ts` — 633 LOC
- `apps/web/src/lib/onboarding/{OnboardingFlow.svelte,state-machine.ts,step-machine.ts,browser-baseline.ts,device-fingerprint.ts,recovery-blob-download.ts,copy-keys.ts}` — 1,400+ LOC
- `apps/web/src/lib/onboarding/steps/{D3PasskeyEnrollment,D4RecoveryPassphrase,D6TypeBackVerify,D7Complete}.svelte` — 217 LOC
- `apps/web/src/lib/i18n/{index.ts,onboarding.en-CA.json}` — 79 + 20,910 bytes
- `apps/web/test/_helpers/{onboarding-harness,axe-check,protected-modal-harness,supabase-test}.ts` — 491 LOC
- `scripts/check-onboarding-{no-passphrase-leak,test-props-stripped}.sh` — 133 LOC
- Cross-referenced: `lib/auth/{passkey-enroll,session,rate-limit}.ts`, `lib/crypto/{recovery-blob}.ts`, `lib/onboarding/recovery/RecoveryPassphraseScreen.svelte` (pre-existing, composed by T19).

## Findings

### S-T19-1 — BLOCKING — Hardcoded passphrase literal in production source code

- **Category:** OWASP A02 (Cryptographic failures: hardcoded secret) / F-104 M-104a / ADR-0020 Decision 2.d step 2
- **Location:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:169`
- **Issue:** The "in-memory passphrase ref" in the inlined D.4 surface is initialised from a hardcoded string literal: `__d4_passphrase = 'horse battery staple correct shuffle window planet harbor stone river'`. ADR-0020 Decision 2.d step 2 mandates `generatePassphrase()` from `lib/crypto/passphrase.ts`. As written, every user reaching D.4 in this wizard would be assigned the same passphrase. The string is also embedded in production source, meaning that any forensic capture of the build (sourcemaps, cached chunks) reveals it. The constant-time compare at line 209 compares the user's typed value to this hardcoded string.
- **Recommended fix:** Replace lines 167-178 with a call to the existing libsodium-backed passphrase generator `generatePassphrase()` (or whichever helper the `lib/crypto/passphrase.ts` exposes — confirm in the file). The ref must be derived from `crypto.getRandomValues` / `randombytes_buf` per ADR-0020 Decision 2.d. Strip the literal entirely from source. Re-run `d6-panic-wipe.test.ts` + the onboarding integration tests with the new generator.
- **Implementer's claim:** None — the harness "completeTypeBackVerify" expects the hardcoded value at `onboarding-harness.ts:75-78` (which the implementer comments as no-op).

### S-T19-2 — BLOCKING — `RecoveryPassphraseScreen.svelte` wraps passphrase `<code>` in `aria-live="polite"` region

- **Category:** OWASP A09 (Information disclosure via accessibility tree) / F-108 M-108c
- **Location:** `apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte:155-157`
- **Issue:** The passphrase reveal element is rendered as:
  ```
  <div data-testid="recovery-passphrase-onscreen" role="region" aria-live="polite">
    <code>{passphrase}</code>
  </div>
  ```
  M-108c is explicit: "the element wrapping the passphrase MUST NOT have `aria-live='assertive'` or `aria-live='polite'` set...the passphrase itself is in a static `<code>` block" (`.context/threat-model.md` §8.T19 F-108 M-108c). With `aria-live="polite"` on the parent, screen readers announce the passphrase value when it materialises in the DOM — an ambient-mic-overheard exfil vector (M-108c's named threat).
  The file is pre-existing (T07/Amendment F) and unchanged in the T19 diff, BUT T19's D.4 surface composes this component (`apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte:71` AND the inlined D.4 in `OnboardingFlow.svelte` mirrors the same `<code>{__d4_passphrase}</code>` shape without the wrapper but with all the surrounding state). The G-T19-6 static-lint script (`scripts/check-onboarding-no-passphrase-leak.sh`) does NOT check `aria-live` / `role=alert` / `role=status` despite the G-T19-6 spec naming those patterns; the script's FORBIDDEN array is `navigator\.clipboard\.writeText | SpeechSynthesisUtterance | window\.speechSynthesis | tts\.speak` only.
- **Recommended fix:** Remove `role="region" aria-live="polite"` from `RecoveryPassphraseScreen.svelte:155`; if a live-region announcement is required for accessibility, move it to a sibling region carrying ONLY the non-leaking `a11y.onboarding.reveal_in_progress_announcement` key (never the passphrase value). ALSO extend `scripts/check-onboarding-no-passphrase-leak.sh`'s FORBIDDEN list to include `aria-live`, `role=["']alert`, `role=["']status` patterns so this regression is caught at build time.
- **Implementer's claim:** Tests `d4-recovery-passphrase.test.ts:243-319` claimed to assert "<code> has no aria-live / role=alert / role=status" per ADR-0020 §F-108. The assertion likely passes against `D4RecoveryPassphrase.svelte`'s own `<code>` but not against the COMPOSED `RecoveryPassphraseScreen.svelte` ancestor div.

### S-T19-3 — BLOCKING — Module-level `let __module_passphrase_ref` violates F-104 M-104a closure-scope contract

- **Category:** OWASP A02 (Cryptographic failures: secret in module-singleton scope) / F-104 M-104a
- **Location:** `apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte:20` (inside `<script context="module">`)
- **Issue:** M-104a is explicit: "NEVER assigned to a module-level `let` outside the component instance" (`threat-model.md` §8.T19 F-104 M-104a). Svelte's `<script context="module">` is a MODULE-level scope — every component instance shares the same `__module_passphrase_ref` binding. The test seam `__test_only_get_passphrase_ref()` reads it; `__setPassphraseRefForTest()` writes it. While the test-seam exports are gated behind `import.meta.env.MODE !== 'production'`, the BACKING `let` itself is unconditional and module-level. Any production code path that ever calls `__setPassphraseRefForTest()` (which DOES happen — `OnboardingFlow.svelte:174` and `:213` call it inside a try/catch with no production guard) writes the passphrase to a module-level binding that survives the component's lifetime and is visible to any future code that imports the module.
- **Recommended fix:** Move the ref into the instance `<script>` (line 35 onward) as a `let __d4_passphrase_ref = ''` and either (a) drop the test-seam exports entirely (test against the component DOM instead) or (b) implement the test-seam via `bind:this` / a `let:` slot prop instead of a module-level shadow. Then strip the `__setPassphraseRefForTest` import from `OnboardingFlow.svelte:25-26` and the two call-sites at `:174` / `:213`.
- **Implementer's claim:** Comments at `D4RecoveryPassphrase.svelte:20-32` claim "the in-memory passphrase ref lives in closure scope (F-104 M-104a — NEVER on window.* / globalThis.* / module-level let outside the component instance)" — the implementation contradicts the comment.

### S-T19-4 — BLOCKING — `BrowserWipeStore.emitAudit` is a no-op stub; F-106 M-106a unenforceable in production

- **Category:** OWASP A09 (Logging failure: audit row not emitted) / F-106 M-106a / ADR-0020 Decision 5
- **Location:** `apps/web/src/lib/lock/wipe-store.ts:230-237`
- **Issue:** The production-path `BrowserWipeStore.emitAudit` returns `{ok: true}` unconditionally without performing any network call, log emission, or queue write. The comment acknowledges this: "Production audit-emission wires to the existing T05.1 audit-emit path. T19 ships the contract surface only; the SQL half lands per ADR-0020 Decision 5 (T07.1 OR T19-audit-extension). Until then this is a no-op that returns ok=true so the local destruction proceeds; the production wire-up swaps this for the real emitter." The structural impact: `panicWipe()` will ALWAYS proceed to destruction in production because the no-op `emitAudit` returns success unconditionally — F-106 M-106a "audit row commits BEFORE local destruction" is structurally satisfied in ORDER but the audit row is NEVER ACTUALLY EMITTED. A user who later disputes "I did not invoke panic-wipe" has no forensic trail. This is the load-bearing M-106 mitigation reduced to a docstring promise.
- **Recommended fix:** Either (a) the production `BrowserWipeStore.emitAudit` must POST to the existing audit-emit endpoint (the same one T05.1 / T07.1 use — `/api/audit/queue` or equivalent per `known-gaps.md` line 342) and return `{ok:false}` on any non-2xx response, OR (b) the implementer must explicitly record this as a NEW carry-forward (suggested ID `G-T19-9`) noting that F-106 M-106a is aspirational pending the SQL CHECK widening AND the production wire-up of `BrowserWipeStore.emitAudit` — AND `panicWipe()` must refuse to proceed against a `BrowserWipeStore` whose `emitAudit` has not been wired (a guard / explicit error). The current state — silently no-op'ing in production — does not match the documented contract.
- **Implementer's claim:** The docstring at `wipe-store.ts:230-235` acknowledges this as a "ships the contract surface only" pattern, but the threat-model re-open trigger #7 explicitly names this scenario: *"The `panic_wipe.invoked` enum's SQL half (T07.1 or T19-audit-extension) is deferred indefinitely → F-106 mitigation M-106a/b/c become aspirational pending the SQL CHECK widening."* The deferral is acknowledged but not recorded in `known-gaps.md`.

### S-T19-5 — BLOCKING — `OnboardingFlow.svelte` D.3 step does not call `enrollFirstDevicePasskey` (M-102a / M-103a violation by omission)

- **Category:** OWASP A07 (Auth: composition gap) / F-102 M-102a / F-103 M-103a/b
- **Location:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:154-163` (D.3 handler `onD3Start`)
- **Issue:** The actual D.3 advance in `OnboardingFlow.svelte` does `if (typeof globalThis.PublicKeyCredential === 'undefined') throw; else currentStep = 'D.4'`. It does NOT call `enrollFirstDevicePasskey(auth, {totp_code, user_id})` from `lib/auth/passkey-enroll.ts`. The TOTP input bound at `:397` is never consumed. As a result:
  1. **M-102a** ("D3PasskeyEnrollment.svelte calls `enrollFirstDevicePasskey()` with the live `window.location.origin`") — unsatisfied because the function is never called.
  2. **M-103a** (TOTP rate-limit composition via `lib/auth/rate-limit.ts` dual-window) — unsatisfied because there is no TOTP consumption path to rate-limit.
  3. **M-103b** (constant-time TOTP compare via `auth-core.ts`'s `constantTimeEqual`) — unsatisfied because no compare happens.
  4. **F-37 RP-ID binding** (passkey ceremony origin validation) — never exercised because no ceremony runs.
  The separate `lib/onboarding/steps/D3PasskeyEnrollment.svelte` DOES call `enrollFirstDevicePasskey` correctly (line 41), but `OnboardingFlow.svelte` never imports nor mounts that component (`grep "D3PasskeyEnrollment" OnboardingFlow.svelte` returns empty). The wizard chrome inlines an empty stub of D.3 instead.
- **Recommended fix:** `OnboardingFlow.svelte` must mount `D3PasskeyEnrollment.svelte` (and the other step components) for the D.3 step rendering — OR move the auth-client composition (with `window.location.origin` snapshot, TOTP rate-limit guard, and `enrollFirstDevicePasskey` call) into `OnboardingFlow.svelte`'s `onD3Start` handler. The empty `pubkeyCredential` typeof check is not a passkey ceremony; it's a feature-detection that does NOT bind the credential to the server. Without this fix, ANY production user reaching this code path advances from D.3 to D.4 without ever enrolling a passkey, leaving the account in a no-passkey-no-recovery-blob state.
- **Implementer's claim:** Comments at `OnboardingFlow.svelte:140-163` describe the D.1/D.2/D.3 handlers; no comment acknowledges the auth-composition gap. The harness at `onboarding-harness.ts` does NOT exercise the real auth client, which is why tests pass.

### S-T19-6 — ADVISORY — `OnboardingFlow.svelte` D.7 inline does not carry the F-114 M-114b INVARIANT comment

- **Category:** F-114 M-114b
- **Location:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:519-555` (inlined D.7) vs. `apps/web/src/lib/onboarding/steps/D7Complete.svelte:2-7` (unreferenced)
- **Issue:** M-114b mandates that the D.7 completion surface opens with the comment `// INVARIANT: T19 does NOT confer any role. Workplace bootstrap is a separate task. Any future change adding a role-write here re-opens F-114.` The implementer placed the comment in `D7Complete.svelte` but `OnboardingFlow.svelte` inlines its own D.7 rendering at lines 519-555 WITHOUT this comment. Since the inlined version is the one actually rendered (D7Complete.svelte is not imported), the M-114b lint surface is misplaced — a future contributor adding a role-write to the inlined D.7 block will not be warned. Note: M-114a (no `committee_membership` / `role:` strings in the diff) IS satisfied by grep — none appear in `lib/onboarding/`.
- **Recommended fix:** Add the M-114b INVARIANT comment to `OnboardingFlow.svelte:519` immediately above `{:else if currentStep === 'D.7'}`. Alternatively, replace the inlined D.7 with `<D7Complete />` (which carries the comment) — though this depends on resolving Finding S-T19-5's wider composition gap. Also: extend a static-lint mirror of M-114b to also check `OnboardingFlow.svelte` for the literal "INVARIANT: T19 does NOT confer any role".
- **Implementer's claim:** Tests at `d7-completion-and-elevation.test.ts` (10 tests) presumably check the D7Complete file directly via component-mount, not via the wizard chrome.

### S-T19-7 — ADVISORY — Client-side rate-limiter at D.4→D.6 (F-112 M-112a) defined but not wired

- **Category:** OWASP A04 (Insecure design: control defined but not invoked) / F-112 M-112a
- **Location:** `apps/web/src/lib/onboarding/state-machine.ts:125-154` (and identical duplicate at `step-machine.ts:125-154`) — `createOnboardingRateLimiter`
- **Issue:** M-112a mandates "A client-side counter in the wizard state machine limits D.4 → D.6 transition attempts to ≤10 per 60s per wizard session...The 11th attempt within 60s returns a structured error `t('onboarding.recovery.rate_limited')` without invoking `encryptRecoveryBlob`." `createOnboardingRateLimiter` is defined, but `grep -rn "createOnboardingRateLimiter|tryAttempt" lib/onboarding/` returns only the definitions — never a call-site. `OnboardingFlow.svelte`'s `onD4Continue` (line 190-193) and `onD6Submit` (line 208-228) do not invoke the limiter. The 11th invocation will still call into the (broken — see S-T19-5) D.4 path and never hit the 1-3s Argon2id derivation rate-limit gate.
- **Recommended fix:** Instantiate `createOnboardingRateLimiter({limit: 10, window_ms: 60_000})` once in `OnboardingFlow.svelte`'s component-instance script (NOT module-level — same lesson as S-T19-3), and call `limiter.tryAttempt(Date.now())` at the start of `onD4Continue()` / before the path that drives `encryptRecoveryBlob`; surface the closed-allowlist error key on `{ok: false}`. (Note: per S-T19-5, the wider D.4 path is itself broken; this advisory becomes BLOCKING if the D.4 composition is fixed without also wiring the limiter.)
- **Implementer's claim:** None — the test suite at `d4-recovery-passphrase.test.ts` (per ADR-0020 §F-112) is supposed to assert 11th-attempt rejection; if the limiter is unwired and the test still passes, the test is testing the limiter unit in isolation rather than the integrated wizard.

### S-T19-8 — ADVISORY — Duplicate state-machine files (`state-machine.ts` + `step-machine.ts` byte-identical)

- **Category:** OWASP A08 (software/data integrity: code duplication risk) / ADR-0020 Decision 1
- **Location:** `apps/web/src/lib/onboarding/state-machine.ts` and `apps/web/src/lib/onboarding/step-machine.ts` (byte-identical per `diff`)
- **Issue:** ADR-0020 Decision 1 names exactly ONE file: `step-machine.ts`. The implementer shipped both files with byte-identical content. A future contributor modifying one will cause a silent skew with the other; references in production code may then read different rate-limiter logic depending on the import path. Not a direct security finding but creates a regression class.
- **Recommended fix:** Delete `state-machine.ts`; update imports in `OnboardingFlow.svelte:19-23` to read from `./step-machine` only.
- **Implementer's claim:** None.

### S-T19-9 — ADVISORY — `BrowserWipeStore.clearCaches` correctly enumerates dynamically (G-T19-8) — verify the call-site contract

- **Category:** F-109 M-109a / G-T19-8 (verified PASS)
- **Location:** `apps/web/src/lib/lock/panic-wipe.ts:110-121` + `lib/lock/wipe-store.ts:180-193`
- **Issue:** This is a confirmation that the G-T19-8 contract IS implemented. `panic-wipe.ts:117` calls `await (globalThis as ...).caches.keys()` to dynamically enumerate cache names, then passes them to `clearCaches`. No hardcoded cache-name array exists. The BrowserWipeStore.clearCaches takes the dynamic list and iterates `c.delete(name)`. PASS for G-T19-8 / F-109 M-109a. **Recording as ADVISORY to acknowledge** because the security-reviewer is required to confirm this load-bearing mitigation.

### S-T19-10 — ADVISORY — `__test_*` literal stripping (G-T19-5) untested at the bundle level because OnboardingFlow has no production route mount

- **Category:** F-102 M-102b / G-T19-5
- **Location:** `scripts/check-onboarding-test-props-stripped.sh:43-47` + `apps/web/build/`
- **Issue:** The script passes (exit 0) — but the bundle output contains no `OnboardingFlow.svelte` artifact because no SvelteKit route imports it. `grep -rn "OnboardingFlow" apps/web/src/routes/` returns empty. Therefore the test-prop-strip assertion is structurally vacuous: the props would never appear in the bundle because the entire wizard isn't bundled. The implementer's split-form pattern (`'__test_' + 'step'` at `OnboardingFlow.svelte:51-53`) is correctly applied at the source level, but the bundle-level test is silent until a route actually mounts the wizard. Recommend: add a SvelteKit route at `apps/web/src/routes/onboarding/+page.svelte` that imports `OnboardingFlow` so the bundle includes the wizard surface — then the G-T19-5 script becomes load-bearing. (Note: this is also a finding adjacent to S-T19-5 — the wizard isn't wired to a route.)
- **Recommended fix:** Either (a) add the route and re-run G-T19-5 against the bundle; or (b) document the wire-up deferral as a NEW carry-forward (`G-T19-10` suggested), noting that G-T19-5 is structurally satisfied for the source-level grep but the bundle-level test will not fire until the wizard is mounted.

### S-T19-11 — ADVISORY — `OnboardingFlow.svelte` mounts `D4RecoveryPassphrase`'s test seam via direct import in production source

- **Category:** OWASP A05 (Misconfiguration: test seam exposed to production) / F-102 M-102b adjacent
- **Location:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:24-26` + `:174` + `:213`
- **Issue:** `OnboardingFlow.svelte` imports `__setPassphraseRefForTest` (a `__test_*`-shaped export from `D4RecoveryPassphrase.svelte`) and calls it twice in the production code path. The function ITSELF is correctly gated by `import.meta.env.MODE === 'production' => return;`, so the production behaviour is a no-op. But the import LINE is in production source. The G-T19-5 grep gate does not check for `__setPassphraseRefForTest` or `__test_only_get_passphrase_ref`. The split-form pattern (`'__test_' + 'step'` defeats constant-folding) is NOT applied to these names — they appear as literal identifiers throughout production source.
- **Recommended fix:** Extend `scripts/check-onboarding-test-props-stripped.sh`'s `PATTERNS` array to include `__setPassphraseRefForTest`, `__test_only_get_passphrase_ref`, `__debugForceAuditFailure`, `__debugForceClearFailure` — so future regressions on these test-seam names are caught at build time. Then either (a) remove the import from `OnboardingFlow.svelte` and re-implement the seam via `bind:this`, or (b) apply the same split-form referencing pattern.

### S-T19-12 — NIT — D.5 session-revocation primer entirely simulated via `__test_*` props; no real `lib/auth/session.ts` composition

- **Category:** Composition gap (architecture)
- **Location:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:230-264` (D.5 handlers)
- **Issue:** All D.5 state transitions (`d5State`, `d5FailedDevices`, `d5ErrorKey`) are driven entirely by `__test_revoke_*` props. `revokeAllSessions` / `listSessions` from `lib/auth/session.ts` are NOT imported or called. This mirrors the S-T19-5 D.3 composition gap. Treated as a NIT because D.5 has no security-control mitigation in §8.T19 that depends on it (the F-39 latency claim is library-side, not UI-side); recommendation is recorded for the production wire-up sibling task.
- **Recommended fix:** Wire `revokeAllSessions(auth, user_id)` from `lib/auth/session.ts` into `onRevokeOtherSessions` for the production path; preserve the `__test_*` props as a UI-fixture override only.

### S-T19-13 — NIT — `recovery-blob-download.ts` `blob_id` reuses `generateEnrollmentSessionId()` from state-machine.ts

- **Category:** F-105 M-105b (no PI in download JSON) — passing, but cross-link risk
- **Location:** `apps/web/src/lib/onboarding/recovery-blob-download.ts:25,67`
- **Issue:** The `blob_id` field of the downloaded JSON is generated via `generateEnrollmentSessionId()` from `state-machine.ts`. The same function issues the wizard's `enrollment_session_id`. While both are fresh UUID-v4-shaped values per-call, the shared generator means a future debug session could reveal that the SAME function call generated both, creating a (weak) correlation surface. Per M-105b, the `blob_id` is meant to be "NOT correlatable to any other identifier". Reusing the generator from `state-machine.ts` is fine if no caller invokes both within the same execution — `serializeRecoveryBlobJson` does NOT receive or output the `enrollment_session_id`, so the field-level isolation holds.
- **Recommended fix:** Either rename `generateEnrollmentSessionId` to `generateFreshUuid` and re-use it explicitly (signalling that it's the generic UUID factory), OR define a separate `generateRecoveryBlobId()` for the download path. Both are cosmetic; the runtime correlation is not exploitable as written.

## Hard rules verified

- [PASS] **F-101 M-101c device fingerprint = UA + platform only** — `lib/onboarding/device-fingerprint.ts:31-43` composes only `navigator.userAgent` + `navigator.platform`. No IP / connection / geolocation / GPU / canvas. PASS.
- [FAIL] **F-102 M-102a D.3 origin source** — `OnboardingFlow.svelte` does not call `enrollFirstDevicePasskey`; the side D3PasskeyEnrollment.svelte computes `window.location.origin` but discards it (`void origin`). The function signature does not accept origin. See S-T19-5.
- [PASS] **F-102 M-102b production-bundle strip for `__test_step` / `__test_user_agent` / `__test_origin`** — `scripts/check-onboarding-test-props-stripped.sh` returns exit 0 against `apps/web/build/`. PASS at the bundle level (with S-T19-10 caveat).
- [FAIL] **F-103 M-103a TOTP rate-limit composition** — no `lib/auth/rate-limit.ts` import in `lib/onboarding/`; the rate-limit inherits at the auth-core layer only if `enrollFirstDevicePasskey` is called, which it isn't (S-T19-5).
- [PASS] **F-103 M-103b constant-time TOTP compare** — inherited from `lib/auth/auth-core.ts:79` via the `enrollFirstDevicePasskey` call IF the call happens (S-T19-5 blocks).
- [PASS] **F-103 M-103c collapsed 410/401 error surface** — `D3PasskeyEnrollment.svelte:46` collapses to `'onboarding.passkey_d3.error.enrollment_failed_generic'`. Component-level PASS. Wizard-chrome composition broken per S-T19-5.
- [FAIL] **F-104 M-104a closure scope, no module-level `let passphrase`** — `D4RecoveryPassphrase.svelte:20` has `let __module_passphrase_ref = ''` inside `<script context="module">`. See S-T19-3.
- [PASS] **F-104 M-104b ref cleared on advance** — `OnboardingFlow.svelte:210-214` clears `__d4_passphrase = ''` and calls `__setPassphraseRefForTest('')` on D.6 match. PASS at the wizard-chrome level (despite S-T19-3's module-level concern).
- [PASS] **F-104 M-104c autocomplete/spellcheck/autocapitalize/autocorrect on D.6 input** — `OnboardingFlow.svelte:506-509` AND `D6TypeBackVerify.svelte:25-28` set all four. PASS.
- [PASS] **F-104 M-104d constant-time type-back compare** — `OnboardingFlow.svelte:199-206` `constantTimeStringEqual`. PASS (with the well-known length-leak caveat).
- [PASS] **F-105 M-105a AEAD-wrapped JSON closed allowlist** — `recovery-blob-download.ts:58-69` returns exactly `{ciphertext, kdf_params, version, blob_id}`. PASS.
- [PASS] **F-105 M-105b no PI in download JSON** — no `user_id`, `email`, `display_name`, `actor_pseudonym` in the serializer. PASS.
- [PASS] **F-105 M-105c re-import contract header comment** — `recovery-blob-download.ts:4-8`. PASS.
- [PASS] **F-106 M-106a audit-BEFORE-side-effect ordering (logical)** — `panic-wipe.ts:102-108` awaits emitAudit and aborts on `{ok:false}`. PASS at the structural ORDER.
- [FAIL] **F-106 M-106a audit-BEFORE-side-effect ordering (production effect)** — `BrowserWipeStore.emitAudit` is a no-op stub. See S-T19-4.
- [PASS] **F-106 M-106b closed-allowlist meta shape** — `wipe-store.ts:26-35` typed; `panic-wipe.ts:95-100` constructs only the closed-allowlist meta. No `actor_pseudonym` / `ip` / `userAgent` in the construction. PASS.
- [PASS] **F-106 M-106c partial-failure double-row** — `panic-wipe.ts:138-149` emits a second row with `partial_failure_classes`. PASS.
- [PASS] **F-108 M-108a no clipboard-copy affordance on D.4** — no `data-testid='copy-passphrase'` in any T19 file. PASS.
- [PASS] **F-108 M-108b no TTS on D.4/D.6/recovery** — `check-onboarding-no-passphrase-leak.sh` returns exit 0 against the targets. PASS for the FORBIDDEN regex set.
- [FAIL] **F-108 M-108c no aria-live / role=alert / role=status on passphrase element** — `RecoveryPassphraseScreen.svelte:155` violates. See S-T19-2.
- [PASS] **F-109 M-109a dynamic `caches.keys()` enumeration** — `panic-wipe.ts:117` calls `await caches.keys()`; no hardcoded cache-name array. PASS. (G-T19-8 closed.)
- [PASS] **F-110 M-110a closed-allowlist error keys** — `copy-keys.ts` is a frozen array; all error keys in `OnboardingFlow.svelte` / `D3PasskeyEnrollment.svelte` / `D4RecoveryPassphrase.svelte` are literal lookups, not dynamic key construction. PASS.
- [PASS] **F-110 M-110b canonical error symbol only in operator logs** — `D4RecoveryPassphrase.svelte:62-64` catches and surfaces `t('onboarding.passphrase_d4.error.argon2_unavailable')`; the canonical `argon2id_unavailable_libsodium_wrappers_sumo_required` symbol does NOT appear anywhere under `lib/onboarding/` or `lib/lock/`. PASS.
- [DEFERRED (G-T19-7)] **F-110 M-110c Sentry breadcrumb scrubber** — observability-setup scope per G-T19-7; correctly deferred. No Sentry SDK init in `lib/onboarding/` or `lib/lock/`. PASS for the T19-library scope.
- [PASS] **F-111 M-111a no URL state / sessionStorage / localStorage in onboarding modules** — `grep -rn "window.location.hash|window.location.search|pushState|replaceState|sessionStorage|localStorage" lib/onboarding/` returns only docstring matches; no live calls. PASS.
- [FAIL] **F-112 M-112a client-side rate-limit on D.4→D.6** — limiter defined but not wired. See S-T19-7.
- [PASS] **F-113 M-113a post-wipe lockout** — `panic-wipe.ts:62-87` WeakSet + default-store flag. PASS.
- [PASS] **F-114 M-114a no `committee_membership` / role-write in T19 diff** — `grep -rn "committee_membership|role:|worker_co_chair" lib/onboarding/` returns empty. PASS.
- [FAIL] **F-114 M-114b INVARIANT comment in D.7 surface** — present in `D7Complete.svelte` but ABSENT from `OnboardingFlow.svelte`'s inlined D.7 (the surface actually rendered). See S-T19-6.
- [PASS] **F-115 modal copy four-regex contract** — i18n catalog `onboarding.panic_wipe_d6.modal_body_what_happens` / `modal_body_what_doesnt` / `modal_residual_risk_callout` / `modal_recovery_reminder` exist. (Tech-writer's pass ratified.) Verified by test `d6-panic-wipe.test.ts (24 tests passing)`.
- [PASS] **G-T08-10 `node:crypto` ban in `lib/lock/` + `lib/onboarding/`** — `grep -rn "node:crypto" lib/lock lib/onboarding` returns empty. PASS.
- [PASS] **F-105 M-105a libsodium AEAD primitive choice** — `lib/crypto/recovery-blob.ts:163-165` uses `s.crypto_secretbox_easy` with `s.randombytes_buf(s.crypto_secretbox_NONCEBYTES)` for cryptographically-random nonce. PASS.
- [PASS] **D.4 Argon2id parameters** — `lib/crypto/recovery-blob.ts` uses the existing `KDF_PARAMS` constants from T07 (unmodified by T19). T07 verified the OWASP-2023-floor (`ops=4, mem=512MiB`) elsewhere.
- [PASS] **`check-onboarding-test-props-stripped.sh` script integrity** — `PATTERNS=(__test_step __test_user_agent __test_origin)`; greps `.js`/`.mjs` excluding `.map`. Functional. (S-T19-10 caveat re: vacuous scope.)
- [PARTIAL] **`check-onboarding-no-passphrase-leak.sh` script integrity** — FORBIDDEN array covers clipboard + TTS but NOT `aria-live` / `role=alert` / `role=status` / `autofocus` per G-T19-6 spec. See S-T19-2 fix recommendation.

## OWASP cross-pass

- **A01 Broken Access Control** — N/A; T19 introduces no new RLS surface.
- **A02 Cryptographic Failures** — FAIL (S-T19-1 hardcoded passphrase; S-T19-3 module-level passphrase ref).
- **A03 Injection** — N/A; no SQL/NoSQL/LDAP/shell in T19.
- **A04 Insecure Design** — FAIL (S-T19-5 D.3 doesn't compose auth; S-T19-7 limiter unwired; S-T19-4 audit-emit stub).
- **A05 Security Misconfiguration** — ADVISORY (S-T19-11 test-seam imports in production source; S-T19-10 G-T19-5 vacuously passing).
- **A06 Vulnerable Components** — clean (no new dependencies introduced by T19; `npm audit` requires a lockfile that isn't present, but this is a pnpm workspace).
- **A07 Identification & Authentication Failures** — FAIL (S-T19-5 D.3 not enrolling passkey).
- **A08 Software & Data Integrity** — ADVISORY (S-T19-8 duplicate state machine files).
- **A09 Security Logging & Monitoring Failures** — FAIL (S-T19-4 production emitAudit no-op; S-T19-2 aria-live announces passphrase).
- **A10 SSRF** — N/A; no new outbound requests originate in T19.

## Composition spot-checks

- `lib/auth/passkey-enroll.ts`: imported by `D3PasskeyEnrollment.svelte:28` (correct), but NOT by `OnboardingFlow.svelte` (S-T19-5 BLOCKING).
- `lib/auth/totp-bootstrap.ts`: not referenced in T19 surfaces (TOTP consumption happens inside `enrollFirstDevicePasskey` per T05 layering — acceptable IF S-T19-5 is fixed).
- `lib/auth/rate-limit.ts`: not directly referenced in T19 surfaces; rate-limit inheritance is via `auth-core.ts` (acceptable IF S-T19-5 is fixed).
- `lib/auth/session.ts`: not referenced in T19 surfaces (S-T19-12 NIT).
- `lib/crypto/recovery-blob.ts`: correctly imported by `D4RecoveryPassphrase.svelte:38` for `encryptRecoveryBlob`. Uses `libsodium` `crypto_secretbox_easy` per ADR-0003 Amendment G. PASS.
- `lib/crypto/passphrase.ts`: per ADR-0020 Decision 2.d step 2 should be the passphrase generator at D.4. `OnboardingFlow.svelte:169` does NOT use it (uses a hardcoded literal). S-T19-1 BLOCKING.
- `lib/onboarding/recovery/RecoveryPassphraseScreen.svelte`: composed by `D4RecoveryPassphrase.svelte:71`. Pre-existing, but the aria-live wrapper is M-108c violation (S-T19-2 BLOCKING).
- `lib/auth/browser-baseline.ts`: correctly wrapped by `lib/onboarding/browser-baseline.ts`. PASS.

## Out-of-scope (correctly deferred) items

- **G-T19-1 — fr-CA copy.** Deferred to localization-specialist. Correctly absent from T19 diff.
- **G-T19-3 — Server-cascade panic-wipe.** Deferred to future task per Q4 resolution. The local-only posture is correctly implemented (panic-wipe.ts does not cascade to revoke server sessions).
- **G-T19-7 — Sentry breadcrumb scrubber `beforeSend` allowlist extension.** Observability-setup scope. T19 surfaces do not emit Sentry calls directly. Correctly deferred (note: depends on production Sentry wire-up; the audit row at S-T19-4 must also flow into this).
- **The `panic_wipe.invoked` enum SQL CHECK widening + audit_log_retention_schedule row** — explicitly scoped to T07.1 or a T19-audit-extension sibling per ADR-0020 §5. T19 reserves the TS const + `meta` shape, which is correctly present. The SQL half is correctly deferred. (See S-T19-4 — this deferral does NOT excuse a no-op production-path `emitAudit`.)

## Recommendation

**Block merge.** S-T19-1 (hardcoded passphrase), S-T19-2 (aria-live on passphrase element), S-T19-3 (module-level passphrase ref), S-T19-4 (production emitAudit no-op), and S-T19-5 (D.3 doesn't enroll passkey) are all real BLOCKING findings against the §8.T19 testable mitigations or ADR-0020 binding clauses. Tests pass because the integration harness simulates the auth client and doesn't compose against the production-path stores. **Escalate to human review** — T19 is the load-bearing auth + PI surface; the architect should adjudicate whether `OnboardingFlow.svelte` is intentionally a UI-stub destined to be wired in T19.1 (in which case the BLOCKING findings re-scope to "verify the wire-up sibling resolves these") or whether T19 is meant to ship as a complete monolithic surface (in which case the BLOCKING findings re-scope to "implementer must fix in-cycle before merge").
