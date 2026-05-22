# Accessibility specialist review — worker-side JHSC design tokens + design system + en-CA catalog

> **Reviewer:** accessibility-specialist agent
> **Date:** 2026-05-22
> **Inputs reviewed:**
> - `/home/user/agent-os/design-tokens.json` (full file, with re-verification of `color._contrast_audit`)
> - `/home/user/agent-os/.context/design-system.md` (§1–§9, with attention to §3 patterns, §4 surfaces A–I, the §3.2 protected-modal list, and §6 handoff packet)
> - `/home/user/agent-os/i18n/en-CA.json` (full file, with attention to `a11y.*` and `audit.action.*`)
> - `/home/user/agent-os/i18n/fr-CA.json` (stub-shape parity check only)
> - Cross-referenced: `JHSC-APP-PLAN.md` §9, `.context/constraints.md` AODA section, `.context/threat-model.md` (RA-1, F-19, HG-1, HG-5, HG-6, F-34, F-44, F-08, T11/T18 — coercion-resistance posture).
> **Tested:** static review across all nine surfaces + per-state spec + recomputation of the riskier contrast pairs in `color._contrast_audit`. No assistive-tech instrumentation; cannot perform real-user testing at this phase — flagged in §6.
> **Verdict:** **BLOCK-WITH-CONDITIONS** — three Blockers identified; all are localized fixes the designer can land without revisiting visual direction. Once Blockers 1–3 are addressed (verified inline with a unified diff or a second pass), tokens may be committed. Six Advisories follow for the next design pass; they do not gate this commit.

---

## 1. Verdict

**BLOCK-WITH-CONDITIONS.**

Conditions (small designer fixes) listed in §3. Designer applies fixes, then commit may proceed. No second specialist pass required if the Conditions are addressed exactly as written; if the designer chooses a different remedy for any item, a second pass is required for that item only.

---

## 2. Blockers

### Blocker B-1 — Contrast audit row `foreground.muted on background.primary` (light mode) is mis-claimed and the underlying pair fails WCAG 1.4.3 for normal-size text.

- **Finding.** `design-tokens.json` line 184 claims `foreground.muted on background.primary` measures **4.6:1 AA** in light mode and gates use to "hint text ≥14px". Re-computed against WCAG 2.x relative luminance, the pair `#7b8290` (muted) on `#fbfbfa` (primary background) is **≈3.77:1**. The annotation "use only for hint text ≥14px" misuses the WCAG large-text threshold — 14px regular is **not** "large" under WCAG (the floor is 18pt regular = 24px, or 14pt bold = ~18.66px bold). At 14px regular this pair fails 1.4.3 Contrast (Minimum) for body/hint text.
- **WCAG criterion violated.** WCAG 2.0 AA **1.4.3 Contrast (Minimum)** (normal text 4.5:1 floor).
- **Where.** `design-tokens.json` line 184 (audit claim); `color.light.foreground.muted` `#7b8290` at line 42; usages — `input.placeholder` (line 497) and `input.tertiary` hint text throughout `.context/design-system.md` §4 (form helpers, `concern.intake.anon.helper_on`, `reprisal.passphrase.helper`, anonymous-toggle helper, photo location helper, sensitive-feed empty body, etc.).
- **Fix to unblock.** Either:
  - **(a) Darken the token** so `foreground.muted` reaches ≥4.5:1 against `background.primary` light. A value around `#6c7280` (L≈0.155, ≈4.78:1) or darker satisfies AA. Re-audit `foreground.muted on background.secondary` (`#f3f3f1`) and `on surface.raised` (`#ffffff`) after the change and update the audit table line 184 to the recomputed ratio with an honest annotation.
  - **(b) Restrict the token to non-text use only** (e.g., decorative iconography paired with adjacent label text at `foreground.tertiary`) and replace every text usage of `muted` in `.context/design-system.md` §4 with `foreground.tertiary` (`#5b6270` at 6.0:1 — already AA for normal text). The component spec at `design-tokens.json` line 497 (`input.placeholder`) and the helper-text role must be retoken'd to `foreground.tertiary` in this case.

  Pick one. (b) is the smaller diff. Either way, the audit row text "AA (use only for hint text ≥14px)" is incorrect as written and must be replaced.

