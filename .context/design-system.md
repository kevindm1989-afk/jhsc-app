# Design System — Worker-Side JHSC App

> **Status:** Designer pass complete. **Blocked on accessibility-specialist sign-off before commit.**
> **Authoring agent:** designer
> **Date:** 2026-05-22
> **Inputs:** `JHSC-APP-PLAN.md`, `.context/decisions.md` (14 ADRs + RA-1), `.context/threat-model.md` §3.2 / §3.3 / §3.4 / §8 / §9, `.context/constraints.md` (AODA + no-third-party-JS-at-runtime).
> **Canonical token file:** `/home/user/agent-os/design-tokens.json` — the implementer reads tokens from there; nothing in this document overrides them.

---

## 0. Reading order

1. §1 Discovery — who this is for, what they do, what the surfaces are.
2. §2 Visual direction — committed, with references and anti-patterns.
3. §3 Interaction patterns — common rules every component obeys (focus, modal, toast, validation, destructive confirm).
4. §4 Component state spec — every state for every surface in the surface inventory.
5. §5 Layout patterns — page-level layouts the implementer composes from.
6. §6 Accessibility handoff prep — what the accessibility-specialist verifies.
7. §7 i18n readiness — catalog convention and where the en-CA / fr-CA files live.
8. §8 Sample screen — proof the system is complete.
9. §9 Handoff.

---

## 1. Discovery (short)

- **Audience.** Worker JHSC reps, the worker co-chair, certified members. Ontario workplaces of 50+. Personal Android phones (often older, weak signal on the shop floor) and occasional personal laptops. Includes workers with disabilities — AODA is a hard constraint, not aspirational.
- **Primary task.** Capture inspection / concern / reprisal data quickly from a phone, and (for the co-chair) complete a deliberate friction-by-design export to the employer co-chair without leaking concern-derived or C4 content.
- **Content shape.** Forms-heavy (intake, inspection, recommendations) + list-heavy (concerns register, audit feed, sessions) + small set of high-consequence interstitials (export, panic-wipe, 4-eyes, lock screen).
- **Tone.** Plain, declarative, never coy. Says what the system can see, what it cannot, and what it logs. Uses the literal verb ("reprisal", "wipe this device's data", "export to employer co-chair") rather than euphemism.

---

## 2. Visual direction — committed

**Name:** **Civic-record.** A serious workplace-safety instrument that reads like a labour-tribunal binder rendered for a phone.

**Three references, with what we borrow from each:**
1. **GOV.UK Design System** — typographic posture, focus-ring discipline (visible black-on-yellow outline), unapologetic plainness of language.
2. **Stripe Dashboard** — calm semantic color (single accent + clearly-coded states), destructive confirm pattern that names the irreversible thing about to happen.
3. **Signal Desktop** — sensitivity vocabulary (C3 / C4 badge treatment), conspicuous lock affordance, "sealed" wording that tells the user what the system can and cannot see.

**Mood adjectives:** sober, audited, candid, careful, load-bearing.

**Three anti-patterns (forbidden):**
1. Gradients, glass-morphism, or marketing-grade hero illustrations on any sensitive surface (concerns, reprisal, work-refusal, s.51, exports, sessions). The product is not aspirational.
2. Icon-only controls without text labels for destructive, sensitive, or export actions. Icons accompany text; they do not replace it.
3. Color-only state signals. Sensitivity, success, error, warning, queued, and offline always pair color with an icon **and** a text label.

---

## 3. Interaction patterns (load-bearing across all surfaces)

