# Accessibility review — T19 identity-recovery onboarding (post-implementation pass)

> **Status:** FAIL — BLOCKING findings present.
> **Authoring agent:** accessibility-specialist
> **Date:** 2026-05-24
> **Commit reviewed:** `4e9d1a0` (236/236 tests green per implementer's note)
> **Scope:** ADR-0020 task 7 — formal AODA / WCAG 2.0 AA verification against the implemented surfaces.

---

## 1. Summary verdict

**FAIL — implementation does not meet AODA / WCAG 2.0 AA across multiple criteria.** The implementer made the tests pass (236/236) but the tests, the axe-check helper, and the structural pattern of the wizard's chrome leave material accessibility gaps the automation does not catch.

**Test pass ≠ accessibility pass.** The axe-check helper at `apps/web/test/_helpers/axe-check.ts` is a hand-rolled stub (60 lines of structural querying); it does NOT load axe-core and does NOT enforce the WCAG 2.0 AA rule set. Every test that calls `axeCheck(...)` and asserts `violations === []` is passing against a near-empty check, not against axe-core. This is the single most consequential finding.

**Severity breakdown:**
- **BLOCKING:** 7
- **ADVISORY:** 5
- **NIT:** 3

**Designer reconciliation:** 5 of 9 Designer concerns delivered; 4 BLOCKING gaps filed.

---

## 2. Scope — files reviewed

Implementer's diff `e0f5d8b..4e9d1a0`:

- `/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte`
- `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte`
- `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D4RecoveryPassphrase.svelte`
- `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D6TypeBackVerify.svelte`
- `/home/user/agent-os/apps/web/src/lib/onboarding/steps/D7Complete.svelte`
- `/home/user/agent-os/apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte`
- `/home/user/agent-os/apps/web/src/lib/onboarding/state-machine.ts`
- `/home/user/agent-os/apps/web/src/lib/onboarding/copy-keys.ts`
- `/home/user/agent-os/apps/web/src/lib/onboarding/browser-baseline.ts`
- `/home/user/agent-os/apps/web/src/lib/onboarding/device-fingerprint.ts`
- `/home/user/agent-os/apps/web/src/lib/onboarding/recovery-blob-download.ts`
- `/home/user/agent-os/apps/web/src/lib/lock/PanicWipeModal.svelte`
- `/home/user/agent-os/apps/web/src/lib/lock/panic-wipe.ts`
- `/home/user/agent-os/apps/web/src/lib/lock/wipe-store.ts`
- `/home/user/agent-os/apps/web/src/lib/lock/memory-wipe-store.ts`
- `/home/user/agent-os/apps/web/src/lib/i18n/onboarding.en-CA.json`
- `/home/user/agent-os/apps/web/src/lib/i18n/index.ts`
- `/home/user/agent-os/apps/web/test/T19/onboarding.test.ts`
- `/home/user/agent-os/apps/web/test/T19/state-completeness.test.ts`
- `/home/user/agent-os/apps/web/test/_helpers/axe-check.ts`
- `/home/user/agent-os/apps/web/test/_helpers/onboarding-harness.ts`

**Designer's amended specs consumed:** `.context/design-system.md` §3.1 / §3.2 / §4 Surface D / Surface D.T19 (8 sub-surfaces × 9 states) / Surface G amended / Surface H amended; `design-tokens.json` `color.{light|dark}.onboarding.*` (25 keys × 2 modes) + 22 new contrast-audit pairs.

---

## 3. WCAG 2.0 AA conformance per SC checked

| SC | Title | Verdict | Notes |
|---|---|---|---|
| 1.1.1 | Non-text Content | PASS | All `<svg>` icons declared `aria-hidden="true"`; status icons paired with text. |
| 1.3.1 | Info and Relationships | PARTIAL | Wizard `role="region"` + `aria-labelledby` OK; step-indicator `<ol>` OK; PanicWipeModal has `aria-modal` + `aria-labelledby` but NO `aria-describedby` linking to the body's 4-paragraph context (A11Y-T19-3); type-back textarea NOT `aria-describedby`-linked to its helper (A11Y-T19-4). |
| 1.4.3 | Contrast (Minimum) | UNVERIFIED IN BUILD | Token pairs audited PASS by Designer's pass; **implementation does not bind to the tokens.** No `<style>` blocks consume the new `color.light.onboarding.*` tokens. The render is unstyled (browser defaults). A11Y-T19-7. |
| 1.4.4 | Resize Text | UNVERIFIED | No layout exists to fail (browser defaults); not a regression but unverified. |
| 2.1.1 | Keyboard | FAIL | PanicWipeModal has NO focus-trap implementation (A11Y-T19-2). Wizard step transitions do not move focus to the new step heading (A11Y-T19-1). |
| 2.1.2 | No Keyboard Trap | PASS | No traps observed; the inverse failure is A11Y-T19-2 (missing required trap). |
| 2.4.3 | Focus Order | FAIL | Step advance does NOT shift programmatic focus; SR users hear the polite live-region but their focus stays on the prior step's now-removed button (A11Y-T19-1). WCAG 2.4.3. |
| 2.4.6 | Headings and Labels | PASS | Each step's `<h1 id="onboarding-current-heading">` is referenced by `aria-labelledby`. |
| 2.4.7 | Focus Visible | UNVERIFIED IN BUILD | Designer specified a two-layer focus ring + an INVERTED inner ring on panic-overlay (`color.{mode}.onboarding.panic_overlay_fg`); implementation only records the token name in a `data-focus-ring-inner-token` attribute (documentation, not CSS). No actual focus styling renders. A11Y-T19-8. WCAG 2.4.7. |
| 3.2.2 | On Input | PASS | No surprise focus shifts on input; D.1 checkbox + D.6 textarea behave predictably. |
| 3.3.1 | Error Identification | PARTIAL | `role="alert"` containers exist on each step's error. D.6 mismatch error is rendered but NOT `aria-describedby`-linked to the textarea (A11Y-T19-4). |
| 3.3.2 | Labels or Instructions | PASS | Every interactive control has a label (the hand-rolled axe-check covers this minimum). |
| 4.1.2 | Name, Role, Value | PARTIAL | Most controls have name/role/value, but two D.4 "continue" buttons share identical role+name within the same step (`Print recovery sheet` AND `Next: confirm passphrase`) — second is a hardcoded English string not from catalog (A11Y-T19-9). |
| 4.1.3 | Status Messages (WCAG 2.1) | PASS | `role="status"` on completion summary; `role="alert"` on errors; `aria-live="polite"` on step-change announcer. |

---

## 4. Findings

### A11Y-T19-1 — BLOCKING — Step-advance does not move focus to the new step's heading

**Where:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:141-149, 159, 190-192, 217-218, 258-261` (every step-advance handler: `onD1Continue`, `onD2Continue`, `onD3Start`, `onD4Continue`, `onD6Submit`, `onSkipSessions`).

**WCAG SC:** 2.4.3 Focus Order; 2.4.7 Focus Visible (consequential).

**Why it fails:** When `currentStep` mutates, the previously-focused button is removed from the DOM and the browser drops focus to `<body>`. Keyboard-only users lose their place; SR users get the polite live-region step-change announcement but their focus is in nowhere. Designer §3.1 says "focus moves to first focusable element in the new step or to its heading"; Designer §6.G's pre-impl ratified concern was "focus moves to first focusable in the new step on each transition." Implementation does NOT do this.

**Fix:** After mutating `currentStep`, in a `tick()` or Svelte effect, programmatically `document.getElementById('onboarding-current-heading')?.focus()` (the `<h1>` must also have `tabindex="-1"` to be focusable). Or move focus to the first interactive element in the new step. Add a state-completeness test asserting `document.activeElement` is inside the new step after advance.

---

### A11Y-T19-2 — BLOCKING — PanicWipeModal has no focus trap, no initial-focus shift, no focus-restore-on-close

**Where:** `apps/web/src/lib/lock/PanicWipeModal.svelte:108-168` (the entire `<div role="dialog">` block).

**WCAG SC:** 2.1.1 Keyboard; 2.4.3 Focus Order; 3.2.1 On Focus.

**Why it fails:**
1. No `focus()` call on the modal's first focusable element (the type-back input) when `open` flips to `true`. Designer §3.1: "Modal opens: focus moves to the first focusable element inside (or to a labelled close button)."
2. No keydown-Tab handler cycles focus inside the modal. Tab escapes to the background page (lock screen / settings) — the bullet item Designer §6.G explicitly called out as load-bearing for PanicWipeModal.
3. No focus restoration when the modal closes (when `open` is set back to `false`). Designer §3.1: "Modal closes: focus returns to the element that opened it."
4. The pre-impl review's ADVISORY ("Focus-trap on PanicWipeModal during the ready-delay window — focus MUST be inside the modal from t=0") is NOT honoured.

**Fix:** Implement a focus trap (e.g., a small helper in `lib/a11y/focus-trap.ts` that cycles Tab + Shift-Tab within the dialog). On `open` flip true, `requestAnimationFrame(() => document.getElementById('panic-phrase-input')?.focus())`. On `open` flip false, restore focus to the previously-active element captured at open time.

---

### A11Y-T19-3 — BLOCKING — PanicWipeModal missing `aria-describedby` linking heading to body context

**Where:** `apps/web/src/lib/lock/PanicWipeModal.svelte:108-114`.

**WCAG SC:** 1.3.1 Info and Relationships; 4.1.2 Name, Role, Value.

**Why it fails:** The dialog has `aria-labelledby="panic-wipe-heading"` but not `aria-describedby`. The four paragraphs at lines 141-144 (`modal_body_what_happens`, `modal_body_what_doesnt`, `modal_residual_risk_callout`, `modal_recovery_reminder`) carry the F-115 four-regex copy: "irreversible / cannot be undone", "server / committee", "recovery passphrase / sheet", "co-chair / invite". SR users hearing only the heading "Wipe this device's data" will NOT hear the load-bearing destructive context unless they navigate manually. ARIA Authoring Practices (alertdialog/dialog pattern) requires `aria-describedby` for sensitive confirmations.

**Fix:** Wrap the body paragraphs in an element with `id="panic-wipe-body"` and add `aria-describedby="panic-wipe-body"` to the `<div role="dialog">`. The text content of the wrapped region becomes the dialog's accessible description.

---

### A11Y-T19-4 — BLOCKING — D.6 type-back textarea not `aria-describedby`-linked to helper / error

**Where:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:500-518` (the inline D.6 textarea + helper + error blocks).

**WCAG SC:** 3.3.1 Error Identification; 3.3.2 Labels or Instructions; 1.3.1 Info and Relationships.

**Why it fails:** The textarea has `aria-label="Type the passphrase to confirm"` but the helper text "Type the words exactly as shown, separated by single spaces" at line 512 is a sibling `<p>` with no association. The error block at line 516-518 (`d6-error`) has `role="alert"` but is not associated with the field via `aria-describedby` / `aria-errormessage`. SR users will hear the field label only; they will not hear the format instruction unless they navigate to the helper paragraph manually.

**Fix:** Add `id="d6-help"` to the helper `<p>` and `id="d6-err"` to the error block; on the textarea, `aria-describedby="d6-help"` always plus dynamic `aria-describedby="d6-help d6-err"` when `d6Error` is set; also `aria-invalid="true"` when in error. Mirror the existing pattern in `lib/concerns/ConcernIntakeForm.svelte:227,244` which is the canonical project pattern.

---

### A11Y-T19-5 — BLOCKING — axe-check helper is a STUB; tests assert against ≈4 structural rules, not WCAG 2.0 AA

**Where:** `apps/web/test/_helpers/axe-check.ts` (entire file) — invoked at `apps/web/test/T19/onboarding.test.ts:60-64`.

**WCAG SC:** This is an integration-quality finding (process), but it BLOCKS confidence in the entire test pass and re-opens every other criterion's "axe says PASS" claim.

**Why it fails:** The helper's docstring says "INTENTIONALLY light. The accessibility-specialist's Phase F pass runs the real `@axe-core` rule set against the live surfaces; this helper unblocks the scaffold from passing pre-Phase-F." It checks (a) buttons have an accessible name, (b) inputs have a label or aria-label, (c) `<img>` has alt. That is 3 rules out of axe-core's ~90 WCAG 2.0 AA rules. The test at `onboarding.test.ts:62-64` asserts `r.violations === []` against this stub and treats it as WCAG 2.0 AA conformance. **It is not.** ADR-0020 task 7 explicitly required "axeCheck violations === []" against the real rule set; this is structurally not what is being executed.

**Fix (BEFORE merge):** Replace `axe-check.ts` with a real axe-core invocation. Pattern:

```ts
import { run } from 'axe-core';
export default async function axeCheck(root: Element, opts: AxeCheckOptions) {
  const r = await run(root, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
  return { violations: r.violations, passes: r.passes.length };
}
```

Then run the suite; the existing assertion `expect(r.violations).toEqual([])` will surface the real findings, which include several of the items in this review. axe-core is ~600KB dev-only; vitest can load it as a dep without shipping it to production. Per ADR-0010 (Sentry-only subprocessor) axe-core is a test-time dep, not a runtime subprocessor; no compliance issue.

---

### A11Y-T19-6 — BLOCKING — `state-completeness.test.ts` does not call `axeCheck` for any state

**Where:** `apps/web/test/T19/state-completeness.test.ts` — entire file (314 lines).

**WCAG SC:** Process; reinforces A11Y-T19-5.

**Why it fails:** The file's own header comment (lines 25-30) admits: "Per-state axe-zero-violations is documented here as a TEST OBLIGATION but DEFERRED to the accessibility-specialist's Phase F pass." The deferral was never closed — there is no per-state axe assertion in this file. Designer's pass §E explicitly enumerated 8 sub-surfaces × 9 states = 72 state cells to verify; the test pins state rendering but skips per-state a11y.

**Fix:** After A11Y-T19-5 lands (real axe-core), add `await axeCheck(document.body)` + `expect(r.violations).toEqual([])` to each `it(...)` block in `state-completeness.test.ts`. Currently every state-rendering test should also be a state-a11y test.

---

### A11Y-T19-7 — BLOCKING — Components do not bind to `color.light.onboarding.*` tokens; render is unstyled

**Where:** All T19 Svelte components (`OnboardingFlow.svelte`, `PanicWipeModal.svelte`, `D3PasskeyEnrollment.svelte`, `D4RecoveryPassphrase.svelte`, `D6TypeBackVerify.svelte`, `D7Complete.svelte`).

**WCAG SC:** 1.4.3 Contrast (Minimum); 1.4.11 Non-text Contrast (WCAG 2.1, target).

**Why it fails:** Designer's pass added 25 light + 25 dark tokens under `color.{mode}.onboarding.*` and 22 contrast-audit pairs (the load-bearing reveal pair at 16.1:1; the panic-overlay pair at 15.3:1). Implementation contains:
- Zero `<style>` blocks consuming the new tokens (grep for `color.` returned only the `data-focus-ring-inner-token="color.light.onboarding.panic_overlay_fg"` documentation attribute at `PanicWipeModal.svelte:121`).
- Zero CSS-variable bindings (`var(--color-onboarding-...)`).
- Zero `<style>` blocks at all in `OnboardingFlow.svelte` beyond the `.sr-only` utility.
- Zero `<style>` in `PanicWipeModal.svelte` beyond `.sr-only`.

The render in a browser is therefore browser-default (white background, blue link color, etc.). The 22 contrast-audited pairs are not what the user sees. Designer's pass §C explicitly named these as load-bearing for the keyboard ceremony and the panic overlay. **The accessibility-specialist cannot verify 1.4.3 against tokens that aren't bound.**

**Fix:** Each component MUST consume the design tokens via CSS (typically via SvelteKit's `:global(:root)` token export or per-component scoped `<style>` blocks). At minimum:
- The panic overlay (`PanicWipeModal.svelte:117-125`) must apply `background: var(--color-onboarding-panic-overlay-bg)` + `color: var(--color-onboarding-panic-overlay-fg)`.
- The step-indicator pills must apply pending/active/complete backgrounds.
- The passphrase reveal `<code>` element must apply the load-bearing reveal pair.
- The focus ring (see A11Y-T19-8) must consume `shadow.focus_ring` for non-overlay surfaces and the inverted token for panic-overlay.

---

### A11Y-T19-8 — BLOCKING — Inverted two-layer focus ring on panic-overlay is documented but not rendered

**Where:** `apps/web/src/lib/lock/PanicWipeModal.svelte:121` (the `data-focus-ring-inner-token="color.light.onboarding.panic_overlay_fg"` attribute).

**WCAG SC:** 2.4.7 Focus Visible; 1.4.11 Non-text Contrast (WCAG 2.1).

**Why it fails:** Designer's pass §C contrast-audit row explicitly flagged: "`focus_ring.inner on panic_overlay_bg` = **1.0:1 FAIL** ... Implementer MUST render the inner ring layer at `color.{mode}.onboarding.panic_overlay_fg`." The pre-impl ADVISORY called this out as "the single most non-standard a11y artifact in the T19 design." The implementer recorded the token NAME in a data-attribute but did not produce CSS that renders the inverted ring. Result: on the in-progress overlay (which traps focus during a destructive operation), any focused descendant has the standard `border.focus` inner line at 1.0:1 = invisible.

**Fix:** Add a `<style>` block to `PanicWipeModal.svelte` (or to a global stylesheet scoped to `[data-testid="panic-wipe-in-progress-overlay"]`) that overrides `:focus-visible` outline to use the inverted color: `outline: 2px solid var(--color-onboarding-panic-overlay-fg); outline-offset: 2px; box-shadow: 0 0 0 5px var(--color-focus-outer);`. Add a test that interrogates `getComputedStyle` on the focused button.

---

### A11Y-T19-9 — BLOCKING — Hardcoded English copy in OnboardingFlow.svelte D.7 next-steps paragraph

**Where:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:547-550`:

```
<p>
  Settings → Sessions lets you sign out other devices. Settings → Wipe this device lets
  you wipe this device.
</p>
```

**WCAG SC:** 3.1.1 Language of Page (consequential — French translation drops the English literally); 4.1.2 Name, Role, Value (consistency).

**Why it fails:** Tech-writer's `onboarding.completion_d7.next_steps_body` is rendered at line 551, but lines 547-550 inline an additional hardcoded English string outside the catalog. This violates §7 i18n readiness ("No raw strings in component code") and the closed-allowlist contract in `copy-keys.ts`. fr-CA carry-forward (G-T19-1) will silently miss this copy. The duplicate "continue" buttons at lines 451-453 + 454-456 also include a hardcoded "Next: confirm passphrase" string (line 455).

**Fix:** Move the strings to `i18n/en-CA.json` under the existing `onboarding.completion_d7.*` namespace; consume via `t(...)`. Add to `copy-keys.ts` closed-allowlist. Remove the duplicate D.4 continue button at line 454-456 (it's also a 4.1.2 name conflict — two buttons with different visible labels both call `onD4Continue` in the same step).

---

### A11Y-T19-10 — ADVISORY — Skip-to-content link missing on wizard chrome

**Where:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:271-558` (wizard root section).

**WCAG SC:** 2.4.1 Bypass Blocks.

**Why it fails:** Design-system §3.1: "Skip-to-content link at the top of every page; visually hidden until focused, then surfaces at top-left." The wizard chrome is full-viewport; there is no skip link. For most steps this is minor (one heading, few controls), but D.5 with multiple sessions + D.7 with a checklist + next-step block becomes navigable-only-by-tab.

**Fix:** Add a `<a href="#wizard-step-body" class="skip-link sr-only-focusable">Skip to step content</a>` as the first child of the `<section>`. The wizard-step-body needs `tabindex="-1"`.

---

### A11Y-T19-11 — ADVISORY — Only 3 of 18 `a11y.onboarding.*` catalog keys are actually consumed

**Where:** Catalog at `apps/web/src/lib/i18n/onboarding.en-CA.json:236-258` (18 keys). Consumed only at:
- `OnboardingFlow.svelte:313` — `a11y.onboarding.step_change`
- `OnboardingFlow.svelte:334` — `a11y.onboarding.device_fingerprint_announcement`
- `PanicWipeModal.svelte:124` — `a11y.onboarding.panic_wipe_in_progress_announcement`

**WCAG SC:** 4.1.3 Status Messages (consequential).

**Why it fails:** Designer's §G handoff packet, Tech-writer's catalog, and the pre-impl review all required these announcements. 15 of 18 keys exist in catalog AND in `copy-keys.ts` allowlist (so the CI key-coverage gate is satisfied) but are not consumed:
- `wizard_landmark` — never used (the wizard region uses `aria-labelledby` to the heading, not this key)
- `passphrase_field_announcement` — never used at D.4 or in `RecoveryPassphraseScreen.svelte`
- `reveal_button_announcement`, `reveal_in_progress_announcement`, `reveal_hidden_announcement`, `reveal_capped_announcement` — never used
- `modal_open_announcement`, `modal_close_announcement` — never used at PanicWipeModal
- `destructive_confirm_announcement` — never used (the Escape-no-dismiss invariant is not announced)
- `panic_wipe_complete_announcement`, `panic_wipe_partial_failure_announcement` — never used (the `panic-wipe-complete-toast` uses the visible string at line 134 only)
- `session_revoked_announcement` — never used at D.5 success
- `browser_baseline_pass_announcement`, `browser_baseline_fail_announcement` — never used
- `step_loading_announcement`, `step_error_announcement` — never used

**Fix:** Consume each key at its semantic location, typically as an `<span class="sr-only">{t(...)}</span>` inside a `role="status"` / `role="alert"` live region. Specifically:
- PanicWipeModal modal-open: render the `modal_open_announcement` in a polite live region on `$: if (open) ...`.
- D.5 success path: render `session_revoked_announcement` in the existing `role="status"` block at line 488.
- D.3 baseline pass/fail: render `browser_baseline_pass_announcement` / `browser_baseline_fail_announcement` in the badge.

---

### A11Y-T19-12 — ADVISORY — `aria-live="polite"` step-change announcement may fire before step content is rendered

**Where:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:308-318` (the live-region `<div>`).

**WCAG SC:** 4.1.3 Status Messages.

**Why it fails:** The announcement reads from `stepNumber(currentStep)` and `STEP_LABELS[stepNumber(currentStep) - 1].name`. The live region is in the same template render tick as the new step body, so SR may announce the new step name before the new step's heading is actually present in the accessibility tree. Risk is low (Svelte's render is synchronous), but advisory: add a Svelte `tick()` between step mutation and the announcement update to ensure the new step body exists when the polite region fires.

**Fix:** Move the announcement to a separate reactive statement that fires after `tick()`; or use `aria-relevant="additions text"` to be explicit. Manual SR test recommended (see §7 below).

---

### A11Y-T19-13 — ADVISORY — D.7 hardcoded "Settings → Sessions" / "Settings → Wipe this device" prose duplicates the catalog `next_steps_body` block

**Where:** Same as A11Y-T19-9; covered there.

---

### A11Y-T19-14 — NIT — Step indicator items are `<li>` without role="button" and not keyboard-focusable for complete-step review

**Where:** `apps/web/src/lib/onboarding/OnboardingFlow.svelte:283-305`.

**WCAG SC:** 2.1.1 Keyboard (informational).

**Why it fails:** Designer §4 D.T19.b says complete pills are clickable for review-only re-visit (with hover, active, focus-visible states); implementation renders the `<li>` with `aria-current` / `aria-label` / `aria-disabled` but no `tabindex` and no click handler. This is consistent with "step indicator is decorative" (which is also acceptable per WCAG); but it diverges from the Designer's spec. Either honour the Designer's clickable-complete-pill or set the indicator `aria-hidden="true"` and rely on the polite step-change announcer alone. Currently it is in the SR tree but inert — an SR user can navigate to it but cannot do anything with it.

**Fix:** Choose one of (a) implement clickable complete pills per spec, (b) explicitly mark the entire `<ol>` `aria-hidden="true"` and let the live region carry the step state. Document which.

---

### A11Y-T19-15 — NIT — `aria-disabled` used in lieu of `disabled` on multiple buttons

**Where:** `OnboardingFlow.svelte:425, 435, 474`; `PanicWipeModal.svelte:157`.

**WCAG SC:** 4.1.2 Name, Role, Value.

**Why it fails:** Buttons that are functionally disabled (the reveal control when capped, the download button during encryption, the revoke-other-sessions button when `__test_session_count <= 1`, the panic-wipe primary while `primaryDisabled`) use `aria-disabled="true"` instead of `disabled`. ARIA Authoring Practices is split on this: `aria-disabled` is preferred when the button should remain focusable so SR users discover it; `disabled` removes from tab order. The Designer's spec calls for `aria-disabled` (focusable + announced), which is correct — but the implementation does not also prevent click activation when `aria-disabled="true"` is set. A keyboard-only user pressing Enter on the disabled reveal control may still trigger the handler.

**Fix:** Each `on:click` that backs an `aria-disabled`-able control must early-return if the disabled state is true. For the panic-wipe primary, line 88 of PanicWipeModal.svelte already does this (`if (!ready || !isPhraseMatched()) return;`). Confirm the same guard exists on the reveal control, download button, and revoke-other-sessions button.

---

### A11Y-T19-16 — NIT — `:focus-visible` not specified in any component `<style>`

**Where:** All T19 Svelte files. Only `.sr-only` and one `@media (prefers-reduced-motion: reduce)` exist; no `:focus-visible` rules.

**WCAG SC:** 2.4.7 Focus Visible.

**Fix:** Covered by A11Y-T19-7 / A11Y-T19-8 (tokens must be consumed; focus styling must render). Add explicit `:focus-visible` rules consuming `shadow.focus_ring`.

---

## 5. Screen-reader announcement audit (`a11y.onboarding.*` keys → consumption)

| Catalog key | Specified consumer | Consumed at file:line | Status |
|---|---|---|---|
| `step_change` | Wizard chrome step-transition | `OnboardingFlow.svelte:313` | PASS |
| `wizard_landmark` | Wizard region `aria-label` | (none) | MISSING |
| `passphrase_field_announcement` | D.4 passphrase region | (none) | MISSING |
| `reveal_button_announcement` | D.4 reveal control | (none) | MISSING |
| `reveal_in_progress_announcement` | D.4 hold-to-reveal transient | (none) | MISSING |
| `reveal_hidden_announcement` | D.4 reveal release | (none) | MISSING |
| `reveal_capped_announcement` | D.4 capped helper | (none) | MISSING |
| `modal_open_announcement` | PanicWipeModal open | (none) | MISSING |
| `modal_close_announcement` | PanicWipeModal close | (none) | MISSING |
| `destructive_confirm_announcement` | PanicWipeModal ready | (none) | MISSING |
| `panic_wipe_in_progress_announcement` | PanicWipeModal in-progress overlay | `PanicWipeModal.svelte:124` | PASS |
| `panic_wipe_complete_announcement` | PanicWipeModal complete toast | (none — visible text only) | MISSING |
| `panic_wipe_partial_failure_announcement` | PanicWipeModal partial-failure alert | (none) | MISSING |
| `session_revoked_announcement` | D.5 success toast | (none — visible text only) | MISSING |
| `browser_baseline_pass_announcement` | D.3 pass badge | (none) | MISSING |
| `browser_baseline_fail_announcement` | D.3 fail badge | (none) | MISSING |
| `step_loading_announcement` | Any step in-progress | (none) | MISSING |
| `step_error_announcement` | Any step error | (none) | MISSING |
| `device_fingerprint_announcement` | D.1 fingerprint card | `OnboardingFlow.svelte:334` | PASS |

**Consumption: 3 of 18 keys.** This is reflected as A11Y-T19-11 (ADVISORY rather than BLOCKING because catalog keys exist; consumption is a wiring gap, not a translation gap; and the visible text on these surfaces is correct — SR users get the visible text, just not the polished operational nuance the catalog encodes).

---

## 6. Designer's pre-impl review reconciliation

The Designer's pass §G enumerated 9 concerns/PASS items handed to the implementer. Status in implementation:

| # | Designer concern | Pre-impl verdict | Post-impl status | Finding |
|---|---|---|---|---|
| 1 | Contrast audit (22 new pairs) | PASS | UNVERIFIED — tokens not bound | A11Y-T19-7 |
| 2 | Color-blind safety (icon + text) | PASS | PASS — check icons render at D.7, D.4 (capped helper), step-indicator complete, error x-circle | — |
| 3 | Reduced-motion fallbacks | PASS | PARTIAL — `data-reduced-motion="true"` set on body; no CSS consumes it; `RecoveryPassphraseScreen.svelte:178-181` honours `@media (prefers-reduced-motion: reduce)` for the reveal button; no other component does | NIT — extend the @media rule project-wide |
| 4 | Touch target ≥44px | PASS | UNVERIFIED — no CSS asserts min-height; render is browser-default button height (~24px in some browsers) | A11Y-T19-7 root cause |
| 5 | Inverted focus ring on panic-overlay | PASS | FAIL — documented in a data-attribute only | A11Y-T19-8 |
| 6 | `autocomplete="off"` + `spellcheck="false"` on D.6 textarea | PASS | PASS — `OnboardingFlow.svelte:506-509` AND `D6TypeBackVerify.svelte:25-28` both have the full set (`autocomplete`, `spellcheck`, `autocapitalize`, `autocorrect`) | — |
| 7 | Wizard step-transition reduced-motion | PASS | PARTIAL — `data-reduced-motion` attribute set; no transition CSS exists, so reduced-motion is trivially honoured (no transition to suppress) | NIT |
| 8 | F-53 destructive_confirm contract | PASS | PASS — `PanicWipeModal.svelte:36-48,69-79,100-105` implements ready-delay, input-gating, and Escape-no-dismiss correctly | — |
| 9 | SR announcement `step_change` interpolates BOTH `n` AND `step_name` | ADVISORY | PASS — `OnboardingFlow.svelte:313-317` interpolates n, m, step_name | — |
| (Implicit) | Focus-trap on PanicWipeModal | PASS (advisory) | FAIL | A11Y-T19-2 |
| (Implicit) | Focus moves to new step on advance | PASS (advisory) | FAIL | A11Y-T19-1 |
| (Implicit) | `aria-describedby` on dialog + invalid fields | PASS (advisory) | FAIL | A11Y-T19-3, A11Y-T19-4 |

**Reconciliation summary: 5 of 9 explicit Designer concerns delivered; 1 partial; 3 fail. Plus 3 implicit standard-modal-pattern items fail.**

---

## 7. axe-check integration verification

**Verdict: STUB — does NOT invoke axe-core.**

File: `apps/web/test/_helpers/axe-check.ts` (95 lines, hand-rolled).

Evidence:
- Line 1-14: docstring explicitly says "INTENTIONALLY light" and "does not load `axe-core` (which is a heavy dep); it performs the structural sanity checks the scaffold test cares about."
- Lines 42-91: three structural rules only — button accessible name, form-control label, image alt.
- No `import` of `axe-core`. No call to axe-core's `run()`. No WCAG tag filtering. The `_opts?: AxeCheckOptions` parameter is named `_opts` (intentionally unused).

Every test that calls `axeCheck` and asserts `r.violations === []` is asserting against this stub. The most consequential implication: ADR-0020 task 7 acceptance "axeCheck violations === []" is not satisfied in the production sense. Several real WCAG failures in this review (focus management, aria-describedby, focus-visible) would be caught by axe-core and are not caught by the stub.

**This is A11Y-T19-5 (BLOCKING). It MUST land before any subsequent task 7 retry.**

---

## 8. Items requiring real-user testing (deferred)

The findings above are all detectable without an SR user. The following require an actual person on actual assistive tech:

- **Cognitive-load pass on D.4 / D.6 ceremony:** does a grade-8 reader understand the recovery passphrase ceremony in one read? Reading-level proxy passed (no Latin abbrevs) but comprehension is a human concern.
- **VoiceOver on iOS Safari at D.6 type-back:** does `spellcheck="false"` interact with VoiceOver's typing-feedback correctly? Designer's §G called this out specifically.
- **NVDA on Windows Chrome at the panic-wipe modal:** is the destructive context understood before the user types "WIPE"?
- **TalkBack on Android at the D.5 session-revocation primer:** does the dynamic per-row content announce correctly when `__test_session_count` toggles 1 → 3?

**Recommend scheduling 30-minute sessions with at least two AT-using participants from the worker JHSC rep audience BEFORE the user-approval gate at ADR-0020 task 12.**

---

## 9. AODA artifacts (public-facing)

- **Accessibility statement:** the T19 wizard is the first user-facing flow; an app-level accessibility statement page is NOT in scope for T19 but MUST exist before public launch (AODA s. 14). Recommend creating `/accessibility` route as a sibling deliverable.
- **Feedback mechanism:** AODA s. 11 requires a clear way to report accessibility issues. The D.7 next-steps copy mentions "ask your worker co-chair" — this is partial. A dedicated feedback channel (email, form, or co-chair pathway documented in the accessibility statement) MUST be in place before launch. Out of T19 scope but flagged for the launch checklist.

---

## 10. Recommended action sequence

1. **BLOCK MERGE.** Re-open task 7. The implementer must address A11Y-T19-1 through A11Y-T19-9 before re-submission.
2. **Replace `axe-check.ts` with axe-core (A11Y-T19-5).** Re-run the full T19 suite. Expect new failures; those failures are what the post-impl pass is for.
3. **Bind the design tokens (A11Y-T19-7).** Add component `<style>` blocks or a global token-to-CSS-variable bridge. Re-run state-completeness tests; verify rendered styles.
4. **Implement focus management (A11Y-T19-1, A11Y-T19-2).** Add a small `lib/a11y/focus.ts` helper: `moveFocusTo(el)` and `createFocusTrap(rootEl)`.
5. **Wire `aria-describedby` on PanicWipeModal + D.6 (A11Y-T19-3, A11Y-T19-4).** Mirror the pattern in `lib/concerns/ConcernIntakeForm.svelte`.
6. **Render the inverted focus ring (A11Y-T19-8).** Test it via `getComputedStyle`.
7. **Catalog the hardcoded copy (A11Y-T19-9).** Add the keys; consume via `t(...)`.
8. **Consume the 15 unused a11y.* keys (A11Y-T19-11).**
9. **Add per-state `axeCheck` to state-completeness tests (A11Y-T19-6).**
10. **Re-submit for task 7 second iteration.**

---

## 11. Self-validation

- Designer's 9 concerns reviewed? **Yes** — table in §6.
- Real keyboard-only + real SR pass performed? **Partial — code review only; live SR pass deferred to §8.** Findings flagged as such.
- Every finding cites WCAG SC + file:line + concrete fix? **Yes.**
- AODA artifacts surfaced? **Yes — §9.**

---

**End of accessibility-specialist's post-implementation pass for T19. Verdict: FAIL. Block merge.**