### Blocker B-2 — Contrast-audit coverage gap: the focus ring is not audited against any C3/C4 sensitivity background or against `state.*_bg` strips, where the focus ring will actually appear on the highest-stakes surfaces.

- **Finding.** `color._contrast_audit.light` (lines 176–195) and `color._contrast_audit.dark` (lines 197–217) enumerate `focus_ring.outer on background.primary` but **omit every pair where the focus ring will appear in practice on a sensitive surface**: `focus_ring.outer on sensitivity.c4_bg` (light `#f7e0e4`), `on sensitivity.c3_bg` (`#ede7f9`), `on state.danger_bg`, `on state.warning_bg`, `on state.success_bg`, `on state.info_bg`, and the same set in dark mode. By re-computation, `focus_ring.outer` (`#fbbf24`) on light C4 bg `#f7e0e4` is **≈1.34:1**, and on C3 bg `#ede7f9` is **≈1.43:1** — both well below WCAG 2.1 1.4.11 Non-text Contrast (3:1) considered in isolation. The two-layer construction (outer halo + inner dark line) carries the visibility on most surfaces because the inner `#16181d` line hits ≥15:1 against either background; the construction is a valid technique (cf. GOV.UK's black-on-yellow + dark inner). **But the design system never proves this**, and the C4/C3 row case is where focus-ring legibility breaks first.
  This is a launch-blocking gap because the highest-attention surfaces (the reprisal list, the sensitive-read feed, the export interstitial's concern-flag strip — all `card.sensitive_c4` per §4.C and §4.A) all paint the focus ring on a C4 background. The reviewer cannot sign off without the audit showing these surfaces meet 1.4.11.
- **WCAG criterion violated.** WCAG 2.1 AA **1.4.11 Non-text Contrast** (focus indicator must meet 3:1 against adjacent colors); WCAG 2.0 AA **2.4.7 Focus Visible** is met by construction but unverified for these backgrounds.
- **Where.** `design-tokens.json` lines 174–219 (the `_contrast_audit` table — coverage gap, not a single line). The component-state spec that paints focus rings on C4 backgrounds: `.context/design-system.md` §4.C row "list (badged)" (line ~151), §4.C "reading" (line ~154), §4.A "concern-flag-warning" (line ~110), §4.I row-tint for C4 events (line ~247), §4.C sensitive-read feed "active items present" (line ~167).
- **Fix to unblock.** Extend `color._contrast_audit.light` and `color._contrast_audit.dark` to include explicit rows for every focus-painting context on a non-primary background. At minimum:
  - `focus_ring.outer on sensitivity.c4_bg`
  - `focus_ring.outer on sensitivity.c3_bg`
  - `focus_ring.outer on state.danger_bg`
  - `focus_ring.outer on state.warning_bg`
  - `focus_ring.outer on state.success_bg`
  - `focus_ring.outer on state.info_bg`
  - `focus_ring.inner on sensitivity.c4_bg` (this is the load-bearing layer)
  - `focus_ring.inner on sensitivity.c3_bg`

  For each row, if `outer` alone is <3:1, annotate that the visibility is satisfied by the combined two-layer construction and cite the inner-line ratio that carries it (the dark inner `#16181d` against a light C4 bg is ≥15:1; the dark-mode inner `#f3f4f6` against a dark C4 bg `#3a1620` is ≥10:1). The audit row text must say so explicitly so the implementer cannot inadvertently drop the inner layer thinking the outer alone is sufficient.

  Add an inline note to `design-tokens.json._meta.accessibility` (around line 20) or to the audit `_comment` (line 175): **"Removing the inner ring layer is forbidden. The two-layer construction is the WCAG 1.4.11 conformance path; the outer halo alone does not satisfy 3:1 against C3/C4 or state backgrounds."**

### Blocker B-3 — `audit.action.*` keys include action enum strings that are visible in the audit feed UI (`§4.I "list (events present)"`) but several plain-language values still leak the enum vocabulary, defeating the SR-friendliness contract.

- **Finding.** The instruction in §6.3 of the design system and the brief from the orchestrator both state: `audit.action.*` strings must be plain language (no `committee_data_key.rotation.started`-as-displayed). Most entries in `en-CA.json` lines 489–515 satisfy this. **Three do not**:
  - `audit.action.identity_keypair.created` → "Set up identity keys" — borderline; "identity keys" is jargon. A rep reading the audit feed will not know what an "identity key" is or what consequence it has.
  - `audit.action.committee_data_key.unwrap` → "Opened the committee key for this session" — "unwrap"-as-"opened" is closer to plain but "the committee key" requires the reader to already understand the key model. For an SR user who hears this in sequence, no context is built.
  - `audit.action.client.cache_policy_violation` → "A client cache policy was violated and the response was dropped" — this is implementer language. A worker rep will not know what a "cache policy" is.

  Additionally, `audit.action.queue.integrity_fail` → "An offline-queued entry failed verification and was rejected" is acceptable plain language; included here only as the contrast — that's the bar.
- **WCAG criterion violated.** WCAG 2.0 AA **3.1.5 Reading Level** is AAA, not AA — so this is not strictly a normative AA fail; however **1.3.1 Info and Relationships** is engaged because the visible string IS the role of the row, and **3.2.4 Consistent Identification** is engaged because the SR string and the visual string must convey the same meaning. The deeper issue is the cognitive-accessibility guidance and the design-system's own contract in §6.3, which is the gate set by the orchestrator's instruction.
- **Where.** `i18n/en-CA.json` lines 502, 506, 514 (the three entries above).
- **Fix to unblock.** Reword to name the **consequence** and avoid jargon:
  - `identity_keypair.created`: "Created the keys this device uses to sign in"
  - `committee_data_key.unwrap`: "Unlocked the committee's shared data for this session"
  - `client.cache_policy_violation`: "Blocked a stale response from being shown — possible tampering"

  These three changes only. The other `audit.action.*` entries pass.

---

## 3. Conditions (must be true before commit)

Apply Blockers B-1, B-2, B-3 verbatim or with an equivalent remedy. Specifically:

1. **B-1**: Either darken `color.light.foreground.muted` to reach ≥4.5:1 against `background.primary` and update the audit row, **or** retoken every text usage of `muted` in §4 to `foreground.tertiary`. Update `design-tokens.json` line 184's claim text to match reality.
2. **B-2**: Add the eight enumerated focus-ring audit rows (four for light, four for dark, plus two `focus_ring.inner` rows) and add the "Removing the inner ring layer is forbidden" note in `_contrast_audit._comment` or `_meta.accessibility`.
3. **B-3**: Reword the three `audit.action.*` strings to remove implementer vocabulary.

No other token mutation is required for the commit to land.

---

## 4. Advisories (non-blocking — address in next pass)

### A-1 — `foreground.disabled` text contrast is 2.7:1 light / 2.9:1 dark, justified by the "disabled-text exception". Verify by component spec, not assumption.

- **Finding.** `_contrast_audit` lines 182, 203 cite the WCAG 1.4.3 carve-out for "inactive UI components". The carve-out is real but narrow: it applies to *the disabled control itself*, not to other text that happens to share the disabled color. The button spec (`design-tokens.json` lines 466–485) uses `disabled_fg: color.foreground.disabled` for a disabled button — fine. But `.context/design-system.md` §4.C "reading" has secondary metadata in `foreground.tertiary`; if any future state migrates that to `foreground.disabled`, it leaves the exception and fails 1.4.3.
- **WCAG criterion.** 1.4.3 (carve-out applies to inactive UI components only).
- **Where.** `design-tokens.json` lines 43 (`light.foreground.disabled`), 116 (`dark.foreground.disabled`); usages must be audited at implementer phase.
- **Fix.** Add a `_usage_constraint` field on `foreground.disabled` in both modes: `"Restricted to disabled control labels only. Never used for static text, captions, or hint text."` And the implementer-pass linter (test-writer phase) should grep for `foreground.disabled` outside `aria-disabled`/`disabled` contexts.

### A-2 — Reduced-motion fallback for `modal_enter` collapses to a 100ms opacity transition. For the five protected modals, even a 100ms opacity transition introduces a brief window where focus has not yet trapped and Escape behavior is ambiguous to a SR user.

- **Finding.** `motion.per_surface.modal_enter` (line 405) under reduced-motion uses `micro` (100ms opacity). On the five protected modals (`export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending` — `.context/design-system.md` §3.2), the modal must be focus-trapped and announce its purpose **before** the user can interact. A 100ms fade does not violate AA, but it should not gate the focus trap or the announce-on-open behavior. The design system doesn't explicitly say the trap engages on `modal.show()` regardless of opacity, only after transition end.
- **WCAG criterion.** 2.4.3 Focus Order, 4.1.3 Status Messages (advisory — the design system text is ambiguous, not normatively wrong).
- **Where.** `.context/design-system.md` §3.1 ("Modal opens: focus moves to the first focusable element inside…") and §3.2.
- **Fix (next pass).** Add an explicit line in §3.1: "Focus trap engages and `aria-labelledby` is announced **on `modal.show()`**, not on transition end. The opacity transition is decorative; accessibility behavior is synchronous with mount."

### A-3 — Concatenation risk in the sensitive-feed row strings.

- **Finding.** `en-CA.json` `sensitiveFeed.row.read_action` ("{actor} read {target_type} entry {target_id}") uses ICU-style placeholders correctly — but `target_type` is rendered as a literal value (probably a string like "reprisal" or "concern") which is not itself a translatable key. When fr-CA fills in, a French translator will produce a sentence with an untranslated English noun in the middle.
- **WCAG criterion.** 3.1.2 Language of Parts is engaged if the un-translated word is in another language than the surrounding sentence.
- **Where.** `en-CA.json` lines 289–291 (sensitiveFeed.row.*).
- **Fix (next pass).** Either (a) introduce `sensitiveFeed.target_type.<enum>` and have the renderer substitute the translated label, or (b) introduce one full sentence per `(action, target_type)` pair. Option (a) keeps the catalog small and is the more maintainable shape.

### A-4 — Sensitive-read feed does not specify a maximum announcement burst when many events arrive at once.

- **Finding.** `.context/design-system.md` §4.C sensitive-read feed "realtime new item arriving" — every new row fires `aria-live="assertive"` and a toast. If, e.g., a co-chair completes 3 exports in quick succession, the SR user hears 3 alert announcements stacked, possibly with the toast cap of 3 and an additional row insertion alert — the audit feed (§4.I) compounds this on the same surface. There's no rate-limit or coalescing rule for the SR announcements. RA-1's compensating-control-4 (the rep notification) is the **threat-model** justification for assertive; the a11y mitigation is to coalesce the announcement, not to drop the audit-row.
- **WCAG criterion.** 2.2.4 Interruptions (AAA, advisory) and 4.1.3 Status Messages spirit.
- **Where.** `.context/design-system.md` §4.C "active items present" + "realtime new item arriving" (lines ~167–168).
- **Fix (next pass).** Specify that on burst (≥2 events within 2s of each other), the SR announcement coalesces to "N new sensitive-activity events" with a follow-up assertive announcement only when the user navigates to the feed. **Do NOT change the audit row or the toast-to-feed write-through** — those are RA-1 compensating controls and cannot be weakened. This change is purely the SR live-region behavior.

### A-5 — Recovery-passphrase enrollment (Surface D) is the highest cognitive-load step; the type-back verification on D.6 hides the passphrase and relies on the user holding the printed sheet. A worker with low vision or cognitive impairment who cannot easily read the printed mono passphrase has no alternative path.

- **Finding.** §4 D.6 ("Type the passphrase back to confirm"). The screen explicitly hides the just-shown passphrase so the user must consult the printed sheet (F-08 mitigation). For a screen-reader user, the printed sheet was potentially read aloud one chunk at a time on D.5, which is fine; but for a user with severe low vision who cannot read the printed sheet, the only path is to re-display via "3 wrong attempts → re-display the passphrase". That's a punitive workaround. There is no explicit "I cannot read the printed sheet — show me the passphrase again" link.
- **WCAG criterion.** 3.3.5 Help (AAA, advisory; AA spirit via 3.3.1 Error Identification).
- **Where.** `.context/design-system.md` §4 D.6.
- **Fix (next pass).** Add a secondary, low-prominence link on D.6: `"I can't read the printed sheet — show the passphrase again"`. Tapping it returns to D.4 (re-display) and records the choice in the local-only state. This preserves F-08's type-back-mitigation (the user still types it back) without forcing failure-mode use to access the same path. Threat-modeler should sanity-check that this doesn't create a coercion vector — it doesn't, because the coercion vector is the printed sheet itself (F-41), and re-displaying on demand is no worse than the existing 3-wrong-attempts path.

### A-6 — AODA artifacts are referenced in the plan (§9 "accessibility statement is published; a low-friction feedback channel is provided") but the design system does not define a surface for them. They are launch-blockers per AODA, not commit-blockers.

- **Finding.** No surface in `.context/design-system.md` §4 spec describes an "Accessibility statement" page or an "Accessibility feedback" surface. `JHSC-APP-PLAN.md` §13 item E lists "Privacy policy + accessibility statement + complaints contact published" as a pre-production gate. The design system inherits that gate but doesn't propagate it.
- **AODA reference.** AODA IASR s.14 (accessibility plan + statement), s.11 (feedback process accessible to persons with disabilities). `.context/constraints.md` AODA section.
- **Where.** `.context/design-system.md` — no §4 entry exists.
- **Fix (next pass).** Add a Surface J — "Settings → Accessibility" — with two child surfaces: (a) Accessibility statement (static page surface; can reuse `library` table_variant + a prose layout); (b) Accessibility feedback (a small form surface — name optional, email optional, "what's the problem" textarea, "what device + assistive tech" select, submit goes to the worker co-chair's contact channel; **the feedback form must be itself fully accessible** including keyboard, SR, and reduced-motion). Reference it from the bottom-nav "More" menu. This is **not** a Blocker for token commit (no token is needed); it **is** a Blocker for launch.

---

## 5. What I verified is GOOD (designer got these right; capture for memory-curator)

1. **Two-layer focus ring** (`outer` halo + `inner` line, `design-tokens.json` lines 96–100, 168–171). The construction is GOV.UK-canonical and the right answer for visibility against arbitrary backgrounds — provided the audit gap in B-2 is closed and the "never drop the inner layer" guidance is explicit.

2. **Protected-modal escape policy** (`.context/design-system.md` §3.2 and `design-tokens.json` line 533). Five named modal variants cannot be dismissed by Escape or click-outside. This is the correct a11y posture *and* the correct coercion-resistance posture (RA-1) — they happen to align. A naive a11y "fix" would have made Escape universally dismissive; the designer correctly resisted.

3. **Live-region categorization** (`.context/design-system.md` §3.3 and §4 per-surface). `status` for queued/saved/synced, `alert` for danger and sensitive-activity. The `aria_role` map in `design-tokens.json` lines 555 (`toast.behavior.aria_role`) is correct: info/success/warning are `status`; danger and `sensitive_activity` are `alert`. HG-6 (the sensitive-read announcement) routes through `alert` correctly.

4. **Anonymous-toggle default-ON with advisory on toggle-off** (`.context/design-system.md` §4.B and `en-CA.json` `concern.named.advisory_body` line 180). The advisory is a `alert_banner.sensitive_c4`-style strip + `role="status"`, and the named-source helper text appears *before* the field with `aria-describedby` linkage — this is the right shape for 3.3.2 (Labels or Instructions) and 1.3.1 (Info and Relationships).

5. **48px touch target on inspection and reprisal pipelines** (`design-tokens.json` lines 446–449; `.context/design-system.md` §5.1 bottom nav and §6.5 touch sizing). Exceeds WCAG 2.1 2.5.5 (24×24 in 2.1; 44×44 in 2.2). The 8px adjacent-target spacing rule is also correct.

6. **The "use my location" button is absent** (HG-5 / ADR-0011). `design-tokens.json` line 654 (`photo_capture.location_input: "free_text_only"`) and `.context/design-system.md` §4.E "preview" both explicitly say "no use-my-current-location button". Verified by absence — searched `en-CA.json` and `design-system.md` for any string resembling "use my location" / "current location" — none present.

7. **Anonymous and named source actor are distinct semantically** (F-17): `actor` is never anonymous in the sensitive-feed even when the underlying record is anonymous. `.context/design-system.md` §4.C sensitive-read feed "active items present" — "actor display name (always present even when anonymous on the underlying record — actor is never anonymous per F-17)". This is correct and is the kind of subtle distinction that automation cannot catch.

8. **`audit.action.*` is mostly plain-language** (en-CA.json lines 489–515). Only three entries need rewording (B-3); the other 21 entries name the consequence in plain English.

9. **No third-party fonts** (`design-tokens.json` lines 224–229). System font stacks only. Matches `.context/constraints.md` AODA + no-third-party-JS-at-runtime hard rule.

10. **`fr-CA.json` stub shape matches `en-CA.json` exactly.** Diffed top-level key sets — identical. Every `audit.action.*` enum key, every `a11y.*` sub-key, every per-surface namespace is mirrored with empty values.

11. **Per-record passphrase helper text explicitly says "this is a friction layer, not the crypto"** (`en-CA.json` lines 240, 250). Critical because a sighted user can infer that from the UI flow, but a screen-reader user without the same visual context could misread the friction layer as the cryptographic gate. Designer correctly added the explicit string.

12. **Reduced-motion fallbacks are enumerated per-surface** (`design-tokens.json` lines 402–410), not relegated to a single global media query. Skeletons go flat, spinners get replaced by indeterminate progress bars + text, toasts drop the translate transform — this is the right granularity.

---

## 6. Cross-cutting notes

### 6.1 Real-user testing items (cannot be substituted by this review)

The following require an actual user with assistive technology — flag in the launch-readiness plan, do not skip:

- **Surface D.6 (recovery-passphrase type-back) with a screen reader** — does the user understand they must consult the printed sheet? Does the "X attempts remaining" announcement land at the right cadence?
- **Surface C (reprisal log) with a screen reader on a real phone** — the "Locked — tap to view" pattern is unusual; verify it doesn't read as "tap" while keyboard-navigating on a desktop.
- **Photo capture (Surface E) with VoiceOver on iOS Safari and TalkBack on Android Chrome** — the `<input type="file" capture="environment">` invocation and the post-capture preview flow are both areas where mobile SRs diverge.
- **Sensitive-read feed live-region cadence (Advisory A-4)** with a real SR user — does the assertive announcement on every new row become hostile in burst conditions?
- **Cognitive load on Surface D.2 (hosting tradeoff)** — read the body aloud to a person at a grade-8 reading level who does not work in tech. Do they understand "scrambled bytes"? My instinct is yes (it's a folk-correct metaphor), but verify before launch.

### 6.2 Interactions between accessibility and the security posture (for threat-modeler awareness)

The five protected modals (§3.2) are an alignment point where a11y and coercion-resistance converge — a coerced rep who pressed Escape and saw the export dismiss would not realize the action was reversible without a re-entry, and the protected behavior prevents that confusion as much as it prevents coerced completion. **The threat-modeler should sanity-check Advisory A-2** (focus trap engages on `modal.show()`, not on transition end) — if the focus trap is gated by transition-end, there is a brief window during the 220ms-normal / 100ms-reduced opacity transition where the modal is visually present, focus is not yet trapped, and the user could conceivably interact with the underlying surface. I do not believe this is exploitable in practice (the underlying surface is `aria-hidden` on `modal.show()`, the scrim catches pointer events at `z_index.scrim`, and Escape on the underlying surface is not bound to anything destructive), but it is the kind of interaction-timing window worth a STRIDE pass.

I also surface **Advisory A-5** (the recovery-passphrase low-vision escape hatch) as a CROSS-CUTTING item: the threat-modeler should confirm that a "show me the passphrase again" link does not create a new coercion vector beyond F-41 (which already exists by virtue of the printed sheet itself). My read: no new vector. Route to threat-modeler for second confirmation.

### 6.3 Patterns the designer should carry forward

- **The audit table is a load-bearing document.** It needs every fg/bg pair that actually appears in the spec, not just the canonical-foreground-on-canonical-background pairs. Add audit rows the moment a new background color is used.
- **Plain-language announcements name the consequence, not the event.** "Concern logged" alone is too thin for an SR user — `en-CA.json` already does this well (e.g., `a11y.reprisal.read.logged` names *both* "your read was logged" *and* "other members will be notified"). Apply the same shape to any new announcement.
- **The cognitive-load tradeoff in Surface D (onboarding) is real and unavoidable.** F-08 (printed recovery sheet) and F-41 (sheet coercion) and ADR-0001 (hosting disclosure) all converge on the worker reading legalese they would rather not read. The designer correctly de-lawyered the copy; the accessibility-specialist asks only that one low-vision escape hatch be added (Advisory A-5) and otherwise endorses the tradeoff.
- **Focus-ring layer 2 is non-negotiable.** Add a lint/test that any custom CSS overriding `box-shadow` on a focusable element must include both layers, in `test-writer` phase.

### 6.4 AODA artifact status (pre-launch, not pre-commit)

- **Accessibility statement:** **missing surface** in the design system (Advisory A-6). Not a commit blocker; **is** a launch blocker per AODA IASR s.14 and `JHSC-APP-PLAN.md` §13 item E.
- **Feedback mechanism for accessibility issues:** **missing surface** (Advisory A-6). Same status. Launch blocker.

The designer should add Surface J in the next pass. The librarian and the tech-writer should be made aware that the accessibility statement copy and the feedback-form text are upcoming inputs.

---

## 7. Handoff

**Next step:** designer addresses Blockers B-1, B-2, B-3 per Conditions in §3. The fixes are localized:

- B-1: one token recolor or one find/replace from `foreground.muted` to `foreground.tertiary`, plus one audit-row text correction.
- B-2: eight new audit rows in `color._contrast_audit`, plus one comment line.
- B-3: three string changes in `en-CA.json`.

No second accessibility-specialist pass is required if the Conditions are addressed as written. If the designer chooses a materially different remedy for any item (e.g., changes the focus-ring construction rather than adding the audit rows in B-2), a second pass is required for that item only.

Once Conditions are met: **orchestrator may commit the four design files** (`design-tokens.json`, `.context/design-system.md`, `i18n/en-CA.json`, `i18n/fr-CA.json`) and route to **test-writer**. Test-writer should add:

- A static lint rule that `foreground.muted` (if retained per B-1 option a) is not used in body/hint text contexts.
- A static lint rule that no `box-shadow: outline:none;` or `box-shadow: none` appears on a focusable element without an explicit replacement.
- A test that all five protected modal variants do not call `close()` on Escape or backdrop-click.
- A test that the audit-feed renderer maps every `audit.action.*` enum key to a defined plain-language string (no enum leakage).
- A test that the `fr-CA.json` key set is a structural superset / equal of `en-CA.json` (parity check).

Advisories A-1 through A-6 are logged for the **next design pass** (between MVP and launch), with A-6 (AODA artifacts) being the launch gate per `JHSC-APP-PLAN.md` §13 item E.

---

**End of review.**
