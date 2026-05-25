## Re-review (2026-05-25)

**Verdict: PASS-WITH-ADVISORIES. P-T19-2 CLOSED. Merge still gated on HG-10; HG-10 packet must be REGENERATED for 5 new a11y keys.**

- **P-T19-2** (hard-coded English, former OnboardingFlow.svelte:547-550) — **CLOSED.** Grep for "Settings → Sessions"/"Settings → Wipe"/"sign out other devices" returns zero. Region now t()-only (lines 548-549). G-T19-PRIV-1 resolved.
- **P-T19-1 / HG-10** — STILL PENDING (correct). Banner intact at decisions.md:795 + onboarding.en-CA.json:20.
- **P-T19-RR-1 (NEW, BLOCKING-AT-MERGE)** — HG-10 packet stale. Rework added 5 user-facing keys (panic_wipe_type_back_label, step_indicator_landmark, step_pill_completed/current/pending, failed_checks_list_label, failed_capability_label) at onboarding.en-CA.json:264-276. In catalog (lawyer-reviewable) and t()-referenced (OnboardingFlow.svelte:362,371-374,467,469) — NOT hardcoded. But A11y summary at decisions.md:832-834 still says "18 strings" and omits them. Regenerate the HG-10 A11y summary before routing to counsel. Regime: PIPEDA 4.3.4 + ADR-0020 Decision 7 + HG-10 (lawyer must see every string).
  - Non-privacy note: new keys absent from copy-keys.ts COPY_KEYS — flag to verifier (orphan-key contract), not a privacy block.
- **Over-collection re-check** — PASS. recovery-blob-download.ts holds the 4-key allowlist (lines 44-49, 79-88); nonce folded into ciphertext (non-PI), no separate nonce key, no PI fields. device-fingerprint unchanged (UA+platform only). browser-baseline.ts detection-only/client-side/no-transmission; passkey probe does NOT enumerate authenticators (lines 93-101); argon2id probe reads cache only (lines 113-130).
- **emitAudit** now {ok:false} fail-closed (wipe-store.ts:230-238); PanicWipeAuditRow.meta still closed allowlist (lines 26-35), no new PI. Strengthens P-T19-4 posture; G-T19-PRIV-3 (prod wire-up) still open.
- New interpolations {n}/{m}/{key} are non-PII operational tokens; {key} is a BaselineCheckKey enum value. No {user_name}/{email}.
- Threat-model §8.T19: no classification/residency/retention/purpose drift. No new subprocessor; no cross-border transfer.

---

# Privacy Review T19 — Identity-Recovery Onboarding Library + OnboardingFlow / PanicWipeModal Composition

**Status: PASS-WITH-ADVISORIES (BLOCKED-AT-MERGE on HG-10 + 1 catalog-bypass finding)**

Library-only per ADR-0002 Amendment H. The architectural posture is sound: device-fingerprint over-collection check PASSES, recovery-blob plaintext over-collection check PASSES, no PII in URLs/logs/errors, in-memory wizard state honoured, panic-wipe Q4 residual honestly disclosed, no new subprocessor, no cross-border transfer. Merge is blocked only by HG-10 lawyer ratification (already documented as PENDING) and one hard-coded English string in `OnboardingFlow.svelte` that bypasses the HG-10 ratification packet.

---

## HUMAN GATES

