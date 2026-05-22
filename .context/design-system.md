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

### Surface D — Onboarding (ADR-0008 + ADR-0001 + RA-1 + F-08)

First-launch flow. Plain-language; no lawyer voice.

| step | state | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **D.1 device advisory** | initial | Full-screen page (not a modal — this is the first screen the rep ever sees); headline `onboarding.device.heading` ("Use a personal device only"); body explains in plain English: "If you are reading this on a phone or laptop your employer owns or pays for, your employer may be able to read what you do here. Stop. Install on a personal phone or laptop and start again."; primary button `onboarding.device.continue` ("This is a personal device — continue"); secondary button `onboarding.device.stop` ("Stop — I'll switch to a personal device"); the page also shows the current device fingerprint (UA + platform) as info | Plain-language body wraps at `max_width.prose`; secondary button surfaces a confirmation that simply closes the tab with a friendly message | n/a — initial state |
| **D.2 hosting tradeoff** | post-D.1 | Headline `onboarding.hosting.heading` ("Where your data lives"); body in `body` role explains in plain English: "Your committee's data is stored on Supabase, a service based in the US that runs on servers in Canada (ca-central-1). Two things you should know: (1) the worker-side content — concerns, reprisal entries, minutes drafts — is encrypted on your device before it leaves, so Supabase only sees scrambled bytes; (2) US legal process could in principle reach the company, but what they would get back is the same scrambled bytes."; primary `onboarding.hosting.continue` ("Got it") | Reading level target: grade 8; no Latin abbreviations ("i.e.", "e.g."); link to the full privacy policy as a secondary action | n/a |
| **D.3 passkey enrollment — explain** | post-D.2 | Headline `onboarding.passkey.heading` ("Set up your passkey"); body explains what a passkey is in plain English: "A passkey is a way to sign in without a password. It lives on your device and uses your fingerprint, face, or device PIN to confirm it's you. There is no password to phish, leak, or guess."; browser-compatibility check banner if the browser is below the supported baseline (per Q2); primary `onboarding.passkey.start` ("Set up passkey now") | The button triggers `navigator.credentials.create`; SR users hear the explainer before being prompted by the OS dialog | If browser unsupported → block state `onboarding.browser.unsupported` with a plain-language explanation of which browsers work |
| **D.3 passkey enrollment — in progress** | OS WebAuthn dialog | Modal scrim covers app; small in-app card says `onboarding.passkey.waiting` ("Waiting for your device…") | `aria-live="polite"` on the waiting card | If timeout / NotAllowed → inline error in the same card with Retry; on too many retries, return to D.3 explain |
| **D.3 passkey enrollment — done** | WebAuthn returns credential | Inline confirmation: checkmark + `onboarding.passkey.done` ("Passkey set on this device") + primary `onboarding.passkey.continue` ("Next: print your recovery sheet") | `role="status"` | n/a |
| **D.4 recovery passphrase — generate** | post-D.3 | Headline `onboarding.recovery.heading` ("Your recovery sheet"); body explains in plain English: "If you lose this device AND your passkey, the only way back into your account is the recovery passphrase below. There is no admin who can reset it. Print this sheet and store it somewhere safe and **not** at work."; a card with the printable layout (see D.5) embedded; primary `onboarding.recovery.print` ("Print recovery sheet"); secondary `onboarding.recovery.copy` (copy to clipboard with a warning that clipboard isn't a substitute for printing) | The passphrase is rendered in `typography.roles.code` at large size; pre-formatted for screen-reader to read each chunk separately | If `window.print()` unavailable → fallback text and instructions for using the browser's print menu |
| **D.5 recovery passphrase — print layout** | print stylesheet | Print-only layout (`@media print`): single page, no headers/footers, no app chrome. Layout: (a) tribunal-style header `print.recovery.title` ("JHSC App — Recovery sheet for {display_name}") with date; (b) the passphrase rendered as `typography.roles.totp` (large mono) in five word-chunks separated by visible space; (c) the salt rendered as `typography.roles.hash` underneath, labelled; (d) below the passphrase, a single boxed warning paragraph: "If anyone has this sheet, they can recover your account on a new device. Treat it like a key. Do not store it at work."; (e) a footer with the URL of the app + the build hash | All print-only content uses serif `typography.family.serif` to differentiate from on-screen; high contrast (black on white only) | If browser blocks `window.print()` → user is shown the same layout on-screen with instructions to use system print |
| **D.6 recovery passphrase — type-back verification** | post-print | Headline `onboarding.recovery.verify.heading` ("Type the passphrase back to confirm"); textarea input; the previously-shown passphrase is **not** visible on this screen (user must consult the printed sheet); primary `onboarding.recovery.verify.submit` ("Confirm"); on mismatch, error_state inline with attempt counter | The textarea is `aria-required="true"` and `aria-describedby` linked to the helper "Type the words exactly as printed, separated by spaces." | If 3 attempts wrong → return to D.4 (re-display the passphrase); F-08 mitigation requires the type-back; without verification the user cannot proceed |
| **D.7 done** | post-D.6 | Headline `onboarding.done.heading` ("You're set up"); summary card listing: passkey set, recovery sheet printed-and-verified, browser supported, device flagged as personal; primary `onboarding.done.continue` ("Open the app") | `role="status"` | n/a |

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

### Surface G — Lock / panic-wipe (T2 / T6)

| state | trigger | visible cues | a11y notes | empty/loading/error coverage |
|---|---|---|---|---|
| **lock-screen (auto)** | Idle timeout (per ADR-0008, 15 min default) OR tab regains focus after blur and timeout expired | Full-viewport overlay at `z_index.lock_screen`; centered card: headline `lock.heading` ("Locked — confirm it's you to continue"); body explains "Your committee data is protected and was cleared from memory."; primary button `lock.button.unlock` ("Use passkey"); secondary `lock.button.signout` ("Sign out instead") | Focus traps to Use passkey button; the overlay is `role="dialog"` with `aria-modal="true"` and `aria-labelledby` pointing to the headline | If WebAuthn fails → inline error_state with retry; after 3 fails → sign out and return to enrollment selection |
| **lock-screen (manual)** | User clicks "Lock now" in settings | Same as auto-lock | Same | Same |
| **panic-wipe trigger** | User clicks "Wipe this device's data" in settings | `destructive_confirm` modal opens | n/a | n/a |
| **panic-wipe confirm** | Modal | Headline `panic.heading` ("Wipe this device's data"); body lists in plain English what will be removed: encrypted IndexedDB store, session, cached settings; warns that wiping does NOT remove the data from the server (other devices and the committee retain their access); requires the user to type the literal word "WIPE" into a text input; Cancel + Wipe buttons (Wipe variant `destructive`, disabled until the word matches case-insensitive) | Text input is `aria-required="true"`; the Wipe button has `aria-describedby` pointing to the required-phrase hint | n/a |
| **panic-wipe in progress** | User clicks Wipe with phrase typed | Full-viewport overlay at `z_index.panic_overlay`; centered: spinner + heading `panic.wiping.heading` ("Wiping…"); no controls | `aria-busy="true"`; SR announces "Wiping local data" | If wipe partial-fails → error_state with details; user is told what was and wasn't wiped |
| **panic-wipe complete** | IndexedDB cleared, session torn down, service-worker caches purged | Page redirects to a fresh login surface; toast `success` ("Local data wiped. Sign in again to continue, or close this tab to leave the app.") | `role="status"` | n/a |

---

### Surface H — Session listing (F-39 / T05)

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