### 3.1 Focus management
- **Focus-visible always.** Two-layer ring: `outer` (#fbbf24 / yellow halo, 3px) + `inner` (foreground line, 2px) per `shadow.focus_ring`. Visible on any background light or dark. **`outline: none` is forbidden without a replacement at least as visible.**
- **Skip-to-content link** at the top of every page; visually hidden until focused, then surfaces at top-left.
- **Tab order follows DOM order.** No `tabindex` other than `0` (or `-1` for programmatic focus targets).
- **Modal opens:** focus moves to the first focusable element inside the modal (or to a labelled close button), focus trap engages, body scroll locks.
- **Modal closes:** focus returns to the element that opened it.
- **Toast appears:** focus does NOT move automatically (interrupting screen-reader flow is hostile); toast is announced via `aria-live` (`status` for info/success/warning; `alert` for danger and sensitive).

### 3.2 Modal / Dialog rules
- One modal at a time. A second `show()` call closes the first.
- `Escape` dismisses **except** for `destructive_confirm`, `export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `four_eyes_pending` — these require explicit Cancel (a coerced user must not be able to accidentally swipe a sensitive action away).
- Click-outside dismisses **only** for the plain `dialog` variant. Forbidden for the same five high-consequence variants above.
- Scrim color: `color.background.scrim`. z-index: `z_index.scrim` for the dimmer, `z_index.modal` for the dialog.

### 3.3 Toast / Notification rules
- **Severity → role:** info/success/warning use `role="status"` (polite); danger and sensitive_activity use `role="alert"` (assertive).
- **Auto-dismiss:** info/success 4s; warning 7s; danger and sensitive_activity **never auto-dismiss** (manual close only).
- **Max 3 visible** at once; oldest fades when a fourth arrives.
- **Sensitive-activity toasts** (RA-1 post-export notification; C4 sensitive-read notification) additionally write to the persistent audit feed, so a missed toast is recoverable.

### 3.4 Form validation timing
- **Inline validation on blur** for individual fields (so a sighted, sequential filler sees errors as they finish a field).
- **Batch validation on submit** for the form as a whole (so a screen-reader user filling top-down isn't yelled at mid-field).
- **Passphrase and TOTP fields validate only on submit.** Mid-typing validation of secrets leaks correctness through timing and through visible feedback.
- **Error messages** name what's wrong, why, and what to do. Never "Invalid." or "Error 422."

### 3.5 Destructive-action confirmation pattern (used by export, panic-wipe, 4-eyes, soft-delete on C4)
A single canonical pattern; do not reinvent.

1. **Trigger.** Destructive button (variant: `destructive`) — labeled with the literal verb ("Wipe this device's data", "Export to employer co-chair", "Delete reprisal entry").
2. **Modal variant: `destructive_confirm`.** Scrim + dialog. Headline = the action in plain English. Body = (a) what will happen, (b) what is irreversible about it, (c) any sensitive cargo it carries (e.g., "this export includes 2 concern-derived items").
3. **Inputs.** Most destructive_confirm modals require the user to either (a) re-auth via passkey, (b) enter a per-record passphrase, OR (c) type a literal confirmation phrase ("WIPE" for panic-wipe). The choice depends on the surface (see component spec).
4. **Buttons.** Cancel (variant `secondary`, on the left). Confirm (variant `destructive`, on the right). The confirm button is disabled until the requirement above is satisfied.
5. **Post-confirm.** Loading state in the modal (spinner + "Working…"); success closes modal and shows a confirmation toast; error stays in the modal with the error message inline.
6. **Audit-log emission.** Per RA-1 and Invariant 8: the audit row is the precondition, not a side effect — the action does not complete until the audit row is hash-chained.

---

## 4. Component state spec — every surface, every state

> **Implementer's contract.** Every state in this section MUST be built. Adding a new state requires a new designer pass and a fresh accessibility-specialist review. Inventing values not in `design-tokens.json` is forbidden.

**Reading the table:** `component | state | trigger | visible cues (tokens) | a11y notes | empty/loading/error coverage if applicable`.

---

### Surface A — Export interstitial (RA-1 / F-19 / HG-1)

The single egress at trust boundary B3. Friction is intentional.

| state | trigger | visible cues (tokens) | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **idle** | User clicks `Export to employer co-chair` on a finalized minutes / recommendation surface | Button variant `destructive`; icon=arrow-up-right + text label `export.button.label` | Button is keyboard-reachable; `aria-haspopup="dialog"` | n/a |
| **re-auth-required** | Modal opens; current session JWT alone is insufficient (RA-1) | `modal.reauth_prompt`; scrim `color.background.scrim`; headline `export.reauth.heading` ("Confirm with your passkey to continue"); body explains why; primary button `reauth.button.label` ("Use passkey") | Focus traps to `Use passkey` button; cancel returns focus to the trigger | If WebAuthn unavailable in browser → error_state.permission variant; if user has no enrolled passkey → error linking to enrollment |
| **re-auth-failed** | WebAuthn returns NotAllowed / abort / timeout | Inline `alert_banner.danger` inside the modal; original re-auth button re-enabled; counter shown ("2 of 3 attempts left before lockout per F-42") | `role="alert"` on the inline error; counter is in catalog key `export.reauth.attempts_left` | After 3 failures, modal closes with toast `toast.danger`; co-chair must wait per rate limit |
| **reviewing-fields** | Re-auth succeeded; modal transitions to the field-list review | `modal.export_interstitial`; section heading `export.fields.heading` ("These fields will leave the worker side"); enumerated list of fields by **label** (not value) grouped by document; if there are zero rows in any allowlist group, the group is hidden (no "empty exports") | List is `<ul>` with `aria-label` matching the heading; each item is plain text; the field list is rendered from the same allowlist constant the renderer uses (F-27 hash) | If the allowlist is empty (no exportable rows) → block state: heading `export.empty.heading` ("Nothing to export yet"), body explains, single Close button |
| **concern-flag-warning** | The export includes any item with non-empty `derived_from_concerns: concern_id[]` | Above the field list, a `alert_banner.sensitive_c4`-style strip (uses C4 tokens since concern provenance is reprisal-sensitive): icon=flag + heading `export.concern_flag.heading` ("This export includes items derived from worker concerns"); body lists the originating concern IDs and hazard_class; a separate inline checkbox `export.concern_flag.confirm_checkbox` ("I have reviewed the concern-derived items") gates the Confirm button | `role="alert"`; checkbox is its own focusable target; Confirm button has `aria-describedby` pointing to the checkbox label so SR announces the gating | If concern-derived items exist but the user un-checks the box, Confirm disables and the helper hint reappears |
| **confirming** | User clicks Confirm | Button `loading` state (spinner + `export.confirming.label` "Preparing PDF…"); all other modal controls disabled; modal cannot be dismissed | `aria-busy="true"` on the modal body | If audit-log POST fails BEFORE blob creation → error-state variant `integrity_fail`; modal stays open, error inline, no PDF offered |
| **exporting** | Audit row committed; PDF rendering in-browser | Same as confirming; progress phrase changes to `export.rendering.label` ("Rendering…"); determinate progress bar if pages are countable | Progress bar has `role="progressbar"`, `aria-valuenow` updated; SR announces "Rendering page X of Y" | If render fails (memory, font fallback) → error_state variant generic with retry |
| **exported** | Blob URL created; `<a download>` injected and auto-clicked OR user clicks "Download PDF" if browser blocks auto-click | Modal transitions to success state: headline `export.exported.heading` ("Export ready"); checkmark icon (color `state.success`); list of: filename, audit row ID, post-export-notification-fired indicator; primary button `export.exported.close` ("Done") | `role="status"`; SR announces "Export ready" | n/a |
| **error** | Network, crypto, integrity_fail, or rate-limit | Modal stays open; `error_state` inline with named variant; Retry button for recoverable errors; for rate-limit, shows time-until-allowed | `role="alert"` | Always present in this state matrix |

**Specific behavior notes for A:**
- Auto-dismiss is **forbidden** for this modal in all states. Friction is the point.
- The recipient destination is rendered in plaintext as part of `reviewing-fields`: `export.recipient.label` = "Recipient: Employer co-chair (manual delivery — you will send the file yourself)." This makes RA-1 compensating control #1 visible.
- Per F-25 / F-24: no server-side PDF rendering, no POST that returns `application/pdf`. The implementer assembles bytes in the browser only.
- Post-export rep notification (RA-1 compensating control #4) is fired by the same submit action that creates the audit row; if the notification POST fails, the export still completes (audit row is the gate) but a `toast.warning` informs the co-chair that other reps will be notified on next sync.

---

### Surface B — Concern intake form (T08 / ADR-0007)

Committee-members-only intake. Anonymous toggle defaults ON (T3 / F-17).

| state | trigger | visible cues (tokens) | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **empty** (initial render) | Rep opens the intake page | Form layout (single column, max-width `layout.max_width.form`); fields in order: hazard_class (select), severity (radio group), location (select from C1 enum), title (text), body (textarea), source toggle (switch, **default ON = anonymous**); source_name field is **hidden when anonymous=ON** | Fieldsets group radio and switch controls; legends are the question; required asterisks have a visually-hidden "required" SR string | n/a — empty is the initial state |
| **drafting (anonymous)** | Anonymous toggle is ON (default) | Source name input is not rendered; helper text under the toggle: `concern.anon.helper_on` ("The original worker's name is not stored. Only what you type in the body is.") | Switch announces "Anonymous source, on. Press to switch off." (locale string) | n/a |
| **drafting (named — with advisory)** | User flips toggle to OFF | Source name input appears below the toggle with `inline-fade`-via-opacity transition (reduced-motion: no transition, just appears); above the source name field, a `alert_banner.sensitive_c4` strip displays `concern.named.advisory` ("The source name will be encrypted under the committee key. Every active committee member can see it. You cannot un-name it once you save.") | The advisory has `role="status"` (it appears, then is read once); the source name field is `<input type="text">` with `aria-describedby` pointing to the advisory | n/a |
| **saving** | User clicks Save | Save button in `loading` state (spinner + `concern.saving.label` "Encrypting and saving…"); all form controls disabled | `aria-busy="true"` on the form; SR announces the loading label once | If encryption fails → error_state.crypto |
| **saved** | Server confirms write; audit row hash-chained | Page transitions to a confirmation view: headline `concern.saved.heading` ("Concern logged"); summary card showing hazard class, severity, anonymous status (no source name even if named — defense-in-depth); primary action `concern.saved.next` ("Log another") and secondary `concern.saved.return` ("Back to register") | `role="status"`; SR reads heading | n/a |
| **error** | Network, crypto, RLS denial | Form remains populated; inline error banner above the Save button with the specific cause and what to do | `role="alert"` | Always present |
| **validation-error** | User submits with missing required fields | Each missing field gets its inline error text; first invalid field receives focus; banner above the form summarizes count | Errors are `aria-describedby`-linked to their inputs; summary banner is `role="alert"` and lists each error as a hyperlink jumping to the field | Always present |

**Specific behavior notes for B:**
- The anonymous toggle's default state is locked: the initial render is anonymous=ON. There is no "remember last setting" affordance — every new concern starts anonymous (T3 structural enforcement).
- Per F-18: the list view (separate surface, see §4.G) never includes `source_name_ct` in the default payload. The intake form does not influence list payload defaults.
- Per F-16: every save (create OR update) commits an audit row capturing `prev_field_hashes`; the user is not shown the hashes but the audit feed is.

---

### Surface C — Reprisal log entry (T13 / C4)

Highest sensitivity. The per-record passphrase is a UX gate (per F-34) — the cryptographic gate is `ck_priv`. The visual treatment must NOT imply the passphrase is the crypto.

| state | trigger | visible cues (tokens) | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **list (badged)** | User opens reprisal log surface | Each row uses `card.sensitive_c4`: 4px left border `sensitivity.c4_border`, top-right C4 badge ("Highest sensitivity — passphrase required to view"), title visible (also C3 — encrypted but the title decrypts client-side on list mount), body shown only as "Locked — tap to view"; row count visible at top | Each row is a focusable list item with `aria-label` describing sensitivity; the C4 badge is not the only signal — the lock icon + the "Locked" text carry the meaning too | If zero entries → empty_state with heading `reprisal.empty.heading` ("No reprisal entries logged"), body explains what a reprisal entry is and links to OHSA s.50 doc-library reference; primary action `reprisal.empty.cta` ("Log a reprisal entry") |
| **entering (with passphrase prompt)** | User taps a row OR opens "Log a new entry" | Two distinct sub-surfaces: (1) For VIEWING an existing entry: `modal.passphrase_prompt` opens; headline `reprisal.passphrase.heading` ("Enter the passphrase for this entry"); input field type=password with show/hide toggle; helper text `reprisal.passphrase.helper` ("This is a friction layer. The entry is also protected by your passkey-derived keys."); Cancel + Open buttons. (2) For CREATING: full form (similar to concern intake but with body textarea sized larger, no anonymous toggle — author is always recorded, F-17 applies); passphrase set as part of form, with confirm field | Passphrase input uses `autocomplete="off"` and `inputmode="text"`; the helper text exists specifically so SR users hear that the passphrase is not the only protection | If passphrase wrong → `error_state` inline; counter ("2 attempts left") visible; on 3rd wrong attempt, modal closes and a `sensitive.access_attempt` audit row fires (F-34) |
| **saved** | New entry committed | Toast `success` + immediate transition to "reading" the just-saved entry (since the author already authenticated this session) | `role="status"` | n/a |
| **reading** (triggers server-side audit per HG-6) | Passphrase correct → view full entry | Entry card uses `card.sensitive_c4`; top strip shows: actor who created, timestamp, status, hash; body in `typography.roles.body`; below the body, a "Recent reads" mini-feed (last 5 reads) is visible so the reader knows their own read just appeared | The "Recent reads" feed reinforces RA-1's compensating control #4 visually; SR announces "Your read was logged at <ts>" via `role="status"` after the load | If decrypt fails → error_state.crypto |
| **4-eyes-needed-for-status-change** | User clicks "Change status" (to resolved / withdrawn / deleted) | Inline within the entry view, a `card.default` appears below the body with heading `reprisal.fourEyes.heading` ("This change needs a second committee member's approval"); explanation; "Propose change" button | The card is `role="region"` with `aria-labelledby` pointing to the heading | If user has no quorum partner available, the proposal still records; helper text explains a partner will see it in their feed |
| **4-eyes-pending** | User submits a proposal; awaiting a distinct second approver | Status pill on the entry: `status_pill.warning` "Pending second approval"; the entry view shows the proposal: who proposed, what change, when, when it expires | `aria-live="polite"` region announces "Pending second approval" | Auto-times out after the TTL — surface shows `status_pill.danger` "Proposal expired" and offers re-propose |
| **4-eyes-confirmed** | A distinct second member approves | Toast `success` ("Status changed by 4-eyes approval"); entry refreshes; audit feed gets two rows (proposal + approval, hash-chained) | `role="status"` | n/a |
| **error** | Network, crypto, integrity_fail | `error_state` inline | `role="alert"` | Always |

**Sensitive-read notification feed (the "post-coercion notification" surface — companion to C):**

This is a persistent in-app feed every active member sees. It is the **HG-6 / F-33 / RA-1 compensating-control-4** UI.

| state | trigger | visible cues (tokens) | a11y notes |
|---|---|---|---|
| **idle (no recent activity)** | Feed mounted; nothing in the last 7 days | Empty-state card: `empty_state` heading `sensitiveFeed.empty.heading` ("No recent sensitive activity"); body `sensitiveFeed.empty.body` ("When another member reads a C4 entry or exports anything to the employer co-chair, you will see it here.") | Empty state has `role="status"` initially, then becomes inert |
| **active items present** | Server-emitted events from `sensitive.read` / `export.*` / `reprisal.update` / etc. | Each item is a row in the feed: actor display name (always present even when anonymous on the underlying record — actor is never anonymous per F-17), action verb, target type + truncated ID, timestamp (relative + absolute on hover/focus); items use `alert_banner.sensitive_c4` color treatment when the action is C4-related, `alert_banner.warning` for exports, `alert_banner.info` for less-sensitive sensitive events | Each row is `role="article"` with `aria-label` summarizing the event |
| **realtime new item arriving** | New event during current session | A new row inserts at the top with a momentary `bg-tertiary` highlight that fades to `bg-raised` over `motion.duration.normal` (reduced-motion: no fade, just the row appears + a toast variant `sensitive_activity` fires for it) | New row also fires `aria-live="assertive"` (matches the toast's `role="alert"`) |
| **muted-by-self** | User toggles "Pause notifications" (does NOT stop logging — only suppresses toast pop-ups; the feed still updates) | Banner above the feed: `sensitiveFeed.muted.banner` ("Notification pop-ups paused. The feed still updates. Audit logging is unaffected."); status_pill on the toggle | The banner has `role="status"` | n/a |
| **error** | Stream disconnect, RLS denial | Inline `alert_banner.warning`: "Unable to load recent activity. Retry." | `role="alert"` |

---

### Surface D — Onboarding (ADR-0008 + ADR-0001 + RA-1 + F-08 + ADR-0020 T19)

First-launch flow. Plain-language; no lawyer voice.

> **D.5 LABELLING-DRIFT RESOLUTION (designer's pass 2026-05-24, per ADR-0020 follow-up G-T19-2):** the canonical D.1→D.7 step labels are now aligned with ADR-0020's librarian briefing. The print sheet is renamed **D.4.print** (a sub-step of D.4 rendered via `@media print`); **D.5** is now the **session-revocation primer**; **D.6** stays type-back verify; **D.7** stays completion. The original §4 D.5 row below (which described the print stylesheet) is preserved as `D.4.print` in the table; a new `D.5 session-revocation primer` row replaces the step-5 slot. The test scaffold's `advanceThroughTo('D.4')` / `advanceThroughTo('D.7')` references are unaffected; the harness exposes steps by name and the harness's `'D.5'` step name now maps to the session-revocation primer (not the print sheet). Implementer + test-writer MUST consume this canonical labelling.

| step | state | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **D.1 device advisory** | initial | Full-screen page (not a modal — this is the first screen the rep ever sees); headline `onboarding.device.heading` ("Use a personal device only"); body explains in plain English: "If you are reading this on a phone or laptop your employer owns or pays for, your employer may be able to read what you do here. Stop. Install on a personal phone or laptop and start again."; primary button `onboarding.device.continue` ("This is a personal device — continue"); secondary button `onboarding.device.stop` ("Stop — I'll switch to a personal device"); the page also shows the current device fingerprint (UA + platform) as info | Plain-language body wraps at `max_width.prose`; secondary button surfaces a confirmation that simply closes the tab with a friendly message | n/a — initial state |
| **D.2 hosting tradeoff** | post-D.1 | Headline `onboarding.hosting.heading` ("Where your data lives"); body in `body` role explains in plain English: "Your committee's data is stored on Supabase, a service based in the US that runs on servers in Canada (ca-central-1). Two things you should know: (1) the worker-side content — concerns, reprisal entries, minutes drafts — is encrypted on your device before it leaves, so Supabase only sees scrambled bytes; (2) US legal process could in principle reach the company, but what they would get back is the same scrambled bytes."; primary `onboarding.hosting.continue` ("Got it") | Reading level target: grade 8; no Latin abbreviations ("i.e.", "e.g."); link to the full privacy policy as a secondary action | n/a |
| **D.3 passkey enrollment — explain** | post-D.2 | Headline `onboarding.passkey.heading` ("Set up your passkey"); body explains what a passkey is in plain English: "A passkey is a way to sign in without a password. It lives on your device and uses your fingerprint, face, or device PIN to confirm it's you. There is no password to phish, leak, or guess."; browser-compatibility check banner if the browser is below the supported baseline (per Q2); primary `onboarding.passkey.start` ("Set up passkey now") | The button triggers `navigator.credentials.create`; SR users hear the explainer before being prompted by the OS dialog | If browser unsupported → block state `onboarding.browser.unsupported` with a plain-language explanation of which browsers work |
| **D.3 passkey enrollment — in progress** | OS WebAuthn dialog | Modal scrim covers app; small in-app card says `onboarding.passkey.waiting` ("Waiting for your device…") | `aria-live="polite"` on the waiting card | If timeout / NotAllowed → inline error in the same card with Retry; on too many retries, return to D.3 explain |
| **D.3 passkey enrollment — done** | WebAuthn returns credential | Inline confirmation: checkmark + `onboarding.passkey.done` ("Passkey set on this device") + primary `onboarding.passkey.continue` ("Next: print your recovery sheet") | `role="status"` | n/a |
| **D.4 recovery passphrase — generate** | post-D.3 | Headline `onboarding.recovery.heading` ("Your recovery sheet"); body explains in plain English: "If you lose this device AND your passkey, the only way back into your account is the recovery passphrase below. There is no admin who can reset it. Print this sheet and store it somewhere safe and **not** at work."; a card with the printable layout (see D.5) embedded; primary `onboarding.recovery.print` ("Print recovery sheet"); secondary `onboarding.recovery.copy` (copy to clipboard with a warning that clipboard isn't a substitute for printing) | The passphrase is rendered in `typography.roles.code` at large size; pre-formatted for screen-reader to read each chunk separately | If `window.print()` unavailable → fallback text and instructions for using the browser's print menu |
| **D.4.print recovery passphrase — print layout** *(sub-step of D.4; was previously labelled "D.5" before the 2026-05-24 designer-pass labelling resolution)* | print stylesheet | Print-only layout (`@media print`): single page, no headers/footers, no app chrome. Max width `layout.max_width.recovery_sheet_print` (5.5in). Layout: (a) tribunal-style header `print.recovery.title` ("JHSC App — Recovery sheet for {display_name}") with date; (b) the passphrase rendered as `typography.roles.totp` (large mono) in five word-chunks separated by visible space; (c) the salt rendered as `typography.roles.hash` underneath, labelled; (d) below the passphrase, a single boxed warning paragraph: "If anyone has this sheet, they can recover your account on a new device. Treat it like a key. Do not store it at work."; (e) a footer with the URL of the app + the build hash | All print-only content uses serif `typography.family.serif` to differentiate from on-screen; high contrast (black on white only) | If browser blocks `window.print()` → user is shown the same layout on-screen with instructions to use system print |
| **D.5 session-revocation primer** *(NEW per ADR-0020 + designer-pass 2026-05-24 — canonical D.5 slot)* | post-type-back at D.6 success transitions here; OR directly during onboarding when the user wants to review existing sessions before completion | Headline `onboarding.sessions.heading` ("Sign out other devices?"); body explains in plain English: "If you've ever signed into this account on another phone or laptop, you can sign those sessions out now. This is optional. You can do it later from Settings."; renders `session_revocation_primer` (see §4.T19): a compact session list (variant of `table.sessions`) showing each known session row (device, OS/browser, last-seen, 'This device' badge); primary destructive button `onboarding.sessions.revoke_other.label` ("Revoke other sessions"); tertiary `onboarding.sessions.skip.label` ("Skip — I'll do this later"). Both advance to D.7 on click | Primary action follows §3.5 destructive-action pattern but **without** the per-record passphrase or 4-eyes gate (the user just authenticated their first passkey at D.3; re-auth is unnecessary). Action's `aria-describedby` links to a small helper count ("3 other sessions will be signed out"). If revoking the current session is somehow selected, surface §3.2's protected-modal pattern (this should not be reachable through the primer's controls — the primer pre-filters; defense-in-depth). Live region announces revocation success per `a11y.session.revoked` catalog key. | **empty** (only this device exists): list shows the single 'This device' row; primer copy explains there's nothing else to revoke; Skip becomes the only forward action (still navigates to D.7). **loading** (`revokeAllSessions` in flight): button enters `loading` state with `onboarding.sessions.revoking.label` ("Signing out other devices…"); list rows are interactive-disabled; F-39 contract pins ≤5s server propagation. **success**: toast `success` confirms count revoked; auto-advance to D.7 after 500ms (reduced-motion: immediate). **error**: inline `error_state.network` or `error_state.session_expired`; retry button replaces primary; Skip remains available so a network failure does not strand the user mid-enrollment. |
| **D.6 recovery passphrase — type-back verification** | post-print | Headline `onboarding.recovery.verify.heading` ("Type the passphrase back to confirm"); textarea input; the previously-shown passphrase is **not** visible on this screen (user must consult the printed sheet OR the hold-to-reveal control per Amendment F); primary `onboarding.recovery.verify.submit` ("Confirm"); on mismatch, error_state inline with attempt counter | The textarea is `aria-required="true"` and `aria-describedby` linked to the helper "Type the words exactly as printed, separated by spaces."; additionally `autocomplete="off"` and `spellcheck="false"` (per ADR-0020 threat-model delta T — defense against Chromium cloud-spellcheck plaintext-passphrase leak) | If 3 attempts wrong → return to D.4 (re-display the passphrase); F-08 mitigation requires the type-back; without verification the user cannot proceed |
| **D.7 done** | post-D.5 session-revocation-primer skip OR revoke-complete | Headline `onboarding.done.heading` ("You're set up"); `completion_summary` card (see §4.T19): icon `check-circle` (`icon.size.lg`) + summary listing — passkey set, recovery sheet printed-and-verified, browser supported, device flagged personal; below the summary, an informational block per ADR-0020 Decision 3.f naming where panic-wipe + sessions live for future need; primary `onboarding.done.continue` ("Open the app") | `role="status"` on the success card; the next-step pointer block is `role="region"` `aria-labelledby` pointing to its heading | n/a |

---

### Surface D.T19 — Onboarding wizard infrastructure (NEW — ADR-0020)

Wizard chrome + per-step infrastructure shared across D.1–D.7. Per ADR-0020 task 1, the architect's identified token gaps (`z_index.onboarding_overlay`, `motion.duration.step_transition`, `layout.max_width.recovery_sheet_print`) have been ratified and added to `design-tokens.json`. Implementers MUST bind every visual via these tokens; no magic values.

#### Surface D.T19.a — OnboardingFlow (wizard chrome)

Full-viewport wizard chrome rendered on first launch. Sits at `z_index.onboarding_overlay` (1550 — above tooltip 1500, below lock_screen 1600 + panic_overlay 1700, so idle-lock and panic-wipe correctly draw on top mid-flow).

| state | trigger | visible cues (tokens) | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **default (active step rendered)** | User is at any of D.1–D.7 | Full-viewport bg `color.{mode}.onboarding.wizard_chrome_bg`; max-width `layout.max_width.wizard_chrome` (640px) on desktop, full-width on mobile per layout pattern 5.4; top-aligned step indicator (7 pills, see D.T19.b); body area; sticky bottom action bar (Back/secondary on left, Continue/primary on right) — bar respects safe-area-inset-bottom on iOS Safari. Per-step transition opacity-only, `motion.per_surface.wizard_step_transition` (`duration.step_transition` = 320ms, easing `out`). | Wizard root is `role="region"` with `aria-labelledby` pointing to the current step's heading; `aria-live="polite"` region announces step change ("Step 3 of 7: Set up your passkey"); focus moves to first focusable in the new step on each transition; tab order is DOM-order. | n/a — every step has its own state matrix below. |
| **hover** | n/a at chrome level | n/a — hover lives on the per-step controls (button/input variants per existing component spec). | n/a | n/a |
| **focus-visible** | Tab into any control inside the chrome | Two-layer focus ring per `shadow.focus_ring`. | Skip-to-content link surfaces at top-left when focused (per §3.1). | n/a |
| **active** | n/a at chrome level | n/a | n/a | n/a |
| **disabled** | n/a — wizard chrome is never disabled (a baseline-block uses its own state below). | n/a | n/a | n/a |
| **loading (during a step's async)** | Any step's primary action triggers an async (D.3 passkey enroll, D.4 encryptRecoveryBlob, D.5 revokeAllSessions) | Sticky action bar's primary button enters `loading` per button component spec; chrome remains interactive for Back-button unless the operation explicitly forbids it (D.4 in mid-encrypt forbids Back; D.5 in mid-revoke forbids Back). | `aria-busy="true"` on the body region for the duration; live region announces the in-progress text (e.g., "Encrypting recovery blob…", per `a11y.onboarding.{step}.loading` keys). | If user attempts Back during a forbidden window → toast `warning` ("Please wait — the current step is finishing"). |
| **error (per-step)** | Per-step failure (network, crypto, baseline) | Inline `error_state` variant per the failure class — `network`, `crypto`, `permission`. The wizard chrome itself does NOT swallow the error; the step component renders the error inline above its own primary action. | `role="alert"` on the error block; focus moves to the error heading on first render. | Always present — every step has an error sub-state. |
| **success (per-step)** | Step's success advances to the next | Step transition fires per `motion.per_surface.wizard_step_transition`; step indicator advances (current → complete, next → active). | `role="status"` announcement per `a11y.onboarding.{step}.success`. | n/a |
| **empty** | n/a — wizard always has a current step. | n/a | n/a | n/a |
| **baseline_blocked** (terminal sub-state — not a step) | `D.3` runtime feature-detection OR `checkBrowserBaseline()` fails | Body replaces with a block-state card: heading `onboarding.browser.unsupported.heading` ("Your browser is too old"); `browser_baseline_badge` (fail variant) listing which checks failed; body lists supported browsers (Chrome 109+, Edge 109+, Firefox 122+, Safari 16+) per ADR-0002; secondary `onboarding.browser.unsupported.reload` ("Reload after switching browsers"); NO continue button. Step indicator freezes at D.3 (no advance, no complete). | Block-state card has `role="alert"`; focus moves to the heading. | This IS the error coverage for D.3 baseline. |

**Per-screen DOM contract (binding for implementer + test-writer):**
- Test scaffold requires `data-testid="device-fingerprint"` on D.1; `data-testid="onboarding-d2-body"` on D.2; `role="heading"` matches `/personal device/i` on D.1; `role="button"` matches `/personal device.*continue/i` and `/stop.*switch.*personal/i` on D.1; `role="button"` matches `/set up passkey/i` on D.3 (baseline pass); body text matches `/browser is too old/i` on D.3 (baseline fail).
- Step-indicator: `<ol>` with one `<li>` per step; current step has `aria-current="step"`; complete steps have `aria-label` ending "completed".
- Test-only props `__test_step` / `__test_user_agent`: per ADR-0020 Decision 8, source references via split-form (`'__test_' + 'step'`); runtime no-op when `MODE === 'production'`; build-time grep CI test asserts the literals are absent from the production bundle.

#### Surface D.T19.b — Step indicator

7-pill horizontal indicator on desktop; vertical condensed (current-step pill only + "Step 3 of 7" text) on mobile below `breakpoint.md`.

| state | visible cues (tokens) | a11y notes |
|---|---|---|
| **pending** | Bg `color.{mode}.onboarding.step_indicator_pending_bg`; fg `..._pending_fg`; border `border_width.step_indicator` `..._pending_border`; icon `circle-outline` (icon.size.sm); label in `typography.roles.caption` | `aria-disabled="true"`; `aria-label` "Step N, not yet reached" |
| **active** | Bg `..._active_bg`; fg `..._active_fg`; border `..._active_border`; icon `circle-filled`; label in `typography.roles.caption`, weight `semibold` | `aria-current="step"`; `aria-label` "Step N of 7, current" |
| **complete** | Bg `..._complete_bg`; fg `..._complete_fg`; border `..._complete_border`; **icon `checkmark` REQUIRED** in addition to color (color-blind safe per anti-pattern #3); label in `typography.roles.caption` | `aria-label` "Step N, completed" |
| **focus-visible** | Two-layer focus ring per `shadow.focus_ring` on any pill that becomes a click target (only complete pills are clickable for review-only re-visit) | Tab order matches DOM order |
| **hover** (complete pills only) | Slight darken via `color.{mode}.surface.hover`; cursor `pointer` | n/a |
| **active** (complete pills only — pressed) | `color.{mode}.surface.press` | n/a |
| **disabled** | Pending pills only — not clickable; cursor `default` | `aria-disabled="true"` |
| **loading** | When the wizard is in a per-step loading state, the active pill shows a small inline spinner overlay; reduced-motion: pill border thickens to `border_width.thick` instead of spinner | `aria-busy="true"` on the pill |
| **error** | When the active step is in error, the active pill bg shifts to `color.{mode}.state.danger_bg`, fg `state.danger`; icon `x-circle` | `role="alert"` is on the inline error block, not the pill; pill state is supportive only |
| **success** | Transient (250ms) — pill briefly highlights `..._complete_bg` then settles into the standard `complete` styling on next-step entry | n/a |
| **empty** | n/a — indicator always renders all 7 pills | n/a |

#### Surface D.T19.c — Device fingerprint card (D.1)

| state | visible cues (tokens) | a11y notes |
|---|---|---|
| **default** | `card.default` with bg `color.{mode}.onboarding.device_fingerprint_bg`; fg `..._fg`; border `..._border`; content rendered in `typography.roles.code`: UA string on line 1, platform on line 2. NEVER renders IP, geolocation, `Sec-CH-UA-Full-Version-List`, navigator.connection — per ADR-0020 §3.e. | `data-testid="device-fingerprint"`; `aria-label` "Browser information (this is what your browser tells the page; nothing here is sent to the server)" |
| **focus-visible / hover / active / disabled / loading / error / success / empty** | n/a — this is a read-only render of UA + platform; no interactive states. The card is a focusable element ONLY if the user can copy/inspect its text (per OS-native text-select); no app-level click handler. | n/a |

#### Surface D.T19.d — Recovery-blob download affordance (D.4 secondary)

| state | visible cues (tokens) | a11y notes | empty/loading/error coverage |
|---|---|---|---|
| **default** | `button.ghost` with fg `color.{mode}.onboarding.download_affordance_fg`; border `..._border`; icon `download` (icon.size.sm) + label `onboarding.recovery.download.label` ("Download encrypted recovery blob"); helper text below in `typography.roles.hint` per `onboarding.recovery.download.helper` ("This is the encrypted file. It is NOT the passphrase. Store it separately.") | Min target `touch_target.min`; `aria-describedby` to the helper text | n/a |
| **hover** | Per `button.ghost` hover tokens | n/a | n/a |
| **focus-visible** | Two-layer focus ring per `shadow.focus_ring` | n/a | n/a |
| **active** | Per `button.ghost` active tokens | n/a | n/a |
| **disabled** | Per `button.ghost` disabled tokens; only disabled while D.4 is still in the encryption phase | `aria-disabled="true"`; helper text updates to "Available once the recovery blob is ready" | n/a |
| **loading** | Spinner inline + label changes to `onboarding.recovery.download.preparing` ("Preparing download…") | `aria-busy="true"` | n/a |
| **error** | Toast `warning` ("Download blocked by the browser — the encrypted blob is still saved on this device"); button stays available for retry; the wizard does NOT block advancement (per ADR-0020 Decision 9 — download is opt-in) | `role="alert"` on the toast | Always present |
| **success** | Toast `success` ("Downloaded. Move this file off your device."); button label transiently switches to "Downloaded — download again" then settles | `role="status"` | n/a |
| **empty** | n/a — the affordance is always offered at D.4 | n/a | n/a |

#### Surface D.T19.e — Browser-baseline badge (D.3)

Inline status badge below the D.3 heading reporting which checks the runtime passed/failed.

| state | visible cues (tokens) | a11y notes |
|---|---|---|
| **pass** | Bg `color.{mode}.onboarding.browser_baseline_pass_bg`; fg `..._pass_fg`; border `..._pass_border`; icon `check` (icon.size.sm) + label `onboarding.baseline.pass.label` ("This browser is supported") | `role="status"` once on render; never color-only |
| **fail** | Bg `..._fail_bg`; fg `..._fail_fg`; border `..._fail_border`; icon `x-circle` + label `onboarding.baseline.fail.label` ("This browser is too old"); below the badge, a `<ul>` enumerates which sub-checks failed (`PublicKeyCredential` absent, `crypto.subtle` absent, `indexedDB` absent, `navigator.serviceWorker` absent, `crypto_pwhash` (libsodium) absent per ADR-0003 Amendment G) | `role="alert"`; sub-check list has `aria-label` "Failed checks" |
| **focus-visible** | Badge is not focusable; the supported-browsers links beneath it are focusable per standard button rules | n/a |
| **hover/active/disabled/loading/empty** | n/a — the badge is a read-only state indicator. | n/a |
| **error** | n/a — the fail state IS the error surface | n/a |
| **success** | n/a — covered by pass state | n/a |

#### Surface D.T19.f — Recovery-passphrase reveal pair (D.4 — composes RecoveryPassphraseScreen.svelte)

The on-screen passphrase rendering. Composes the existing `RecoveryPassphraseScreen.svelte` per ADR-0020 Decision 2.d. Per ADR-0003 Amendment F operational rule 5: largest typography token + highest-contrast pair.

| state | visible cues (tokens) | a11y notes | empty/loading/error coverage |
|---|---|---|---|
| **default (concealed; before any hold-to-reveal)** | The reveal region is collapsed; only the hold-to-reveal button is visible (existing surface owns the button). No passphrase in DOM. | `aria-live="polite"` region for "Hold the reveal button to show the passphrase" | n/a |
| **hold-in-progress** | Existing surface owns the press feedback (it owns the button); no token changes from the designer at this layer. | Existing handler | n/a |
| **revealed (transient — only while held)** | `<code>` element rendered in `typography.roles.totp`; fg `color.{mode}.onboarding.passphrase_reveal_fg` (foreground.primary); bg `..._reveal_bg` (background.primary); border `..._reveal_border` 2px (the load-bearing high-contrast pair — 16.1:1 / 15.2:1 light/dark); chunked into 5-word groups separated visually by `..._chunk_separator` foreground at reduced size | `role="region"` `aria-live="polite"` per existing component; the visible passphrase MUST NOT be inside an `<input>` (autocomplete/paste-history risk); the chunk separator MUST be visually-hidden in screen-reader output so SR reads the passphrase as a single string | n/a |
| **focus-visible** | Two-layer focus ring per `shadow.focus_ring` on the reveal control; inner line at 16.1:1 against `..._reveal_bg` is load-bearing per contrast audit | n/a | n/a |
| **hover / active / disabled** | Hold-to-reveal control owns these per existing surface; designer does NOT modify | n/a | n/a |
| **loading** | The audit-emit-before-reveal contract (Amendment F operational rule 2) means there IS a "preparing reveal" sub-state. Existing surface shows the helper text; designer adds: during this sub-state, the reveal region is NOT in the DOM (per M-54b — the passphrase is not in DOM until audit resolves ok). | Existing `role="status"` on helper | n/a |
| **error (audit failed)** | Existing surface fires danger toast; designer ratifies: toast uses `toast.danger` variant per §3.3 (manual dismiss only); the reveal region remains absent from DOM. | `role="alert"` per existing surface | Always present |
| **success** | n/a — "success" is the revealed transient state above | n/a | n/a |
| **capped (3 reveals consumed in this enrollment session)** | Existing surface owns the helper-text swap; designer ratifies: the reveal control becomes `aria-disabled="true"`; helper text per `onboarding.recovery.show_again.helper_capped` | `aria-disabled="true"` | Always present after 3rd reveal |
| **empty** | n/a — the surface always renders at D.4 | n/a | n/a |

**Forbidden affordances (per ADR-0003 Amendment F operational rule 4; static-lint enforced):** copy-to-clipboard control, SpeechSynthesis call, file-export of the plaintext, screenshot-friendly affordance, `<input>` rendering of the plaintext. None appear in any of the above states.

#### Surface D.T19.g — Session-revocation primer (D.5 — see also Surface H amendment)

Spec lives in the D.5 row of Surface D's table above. The primer is a constrained subset of Surface H's full session-listing surface; see "Surface H amendment" below for the cross-link.

#### Surface D.T19.h — Completion summary (D.7)

| state | visible cues (tokens) | a11y notes |
|---|---|---|
| **default** | `card.elevated` (variant); bg `color.{mode}.onboarding.completion_success_bg`; fg `..._success_fg`; border `..._success_border`; **icon `check-circle` (`icon.size.lg`) REQUIRED**; checklist of 4 lines (passkey set, recovery sheet printed-and-verified, browser supported, device flagged personal), each with its own check icon; below the card, an `alert_banner.info` strip linking to where panic-wipe + sessions live for future need (per ADR-0020 Decision 3.f) | `role="status"` on the card; the next-step pointer block is `role="region"` `aria-labelledby` to its heading |
| **focus-visible** | Two-layer focus ring on the "Open the app" primary button | n/a |
| **hover / active / disabled / loading / error / success / empty** | n/a — D.7 is a terminal render; only the primary action has interactive states (per `button.primary`) | n/a |

---

### Surface E — Photo capture (HG-5 / ADR-0011 amend)

| state | trigger | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **idle (capture button)** | Inspection or s.51 form has a photo-attach slot | Button variant `secondary` with camera icon + label `photo.capture.button` ("Add photo"); next to it a sub-label `photo.capture.advisory_inline` ("GPS removed automatically. Enter location as text or pick from the list.") | The advisory is in the SR DOM next to the button, not hidden | n/a |
| **capturing** | User clicks; browser opens camera (via `<input type="file" accept="image/*" capture="environment">`) | OS native camera UI; app shows a small loading spinner on return | Native UI is OS-native a11y | If camera unavailable → fallback to file picker; if file picker also fails → error_state |
| **preview (pre-encryption)** | Image returned from camera | Preview card showing the image at full width (capped by `max_width.content`); above the image, a `alert_banner.info` strip: `photo.preview.gps_advisory` ("All location and metadata has been removed from this photo. The location below — if you enter it — is what will be saved.") + an inline location free-text input labeled `photo.location.label` ("Location (optional, free text)") + a secondary select for `location_id` from the C1 enum; below the image, primary `photo.preview.attach` ("Attach this photo") and secondary `photo.preview.retake` | The advisory is `role="status"` once on render; the location input is `<input type="text" autocomplete="off">` with `inputmode="text"`; per HG-5, there is no "use my current location" button anywhere | If sanitize fails (canvas re-encode error) → error_state.crypto inline; user can retake |
| **attached** | User confirms; image is sanitized (EXIF strip + canvas re-encode per HG-5), encrypted, queued | Preview transitions to attached state: thumbnail + filename + size + status pill `status_pill.success` "Attached"; remove button (variant `ghost` with `aria-label="Remove photo"`) | thumbnail has `alt` populated from the location text if entered, else `photo.thumbnail.alt_unspecified` ("Inspection photo, no location text") | n/a |
| **upload error** | Sync fails | Status pill on the thumbnail changes to `status_pill.danger` "Upload failed — will retry on next sync"; the entry remains in queue | `aria-live="polite"` on the pill | Always |
| **integrity-fail** | HMAC verification fails on sync (F-44) | Thumbnail gets a `status_pill.danger` "Could not verify — re-enter"; the row is moved to a quarantine section; the user is shown a banner explaining what happened in plain English (a malicious extension may have modified the queue) | `role="alert"` | Always |

---

### Surface F — Offline state (ADR-0013 / ADR-0014)

| state | trigger | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **online (no banner)** | `navigator.onLine === true` AND last sync succeeded | No offline banner; status pill in top-right header shows `status_pill.success` "Synced {relative time}" | Pill has `aria-label` with absolute time | n/a |
| **offline (banner shown)** | `navigator.onLine === false` OR last sync failed | Persistent `alert_banner.offline` strip pinned below top header: icon=cloud-off + text `offline.banner.heading` ("Offline — entries are being queued") + queued count + a "Retry sync" button | The banner is `role="status"` and remains visible until online; queued count is updated in place with `aria-live="polite"` | n/a |
| **queuing** | A write happens while offline | Inline toast `info` ("Queued — will sync when online"); the queued count in the offline banner increments | `role="status"` | n/a |
| **syncing** | App regains connectivity; service worker drains queue | Banner switches to `alert_banner.info`: icon=cloud-up + text `offline.syncing.heading` ("Syncing… {n} of {total}"); determinate progress bar inside the banner | `aria-busy="true"` on the banner; progress bar has `role="progressbar"` | If any item fails HMAC verification (F-44) → see "sync result" below |
| **sync result (success)** | Drain completes; all items verified | Banner transitions to `alert_banner.success` for `motion.duration.slow`, then disappears; toast `success` ("All queued entries synced.") | `role="status"` | n/a |
| **sync result (partial fail)** | Some items failed (HMAC or server) | Banner becomes `alert_banner.warning`: "{n} synced, {k} failed verification — these entries could not be saved and must be re-entered"; list link opens a detail surface | `role="alert"` | Always; lists the failed items with reason |

---

### Surface G — Lock / panic-wipe (T2 / T6 + ADR-0020 T19 amendments)

> **AMENDMENT (designer's pass 2026-05-24, per ADR-0020 T19):** the panic-wipe modal is canonicalized as `PanicWipeModal` (free-standing component in `lib/lock/`, mounted at the app-shell level; NOT inside OnboardingFlow per ADR-0020 Decision 2.c). The F-53 destructive_confirm contract is binding: (a) `ready_delay_ms` gate (default 200ms) — primary button does not accept activation before `ready` resolves; (b) literal-phrase input is keystroke-gated (does not accept any input) before `ready`; (c) Escape during the ready-delay transition does NOT dismiss (consistent with §3.2 no-Escape-dismiss list); (d) the wipe is LOCAL-ONLY (IndexedDB + service-worker caches + sessionStorage + localStorage + session cookie + in-memory libsodium buffers) per ADR-0020 Decision 5 and user adjudication 2026-05-24; no server-side cascade. The `panic_wipe.invoked` audit row MUST be written BEFORE any wipe side-effect (audit-before-side-effect per F-53). On partial failure, the audit row's `meta.partial_failure_classes` enumerates the failed subsystems; the in-progress overlay transitions to an error_state listing what was and was not cleared. The user is told to close the tab + re-install or seek help. New T19-specific state rows are added below the original lock/panic table.

| state | trigger | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **lock-screen (auto)** | Idle timeout (per ADR-0008, 15 min default) OR tab regains focus after blur and timeout expired | Full-viewport overlay at `z_index.lock_screen`; centered card: headline `lock.heading` ("Locked — confirm it's you to continue"); body explains "Your committee data is protected and was cleared from memory."; primary button `lock.button.unlock` ("Use passkey"); secondary `lock.button.signout` ("Sign out instead") | Focus traps to Use passkey button; the overlay is `role="dialog"` with `aria-modal="true"` and `aria-labelledby` pointing to the headline | If WebAuthn fails → inline error_state with retry; after 3 fails → sign out and return to enrollment selection |
| **lock-screen (manual)** | User clicks "Lock now" in settings | Same as auto-lock | Same | Same |
| **panic-wipe trigger** | User clicks "Wipe this device's data" in settings | `destructive_confirm` modal opens | n/a | n/a |
| **panic-wipe confirm** | Modal | Headline `panic.heading` ("Wipe this device's data"); body lists in plain English what will be removed: encrypted IndexedDB store, session, cached settings; warns that wiping does NOT remove the data from the server (other devices and the committee retain their access); requires the user to type the literal word "WIPE" into a text input; Cancel + Wipe buttons (Wipe variant `destructive`, disabled until the word matches case-insensitive) | Text input is `aria-required="true"`; the Wipe button has `aria-describedby` pointing to the required-phrase hint | n/a |
| **panic-wipe in progress** | User clicks Wipe with phrase typed | Full-viewport overlay at `z_index.panic_overlay`; centered: spinner + heading `panic.wiping.heading` ("Wiping…"); no controls | `aria-busy="true"`; SR announces "Wiping local data" | If wipe partial-fails → error_state with details; user is told what was and wasn't wiped |
| **panic-wipe complete** | IndexedDB cleared, session torn down, service-worker caches purged | Page redirects to a fresh login surface; toast `success` ("Local data wiped. Sign in again to continue, or close this tab to leave the app.") | `role="status"` | n/a |
| **panic-wipe ready-delay-pending** *(NEW per ADR-0020 / T19)* | Modal just opened; `ready` promise in flight (default 200ms) | Modal is visible; primary `Wipe` button is `aria-disabled="true"`; literal-phrase input is rendered but its keystroke handler is gated — input value remains empty even if user types; helper text per `panic.readydelay.helper` ("Preparing…") | `aria-busy="true"` on the modal body; `role="alert"` is NOT yet attached (no destructive state to announce yet); Escape keydown is captured by the modal but does NOT dismiss | n/a — this is a short transient |
| **panic-wipe ready (awaiting phrase + click)** *(NEW per ADR-0020 / T19)* | `ready` resolved; literal-phrase input now accepts keystrokes; primary button still disabled until phrase matches (case-insensitive) | Standard `destructive_confirm` styling; primary button enables when input value matches "WIPE" case-insensitive | `aria-required="true"` on the literal-phrase input; primary button `aria-describedby` to the required-phrase hint; Escape continues to NOT dismiss (this is the §3.2 protected variant) | n/a |
| **panic-wipe in progress overlay** *(NEW per ADR-0020 / T19 — replaces the prior "panic-wipe in progress" row with full token binding)* | Full-viewport overlay at `z_index.panic_overlay` (1700); bg `color.{mode}.onboarding.panic_overlay_bg` (rgba near-black, 0.92 light / 0.94 dark); fg `..._panic_overlay_fg`; centered spinner + heading `panic.wiping.heading` ("Wiping…") in `typography.roles.section`; no other controls; on this surface the focus ring uses the INVERTED two-layer construction per the design-tokens contrast audit (outer `fbbf24` 13.1:1 carries visibility; inner uses `..._panic_overlay_fg` rather than `border.focus`) | `aria-busy="true"`; SR announces `a11y.panic.in_progress` ("Wiping local data — do not close this tab"); focus is trapped inside the overlay; reduced-motion: spinner replaced by static "Wiping…" text + indeterminate progress bar per `motion.per_surface.spinner_rotate` reduced-motion rule | If wipe partial-fails → transitions to `panic-wipe partial-failure` (new row below); if total-fail before any side-effect → modal returns to ready state with `error_state.crypto` inline |
| **panic-wipe partial-failure** *(NEW per ADR-0020 / T19)* | One or more `WipeStore` clear* calls returned `{ok: false}` after the audit row was committed | Overlay transitions to error_state: heading `panic.partial_failure.heading` ("Wipe partially completed"); enumerated list of which subsystems were and were not cleared (read from `meta.partial_failure_classes`); body explains in plain English what to do ("Close this tab, then uninstall and reinstall the app from your home screen. Contact the worker co-chair if anyone is around to help."); single primary `panic.partial_failure.close` ("Close this tab") | `role="alert"` on the error heading; SR announces `a11y.panic.partial_failure`; focus moves to the error heading | This IS error coverage |

---

### Surface H — Session listing (F-39 / T05 + ADR-0020 T19 amendments)

> **AMENDMENT (designer's pass 2026-05-24, per ADR-0020 T19):** D.5 of the onboarding wizard (`Surface D.T19.g`) renders a **constrained subset** of Surface H — the "session-revocation primer". The primer is its own component (`SessionRevocationPrimer.svelte`, see `components_extended.session_revocation_primer` in `design-tokens.json`) and intentionally LACKS Surface H's per-row Revoke buttons + Revoke-all destructive_confirm; the primer offers ONLY "Revoke other sessions" (one bulk action) + "Skip — I'll do this later". The data source is the same `listSessions` library call as Surface H. Once the user is past D.7, Surface H proper is the canonical session-management surface (Settings → Sessions). The primer is read-only-presentation + one bulk action; Surface H is full per-row management. Implementer MUST NOT duplicate logic — the primer composes the same `table.sessions` markup with a `density.compact` override and a `__role="primer"` prop that hides the per-row Revoke buttons. The current-session badge ("This device") is rendered identically in both surfaces.

| state | trigger | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **list (one or more sessions)** | User opens Settings → Sessions | `table.sessions` (uses `density.compact` on desktop, `density.comfortable` on mobile with stacked rows); each row shows: device fingerprint, OS / browser, last-seen (relative + absolute on hover), location-hint NONE (we do not collect IP geolocation), current-session badge, "Revoke" button | Current session is identified with `status_pill.info` "This device"; revoking the current session shows a confirmation that signs the user out | If only one session → still list it; user can revoke (signs out) |
| **revoking (per row)** | User clicks Revoke | That row's Revoke button enters `loading` state; row is otherwise interactive-disabled | `aria-busy="true"` on the row | If revoke fails → inline error_state in that row; Retry button replaces Revoke |
| **revoked** | Server confirms; jti invalidated | Row updates: device pill → `status_pill.neutral` "Revoked {ts}"; Revoke button removed; toast `success` confirms; if it was the current session, user is signed out and the lock screen appears immediately | `role="status"` on the toast | n/a |
| **revoke all** | User clicks "Revoke all other sessions" | `destructive_confirm` modal: lists each session that will be revoked; Cancel + Revoke all buttons | n/a | n/a |
| **error** | RLS denial, network | `error_state` inline | `role="alert"` | Always |

---

### Surface I — Audit log feed

| state | trigger | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **list (events present)** | User opens Audit log surface | `table.audit_feed` with `density.compact`; columns: timestamp (absolute), actor display name, action enum value (mapped to plain-language label in i18n catalog), target type + truncated ID, prev_hash (mono, truncated to 8 chars with "show full" affordance); filter bar above for action-type and time range; export-events are visually highlighted with `alert_banner.warning` row-tint; C4 events with `alert_banner.sensitive_c4` row-tint | Each row is `role="row"`; truncated hashes have `title` and `aria-label` with full hash | If zero events in the filter window → empty_state |
| **expanded row** | User clicks a row | Inline expand showing full prev_hash, full target_id, any additional fields (e.g., `derived_from_concerns` for exports, `field_set_hash` for export integrity); copy buttons for each hash | Expanded content is `role="region"` with `aria-labelledby` to the row | n/a |
| **integrity check status** | Header strip above the table | `alert_banner.success` if the last daily integrity check succeeded; `alert_banner.danger` if it failed; shows last-check timestamp | `role="status"` for success, `role="alert"` for failure | If never run yet → `alert_banner.info` with explanation |
| **streaming new event** | Server emits a new audit event | New row inserts at the top with the same momentary highlight pattern as the sensitive-read feed (reduced-motion: no highlight, just appears) | `aria-live="polite"` region announces "New audit event: {action} by {actor}" | n/a |
| **error** | Stream failure, RLS denial | `error_state` inline | `role="alert"` | Always |

---

### Surface J — `/redeem` member invite redemption (ADR-0029 P1-7 / §3.18 F-168–F-177)

> **Status:** Designer pass 2026-06-23. Blocked on accessibility-specialist sign-off before commit. **Authoring agent:** designer. **Inputs:** `supabase/functions/redeem-invite/core.ts` (the normalized-error contract), `apps/web/src/routes/bootstrap/+page.svelte` (the ceremony to mirror), `apps/web/src/routes/sign-in/+page.svelte` (the idle/submitting/error/success machine to mirror), `apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte` (the TOTP-input pattern), `.context/decisions.md` ADR-0029 Decision 2b/6, `.context/threat-model.md` §3.18 F-170/F-176.

The unauthenticated, **repeatable** sibling of Surface-less `/bootstrap`. A brand-new member opens the redeem link (`/redeem?invite_id=…` — the link carries `invite_id` ONLY; the 6-digit code is member-ENTERED, never in the URL, F-170/F-176), enters their one-time code + TOTP, and runs the WebAuthn **registration** ceremony to bind their first passkey and activate their pending membership. On success it hands off to `/sign-in` (the member then signs in, enrolls identity + recovery via the reused Phase-0a children, and lands in the P1-9 "waiting for committee access" holding state — that holding state is a separate surface, NOT part of `/redeem`).

This is the first impression for a new committee member of an E2EE safety-reporting tool. Visual + interaction language is **near-identical** to `/bootstrap` (the ceremony) and `/sign-in` (the state machine): same single-card centered layout (layout pattern 5.4 interstitial; max-width `layout.max_width.form`), same two-layer AODA focus ring, same `role="status"`/`role="alert"` tinted panels, same `aria-busy` on the ceremony container. It is NOT a wizard — there is no step indicator; it is one card with one form and the in-flight/terminal states layered on it. **No new tokens.**

**Layout:** centered single card, `card.default` (`color.surface.raised` bg, `color.border.subtle` 1px, `shadow.sm`), max-width `layout.max_width.form` (560px), centered on desktop / full-width with `layout.gutter.mobile` on mobile; vertical rhythm `spacing.5`/`spacing.6`; comfortable density (`density.comfortable`, control height ≥ `touch_target.min`). Title `typography.roles.title`; intro/body `typography.roles.body` (`color.foreground.secondary`); the single 6-digit code field uses the `input.totp_code` spec; primary action `button.primary` full-width on mobile. Page is `noindex,nofollow` (mirror `/sign-in`).

> **Amendment A-7.5 (2026-06-23) — ONE field, not two (supersedes the two-field code-entry row below).** The redeem form has a SINGLE member-entered secret: the 6-digit `totp_code`. The `invite_id` arrives in the link query (`/redeem?invite_id=…`) and is NOT secret — per the merged redeem EF contract (`supabase/functions/redeem-invite/core.ts:196,287,328`: `buildRedeemLink` carries only `invite_id`; `handleRegister` reads only `totp_code`). Drop the `redeem.code_label`/`redeem.code_helper` field; keep only the `redeem.totp_label`/`redeem.totp_helper` (rendered `typography.roles.totp`). Initial focus lands on that single field. The `challenge` POST carries only `{action,rpId,origin}` (no `invite_id`/code); `invite_id` + `totp_code` go on `register` only.

| state | trigger | visible cues (tokens) | a11y notes | recovery path |
|---|---|---|---|---|
| **code-entry (initial)** | Member opens `/redeem?invite_id=…`; `state='idle'` | Card with title `redeem.title` ("Join your committee"); intro `redeem.intro`; two stacked fields — (1) **invite code** `input.text` (`redeem.code_label`, helper `redeem.code_helper`), (2) **one-time code / TOTP** `input.totp_code` rendered in `typography.roles.totp` (large mono, tabular) mirroring D3PasskeyEnrollment; primary `button.primary` `redeem.button.idle` ("Create my passkey"). Field gap `density.comfortable.form_field_gap`. Labels above per `components.form.label_position`. Required indicator per `components.form.required_indicator`. | `<form>` wraps both fields so submit-on-Enter works; each input has a visible `<label for>` + `aria-describedby` to its helper; the ceremony container carries `aria-busy="false"`. Initial focus on the **invite-code** field on mount. | n/a — entry state |
| **requesting-challenge** | Submit; `state='requesting_challenge'`; POST `{action:'challenge', invite_id, rpId, origin}` | Primary button enters `loading`: inline spinner (`motion.per_surface.spinner_rotate`, reduced-motion → static text) + label `redeem.button.requesting` ("Starting…"); both inputs `disabled` (`input.disabled`); no error panel. | `aria-busy="true"` on the ceremony container; live region (`role="status"`) announces `a11y.redeem.requesting`. Focus stays on the (now-disabled→) button; do NOT move focus into the OS dialog (browser owns it). | If challenge fails (503 `service_unavailable` / `issue_failed`) → **system-error** state below |
| **awaiting-ceremony** | Challenge OK; `navigator.credentials.create(...)` in flight | Card persists; small waiting note `redeem.waiting` ("Follow your device's prompt to create your passkey…"); OS WebAuthn dialog draws over the page (browser-owned scrim). Spinner continues. | `aria-live="polite"` on the waiting note (mirror Surface D.3 in-progress + `/bootstrap` "Follow your device prompt"). The explainer text is rendered BEFORE the OS prompt opens so SR users hear what is about to happen (see §3.1). | User-cancel of the OS prompt → **cancelled** state below |
| **verifying / registering** | `credentials.create` resolved; `state='verifying'`; POST `{action:'register', …verified attestation…}` | Spinner + label `redeem.button.verifying` ("Setting up your account…"); inputs stay disabled. | `aria-busy="true"`; `role="status"` announces `a11y.redeem.verifying`. | If register fails → mapped error state below (normalized / rate-limited / system) |
| **success** | EF returns `{ok:true, user_id}`; `state='ok'` | Replace the form with a `state.success`-tinted confirmation panel (`color.state.success_bg` / `success_fg` / `success_border`) carrying a **check icon + text** (color never alone, anti-pattern 3): heading `redeem.success.heading` ("You're in — passkey created"); body `redeem.success.body` (explains: passkey is on this device; next step is sign in; you'll then set up a recovery passphrase and wait for your co-chair to grant access); primary `button.primary` link to `/sign-in` (`redeem.success.cta` "Sign in now"). `user_id` is NOT shown to the member (unlike `/bootstrap`, which is operator-only — a member never needs the raw uid; F-176 keep it out of the visible UI). | Focus moves to the success heading (`tabindex="-1"`) on transition; panel is `role="status"`. The CTA is a real `<a href="/sign-in">` so it is keyboard + SR operable. | n/a (forward to `/sign-in`) |
| **redeem-invalid (normalized failure)** | EF returns `{error:'redeem_invalid', status:422}` — covers consumed / expired / non-existent invite AND every TOTP condition (wrong / expired / locked / consumed / not-found); `state='error'` | **One** `error_state`-style `alert_banner.danger` (`color.state.danger_bg`/`danger_fg`/`danger_border`, left-border `border_width.c4_stripe` per `alert_banner`) with **X-circle icon + text**: heading `redeem.error.invalid.heading` ("That code didn't work"); body `redeem.error.invalid.body` — single message that does NOT distinguish invite-vs-TOTP-vs-expired-vs-locked (F-169/F-170 oracle defense); the recovery sentence points to the P1-6 re-send path ("ask your co-chair to send you a new code"). Both inputs re-enabled and retained (code field is NOT cleared — let the member fix a typo; F-176 the code is never echoed to logs/URL but stays in the field). Primary button returns to `redeem.button.idle`. | `role="alert"` on the banner; banner `id` is referenced by both inputs' `aria-describedby` (appended to the helper id list) so an SR user re-focusing a field hears the error. Focus moves to the error heading on transition. | Member fixes the code and resubmits; OR contacts co-chair for a re-send (P1-6). The copy MUST NOT promise "try again" will succeed if the invite is actually consumed/expired — it offers BOTH paths. |
| **rate-limited** | EF returns `{error:'rate_limited', status:429}` (per-IP throttle, F-175) | `alert_banner.warning` (`color.state.warning_bg`/`warning_fg`/`warning_border`) with **clock/alert icon + text**: heading `redeem.error.rate_limited.heading` ("Too many tries"); body `redeem.error.rate_limited.body` ("Wait a few minutes and try again. If this keeps happening, ask your co-chair to send a new code."). Primary button disabled briefly is OPTIONAL; default is re-enabled so the member can wait then retry. | `role="alert"`; focus to heading. | Wait + retry; or co-chair re-send |
| **cancelled (user dismissed OS prompt)** | `credentials.create` rejected with `NotAllowedError`/`AbortError`, OR returns null; `state='cancelled'` | `alert_banner.info`/neutral tint (mirror `/sign-in` cancelled — polite, user-initiated): `redeem.cancelled` ("Set-up cancelled. Press Create my passkey when you're ready."). Form re-enabled; inputs retained. | `role="status"` (polite — user did this on purpose; do NOT use assertive `alert`). Focus returns to the primary button. | Re-press primary |
| **webauthn-unsupported** | `typeof PublicKeyCredential === 'undefined'` at submit (feature-detect BEFORE the challenge call, mirror D3) | `alert_banner.danger` with icon + text: `redeem.error.unsupported.heading` ("This device can't create a passkey") + body `redeem.error.unsupported.body` ("Use a different personal device, or ask your co-chair for help."). Primary button hidden or disabled (no point retrying on this device). | `role="alert"`; focus to heading. | Switch device / contact co-chair |
| **system-error** | 503 `service_unavailable` (key-parity / challenge issue), 401 `origin_rejected` / `registration_invalid`, 500 `redeem_failed`, 400 `bad_request`, or any unexpected throw; `state='error'` | `error_state.network`/generic `alert_banner.danger` with icon + text: `redeem.error.system.heading` ("Something went wrong") + body `redeem.error.system.body` ("This is on our side, not you. Try again in a moment. If it keeps happening, contact your co-chair."). NEVER echo the raw `error` enum to the member (F-176); map to this one generic copy. Primary returns to idle. | `role="alert"`; focus to heading. | Retry; co-chair escalation |

**State-machine seam to `/sign-in`:** `/redeem` terminates at **success**; it does NOT itself run sign-in, identity-enroll, recovery, or the holding state. The success CTA navigates to `/sign-in`. Implementer note: this is a hard seam — the redeem ceremony is registration (`navigator.credentials.create`), the next ceremony is assertion (`navigator.credentials.get`) and lives on `/sign-in`; do NOT chain them in one route.

**Empty/loading/error per the Common state matrix:** there is no list, so no "empty" in the list sense; the code-entry state IS the resting state. Loading = requesting-challenge / awaiting-ceremony / verifying (each names its literal action per the matrix rule — never bare "Loading…"). Error = the four error rows above. Success = the success row. All four matrix rows are covered.

---

### Surface K — `/committee` co-chair route (ADR-0029 P1-8 / Amendment A-8 / §3.18 F-178–F-181)

> **Status:** Designer pass 2026-07-08 — **this pass scopes ONLY the read-only roster + the route shell + nav + role-gate (P1-8b).** Blocked on accessibility-specialist sign-off before commit. **Authoring agent:** designer. **Inputs:** `.context/decisions.md` Amendment A-8 (A-8.1 roster-read columns/gate/order/null-PI, A-8.4 the 5 screens + Surface K + `committee.*` i18n + roster-read role-gate, A-8.5/A-8.7 sub-PR sequence); `apps/web/src/lib/committee/supabase-committee-client.ts:112-229` (the `RosterRow`/`PendingInvite` shapes + `listRoster`/`listPendingInvites` — already built in P1-8a); `apps/web/src/routes/concerns/+page.svelte` + `apps/web/src/routes/reprisal/+page.svelte` (the signed-out / loading / session-expired / error / empty / list state ladder + stacked-row layout to mirror); `apps/web/src/routes/more/+page.svelte` (the `/more` link-row the route hangs off); `apps/web/src/lib/ui/BottomTabBar.svelte` (NOT touched — /committee is a `/more` entry, not a fixed tab); `apps/web/src/lib/auth/jwt-claims.ts` (there is NO committee-role claim in the JWT — GoTrue issues bare `authenticated`, so the ONLY co-chair signal is the roster read itself).

**Surface-K umbrella (what this surface will eventually host — only the roster is fully spec'd here).** `/committee` is the co-chair member-management surface. Amendment A-8.4 pins **five** screens onto it, shipped as separate sub-PRs. This designer pass lays the umbrella (route shell, nav entry, role-gate, `committee.*` namespace) and fully specifies **only screen 1, the read-only roster (P1-8b)**. The other four get their own designer passes when their sub-PRs land:

- **Screen 1 — Roster (P1-8b, THIS PASS).** Read-only member list with grant-state badges. Role-gated by roster-read denial.
- **Screen 2 — Invite + one-time-code display (P1-8c).** `issueInvite`; the 6-digit code shown ONCE from the in-memory EF response (F-176); the pending-invite management list (B2 `listPendingInvites`) lives here. *Later designer pass.*
- **Screen 3 — Grant-access + F-172 fingerprint confirm (P1-8d).** `getMemberPubkey` → out-of-band fingerprint compare → `wrapMemberInViaProduction` (single-disclosure refactor A-8.6). Depends on the P1-9-fingerprint slice. *Later designer pass.*
- **Screen 4 — Re-send code (P1-8c).** `reissueTotp`; fresh code, same in-memory-once custody. *Later designer pass.*
- **Screen 5 — Role-change / remove (P1-8e).** 4-eyes governance (`setRoles`/`removeMember`/`reactivateMember`), `second_approver_id`, `last_co_chair` block, self-approve prevention. *Later designer pass.*

The umbrella note exists so the later sub-PRs slot in without a Surface-letter reshuffle. **Nothing below commits a token, layout, or copy key for screens 2–5** beyond reserving the `committee.*` namespace.

**Route shell + nav (P1-8b).** `/committee` is an authenticated route under the **app shell** (layout pattern 5.1) — sticky top header, `<main>` content, mobile bottom tab bar present but UNCHANGED (A-8.4: /committee hangs off `/more`, NOT the fixed 4-tab bar). Discovery is a single **`.more-link` row** added to the `/more` launcher's **Account** group (`more/+page.svelte:182-211`), styled identically to its siblings: `<strong>` label + `<span>` blurb, full-width padded link row (`--color-bg-elevated` bg, `1px --color-border`, `--radius-md`, hover `--color-muted`). Per the `/more` philosophy (`more/+page.svelte:19-27` — "Role visibility is NOT enforced in the markup; every signed-in member sees every link"), the /committee link is shown to **every signed-in member**; a non-co-chair who taps it lands on the **not-a-co-chair stop** state below (the friendly "you don't have access to this yet" the `/more` page already promises). No BottomTabBar change; no header-nav change.

**Role-gate (P1-8b) — the load-bearing mechanism.** There is NO committee-role in the JWT (`jwt-claims.ts:39-42` — `role` is the GoTrue `authenticated` literal, never a committee capability). The ONLY co-chair signal is the roster read: the page calls `committeeClient.listRoster()` on mount; A-8.1's RPC RAISEs `rls_denied` (ERRCODE 42501 → **403**) for a non-co-chair, and the client surfaces `{ ok:false, reason:'rls_denied', status:403 }`. The route maps that 403 to the **not-a-co-chair stop** (an EXPECTED authz outcome, not an error). A `401` maps to **session-expired**. Success (`{ ok:true, data: RosterRow[] }`) renders the roster. This mirrors the concerns/reprisal state ladder exactly, with the not-a-co-chair stop as the one Surface-K-specific addition.

**Layout.** Single `card.default` section (`.card` — `color.surface.raised` bg, `color.border.subtle` 1px, `shadow.sm`, `radius.default`), inside the 5.1 app-shell `<main>` (max-width `layout.max_width.content` ≈ 48rem, gutter `layout.gutter.mobile`). Title `typography.roles.section` (app.css `h1`). The roster is a **semantic list** of stacked rows (`<ul>`/`<li>`, mirroring `.con-list`/`.rep-list`) using the `table.list_mobile_stacked` realization + `table.sessions` row chrome; **comfortable density** (`density.comfortable`, `row_gap` 0.75rem). Per-row layout is READ-ONLY in P1-8b — rows are NOT interactive (no click target); the per-row grant/role affordances arrive with screens 3/5 and will introduce the ≥44px per-row targets then. Page is `noindex,nofollow` (mirror concerns/reprisal `<svelte:head>`).

| state | trigger | visible cues (tokens) | a11y notes | recovery path |
|---|---|---|---|---|
| **signed-out gate** | `!$isSignedIn` (no JWT in-memory); mount short-circuits BEFORE any `listRoster()` call | Single `role="status"` line mirroring `concerns-signed-out`: a sign-in prompt `committee.roster.signed_out` linking to `/sign-in`. No roster chrome rendered. `data-testid="committee-signed-out"`. Tint: plain body (`color.foreground.primary`), link `color.accent`. | `role="status"` (polite — the user simply isn't signed in yet, not an error). The `<a href="/sign-in">` is a real link, keyboard + SR operable. | Follow the sign-in link |
| **loading** | Mount; `listRoster()` in flight; `listLoading=true` | `role="status"` line with the **literal action** `committee.roster.loading` ("Loading the committee roster…") — never bare "Loading…" (Common-matrix rule). Spinner OPTIONAL per `motion.per_surface.spinner_rotate` (reduced-motion → static text only). `data-testid="committee-loading"`. Text `typography.roles.body`, `color.foreground.secondary`. | `aria-busy="true"` on the roster container while loading; the loading line is a `role="status"` live region announcing the literal action. | n/a — transient |
| **not-a-co-chair stop** | `listRoster()` → `{ ok:false, reason:'rls_denied', status:403 }` | **NOT a red error panel — this is an expected authz outcome.** A calm `alert_banner.info` strip (`color.state.info_bg`/`info_border` → `--color-tint-blue-*`) with **info icon + text** (color never alone): heading `committee.roster.not_co_chair.heading` ("This area is for co-chairs") + body `committee.roster.not_co_chair.body` ("The committee roster and member management are available to worker co-chairs. If you think you should have access, ask your co-chair."). A single secondary link back to `/more` (`committee.roster.not_co_chair.back`). NO retry button (retrying will not change the answer). `data-testid="committee-not-co-chair"`. | **`role="status"` (POLITE), NOT `role="alert"`** — a coerced or curious member hitting a screen they're not entitled to must not be alarmed; this is a normal boundary, announced calmly. Focus is NOT force-moved (the page simply renders the stop). Info icon is `aria-hidden`; the heading text carries the meaning. | Back to `/more`; ask co-chair out-of-band |
| **session-expired** | `listRoster()` → `status === 401` (JWT invalid/expired at the EF auth boundary, OR `onSessionRevoked` fired) | `role="alert"` line mirroring `concerns-session-expired`: `committee.roster.session_expired` linking to `/sign-in`. `alert_banner.danger`-adjacent treatment is NOT required — mirror the concerns route's plain `role="alert"` sign-in prompt. `data-testid="committee-session-expired"`. | `role="alert"` (assertive — the session died mid-use; re-auth is required now). Sign-in `<a>` is the recovery target. | Re-authenticate via `/sign-in` |
| **error** | `listRoster()` → any other failure (500 / network / unexpected `reason`); `listError` set | Generic `alert_banner.danger` (`color.state.danger_bg`/`danger_fg`/`danger_border` → `--color-tint-red-*` / `--color-destructive`) with **X-circle icon + text**: heading `committee.roster.error.heading` ("Couldn't load the roster") + body `committee.roster.error.body` ("Something went wrong on our side. Try again in a moment."). Primary **Retry** button (`button.primary`, ≥`touch_target.min`) re-runs `listRoster()`. NEVER echo the raw `reason` enum (F-176 posture). `data-testid="committee-list-error"`. | `role="alert"`. Retry `<button>` is a tab stop (Tab + Enter/Space). Icon `aria-hidden`; heading carries meaning. | Retry; if persistent, contact support (no PI in the message) |
| **empty** | `listRoster()` → `{ ok:true, data: [] }` (degenerate — a co-chair reading the roster is themselves a member, so this should never occur in practice; still handled) | `empty_state` block: icon (`icon.size.lg`, `color.foreground.tertiary`), heading `committee.roster.empty.heading` ("No members yet"), body `committee.roster.empty.body` ("Once members are invited and join, they'll appear here.") in `typography.roles.body`, max-width `layout.max_width.prose`. The section chrome (title, back link) STILL renders around it. `data-testid="committee-empty"`. | `role="status"` on initial mount, inert thereafter (Common-matrix empty rule). | n/a (chrome remains; invite flow arrives in P1-8c) |
| **roster list** | `listRoster()` → `{ ok:true, data: RosterRow[] }` with ≥1 row | `<ul data-testid="committee-roster-list">` of stacked `<li>` rows (`.con-row`-equivalent: `--color-bg-elevated` bg, `1px --color-border-strong`, `--radius-md`, padding `spacing.4`, gap `density.comfortable.row_gap`). Rows render in the server's pinned order (A-8.1: `active DESC, display_name NULLS LAST` — active members first, nameless rows sink within each group). Per-row layout below. | The list is a `<ul>` with `aria-label` = `committee.roster.list_aria` ("Committee members"). Each `<li>` KEEPS its implicit `listitem` role; a **wrapper `<div>` INSIDE the `<li>`** carries `role="group"` + `aria-labelledby` → its own name element, so an SR reads each member as one unit (name → roles → status badge → dates) while the `<ul>`/`<li>` list structure stays axe-valid. (Resolved during P1-8b build: `role="group"` placed directly on the `<li>` strips the implicit `listitem` role and fails axe's `list` structure rule — the wrapper-div realization is the axe-clean form.) Rows are NON-interactive in P1-8b (no tab stop). | n/a — resting state |

**Per-row layout (roster list state).** Each `<li>` renders, top to bottom:

1. **Name** (`typography.roles.subsection`, `color.foreground.primary`) — `display_name` when present. When `display_name` is NULL (LEFT JOIN yields no `users` PI, A-8.1), render the fallback `committee.roster.row.unnamed` ("Member — no name on file") in `color.foreground.secondary`, PLUS a monospace short-uid disambiguator (`user_id.slice(0,8)`, `typography.roles.code` / `--font-mono`, `color.foreground.muted`) so two nameless rows are distinguishable and still map to a uid for later governance ops. The disambiguator is keyed off the **stable `user_id`** (never a blank cell, never a crash — A-8.1 pinned requirement).
2. **Grant-state badge** (the badge taxonomy table below). One badge per row.
3. **Roles** (`typography.roles.small`, `color.foreground.muted`) — `roles[]` mapped through `committee.roster.role.<role>` and comma-joined (e.g., "Worker co-chair", "Worker member", "Certified member"). Empty array → omit the line.
4. **Off-employer contact** (`typography.roles.small`, `color.foreground.muted`) — `off_employer_contact` when present, prefixed with a visually-labelled `committee.roster.row.contact_label` ("Off-employer contact"). When NULL, the line is omitted entirely (optional PI; no fallback needed).
5. **Contextual date** (`typography.roles.small`, `color.foreground.tertiary`), ISO format per §7, keyed off the badge: `pending-invite` → "Invited {invited_at}"; `awaiting-identity` / `pending-grant` → "Joined {activated_at}"; `active` → "Member since {activated_at}"; `inactive/removed` → "Removed {deactivated_at}" and, when `grace_until` is set, a second line "Access ends {grace_until}". Copy keys `committee.roster.row.date_*`.

Removed rows (`inactive/removed`) additionally de-emphasize the whole row body to `color.foreground.tertiary` so terminated members visually recede (structural de-emphasis, NOT color-only — the `Removed` badge text + `user-x` icon carry the meaning).

**Grant-state badge taxonomy (P1-8b — derived CLIENT-SIDE from the `RosterRow` columns; no server badge field).** Every badge is **icon + text** (color never alone, anti-pattern #3); color may repeat across badges because the icon + visible text + programmatic label always disambiguate. All badges use the shared `.badge` chrome (`radius.sm`, `border_width.hairline`, uppercase micro-label) with the variant tint below.

| badge | derivation from `RosterRow` | tint (design-token → CSS var) | icon | visible text | SR / programmatic label |
|---|---|---|---|---|---|
| **active** | `active === true && has_identity_key && has_live_wrap` | `.badge-resolved` — `color.state.success_bg/fg/border` → `--color-tint-green-*` | `check-circle` | "Active" | "Status: Active member with committee-key access" |
| **pending-grant** 🔑 | `active === true && has_identity_key && !has_live_wrap` (A-8.1 pinned = the co-chair's "grant now" cue) | `.badge-pending` — `color.state.warning_bg/fg/border` → `--color-tint-amber-*` | `key-round` | "Waiting for key access" | "Status: Waiting for you to grant committee-key access" |
| **awaiting-identity** | `active === true && !has_identity_key` (redeemed + activated, hasn't enrolled identity keys yet) | `.badge-info` — `color.state.info_bg/fg/border` → `--color-tint-blue-*` | `hourglass` | "Setting up encryption" | "Status: Member is still setting up their encryption; nothing for you to do yet" |
| **pending-invite** | `active === false && activated_at == null && deactivated_at == null` (invited, never redeemed — see the lifecycle note) | `.badge-info` — `color.state.info_bg/fg/border` → `--color-tint-blue-*` | `mail` | "Invited — not joined yet" | "Status: Invited but has not joined yet" |
| **inactive/removed** | `active === false && deactivated_at != null` (was active, since removed; `activated_at` may still be set from before) | `.badge-neutral` — `status_pill.neutral` (`color.background.tertiary`/`color.foreground.secondary`) → `--color-tint-neutral-*` | `user-x` | "Removed" | "Status: Removed from the committee" |

The **only amber badge is `pending-grant`** — deliberately, so the co-chair's single actionable state (the grant cue) is the one that draws the eye. `awaiting-identity` and `pending-invite` share the calm blue/info tint (both are "waiting on the member, no co-chair action") but carry **distinct icons + text + SR labels**, so they are unambiguous for color-blind and SR users. In P1-8b the `pending-grant` badge is **read-only signage** — the grant action itself is screen 3 (P1-8d); do NOT wire a grant button onto the badge in this sub-PR.

**🔒 Member-lifecycle note (badge-derivation contract — verified against `00000000000002_committee.sql`).** `committee_invite_member` (`:246`) INSERTs a `committee_membership` row at invite time with `active=false, invited_at=now(), activated_at=NULL, deactivated_at=NULL`; `committee_activate_membership` (`:287`) flips `active=true, activated_at=now()` on redeem; `committee_remove_member` (`:415`) sets `active=false, deactivated_at=now()`; `committee_reactivate_member` (`:454`) sets `active=true, activated_at=now()` WITHOUT clearing `deactivated_at`. **Consequence the implementer MUST honour:** `inactive/removed` MUST key off `active === false && deactivated_at != null`, and `pending-invite` off `active === false && activated_at == null` — do NOT use `deactivated_at != null` as the sole "removed" test on the active branch, and do NOT treat a reactivated member (active=true, but a stale `deactivated_at`) as removed. The `active` boolean is the authoritative live/not-live gate; `activated_at`/`deactivated_at` only disambiguate the two inactive sub-states.

**🔒 Roster vs. pending-invites — the read-boundary decision (resolves the A-8 ambiguity the orchestrator flagged).** Because `committee_invite_member` creates the membership row up front, an invited-but-not-redeemed member **already appears in the B1 roster** as a `pending-invite` badge row (`active=false, activated_at=null`). B1 (`committee_roster_list`) has NO `WHERE active` filter — it returns the WHOLE membership table including pending and removed rows. The separate B2 read (`listPendingInvites` → `committee_invite` rows where `consumed_at IS NULL`, carrying `invite_id` / `expires_at`) is a DIFFERENT projection that exists to power the **re-send / re-invite per-row ACTIONS** (screen 2/4, P1-8c). **P1-8b (this pass) renders ONLY the B1 roster and does NOT call `listPendingInvites`.** Interleaving B2 rows into the P1-8b roster would double-render every pending member (once from the B1 membership row, once from the B2 invite row). So: pending members surface in P1-8b via the `pending-invite` badge (read-only); their actionable invite management (expiry, re-send, re-invite) is P1-8c's B2-backed list. (Implementer: confirm this split is intended — see Open questions.)

**Copy — proposed `committee.*` en-CA keys (grade-8, calm governance tone; fr-CA is a LATER localization handoff, keys mirrored empty per ADR-0009).** Namespace is NEW; add to `i18n/en-CA.json` (root catalog). Names below are suggestions; the implementer may adjust casing to match the existing `<surface>.<element>.<role>` convention.

- `committee.nav.label` → "Committee"
- `committee.nav.blurb` → "Manage members, invites, and committee-key access. Co-chairs only."
- `committee.roster.title` → "Committee roster"
- `committee.roster.signed_out` → "Sign in to view the committee roster."
- `committee.roster.loading` → "Loading the committee roster…"
- `committee.roster.list_aria` → "Committee members"
- `committee.roster.not_co_chair.heading` → "This area is for co-chairs"
- `committee.roster.not_co_chair.body` → "The committee roster and member management are available to worker co-chairs. If you think you should have access, ask your co-chair."
- `committee.roster.not_co_chair.back` → "Back to more"
- `committee.roster.session_expired` → "Your session ended. Sign in again to view the roster."
- `committee.roster.error.heading` → "Couldn't load the roster"
- `committee.roster.error.body` → "Something went wrong on our side. Try again in a moment."
- `committee.roster.error.retry` → "Try again"
- `committee.roster.empty.heading` → "No members yet"
- `committee.roster.empty.body` → "Once members are invited and join, they'll appear here."
- `committee.roster.row.unnamed` → "Member — no name on file"
- `committee.roster.row.contact_label` → "Off-employer contact"
- `committee.roster.row.date_invited` → "Invited {date}"
- `committee.roster.row.date_joined` → "Joined {date}"
- `committee.roster.row.date_member_since` → "Member since {date}"
- `committee.roster.row.date_removed` → "Removed {date}"
- `committee.roster.row.date_grace_until` → "Access ends {date}"
- `committee.roster.role.worker_co_chair` → "Worker co-chair"
- `committee.roster.role.worker_member` → "Worker member"
- `committee.roster.role.certified_member` → "Certified member"
- `committee.roster.badge.active.text` → "Active" · `committee.roster.badge.active.sr` → "Status: Active member with committee-key access"
- `committee.roster.badge.pending_grant.text` → "Waiting for key access" · `committee.roster.badge.pending_grant.sr` → "Status: Waiting for you to grant committee-key access"
- `committee.roster.badge.awaiting_identity.text` → "Setting up encryption" · `committee.roster.badge.awaiting_identity.sr` → "Status: Member is still setting up their encryption; nothing for you to do yet"
- `committee.roster.badge.pending_invite.text` → "Invited — not joined yet" · `committee.roster.badge.pending_invite.sr` → "Status: Invited but has not joined yet"
- `committee.roster.badge.inactive.text` → "Removed" · `committee.roster.badge.inactive.sr` → "Status: Removed from the committee"
- `committee.roster.back_to_more` → "Back to more"
- `a11y.committee.roster.loaded` → "Committee roster loaded. {count} members." (`role="status"` after a successful load)

**Accessibility packet (AODA / WCAG 2.0 AA — the mandatory handoff).**

- **List vs. table semantics.** The roster ships as **list semantics** (`<ul>`/`<li>`), mirroring `/concerns` and `/reprisal` for cross-surface consistency and mobile-first stacked rows — the roster is read-only in P1-8b (no cell-by-cell comparison need). Each `<li>` KEEPS its implicit `listitem` role; a **wrapper `<div>` INSIDE the `<li>`** carries `role="group"` + `aria-labelledby` pointing to its name element, so a screen reader announces each member as a self-contained unit (name → badge → roles → contact → date, in DOM order) without breaking the list structure. (Axe-clean resolution decided at P1-8b build time: `role="group"` directly on the `<li>` strips the implicit `listitem` role and fails axe's `list` rule, so the group role lives on an inner wrapper `<div>` — either satisfies "announced as a named unit" while keeping the `<ul>`/`<li>` valid.) The `<ul>` carries `aria-label="Committee members"` (`committee.roster.list_aria`). **If** a future desktop-columned variant is wanted (Surface H/I precedent), it MUST use a real `<table>` with `<caption>`, `<th scope="col">` per column, and `role` mapping — but that is out of P1-8b scope; the stacked list is the P1-8b deliverable.
- **Badge programmatic label — never color-only.** Each badge is `<span class="badge badge-*">` = decorative icon (`aria-hidden="true"`) + visible micro-text that already carries the meaning ("Active", "Waiting for key access", "Removed", …). Additionally attach the longer `committee.roster.badge.*.sr` string via `aria-label` on the badge (or a visually-hidden `<span>`), so an SR user hears the full, unambiguous status ("Waiting for you to grant committee-key access") rather than the compact visible label. Satisfies anti-pattern #3 (color paired with icon AND text) AND the §6.7 color-blindness check.
- **Not-a-co-chair announced POLITELY.** The stop state is `role="status"` (polite), never `role="alert"` — it is an EXPECTED authorization boundary, not a failure. A member who lands here (including a coerced or merely curious one) must not be alarmed. Contrast with the session-expired and generic-error states, which ARE `role="alert"` (assertive — a real interruption requiring action).
- **Loading via `aria-busy` + live region.** While `listRoster()` is in flight, the roster container carries `aria-busy="true"` and a `role="status"` live region announces the literal action ("Loading the committee roster…") — never bare "Loading…". On success, `a11y.committee.roster.loaded` announces the member count.
- **Focus order.** DOM order, no positive `tabindex`. Interactive elements in P1-8b are limited to: the `/more` nav link (to reach the route), the sign-in link (signed-out / session-expired states), the "Back to more" link (not-co-chair / list states), and the Retry button (error state). The roster rows themselves are NON-interactive (not tab stops) in P1-8b; the two-layer AODA focus ring (`shadow.focus_ring` via app.css `:focus-visible`) applies to every link/button. When screens 3/5 add per-row grant/role controls, those controls join the tab order and MUST carry the ring + ≥44px targets.
- **Keyboard operability.** No custom key handling — every interactive element is a native `<a>` or `<button>` (Tab to focus; Enter on links; Enter/Space on buttons). Escape is not consumed (no modal on the roster surface in P1-8b).
- **Nav entry accessible name.** The `/more` `.more-link` for /committee has accessible name = its `<strong>` label + `<span>` blurb text (`committee.nav.label` + `committee.nav.blurb`); any icon added is `aria-hidden` with the text label present (anti-pattern #2 — never icon-only for a navigational/consequential control). `aria-current="page"` is NOT set on the /more row (the destination is /committee, not /more).
- **Touch targets.** The `/more` nav row is a full-width padded link (well ≥ `touch_target.min` 44px). The Retry / Back / sign-in controls are `button`/`.cta`/link at `min-height: 2.75rem` (44px) per app.css. Rows are non-interactive so carry no target requirement in P1-8b; later per-row action targets MUST be ≥44px (`touch_target.min`, general app tier — the roster is not in the gloves-friendly inspection/reprisal 48px tier).
- **Reduced motion.** The only motion is the optional loading spinner; under `prefers-reduced-motion: reduce` it degrades to static text + the `aria-busy` live region per §6.6 (no rotation). No row-insert animation (the roster is a single fetch, not a stream).

**Token usage table (every visual → its `design-tokens.json` key → the CSS var the implementer binds).** No raw values; A-8 confirmed all needed tokens exist (`table.sessions`, the badge tints, `card.default`).

| element | design-tokens.json key | CSS custom property |
|---|---|---|
| page background | `color.{mode}.background.primary` | `--color-bg` |
| roster section card | `components.card.default` (`color.surface.raised` / `color.border.subtle` / `shadow.sm`) | `.card` → `--color-bg-elevated`, `--color-border`, `--shadow-sm`, `--radius` |
| title (h1) | `typography.roles.section` | app.css `h1` |
| roster `<ul>` gap | `density.comfortable.row_gap` | `0.75rem` (comfortable row gap) |
| roster row (`<li>`) | `components.table.sessions` row tokens (`row_bg`=`color.surface.raised`, `row_border`=`color.border.subtle`) realized as `table.list_mobile_stacked` | `--color-bg-elevated`, `1px --color-border-strong`, `--radius-md`, padding `spacing.4` |
| member name | `typography.roles.subsection`, `color.foreground.primary` | `--color-fg` |
| unnamed fallback label | `color.foreground.secondary` | `--color-fg` (secondary) |
| short-uid disambiguator | `typography.roles.code`, `color.foreground.muted` | `--font-mono`, `--color-fg-muted` |
| roles / contact / date meta | `typography.roles.small`, `color.foreground.muted` / `.tertiary` | `--color-fg-muted` / `--color-fg-subtle` |
| badge chrome | `components.status_pill` / `.badge` (`radius.sm`, `border_width.hairline`) | `.badge` → `--radius-sm`, `--border-width-hairline` |
| badge `active` | `color.state.success_bg/fg/border` | `.badge-resolved` → `--color-tint-green-bg/fg/border` |
| badge `pending-grant` | `color.state.warning_bg/fg/border` | `.badge-pending` → `--color-tint-amber-bg/fg/border` |
| badge `awaiting-identity` + `pending-invite` | `color.state.info_bg/fg/border` | `.badge-info` → `--color-tint-blue-bg/fg/border` |
| badge `inactive/removed` | `status_pill.neutral` (`color.background.tertiary` / `color.foreground.secondary`) | `.badge-neutral` → `--color-tint-neutral-bg/fg/border` |
| not-a-co-chair stop | `components.alert_banner.info` (`color.state.info_bg/fg/border`) | `--color-tint-blue-bg/fg/border` |
| session-expired / error | `components.alert_banner.danger` (`color.state.danger_bg/fg/border`) | `--color-tint-red-*` / `--color-destructive` |
| empty-state icon | `empty_state.icon_color` = `color.foreground.tertiary` | `--color-fg-subtle` |
| empty/loading/error copy | `typography.roles.body` | app.css `p` |
| Retry / Back / sign-in link | `components.button.primary` / link, `touch_target.min` (44px) | `.btn` / `.cta` (`min-height: 2.75rem`) |
| nav row (`/more`) | `.more-link` row (`color.surface.raised` / `color.border` / `radius.md`) | `--color-bg-elevated`, `--color-border`, `--radius-md`, hover `--color-muted` |
| focus ring (all interactive) | `shadow.focus_ring` (two-layer, `focus_ring.outer` + `.inner`) | app.css `:focus-visible` → `--color-focus-outer`, `--color-focus-inner` |

**No missing tokens.** Every Surface-K roster value binds to an existing token; nothing new is required in `design-tokens.json` for P1-8b. (Screens 2–5 will be assessed for token gaps in their own designer passes — e.g., a possible dedicated grant-confirm fingerprint-compare treatment for P1-8d.)

**Empty/loading/error per the Common state matrix:** empty = the degenerate empty-roster state (chrome retained); loading = the `listRoster()`-in-flight state (literal action text + `aria-busy`); error = the generic-failure state (`role="alert"` + Retry) plus the two authz-shaped terminal outcomes (not-a-co-chair `role="status"`, session-expired `role="alert"`); success = the roster-list state (`a11y.committee.roster.loaded` announcement). All matrix rows covered.

**Open questions for the implementer (A-8 ambiguities to resolve before/at build):**

1. **Roster vs. pending-invites read boundary (recommended resolution above).** This pass specs P1-8b as **B1-only** (roster shows pending members via the `pending-invite` badge; B2 `listPendingInvites` is deferred to P1-8c's invite-management list). Confirm the orchestrator/architect intends P1-8b to be roster-only and NOT interleave B2 rows. If instead P1-8b must show the B2 pending-invite detail (expiry, invite_id) inline, that is a scope change requiring a follow-up designer pass for the interleave layout + de-dupe rule (a member would otherwise appear once per read).
2. **401 vs. 403 disambiguation for session-liveness.** A-8.1's RPC RAISEs `rls_denied` (403) for BOTH `NOT session_is_live()` AND `NOT is_active_co_chair()`. This pass maps 403→not-a-co-chair and 401→session-expired. Edge case: a locally-un-expired JWT whose SERVER session was revoked (`session_is_live()` false) would return 403 and mis-render as "not a co-chair" rather than "session-expired". Mitigant: server-side revocation usually also fails the EF auth boundary → 401. Flag: if this edge matters, the backend could split the error code (session-liveness vs. co-chair) — but that is a backend change out of P1-8b scope; confirm the 403→not-a-co-chair mapping is acceptable.
3. **Badge set completeness.** This pass ships **five** badges (`active`, `pending-grant`, `awaiting-identity`, `pending-invite`, `inactive/removed`). A-8.4's enumerated list names four (it omits `inactive/removed`, which is nonetheless derivable from `active === false && deactivated_at != null` and is required so a removed member renders — A-8.1's null-PI/always-render-a-row rule). Confirm `inactive/removed` is wanted in the read-only P1-8b roster (recommended: yes — removed-with-grace members are exactly what a co-chair needs to see).
4. **Raw-uid disambiguator visibility.** A-8.1 pins that the roster returns the RAW `user_id` and that it is acceptable to disclose to a co-chair. This pass renders only a **short 8-char uid fragment** as a disambiguator for nameless rows (not the full uuid in the primary label). Confirm the co-chair's downstream governance ops (screens 3/5) don't need the FULL uid surfaced/selectable in P1-8b — if they do, a copy-uid affordance is a screen-3/5 concern, not P1-8b.

---

### Common state matrix — apply to every interactive component above

Per the hard rule "every state must have empty + loading + error + success coverage":

| state | minimum visible cue | a11y |
|---|---|---|
| empty | Heading + body explaining; primary action if applicable | `role="status"` on initial mount; inert thereafter |
| loading | Spinner + literal current-action text (never "Loading…" alone for sensitive surfaces — name the action: "Encrypting…", "Verifying passkey…", "Logging audit row…") | `aria-busy="true"` on the parent; live region with the action text |
| error | Heading + plain-language cause + next-action button; for unrecoverable: contact support link with no PI in the error message | `role="alert"` |
| success | Heading or toast + plain confirmation + next-action button or implicit advance | `role="status"` |

---

## 5. Layout patterns

### 5.1 App shell (default for authenticated views)
- **Top header** (sticky, `z_index.sticky_header`): app name, environment badge (if not prod), offline pill (Surface F), user identity affordance (avatar + display name → menu with Lock now, Sign out, Settings).
- **Body**: max-width `layout.max_width.content`; gutters per `layout.gutter`.
- **Bottom nav (mobile only)**: 3-4 tabs (Inspections, Concerns, Reprisal, More). Each tab = icon + text label; min target `touch_target.inspection_min`.
- **Mobile collapse rule**: at `breakpoint.xs` to `breakpoint.md`, bottom nav is present; from `breakpoint.lg` and up, nav moves into the top header as inline links; bottom nav is hidden.

### 5.2 Form layout (concern intake, reprisal entry, inspection)
- Single column, max-width `layout.max_width.form` (560px); centered on desktop, full-width on mobile.
- Section headings every ~5 fields; visible separator (1px `border.subtle`).
- Field gap from `density.{mode}.form_field_gap`.
- Sticky bottom action bar on mobile (`z_index.sticky_header - 1`): Cancel (ghost) on left, Save (primary or destructive) on right; bar height respects safe-area-inset-bottom.

### 5.3 List layout (concerns, audit feed, sessions, hazard register)
- Filter / search bar at top (sticky on scroll).
- Empty state per §4 common matrix.
- Mobile: stacked card rows (`card.default` per row).
- Desktop: tabular (`table.list_desktop_columned`).

### 5.4 Interstitial layout (export, panic-wipe, 4-eyes confirm, lock screen)
- Full-screen on mobile, modal on desktop ≥ `breakpoint.md`.
- One-column layout; never two-column.
- Action buttons full-width on mobile; right-aligned on desktop.
- Body content max-width `layout.max_width.prose`.

---

## 6. Accessibility handoff prep

(This section is the packet the accessibility-specialist consumes.)

### 6.1 Targets
- **WCAG 2.0 AA** minimum (AODA); **target 2.1 AA** where feasible.
- Body text in both modes targets AAA (7:1) per the contrast audit in `design-tokens.json`.

### 6.2 Keyboard nav (one path per component)
- **Button**: Tab to focus; Enter or Space to activate. Loading state: focus remains; activation no-op.
- **Input (text/textarea)**: Tab to focus; native typing.
- **Select**: Tab to focus; Space or Enter to open; arrow keys to navigate; Enter to select; Escape to close without selection.
- **Checkbox/Radio**: Tab to focus the group; arrow keys within group (radio); Space to toggle (checkbox); Enter does NOT activate to avoid form-submit conflict.
- **Switch (anonymous toggle)**: Tab to focus; Space to toggle.
- **Modal**: opens → focus moves to first focusable inside (or labelled Cancel for destructive); Tab cycles within trap; Shift+Tab reverses; Escape dismisses (except for the five protected variants in §3.2).
- **Toast**: not in tab order. To act on a toast (e.g., Undo), the toast contains a focusable button that joins the tab order while visible.
- **Table row**: Tab to row, Enter to expand/open, arrow keys to navigate within table when in grid mode.
- **Bottom nav tab**: Tab to focus tab; Enter or Space to activate; left/right arrow keys navigate between tabs.

### 6.3 Screen-reader announcement strings (catalog keys)
Every announcement string is in the i18n catalog. The full set is in `/home/user/agent-os/i18n/en-CA.json`. Examples that MUST be announced (catalog key → English):
- `a11y.export.reauth.success` → "Passkey confirmed. Reviewing export fields."
- `a11y.export.concern_flag.detected` → "This export includes items derived from worker concerns. Review carefully."
- `a11y.export.complete` → "Export ready. PDF is downloaded. Audit row {audit_id} recorded."
- `a11y.reprisal.read.logged` → "Your read of this reprisal entry was logged at {timestamp} and other members will be notified."
- `a11y.passphrase.wrong` → "Passphrase incorrect. {n} attempts remaining."
- `a11y.offline.banner` → "You are offline. {n} entries queued."
- `a11y.lock.engaged` → "Application locked. Sign in again to continue."
- `a11y.panic.complete` → "Local data wiped from this device."
- `a11y.session.revoked` → "Session on {device} revoked."
- `a11y.audit.integrity_fail` → "Audit log integrity check failed. Contact the worker co-chair."

### 6.4 Color-contrast pairs (claimed to meet AA)
The full audit is in `design-tokens.json` under `color._contrast_audit`. Every pair in that table is what the implementer is permitted to use; any new pair requires a designer revision.

### 6.5 Touch target sizing
- General app: 44×44 minimum (`touch_target.min`).
- **Inspection workflow and reprisal entry** (gloves-friendly per plan §9): 48×48 minimum (`touch_target.inspection_min`).
- Spacing between adjacent targets: 8px minimum (`touch_target.spacing_between_targets_min`).

### 6.6 Reduced-motion fallbacks
Per `motion._reduced_motion` in tokens. Specifically:
- Skeletons render as flat solid blocks; no shimmer.
- Modal / toast use opacity-only transitions at `micro` duration.
- Spinners are replaced by static "Loading…" text + indeterminate progress bars (no rotation).
- Row-insert highlights in sensitive-read feed and audit feed do not animate; rows simply appear.
- No transform-based motion (no slide-up, no fade-from-bottom).

### 6.7 Color-blindness check
Per anti-pattern #3: every color is paired with an icon AND text. The sensitivity badges (C3 / C4) additionally use a left-border stripe pattern (`sensitivity.c4_stripe`) so deuteranopic and protanopic users see structural distinction beyond hue.

---

## 7. i18n readiness

- Every user-visible string is a catalog key. **No raw strings in component code.**
- Catalog files: `/home/user/agent-os/i18n/en-CA.json` (populated for v1) and `/home/user/agent-os/i18n/fr-CA.json` (empty stub — same key set, empty values, per ADR-0009).
- Keys are namespaced: `<surface>.<element>.<role>` (e.g., `export.interstitial.heading`, `reprisal.entry.passphrase.label`, `a11y.export.complete`).
- Placeholders use `{variable_name}` syntax (matches `svelte-i18n` and `messageformat`).
- **Locale-aware formatting** from day 1: dates in ISO `2026-05-22` (Ontario context), numbers per locale.
- **OHSA legal terms** are marked in the catalog with a `_review_needed: true` adjacent key when fr-CA is added; a labour lawyer reviews translations of those keys before fr-CA ships.

---

## 8. Sample screen spec (proof the system is complete)

**Screen: Reprisal log — list view (Surface C, `list (badged)` state) on a 360-wide phone (`breakpoint.xs`), comfortable density, light mode.**

Built entirely from tokens:

- **Page background**: `color.light.background.primary` (`#fbfbfa`).
- **Top header** (sticky, `z_index.sticky_header`, height `layout.app_chrome.header_height_mobile` = 3.5rem, bg `color.light.surface.raised`, border-bottom 1px `color.light.border.subtle`):
  - Left: back button (variant `ghost`, min-width `touch_target.min`, icon=arrow-left + visually-hidden text "Back").
  - Center: page title (`typography.roles.section`, color `color.light.foreground.primary`).
  - Right: identity affordance (avatar 32px round + display name truncated at `typography.roles.small`).
- **Offline pill / sync pill**: just below header, status_pill height `layout.app_chrome.status_pill_height`.
- **Filter bar** (sticky under header): single-line, padding `spacing.4`, search input (variant `text`, control height `density.comfortable.control_height` = 2.75rem, border `color.light.border.default`, focus ring per `shadow.focus_ring`), filter select for status. Gap between controls `spacing.2`.
- **List** (gutter `layout.gutter.mobile` = 1rem, gap between cards `density.comfortable.row_gap` = 0.75rem):
  - Each row is a `card.sensitive_c4`:
    - Background `color.light.surface.raised`.
    - 4px left border `color.light.sensitivity.c4_border` (`#7a1d2e`).
    - Padding `spacing.4`.
    - Top-right C4 badge: `status_pill.sensitive_c4` — bg `color.light.sensitivity.c4_bg`, fg `color.light.sensitivity.c4_fg`, icon=shield + text "C4 — passphrase to view".
    - Title (decrypted client-side; `typography.roles.subsection`, color `color.light.foreground.primary`).
    - Below title, two rows of metadata in `typography.roles.small`, color `color.light.foreground.tertiary`: actor display name + relative timestamp; status pill.
    - Body preview replaced by `"Locked — tap to view"` text in `typography.roles.body`, color `color.light.foreground.secondary`, with a lock icon (`icon.size.sm`) before it.
    - Whole row is a focusable button-like element (min target `touch_target.inspection_min` = 48px); focus ring per `shadow.focus_ring`.
- **Empty state** (if zero entries):
  - Vertically centered in remaining viewport.
  - Icon `icon.size.lg` color `color.light.foreground.tertiary`.
  - Heading `reprisal.empty.heading` in `typography.roles.subsection`.
  - Body `reprisal.empty.body` in `typography.roles.body`, max-width `layout.max_width.prose`.
  - Primary button `reprisal.empty.cta`, variant `primary`, height `density.comfortable.control_height`.
- **Bottom nav** (`z_index.bottom_nav`, height `layout.app_chrome.bottom_nav_height` = 3.75rem, bg `color.light.surface.raised`, border-top 1px `color.light.border.subtle`):
  - 4 tabs, each min-target `touch_target.inspection_min`, icon (`icon.size.default`) + text label (`typography.roles.caption`).

**Every value is from a token. No invented values.** If the implementer cannot build this from `design-tokens.json` plus this spec, file a designer-pass-needed issue rather than inventing.

---

## 9. Handoff

**Inputs that the accessibility-specialist must review:**
1. `/home/user/agent-os/design-tokens.json` — token-level decisions and the full contrast audit.
2. `/home/user/agent-os/.context/design-system.md` (this file) — direction, interaction patterns, component-state spec, layout patterns, the keyboard nav and SR strings packet, the reduced-motion fallbacks, the sample screen.
3. `/home/user/agent-os/i18n/en-CA.json` — every user-visible string and every SR announcement.

**Pack rule:** Design tokens are NOT committed until the accessibility-specialist signs off. Findings come back as a list; the designer addresses each, then re-invokes for a second pass if changes are material.

The accessibility-specialist's verification scope at minimum:
- WCAG 2.0 AA across the contrast audit; spot-check 2.1 AA.
- Focus order on every modal and every form.
- Live-region categorization (status vs alert) per §3.3 and §4.
- Reduced-motion fallback completeness per §6.6.
- Touch target sizing per §6.5 with attention to inspection + reprisal pipelines.
- SR string clarity and locale-tagging in the catalog.
- The five protected modal variants in §3.2 do not silently dismiss (a coercion-resistance posture).