- **HG-10 FIRES and is BLOCKED — does not merge until labour-lawyer ratifies the en-CA copy.** Status correctly recorded as `PENDING EXTERNAL LABOUR-LAWYER REVIEW (deferred 2026-05-24)` at `decisions.md:795` and `apps/web/src/lib/i18n/onboarding.en-CA.json:20` (`review_status`). The 7-paragraph packet at `decisions.md:812-830` is the deliverable to counsel.
- **HG-15 does NOT fire** in T19 (library-only; no SQL migration; `panic_wipe.invoked` audit-event SQL CHECK widening defers to T07.1 or a T19-audit-extension sibling per ADR-0020 Decision 5 + G-T19-3 path).
- **HG-9 does NOT re-fire** in T19 library (`panic_wipe.invoked` TS const ships in T19; SQL half six-mirror dance lands with the audit-extension sibling).
- **No cross-border transfer introduced.** Recovery-blob download is user-mediated to the user's local filesystem; the wizard performs no fetch to any external service; Sentry path remains the only pre-existing extraterritorial subprocessor under ADR-0010, and G-T19-7 properly defers the `lib/onboarding/*` breadcrumb-allowlist extension to observability-setup.
- **No new subprocessor.** Verified: zero `fetch(` / `XMLHttpRequest` / `sendBeacon` calls in `apps/web/src/lib/onboarding/` and `apps/web/src/lib/lock/`.

---

## Scope

- **Commit SHA:** `4e9d1a0` (236/236 tests green per the implementer handoff).
- **Files reviewed under privacy lens:**
  - `/home/user/agent-os/apps/web/src/lib/onboarding/device-fingerprint.ts`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/recovery-blob-download.ts`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/state-machine.ts`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/step-machine.ts`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/browser-baseline.ts`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/copy-keys.ts`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D6TypeBackVerify.svelte`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D7Complete.svelte`
  - `/home/user/agent-os/apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte`
  - `/home/user/agent-os/apps/web/src/lib/lock/panic-wipe.ts`
  - `/home/user/agent-os/apps/web/src/lib/lock/wipe-store.ts`
  - `/home/user/agent-os/apps/web/src/lib/lock/memory-wipe-store.ts`
  - `/home/user/agent-os/apps/web/src/lib/lock/PanicWipeModal.svelte`
  - `/home/user/agent-os/apps/web/src/lib/i18n/onboarding.en-CA.json`
  - `/home/user/agent-os/apps/web/src/lib/crypto/recovery-blob.ts` (re-read for AEAD + KDF floors)

---

## PIPEDA 7-principle mapping

| Principle | Status | Finding refs |
|---|---|---|
| **4.1 Accountability** | PASS | Named owner in ADR-0020; no new PI flow without owner. |
| **4.2 Identifying Purposes** | PASS | Catalog `body_purpose` strings document the purpose of each PI collection moment (D.1 device choice, D.4 passphrase, D.5 sessions, D.6 panic-wipe, D.7 summary). Compliance-mapping table at `decisions.md:842-852` enumerates which principle each section satisfies. |
| **4.3 Consent + 4.3.4 Informed-of-purpose** | PASS pending HG-10 | All four consent moments (D.1, D.2, D.4, D.6) state purpose plainly; explicit-click + checkbox-gate at D.1. **Blocked on HG-10 lawyer ratification** (correctly recorded). See P-T19-1. |
| **4.4 Limiting Collection** | PASS | Device-fingerprint is UA + platform ONLY (`device-fingerprint.ts:34-42`). Recovery-blob JSON keys are the F-105 closed allowlist (`recovery-blob-download.ts:59-68`). `panic_wipe.invoked` meta is closed allowlist (`wipe-store.ts:28-35`). No `__test_user_agent` leak into rendered shape. |
| **4.5 Limiting Retention** | ADVISORY — DEFERRED to T07.1 / T19-audit-extension | `panic_wipe.invoked` audit-event retention class (7-year per ADR-0016 lineage) lands with the SQL half. Library does not persist anything itself; in-memory wizard state dies on refresh (`state-machine.ts:4-6`, `OnboardingFlow.svelte:6-7`). Recovery blob is user-custody — not app-retained. **See P-T19-3.** |
| **4.6 Accuracy** | N/A | No user-profile data collected at T19 (consistent with `threat-model.md:2289`). |
| **4.7 Safeguards** | PASS | AEAD = libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305) at `recovery-blob.ts:165`. KDF = Argon2id with `ops=4`, `mem_bytes=512 MiB` — well above OWASP floor (`recovery-blob.ts:19-24`). No `node:crypto` imports in `lib/onboarding/` or `lib/lock/` (grep clean). Constant-time string compare on type-back at `OnboardingFlow.svelte:199-206`. Closed-allowlist error keys at all error sites; no template-string user-input interpolation. |
| **4.8 Openness** | PASS pending HG-10 | D.2 hosting-tradeoff body discloses Supabase + ca-central-1 + US-legal-process posture (`onboarding.en-CA.json:45`); privacy-policy link at D.2. Lawyer ratifies under HG-10. |
| **4.9 Individual Access** | PASS | Recovery blob is user-custody (the access mechanism itself). D.7 checklist enumerates what was collected (passkey, recovery sheet, backup file, sessions reviewed) — `completion_d7.checklist.*`. |
| **4.10 Challenging Compliance** | N/A in library scope | Standard channels; out of T19 scope per `threat-model.md:2293`. |

---

## Threat-model cross-check (§8.T19)

For each PI touchpoint enumerated in threat-model §8.T19 PI touchpoints table, classification / residency / retention / purpose are **UNCHANGED** by this diff:

- **UA + platform string** (D.1 client-side render only) — classification C0, residency client-only, never sent. Verified `device-fingerprint.ts` does not transmit; verified the catalog announcement at `a11y.onboarding.device_fingerprint_announcement` explicitly tells SR users "Nothing here is sent to the server."
- **Passkey credential ID** (D.3) — composes existing T05 surface; no new attack surface (F-102 / F-103 covered by composition; M-102a `window.location.origin` source at `D3PasskeyEnrollment.svelte:38`).
- **Recovery blob ciphertext** (D.4) — closed allowlist verified; F-105 plaintext-keys assertion holds (P-T19 over-collection check PASS).
- **Recovery passphrase in-memory** (D.4 → cleared at D.6) — closure-scope ref at `D4RecoveryPassphrase.svelte:20` + clear-on-advance at `OnboardingFlow.svelte:210-213`. F-104 invariants honoured.
- **Session-revocation primer** (D.5) — no new collection; composes existing T05.1 surface.
- **`panic_wipe.invoked` audit row** (D.6) — meta closed allowlist (`wipe-store.ts:33`); `actor_pseudonym` not in the library row (only `surface`, `wipe_scope`, `completed`, `partial_failure_classes`). Server-side wire (T05.1 ingest path) adds the actor at the boundary. Retention class deferred to T07.1 / T19-audit-extension per Decision 5.

No PI touchpoint quietly upgraded sensitivity, crossed a border, extended retention, or expanded purpose.

---

## Over-collection checks (the two explicit asks)

- **`device-fingerprint.ts` over-collection check: PASS.** File at `apps/web/src/lib/onboarding/device-fingerprint.ts:34-42` reads ONLY `navigator.userAgent` and `navigator.platform`. No IP, no `navigator.connection.*`, no `Sec-CH-UA-Full-Version-List`, no `crypto.subtle.digest` over canvas, no GPU info, no font enumeration, no audio-context, no `navigator.getBattery()`. The `display` field is `${ua}\n${platform}` — no transformation that adds entropy. Per F-101 M-101c. **Verified compliant.**
- **`recovery-blob-download.ts` plaintext over-collection check: PASS.** File at `apps/web/src/lib/onboarding/recovery-blob-download.ts:58-69` returns EXACTLY the closed allowlist `{ ciphertext, kdf_params, version, blob_id }`. `kdf_params` contains only `{ ops, mem, salt }` — no `user_id`, no `email`, no `display_name`, no `actor_pseudonym`, no `passphrase`, no `privkey`. `blob_id` is a fresh UUID via `generateEnrollmentSessionId()` and is NOT correlated to any other identifier. Per F-105 M-105a/b/c. **Verified compliant.**

---

## HG-10 catalog-readiness check

**READY-WITH-EDITS-NEEDED.** The `apps/web/src/lib/i18n/onboarding.en-CA.json` catalog is structurally lawyer-reviewable:

- No TODOs, no [PLACEHOLDER], no lorem ipsum, no "TODO: lawyer to draft" markers (grep clean).
- `review_status` at line 20 correctly states `AWAITING HG-10 LABOUR-LAWYER RATIFICATION before merge per ADR-0020 §Decision 7 + task #2`.
- Compliance bullets at lines 8-19 enumerate every constraint (PIPEDA 4.3.4, no-PII interpolations, honest panic-wipe scope, in-memory wizard state, plain language, scaffold regex assertions).
- Every body string at D.1, D.4, D.5, D.6 states the purpose of the PI being touched.
- D.6 panic-wipe modal contains all four F-115 / M-115 mandated paragraphs (`modal_body_what_happens`, `modal_body_what_doesnt`, `modal_residual_risk_callout`, `modal_recovery_reminder`).

**One issue blocks HG-10 readiness:** `OnboardingFlow.svelte:547-550` contains a hard-coded English string ("Settings → Sessions lets you sign out other devices. Settings → Wipe this device lets you wipe this device.") that bypasses the catalog AND bypasses the HG-10 ratification packet. The lawyer will review the catalog file and the 7-paragraph packet; this hard-coded paragraph escapes both. See **P-T19-2 (BLOCKING)**.

---

## Findings

### P-T19-1 — HG-10 LABOUR-LAWYER RATIFICATION PENDING (acknowledged blocker, not a new finding)
- **Severity:** BLOCKING-AT-MERGE (acknowledged; not new)
- **Regime:** PIPEDA Principle 4.3.4 (informed-of-purpose) + ADR-0020 §Decision 7 + G-T08-11 precedent
- **Location:** `/home/user/agent-os/.context/decisions.md:795` (status banner) + `/home/user/agent-os/apps/web/src/lib/i18n/onboarding.en-CA.json:20`
- **Issue:** Catalog status is `PENDING EXTERNAL LABOUR-LAWYER REVIEW`. Per the user-adjudication 2026-05-24 path, T19 cannot merge to `main` until counsel ratifies the 7-paragraph packet at `decisions.md:812-830`.
- **Fix:** Route the 7-paragraph packet + the catalog file to labour-lawyer; capture per-paragraph dispositions in the ADR; replay any catalog VALUE edits without invalidating COPY_KEYS or tests.

### P-T19-2 — Hard-coded English string in `OnboardingFlow.svelte` bypasses i18n catalog AND HG-10 packet
- **Severity:** BLOCKING-AT-MERGE
- **Regime:** PIPEDA Principle 4.3.4 + 4.8 Openness; ADR-0020 Decision 11 (closed-allowlist copy-keys.ts contract); HG-10 (the lawyer must see every user-facing string)
- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte:547-550`
- **Issue:** The D.7 completion screen renders the hard-coded English paragraph `"Settings → Sessions lets you sign out other devices. Settings → Wipe this device lets you wipe this device."` directly in the component, OUTSIDE the i18n catalog. (a) It is not in `onboarding.en-CA.json`, so the labour lawyer reviewing the HG-10 packet at `decisions.md:812-830` will not see it. (b) It is not in `copy-keys.ts` — defeats the F-110 M-110a / Decision 11 closed-allowlist gate. (c) It is not in `COPY_KEYS`, so the orphan-key contract test for completion-screen pointers is not enforced for this string. (d) It cannot be translated for fr-CA (G-T19-1 future work). The companion catalog entry `onboarding.completion_d7.next_steps_body` rendered immediately below (line 551) already covers this content area — the lawyer will ratify ONE paragraph then ship TWO.
- **Fix:** Delete `OnboardingFlow.svelte:547-550` entirely (the next-line `{t('onboarding.completion_d7.next_steps_body')}` already covers the "where to find things later" pointer). OR move the literal into a new catalog key under `onboarding.completion_d7.*`, add it to `copy-keys.ts`, and re-route the HG-10 packet to counsel including the new key. Preferred: delete; the existing catalog body is sufficient and was ratification-shaped by tech-writer.

### P-T19-3 — Retention class for `panic_wipe.invoked` audit event is unenforced at library boundary (DEFERRED-T19-AUDIT-EXTENSION)
- **Severity:** ADVISORY (BLOCKING-IN-T07.1 OR T19-audit-extension)
- **Regime:** PIPEDA Principle 4.5 (Limiting Retention) + ADR-0016 schedule-row contract
- **Location:** `/home/user/agent-os/apps/web/src/lib/lock/panic-wipe.ts:92-101` (audit row composition) + `wipe-store.ts:26-35` (row shape)
- **Issue:** T19 introduces ONE new audit event type (`panic_wipe.invoked`) at the library boundary. ADR-0020 Decision 5 routes the SQL CHECK widening + ADR-0016 retention-schedule row + `audit_log_retention_schedule` row to T07.1 OR a T19-audit-extension sibling task. Until that lands, the event has NO enforced retention class. Library-half is fine per ADR-0002 Amendment H; production deploy with real PI must NOT proceed until the SQL half ships.
- **Fix:** Record this carry-forward as G-T19-PRIV-3 in `known-gaps.md`. Architect ADR-0016 amendment adds the schedule row (class = 7-year per `panic_wipe.invoked` security-event lineage; mirror of `auth.passkey.enrolled` class). HG-15 re-fires at the SQL extension's PR submission.

### P-T19-4 — `BrowserWipeStore.emitAudit` is a `return { ok: true }` no-op stub (production wire-up gap)
- **Severity:** ADVISORY (BLOCKING-IN-T19-PROD-WIRE-UP)
- **Regime:** PIPEDA Principle 4.7 (Safeguards) — F-106 M-106a audit-BEFORE-side-effect contract
- **Location:** `/home/user/agent-os/apps/web/src/lib/lock/wipe-store.ts:230-237`
- **Issue:** `BrowserWipeStore.emitAudit` returns `{ ok: true }` unconditionally, bypassing the audit-BEFORE-side-effect contract in production. The comment correctly documents this as "scaffold only — production wire-up swaps for the real emitter (T05.1)". In production the M-106a invariant would silently degrade: a wipe would proceed with NO audit row written. Library-half OK; production wire-up must replace with the real T05.1 audit-emit path BEFORE any deploy carrying real PI.
- **Fix:** Carry-forward as G-T19-PRIV-4. Block production deploy until `BrowserWipeStore.emitAudit` is wired to the real T05.1 `/api/audit/queue` POST (or equivalent) with the M-106a `{ok:false}`-aborts-wipe contract preserved.

### P-T19-5 — D.5 helper interpolation `{other_count}` is operational-counter only (non-PII) — VERIFIED
- **Severity:** PASS-NOTED (not a finding; documented for completeness)
- **Regime:** PIPEDA Principle 4.4 + constraints.md "no PII in URLs/logs/errors"
- **Location:** `/home/user/agent-os/apps/web/src/lib/i18n/onboarding.en-CA.json:162` + `OnboardingFlow.svelte:493`
- **Issue:** D.5 helper string uses `{other_count}` and `{failed_systems}` interpolations. Verified these are non-PII operational counters (count of other sessions, comma-joined WipeClass enum). The catalog _meta block at line 10 explicitly enumerates this allowlist. No `{user_name}`, `{email}`, `{workplace}`, `{ip}` exists.

### P-T19-6 — Q4 panic-wipe local-only disclosure is HONEST (verified against §8.T19 residual block)
- **Severity:** PASS-NOTED
- **Regime:** PIPEDA Principle 4.8 (Openness) + Q4 user-adjudication 2026-05-24
- **Location:** `onboarding.en-CA.json:190-193` (`modal_body_what_happens`, `modal_body_what_doesnt`, `modal_residual_risk_callout`, `modal_recovery_reminder`)
- **Issue:** Copy honestly discloses (a) what is wiped (THIS device only), (b) what is NOT wiped (server, other devices, committee can still see prior contributions), (c) residual coerced-user risk (server session may stay valid up to 15 minutes), (d) recovery path (passphrase off-device → re-sign-in; otherwise contact co-chair). Implementation matches: `panic-wipe.ts` only clears local IDB / Caches / sessionStorage / localStorage / cookies; no server-side session-revocation call. **Promise matches delivery.**

### P-T19-7 — In-memory wizard state contract honoured (no localStorage / IndexedDB / sessionStorage persist)
- **Severity:** PASS-NOTED
- **Regime:** PIPEDA Principle 4.5 + F-111 M-111a
- **Location:** `state-machine.ts:4-6`, `OnboardingFlow.svelte:6-7` — both header comments pin the in-memory-only contract. Grep across `lib/onboarding/` for `localStorage|sessionStorage|indexedDB` returns ONLY the header-comment documentation lines. No persist call.

### P-T19-8 — No PII in URLs (zero `searchParams` / `location.search` / `$page.url` in `lib/onboarding/`)
- **Severity:** PASS-NOTED
- **Regime:** constraints.md "no PII in URL query strings" + F-111 M-111a/b
- **Issue:** Grep across `lib/onboarding/` for `searchParams|location\.search|window\.location|\$page\.url` returns only the D.3 RP-origin source (`window.location.origin` — host name only, not a PI surface). Wizard step state is in-memory only.

### P-T19-9 — No PII in logs / errors (zero `console.log|warn|error|info|debug` in `lib/onboarding/` and `lib/lock/`)
- **Severity:** PASS-NOTED
- **Regime:** constraints.md "no PII in application logs / error messages returned to clients" + F-110 M-110a closed-allowlist error keys
- **Issue:** Grep returns no matches in either `lib/onboarding/` or `lib/lock/`. Every user-visible error renders a literal closed-allowlist `t('onboarding.<sub>.error.<key>')` call (verified at `D3PasskeyEnrollment.svelte:46-49`, `D4RecoveryPassphrase.svelte:63`, `OnboardingFlow.svelte:225, 240-245, 493-498, 517, 405`). No template-string user-input construction; no `error.message` surfacing.

### P-T19-10 — F-114 admin-elevation invariant: `D7Complete.svelte` header comment present
- **Severity:** PASS-NOTED
- **Regime:** F-114 M-114b (no-elevation invariant documented)
- **Location:** `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D7Complete.svelte:2-6`
- **Issue:** Required invariant comment is present verbatim ("INVARIANT: T19 does NOT confer any role…"). PR-time `git diff` against `src/lib/committee/` deferred to security-reviewer per ADR-0020 task 9 sibling.

### P-T19-11 — AODA / WCAG cognitive-accessibility plain-language: PASS
- **Severity:** ADVISORY (handoff to accessibility-specialist for formal Phase F WCAG 2.0 AA pass)
- **Regime:** AODA WCAG 2.0 AA cognitive-accessibility expectation (~grade 8)
- **Issue:** Spot-skim of catalog body strings finds plain, declarative voice; no Latin abbreviations (`i.e.`, `e.g.` not present); no legalese (`hereby`, `pursuant`). Longest sentences inspected: D.1 advisory body sentence 1 ("Set up the JHSC App on a personal phone or laptop — one your employer does not own, pay for, or manage.") = 23 words; D.4 body sentence 1 = 23 words; D.6 modal_body_what_happens = 23 words. All within ~25-word guideline. Specific grade-level scoring (Flesch-Kincaid) belongs to accessibility-specialist; this review's scope is plain-language sanity-check.
- **Fix:** Accessibility-specialist Phase F second pass (ADR-0020 task 7) runs axeCheck + manual SR walk-through against live surfaces.

---

## Subprocessor / cross-border check

- **No new subprocessor.** Verified: zero `fetch(` / `XMLHttpRequest` / `sendBeacon` in `lib/onboarding/` and `lib/lock/`. Sentry breadcrumb-scrubber path-allowlist extension to `lib/onboarding/*` correctly deferred to G-T19-7 (observability-setup).
- **No cross-border transfer.** Recovery-blob JSON download via `URL.createObjectURL` + anchor click is user-mediated to the user's local filesystem (`recovery-blob-download.ts:80-92`). This crosses no app boundary. All server-side writes (passkey enrollment, blob storage, session revocation) compose existing T05.1 / T07.1 endpoints in ca-central-1.
- **Q4 verification:** Panic-wipe is LOCAL-ONLY. Grep confirms `panic-wipe.ts` issues no fetch / server-side call; only `store.clearIndexedDb`, `clearCaches`, `clearSessionStorage`, `clearLocalStorage`, `tearDownSessionCookie` are invoked. Server-cascade deferred to G-T19-3 future task. Honest disclosure verified per P-T19-6.

---

## Quebec Law 25

- Q5 user-adjudication: fr-CA deferred to G-T19-1 (recorded at `known-gaps.md:1178-1182`). T19 ships en-CA only. Law 25 mandates French; out-of-scope per `constraints.md:16-17` (no Quebec users in v1 scope). Carry-forward correctly NOT used to defer a real privacy obligation — it is the absence of fr-CA copy, not the absence of a privacy control.
- No automated decision-making affecting individuals (Law 25 Art. 12.1 disclosure trigger does NOT fire — T19 is consent-gated onboarding, not algorithmic).
- PIA: not required (Quebec users out of scope). Re-engaged if fr-CA rollout opens per `threat-model.md:2295`.

---

## PHIPA / PCI / FIPPA

None engaged at T19 surface. No health information, no payment data, no government data. Consistent with `threat-model.md:2296-2298`.

---

## Carry-forwards (new from this review)

- **G-T19-PRIV-1** — Resolve P-T19-2 hard-coded English string at `OnboardingFlow.svelte:547-550` (delete, OR add to catalog + COPY_KEYS + HG-10 packet) BEFORE HG-10 lawyer review packet routes to counsel. **Blocker for:** T19 merge.
- **G-T19-PRIV-2** — Architect ADR-0016 amendment adding `panic_wipe.invoked` schedule row (recommended class = 7-year per security-event lineage); HG-15 re-fires at the audit-extension sibling task PR. **Blocker for:** T07.1 OR T19-audit-extension PR submission.
- **G-T19-PRIV-3** — Replace `BrowserWipeStore.emitAudit` no-op stub with real T05.1 audit-emit POST; preserve M-106a `{ok:false}`-aborts-wipe contract. **Blocker for:** production deploy with real PI.
- **G-T19-PRIV-4** — Localization-specialist + second HG-10 (labour-lawyer) ratification pass on translated copy when fr-CA lands (G-T19-1 path). **Blocker for:** any fr-CA workplace rollout (not T19 v1).

---

## Overall T19 privacy verdict

**PASS-WITH-ADVISORIES (BLOCKED-AT-MERGE on HG-10 lawyer ratification + P-T19-2 hard-coded string fix).** Library-only per ADR-0002 Amendment H. Architectural posture sound: PIPEDA 4.4 (limiting collection) STRENGTHENED via two closed allowlists (device-fingerprint UA+platform only; recovery-blob JSON F-105 closed keys). PIPEDA 4.7 (safeguards) PRESERVED via Argon2id ops=4 / mem=512MiB + XSalsa20-Poly1305 AEAD. PIPEDA 4.8 (openness) HONEST about Q4 local-only panic-wipe scope. Zero PII in URLs / logs / errors. No new subprocessor; no cross-border transfer. HG-10 lawyer ratification is the dominant merge gate; P-T19-2 catalog-bypass is the only NEW privacy-reviewer-surfaced merge blocker.
