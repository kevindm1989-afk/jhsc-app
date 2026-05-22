# Decisions

Architectural choices made for this project and why.

Append newest on top. Don't delete old entries — superseded decisions get a note
pointing to the new one. The history is the value.

---

## Format

```
## YYYY-MM-DD — Short decision title

**Context:** what we were choosing between and why it mattered.
**Decision:** what we picked.
**Rationale:** why this one over the alternatives.
**Reversibility:** how hard it would be to change later (low / medium / high).
**Superseded by:** (only if applicable, link to newer entry)
```

---

## Entries

---

# ADR-0012: Backup strategy and recovery-testing cadence

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect (ratifying), user (locked in plan §7)

## Context

C3/C4 data is E2EE — the server holds ciphertext. A "complete backup" of the
Supabase project is therefore also a ciphertext blob, useless without the
client-side keys. The hard problem isn't binary durability of the bytes; it's
**key durability** (committee data key + per-user identity keys) and the
ability to restore a working committee state after an outage, ransomware
event, or accidental schema migration.

PIPEDA Principle 7 (Safeguards) and constraints.md require encrypted backups
and a documented restore path. Plan §7 requires recovery to be tested per
`playbooks/backup-restore.md`.

## Decision drivers

- Backups must remain in Canada (PI residency).
- Ciphertext-only at rest, including in backups.
- Recovery must cover three distinct failure shapes: (1) Supabase project
  loss, (2) committee data key loss, (3) individual user identity-key loss.
- Restore must be tested, not just configured.
- Single-tenant, ~50 users — exotic DR (multi-region active-active) is
  unjustified.

## Options considered

### Option A: Supabase PITR (Pro tier) only

**Description:** Use Supabase's built-in Point-In-Time Recovery (7-day window
on Pro, configurable up to 28 days), no second copy.

**Pros:**
- Zero ops; covered by the platform.
- Inside `ca-central-1`.

**Cons:**
- Single-vendor durability story. If the Supabase project is destroyed
  (account compromise, billing lapse, vendor incident), PITR doesn't help.
- No protection against a malicious or buggy migration that gets PITR'd
  forward then ages out.

### Option B: Supabase PITR + nightly `pg_dump` to a separate Canadian S3-compatible bucket

**Description:** PITR for short-window recovery; `pg_dump` (custom format,
compressed, encrypted with a key the bucket provider doesn't hold) shipped
nightly to a second Canadian region (e.g., Backblaze B2 or AWS S3 ca-central),
35-day rolling retention. Restore drill quarterly.

**Pros:**
- Two independent durability domains.
- Encrypted-at-rest with our key, so the bucket provider is *not* a PI
  processor for plaintext — it's a ciphertext blob holder. The PI inside
  the dump is already C3/C4 ciphertext at the row level; the dump itself
  is wrapped again.
- Restore drill is forcing-function for proving the playbook.

**Cons:**
- One more vendor to evaluate (lightweight — they don't see plaintext).
- Slight ops overhead (a GitHub Actions cron job, monitoring).

### Option C: Self-managed warm standby in a second region

**Description:** Streaming replication to a self-managed Postgres in a
second Canadian region.

**Pros:**
- RPO near zero.

**Cons:**
- Way over-engineered for 50 users. Re-introduces ops burden we explicitly
  shed by choosing Supabase Cloud.
- Cost.

## Decision

**We choose Option B.**

### Rationale

PITR alone is single-vendor. Option C is over-engineered. Option B gives us
a second, independent durability domain at low cost and forces a real
restore drill.

**Operational rules:**
- **PITR window:** 7 days (Pro default).
- **`pg_dump` cadence:** nightly at 03:00 ET, encrypted with a libsodium
  secret box; the dump key is held in 1Password Business (user account)
  and printed on paper in the worker co-chair's possession (key escrow
  outside any cloud).
- **Off-site bucket:** Backblaze B2 in Canadian region OR AWS S3 ca-central
  — confirmed before T01 ships. The bucket provider is **not** a PI
  processor (encrypted blob only) but is listed in `SUBPROCESSORS.md`.
- **Retention:** 35 days rolling, then hard delete.
- **Restore drill:** quarterly. The drill restores into a scratch Supabase
  project, runs migrations, decrypts a known fixture record with a test
  committee key, and produces a signed restore report.
- **Key-loss recovery:**
  - **Committee data key loss** → at least one remaining member with a wrapped
    copy can re-wrap to the rest. If *all* members lose access, the data is
    cryptographically gone. This is by design (T1, T5).
  - **Individual identity-key loss** → user prints a recovery passphrase at
    enrollment that decrypts an identity-key backup blob stored on the
    server. Loss of both the device and the passphrase = re-enroll as a
    new user, lose history; document this on the recovery screen.

### Reversibility

**Easy.** Switch buckets or providers without touching app code; restore
playbook stays the same.

## Consequences

### Positive
- Two-vendor durability without two-vendor PI exposure.
- Restore drill becomes routine, not a surprise.

### Negative / accepted tradeoffs
- Total key loss = total data loss. Documented; this is the price of E2EE.
- One more thing to monitor (dump job freshness).

### Risks
- Dump job silently failing → mitigated by alert if last successful dump
  is >36 hours old.
- Key escrow procedure not followed → mitigated by quarterly drill that
  fails if the key isn't usable.

## Compliance check

- [x] Aligns with constraints.md (Canadian residency, encrypted at rest).
- [x] No new PI processor (bucket holds ciphertext blob).
- [x] DPA needed with bucket provider (standard SOC2 + region commitment).
- [x] Documented in plan §7.

## Follow-ups

- [ ] T17 — write `playbooks/backup-restore.md` and schedule first drill before launch.
- [ ] Add bucket provider to `SUBPROCESSORS.md` once chosen.

---

# ADR-0011: No native iOS/Android apps in v1 — PWA only

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 10), architect ratifying

## Context

Threat T10 in plan §4: "Forced disclosure of who installed the app."
App-store presence creates a record at Apple/Google tying a real-name
account to JHSC-app installation. For a tool whose users are protected
under OHSA s.50 (anti-reprisal), that record is itself a reprisal vector
— an employer with a court order, or a state actor, can subpoena the
store to learn which workers installed it.

PWAs install from the browser. No store account, no install record at a
third party. The user already locked this decision; this ADR ratifies the
reasoning.

## Decision drivers

- T10 (store install record as reprisal vector).
- No third-party PI processors beyond Supabase (constraints.md hard rule).
- Single small team; one codebase is cheaper to secure than three.
- Offline + push are partially achievable in modern PWAs (iOS 16.4+, all
  modern Android).

## Options considered

### Option A: PWA only

**Description:** Single SvelteKit PWA, installable from the browser,
service worker for offline.

**Pros:**
- No app-store PI processor.
- One codebase, one CSP, one update path.
- Auto-update; no abandoned-old-version users.

**Cons:**
- iOS push is recent and quirky.
- Some platform APIs (background sync on iOS) are limited.
- Users have to know about "Add to Home Screen."

### Option B: Native iOS + Android (React Native or Capacitor)

**Description:** Native shells over a web view or RN.

**Pros:**
- Better push, background sync, biometric integration.
- Familiar install path.

**Cons:**
- **Apple and Google become PI subprocessors** (install records,
  device-bound IDs, crash reports if not disabled). Each requires a
  flagged-human-gate decision.
- US-based platforms; cross-border concern even for metadata.
- Three codepaths to harden, three review cycles per release.
- Store review can delay security fixes.

### Option C: PWA + native shells later for opt-in users

**Description:** Ship PWA in v1; revisit native later when complaints justify it.

**Pros:**
- Keep the v1 attack surface minimal.
- Decision can be re-opened with real data.

## Decision

**We choose Option A for v1. Option C is the migration path.**

### Rationale

T10 is the primary driver. Even one "PWA-only" launch user materially
reduces the reprisal-vector surface area. Native is a v2 conversation
gated on real complaint volume, with a fresh human-gate review of
Apple/Google as processors.

### Reversibility

**Medium.** Adding native shells later is a defined project — not a flag
flip, but not a rewrite. Domain stays the same; auth stays the same;
the crypto core stays the same.

## Consequences

### Positive
- No app-store install record.
- No Apple/Google as subprocessors.
- One CSP, one update path.

### Negative / accepted tradeoffs
- iOS push experience is weaker than native.
- "Add to home screen" requires education in onboarding copy.

### Risks
- iOS Safari changes that break PWA install. Mitigated by tracking
  webkit-dev signals and degrading to in-browser use (still functional).

## Compliance check

- [x] No new PI subprocessor.
- [x] Aligns with constraints.md.
- [x] Mitigates T10.

## Follow-ups

- [ ] Onboarding copy explains why no store install (links to this ADR
      in plain English).
- [ ] `KNOWN-GAPS.md` lists native as v2.

---

# ADR-0010: Error tracking — Sentry SaaS with strict PI scrubbing

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect

## Context

We need error tracking so the implementer and incident-responder can debug
production issues. Plan §7 lists "self-hosted Sentry (or equivalent)" as
the preferred direction, but we should commit to one in an ADR and weigh
the operational cost of self-hosting against the PI-exposure cost of SaaS.

Constraints.md forbids any third-party that processes PI **without a flagged
human-gate decision and a DPA**. Whichever option we pick, the rule is the
same: **no PI may leave the app via error tracking**, regardless of provider.

## Decision drivers

- No PI in telemetry (constraints.md).
- Canadian / EU residency.
- Team-of-one ops capacity — running an extra service has real cost.
- Auditability of what gets sent.
- Speed of getting actionable errors in front of the implementer.

## Options considered

### Option A: Sentry SaaS, EU region, with SDK-layer scrubbing

**Description:** Sentry's EU-hosted instance (Frankfurt). PI scrubbing is
done at the SDK *before* the event leaves the browser/server:
- `beforeSend` strips all `request.cookies`, `request.headers.authorization`,
  query params, form body fields.
- Allowlist of breadcrumb categories; everything else dropped.
- No user identifier sent (no `Sentry.setUser`).
- Source maps uploaded privately; not exposed.
- Tags limited to: environment, release SHA, route name (no params).

Sentry GmbH has a DPA, signs SCCs, and is GDPR-aligned. PIPEDA-comparable
safeguards present.

**Pros:**
- Zero ops.
- Mature product; good UX for triage.
- EU residency is PIPEDA-comparable; documented in DPA.

**Cons:**
- A third party sees *something* (scrubbed payloads, IPs unless we strip).
  Even with aggressive scrubbing, residual risk of accidental PI leak via
  a new code path the scrubber doesn't know about.
- Sentry Inc. is US-incorporated even if the EU instance is in Frankfurt;
  CLOUD-Act-reachable in principle. (Same shape as Supabase, but for
  scrubbed metadata not committee data.)
- Cross-border data flow (Canada → EU); document but not PI in normal flow.

### Option B: Self-hosted GlitchTip in `ca-central-1`

**Description:** GlitchTip is an open-source, Sentry-protocol-compatible
error tracker. Run it on a small VM or in Supabase-adjacent infra in
Canada.

**Pros:**
- No third-party PI processor at all.
- Fully Canadian residency.
- Same SDK story as Sentry.

**Cons:**
- Real ops burden for a team-of-one: patching, monitoring, backups,
  capacity, the meta-question of "what monitors the monitor."
- If GlitchTip is down, errors are lost (not the worst — but means we
  miss bugs).

### Option C: No error tracker; rely on structured logs

**Description:** Just log to Supabase logs / a Canadian log sink.

**Pros:**
- Simplest.

**Cons:**
- No stack-trace aggregation, no de-dup, no release tagging. The
  implementer will be blind to client-side errors.
- Reactive: we hear about bugs from users, late.

## Decision

**We choose Option A: Sentry SaaS (EU region) with strict SDK-layer scrubbing.**

### Rationale

The decisive factor is that the scrubbing posture makes Sentry **not a PI
processor by design** — we don't send PI; we send scrubbed stack traces and
breadcrumb metadata. The DPA + EU region cover the residual exposure. A
team-of-one cannot reliably run a self-hosted error tracker; a flaky
error tracker is worse than a SaaS one because we'll silently miss bugs.

This is a flagged-human-gate processor under constraints.md rule #3 — the
flag is this ADR. The mitigation is the scrubbing contract verified in
CI (semgrep rule + scrubbing test fixture).

### Reversibility

**Easy.** Sentry SDK is protocol-compatible with GlitchTip; swap the DSN
to migrate.

## Consequences

### Positive
- Actionable error data in front of the implementer fast.
- No ops burden.

### Negative / accepted tradeoffs
- Sentry Inc. is a US-incorporated processor (scrubbed metadata only).
- Cross-border flow Canada → EU (metadata, not PI).

### Risks
- A new code path accidentally sends PI (e.g., a form-validation error
  containing the user's input). Mitigated by:
  - `beforeSend` deny-by-default for fields not on an allowlist.
  - CI test that submits known-PI input and asserts the captured Sentry
    payload contains none of it.
  - Semgrep rule banning `Sentry.captureException(err, { extra: { ... } })`
    with non-allowlisted keys.
- Sentry breach exposes scrubbed metadata. Residual risk: low; we treat
  Sentry payloads as if they were public.

## Compliance check

- [x] DPA in place (Sentry's standard DPA + SCCs).
- [x] EU region (PIPEDA-comparable; documented).
- [x] No PI sent (verified in CI).
- [x] Listed in `SUBPROCESSORS.md`.
- [x] Cross-border flow documented (no PI in flow).

## Follow-ups

- [ ] T02 — observability-setup writes the `beforeSend` scrubber + CI test.
- [ ] Add Sentry to `SUBPROCESSORS.md`.
- [ ] Semgrep rule prohibits non-allowlisted extras.

---

# ADR-0009: i18n catalog from day 1; English at launch

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 7), architect ratifying

## Context

Plan §13 locks: English-only at launch, but the i18n catalog must be
scaffolded from day 1. The pack lesson is that retrofitting i18n into a
codebase with hard-coded strings is expensive and error-prone — every PR
becomes a localization PR.

French (`fr-CA`) is the planned second locale; it ships when needed (any
French-speaking committee member), via the localization-specialist agent
as a translation task, not a refactor.

## Decision drivers

- Don't pay the i18n retrofit tax later.
- Don't pay for fr-CA strings we don't have yet.
- Locale-aware date/number/currency formatting from day 1 (Ontario
  contexts: 2026-05-22, not 5/22/2026).
- Accessibility-statement language attribute correctness.

## Options considered

### Option A: i18n library scaffolded, en-CA only at launch

**Description:** Use `svelte-i18n` (if SvelteKit) or `next-intl` (if Next).
All UI strings go through `t()` from day 1. Catalog file
`src/i18n/en-CA.json` exists; `src/i18n/fr-CA.json` exists with the same
keys but empty values (so missing-key checks pass and the structure is
stable).

**Pros:**
- Adding fr-CA later is a translation pass, not a refactor.
- Locale-aware formatting from day 1.
- ESLint rule `no-literal-string` (or equivalent) prevents regression.

**Cons:**
- Slightly more verbose components.
- Translators need to be briefed; not a v1 burden.

### Option B: Hard-coded English now, retrofit later

**Description:** Just write English strings; add i18n when we need French.

**Pros:**
- Slightly less code.

**Cons:**
- This is the exact pack lesson we wrote down — don't do it.

### Option C: i18n + machine-translated fr-CA from day 1

**Description:** Generate fr-CA strings with MT, ship dual locale.

**Pros:**
- French users covered immediately.

**Cons:**
- MT quality on labour-law and OHSA terms is poor.
- Constraints.md forbids third-party AI processors without a flagged
  decision; this is one.
- Bad French is worse than no French in a legal-adjacent tool.

## Decision

**We choose Option A.**

### Rationale

Direct application of the pack lesson. Cheap insurance now; expensive
debt later. Option C trades the wrong kind of risk (translation quality
on legal terms).

### Reversibility

**Easy.** Adding fr-CA = a translation task. Adding more locales beyond
that = same task, repeated.

## Consequences

### Positive
- Future-proof; adding French is straightforward.
- Locale-aware formatting from day 1.

### Negative / accepted tradeoffs
- Slight upfront discipline cost.

### Risks
- Developer forgets to use `t()`. Mitigated by ESLint rule fail-on-CI.

## Compliance check

- [x] AODA: accessibility statement will use correct `lang` attribute.
- [x] No third-party MT processor (Option C rejected).

## Follow-ups

- [ ] T03 — localization-specialist scaffolds catalog and lint rules.
- [ ] Catalog includes a "review needed" marker for OHSA legal-term
      translations; user + labour lawyer review when fr-CA ships.

---

# ADR-0008: Personal-device-only posture — advisory, not enforced

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 6), architect ratifying

## Context

Plan §3.2 ("Worker-side-only ★") prohibits employer-network dependency.
Plan §13 locks the device stance as personal-device-only, advisory only.

A PWA cannot reliably detect:
- MDM enrollment.
- Whether the device is employer-owned.
- Whether DNS, certificates, or proxy infrastructure are employer-controlled.

Even best-effort detection (e.g., DoH probes, certificate-pin checks) is
unreliable and a wrong "your device is monitored" warning is worse than
none. Threat T2 (employer obtains content via employer-owned device) is
real and we can only mitigate it with UX nudges and session hygiene.

## Decision drivers

- T2 mitigation.
- Don't lie about technical enforcement we can't deliver.
- Don't false-positive a clean device as compromised.
- Workers may not have a personal smartphone — onboarding must address this.

## Options considered

### Option A: Hard block via heuristics

**Description:** Probe for MDM/proxy signals; refuse to load if any
positive signal.

**Pros:**
- Looks strong on a slide.

**Cons:**
- High false-positive rate on legitimate setups (corporate-pinned home
  WiFi, university captive portals).
- High false-negative rate on actual MDM (modern MDM is invisible to
  web apps).
- Lock-out is a worse failure mode than warning.

### Option B: Advisory + session hygiene + visible posture

**Description:**
- First-launch screen: "This app is intended for personal devices. If
  you are reading this on an employer-issued device, your employer may
  be able to read what you do here. Don't install. Use a personal phone."
- Settings shows current device fingerprint (UA + platform), last
  installed timestamp, "this device" with a "forget this device" action.
- Session hygiene: 15-min auto-lock; passkey re-auth on resume; no
  persistent refresh tokens; "panic wipe" wipes IndexedDB.
- No content cached on disk beyond what the active session needs;
  optional "cache for offline inspection" is opt-in per inspection.
- Onboarding copy includes "if you don't have a personal smartphone,
  speak to the worker co-chair" — they may have a committee-managed
  device that lives in a locker.

**Pros:**
- Honest about what the app can and can't enforce.
- Layered: warning → behavior → recovery.

**Cons:**
- Some users will install on employer devices anyway. Documented.

### Option C: Require attestation (WebAuthn attestation)

**Description:** Use platform attestation to verify the authenticator
isn't employer-controlled.

**Pros:**
- Strongest signal.

**Cons:**
- WebAuthn attestation doesn't tell us if the device is employer-owned;
  only that the authenticator is genuine.
- Privacy-hostile (attestation can be a tracking vector).

## Decision

**We choose Option B.**

### Rationale

The hard problem is honest framing. Option A gives the wrong impression
of enforcement. Option C answers the wrong question. Option B layers
advice + session hygiene + recovery so the residual T2 risk is reduced
without lying about it.

### Reversibility

**Easy** for advisory copy. **Medium** for session hygiene — these are
behavior choices, not data choices.

## Consequences

### Positive
- Honest UX.
- Real reduction in T2 risk via session hygiene.
- Recovery (panic wipe, session revocation) gives a coerced user a
  visible action.

### Negative / accepted tradeoffs
- We can't prevent a determined user from installing on the wrong
  device.

### Risks
- A worker without a personal smartphone is excluded. Mitigated by
  shared committee device option (locker), called out in onboarding.

## Compliance check

- [x] No covert telemetry (no MDM-detection ping).
- [x] No third-party attestation processor.

## Follow-ups

- [ ] Designer + tech-writer craft onboarding copy (T08, T18).
- [ ] T19 — panic-wipe + session revocation tested.

---

# ADR-0007: Concern intake — committee-members-only, no public endpoint

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 3), architect ratifying

## Context

Plan §2.2 task 1 and §13 lock concern intake as committee-members-only.
A worker rep enters a concern on behalf of a worker; there is no public
form, no anonymous web submission, no email ingestion.

## Decision drivers

- Reduce attack surface — no unauthenticated write path means no spam,
  no enumeration, no abuse vector.
- Preserve labour-relations privilege — the rep mediates submission;
  the rep is the legitimate channel.
- Anonymity of the original complaining worker is achieved via the
  rep's "anonymous source" toggle, *not* by an anonymous public form.
- Eliminate the "worker fills it out at their desk on the employer
  network and it shows up in logs" failure mode.

## Options considered

### Option A: Committee-members-only intake (locked)

**Description:** Only authenticated committee members can write to the
concerns table. Source can be marked anonymous (default ON) or have a
worker name attached (name is E2EE under committee key).

**Pros:**
- Minimal attack surface.
- Privilege story is intact.
- RLS enforces it server-side; no public route.

**Cons:**
- Workers without rep access depend on the rep being responsive.
  Process risk, not a tech risk.

### Option B: Public unauthenticated form

**Pros:**
- Workers can submit without going through a rep.

**Cons:**
- Spam, enumeration of committee existence.
- Submission from employer network has all the IP/header risks.
- Requires CAPTCHA → third-party processor.
- Worse privilege posture.

### Option C: Email-to-app intake

**Pros:**
- Familiar.

**Cons:**
- Email is the worst possible privacy channel for this content;
  contents pass through SMTP relays, anti-spam, mailbox providers.

## Decision

**We choose Option A — locked.**

### Rationale

Locked by plan §13. The ADR records the rationale and the constraints:
- No public route exists in the app — confirmed by route inventory in CI.
- Concerns table RLS denies INSERT unless `committee_membership.active = true`.
- "Anonymous source" toggle in the rep's form defaults to ON.
- Name field, when present, is encrypted client-side before submission.

### Reversibility

**Hard.** Opening a public surface later would be a v2 design exercise
with a fresh threat model. Don't.

## Consequences

### Positive
- Tiny attack surface.
- Privilege intact.
- T8 (account enumeration) addressed structurally.

### Negative / accepted tradeoffs
- Workers must reach a rep to submit. Mitigated by "How to raise a
  concern" doc the committee distributes off-app.

## Compliance check

- [x] No public PI ingress.
- [x] Anonymous-by-default per PIPEDA proportionality.

## Follow-ups

- [ ] T08 — intake form built with anonymous toggle defaulted ON.
- [ ] Route inventory test in CI fails on any new public POST route.

---

# ADR-0006: Frontend framework — SvelteKit

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect

## Context

Plan §5.2 leaves the choice between SvelteKit and Next.js 15 App Router
to the architect. Both are credible TypeScript-first frameworks with
PWA stories, both work fine on top of Supabase. The choice has
medium reversibility (a sprint to swap, plus a re-test of every page) so
we should commit and justify.

The app is:
- Mobile-first, PWA-installable, offline-capable for inspections.
- ~10–20 distinct screens at launch.
- Built by a team of one + the agent pack.
- Performance-sensitive on shop-floor devices (older Android, weak signal).
- E2EE-heavy — client-side crypto runs on hot paths.

## Decision drivers

- PWA story (manifest, service worker, install prompt).
- Bundle size on first paint (shop-floor users on weak networks).
- Mental-model simplicity for a team of one.
- Compatibility with libsodium-wrappers (WASM) on the client.
- Server-side rendering for the small set of authenticated SSR pages
  (auth callback, share-link landings if any) — both options handle this.
- Long-term maintainability and ecosystem health.

## Options considered

### Option A: SvelteKit (v2+)

**Description:** Svelte components + SvelteKit's file-based routing,
adapter-static or adapter-node deployment, Vite under the hood. Service
worker via Workbox or hand-rolled. Stores for client state.

**Pros:**
- **Bundle size:** typically 40–60% smaller than equivalent Next routes
  for similar UX. On a shop floor with weak signal, this matters.
- **Mental model:** runes/stores are simpler than RSC + Server Actions
  + Client Components. One mental boundary (server vs. client) instead
  of three (server-component vs. client-component vs. server-action).
- **PWA story:** SvelteKit's service-worker integration is first-class;
  the `service-worker.ts` file is a documented hook.
- **libsodium-wrappers:** runs cleanly client-side; no RSC/streaming
  pitfalls.
- **Forms-first:** SvelteKit's form actions are the natural fit for the
  intake/inspection flows; progressive enhancement out of the box.

**Cons:**
- **Smaller ecosystem** than React. Some niche libraries (e.g., a
  fancy table) don't exist; we either roll our own or pick a less-
  loved alternative. For this app the component set is small and we'd
  build it ourselves anyway.
- **Smaller talent pool** if the team grows. Mitigated: not growing in
  v1; component model is easy enough to onboard.

### Option B: Next.js 15 App Router

**Description:** React 19 + RSC + Server Actions, Vercel-or-Node deploy,
service worker bolted on.

**Pros:**
- Largest ecosystem.
- Server Components reduce some client JS for read-only pages.
- React talent pool huge.

**Cons:**
- **RSC complexity** adds mental load — "is this a client component?
  why is this hook erroring? what's serializable across the boundary?"
  For a team of one, this is real cognitive tax.
- **Bundle size** is larger out of the box; RSC helps for static-ish
  pages but our pages are almost all interactive (forms, crypto).
- **libsodium + RSC:** WASM in client components is fine, but the
  client/server split makes it easy to accidentally pull crypto into a
  server bundle where it shouldn't be.
- **Vendor pull:** Next is increasingly Vercel-flavored; we're not on
  Vercel (we're on Supabase + Cloudflare Pages or Netlify-like). Works,
  but more friction than the framework's "default" path.
- **Service worker:** less first-class than SvelteKit's.

### Option C: Remix / React Router v7

**Description:** React framework focused on forms + progressive
enhancement.

**Pros:**
- Forms-first philosophy aligns with our intake/inspection flows.

**Cons:**
- The Remix → React Router merger is recent; ecosystem in flux.
- Same RSC-direction signals as Next; less stable.

## Decision

**We choose Option A: SvelteKit.**

### Rationale

Three decisive factors:
1. **Bundle size on weak networks** is a real shop-floor constraint.
2. **Mental simplicity for a team of one** — SvelteKit has one
   client/server boundary; Next has three.
3. **Crypto on the client without RSC footguns** — libsodium runs hot
   in this app; we don't want to fight the server/client split.

Ecosystem size doesn't matter for an app this size; we build our own
small component set anyway and the table of dependencies is short.

### Reversibility

**Medium.** Migrating to Next later would be a sprint or two — same
data layer, same Supabase, same crypto core. Components rewrite, but
the app surface is small. Don't migrate without a stated reason.

## Consequences

### Positive
- Smaller bundles → faster first paint on shop-floor devices.
- Simpler mental model → fewer bugs from team-of-one churn.
- First-class PWA + service worker story.
- libsodium client-only, no server-bundle leakage risk.

### Negative / accepted tradeoffs
- Smaller talent pool if we ever hire.
- Some libraries don't exist; build or find alternatives.

### Risks
- A future maintainer doesn't know Svelte. Mitigated: the agent pack
  knows it; Svelte's learning curve is gentle.
- SvelteKit major-version breaking changes. Mitigated: pin, upgrade
  deliberately, dependency-manager weekly.

## Compliance check

- [x] No new third-party PI processor implied by framework choice.
- [x] Service worker hosted on our origin (no CDN of someone else's JS).
- [x] CSP can be locked down (no inline-eval needed by SvelteKit prod build).

## Follow-ups

- [ ] T01 — scaffold SvelteKit with `adapter-static` (since auth is
      Supabase-side and most routes are client-rendered after login)
      OR `adapter-node` if SSR for auth callbacks is needed. Decide
      during scaffold based on final auth-callback shape.
- [ ] Designer's tokens emitted as CSS custom properties — framework-
      agnostic, easier to port if we ever reverse this.

---

# ADR-0005: Single-tenant v1 — no multi-committee paths in code

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 1), architect ratifying

## Context

Plan §13 locks the workplace context as one JHSC, one workplace (50+
workers, single site). Plan §5.1: "Multi-tenant code paths are
intentionally **not** built in v1; if a second committee adopts later,
that's a v2 project."

The temptation to build "tenant_id everywhere, just in case" is real
and exactly what the constraints warn against ("no premature
genericness").

## Decision drivers

- Smallest possible attack surface.
- Simplest RLS policies (no `current_setting('app.tenant_id')` ceremony).
- No "noisy neighbor" reasoning about multi-tenancy.
- Future second-committee adoption = v2 design exercise with fresh threat
  model, fresh ADR, fresh data-segregation work.

## Options considered

### Option A: Single-tenant (locked)

**Description:** One Supabase project, one committee. Tables don't have
`tenant_id`. RLS policies key off `committee_membership.user_id =
auth.uid()`.

**Pros:**
- Minimal RLS surface.
- No cross-tenant exposure possible by construction.
- Easier audit.

**Cons:**
- Adding a second committee later = new Supabase project + onboarding
  process, OR a real multi-tenancy refactor. Either is a v2 project.

### Option B: Multi-tenant with `tenant_id` everywhere

**Pros:**
- "Future-ready."

**Cons:**
- Every table grows a column we don't need.
- Every RLS policy gains a join.
- Risk of a missing `WHERE tenant_id = ...` somewhere is the highest-
  severity bug class in multi-tenant SaaS.
- We're not selling this. The "future" isn't a market — it's at most a
  second pilot in two years.

## Decision

**We choose Option A — locked.**

### Rationale

Per plan §13. The smallest attack surface in v1 is the right one. If a
second committee ever adopts, we re-design with the benefit of having
operated v1.

### Reversibility

**Hard** to add multi-tenancy retroactively, **easy** to spin up a second
Supabase project for a second committee (n=2 is fine; not many committees
will adopt).

## Consequences

### Positive
- RLS policies stay short and reviewable.
- Onboarding = one committee key, period.

### Negative / accepted tradeoffs
- Second-committee adoption is a project, not a config.

## Compliance check

- [x] Aligns with "no premature genericness" in constraints.

## Follow-ups

- [ ] `KNOWN-GAPS.md` notes multi-tenancy as v2.

---

# ADR-0004: Row-Level Security on every table — mandatory, policies version-controlled

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect

## Context

Plan §5.2 lists RLS as mandatory. Supabase's defining feature for our
use case is Postgres RLS enforced at the database level — even a bug in
app code can't bypass it. This ADR ratifies that RLS is the **authoritative**
authorization layer, that every table without exception has policies, and
that policies live in version-controlled migrations next to schema.

## Decision drivers

- Defense in depth: app bug = no data leak if RLS holds.
- Auditability: policies are SQL files in the repo, reviewable per PR.
- Migration discipline: policies move with schema, never out of sync.
- Test-writer can write policy tests against a real Postgres.

## Options considered

### Option A: RLS on every table, policies as SQL in `drizzle` migrations

**Description:** Every `CREATE TABLE` migration includes a
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and one or more
`CREATE POLICY` statements. No table can ship without policies.
A CI check fails if any table is missing RLS.

**Pros:**
- Authoritative at the data layer.
- Reviewable in PRs.
- Survives any app-layer bug.

**Cons:**
- More SQL to read.
- Policies must be tested (we will — test-writer covers).

### Option B: RLS on PI tables only; app-layer authz elsewhere

**Pros:**
- Less SQL.

**Cons:**
- "Elsewhere" is exactly where a bug will land.
- Two authz models = bugs at the seam.

### Option C: App-layer authz only (RLS off)

**Pros:**
- Familiar.

**Cons:**
- Loses Supabase's central value-prop for this use case.
- App-layer bug → data leak.

## Decision

**We choose Option A.**

### Rationale

This is the defining safety property of Supabase + RLS, and the entire
threat model leans on it. App code is allowed to bug; RLS is not.

**Operational rules:**
- Every `CREATE TABLE` migration in the same file includes RLS + policies.
- `verify.sh` includes a check: `SELECT relname FROM pg_class WHERE
  relkind='r' AND relrowsecurity=false AND relnamespace = ...` returns
  zero rows in CI.
- Test-writer writes policy tests for every table: positive (the right
  user can read) and negative (the wrong user cannot).
- Policy changes go through the same review as schema changes —
  migration-handler + security-reviewer.

### Reversibility

**Hard** to remove RLS once data is there (we'd be removing the safety
property). Not a thing we'd reverse.

## Consequences

### Positive
- Bugs in app code don't become data leaks.
- Policies are reviewable artifacts.

### Negative / accepted tradeoffs
- More SQL per migration.
- Test-writer's load grows with each table.

### Risks
- Performance hit from policy joins. Mitigated by sensible indexes (every
  policy that uses `committee_membership` joins through an indexed FK).

## Compliance check

- [x] Aligns with constraints.md "least privilege."
- [x] Auditable.

## Follow-ups

- [ ] T04 — RLS-coverage check in `verify.sh`.
- [ ] Test-writer policy-test pattern documented in scaffold task.

---

# ADR-0003: E2EE key model — per-user identity + per-committee data key

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 9), architect ratifying

## Context

Plan §5.3 specifies the key model in detail. This ADR ratifies the choice
and writes down the **invariants** that downstream agents must not violate.
This is the load-bearing mitigation for the Supabase hosting tradeoff
(ADR-0001); if E2EE leaks plaintext to the server, the hosting choice is
no longer defensible.

## Decision drivers

- Server never sees plaintext for C3/C4 data.
- Per-user identity so removing a user is meaningful.
- Per-committee data key so all members can read shared content.
- Rotation on member removal (forward secrecy from the removed member).
- Recovery from device loss without weakening the model.

## Options considered

### Option A: Per-user identity + per-committee data key, wrapped per member (locked)

**Description:**
- Each user generates an X25519 identity keypair client-side at first login.
- Private key encrypted with a passkey-derived secret + stored locally
  in IndexedDB. A backup blob is stored on the server, encrypted with a
  user-supplied recovery passphrase the user prints.
- Each committee has an X25519 data keypair. The data private key is
  wrapped once per active member to that member's identity public key
  (libsodium `crypto_box_seal`), stored on the server.
- C3 records are encrypted to the committee public key using
  `crypto_box_seal` (anonymous-sender sealed box).
- C4 records add a per-record symmetric key (libsodium `secretbox`)
  whose key is also wrapped to the committee key — so unsealing C4
  requires unsealing the per-record key first, giving a separate
  decryption step the audit log captures.
- Member removal: a remaining member re-generates the committee data
  keypair, re-encrypts all existing wrapped blobs to all remaining
  members' identity public keys, and revokes the removed member's
  passkey/session. New records use the new key. Old ciphertext keeps
  the old wrap chain but the removed member's wrapped copy is deleted.

**Invariants (the threat-modeler will turn these into tests):**

1. **Server never sees a private key in the clear.** Identity privates
   exist client-side or as ciphertext-on-server. Committee data privates
   exist only as wrapped blobs.
2. **No "admin recovery."** There is no server-side mechanism to recover
   a forgotten passphrase + lost device. (Documented in onboarding.)
3. **No plaintext caching server-side**, including in Edge Functions.
   Edge Functions handle ciphertext, metadata, and notifications only.
4. **All encryption is libsodium primitives** — no homegrown crypto, no
   AES-GCM hand-rolled. `libsodium-wrappers` is the only crypto library.
5. **Key material in URLs is forbidden** — semgrep rule.
6. **Rotation is atomic** — either the new wraps are present for all
   remaining members and old member's wrap is gone, or the operation
   fails and is retried. (Migration-handler enforces.)
7. **C4 records require a second decrypt step** logged in the audit log
   (which is C1, not encrypted, so the metadata is reviewable).

### Option B: Per-user keys only; no committee key (each record encrypted N times)

**Description:** Each shared record is encrypted to every committee
member's public key.

**Pros:**
- No "committee key" rotation problem.

**Cons:**
- Storage explodes (N copies of every blob).
- Adding a new member requires re-encrypting every record they should
  see, in their browser, at invite time. UX nightmare on 1000+
  records.
- Removing a member requires re-encrypting nothing — the record stays
  encrypted to their old key. **No forward secrecy from the removed
  member**. Worse than Option A.

### Option C: Server-side encryption only (no E2EE)

**Pros:**
- Standard, simple.

**Cons:**
- Defeats the entire point of the design. Plan §1 says explicitly that
  the server's compromise must not reveal worker-side content.

## Decision

**We choose Option A — locked.**

### Rationale

Locked by plan §13. Option B fails forward secrecy. Option C invalidates
the hosting tradeoff. Option A is the only viable path; the invariants
above are non-negotiable.

### Reversibility

**Hard.** Once data is encrypted under this model, switching models means
re-encrypting all data through every user's browser. Decide once, get
it right.

## Consequences

### Positive
- Server compromise yields ciphertext only for C3/C4.
- Removal rotation gives forward secrecy from removed members.
- Audit log can record decryption attempts (per-record key access).

### Negative / accepted tradeoffs
- No admin recovery; lost passphrase + lost device = lost user.
- Client crypto on hot paths (manageable; libsodium-wrappers WASM is fast).
- Rotation is a complex operation; needs careful testing.

### Risks
- Implementation bug leaks plaintext to server. Mitigated by:
  - second-opinion-reviewer on every PR touching crypto;
  - integration test asserting all writes to C3/C4 columns are well-
    formed ciphertext (entropy + nonce check);
  - semgrep rule banning `fetch(...)` of a known-plaintext type to a
    Supabase endpoint from outside the encryption module.
- Recovery passphrase loss → user data loss. Mitigated by enrollment
  flow that forces the user to print AND verify the passphrase before
  exiting setup.
- Rotation race conditions on member removal. Mitigated by serializing
  rotations through an Edge Function that takes a per-committee
  advisory lock.

## Compliance check

- [x] Aligns with PIPEDA Safeguards (Principle 7).
- [x] Aligns with constraints.md (AES-256+, E2EE on sensitive worker
      content per plan).
- [x] Reduces residual exposure of ADR-0001.

## Follow-ups

- [ ] T05 (auth) precedes T07 (crypto core).
- [ ] T07 second-opinion-reviewer is mandatory.
- [ ] Threat-modeler verifies invariants 1–7 as testable assertions.

---

# ADR-0002: Authentication — passkeys (WebAuthn) only, via Supabase Auth

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 8), architect ratifying

## Context

Plan §13 locks Supabase Auth, passkeys only, TOTP for first-device
enrollment, removed once a passkey is set, no SMS, no password fallback.

This ADR ratifies the choice and records the **operational constraints**
that downstream agents must follow.

## Decision drivers

- Phishing resistance (T7).
- No SIM-swap or carrier-visible auth (T6, T11).
- No password leaks possible because there are no passwords.
- Multi-device for committee members who use a phone + laptop.

## Options considered

### Option A: Passkeys only, TOTP enrollment bootstrap (locked)

**Description:**
- First device: user enrolls with a TOTP code emailed to them at
  invitation time (or shown by the inviting co-chair on a printed
  invite slip). TOTP is consumed once to bind the first passkey.
- Subsequent devices: bound by an existing passkey-authenticated
  session approving the new authenticator.
- TOTP secret destroyed after first passkey is set.
- No password ever set on the account.
- Session: 15-min access token, passkey re-auth on resume; no
  long-lived refresh tokens.

**Pros:**
- Phishing-resistant by design.
- No password attack surface.
- Supabase Auth supports WebAuthn natively.

**Cons:**
- Browser support gaps on older devices (Android 9-, Safari 15-).
  Mitigated by setting a minimum supported browser baseline.
- Lost-device recovery requires an alternate enrolled device OR a
  committee-administered re-invite. Documented.

### Option B: Passkeys + password fallback

**Pros:**
- Familiar.

**Cons:**
- Defeats T7 mitigation; password is the weakest link.
- Locked out by plan §13.

### Option C: SMS / email magic link

**Pros:**
- Familiar.

**Cons:**
- SIM-swap risk; email-account compromise.
- Locked out by plan §13.

## Decision

**We choose Option A — locked.**

### Rationale

Locked by plan §13. The threat model leans on passkeys for T6, T7, T11.

**Operational rules:**
- Minimum browser baseline documented and enforced (no service worker
  registration on unsupported browsers; visible "your browser is too
  old" page).
- Lost-device recovery flow:
  - **Has another enrolled device** → use it.
  - **Has no other device** → worker co-chair issues a fresh TOTP
    invite that consumes one slot in the audit log and rotates that
    user's identity keys; old data encrypted to the old identity key
    is recoverable only from the recovery passphrase backup (see
    ADR-0003).
- No "remember me." Each session is short.
- Session list and revoke-all is in user settings.

### Reversibility

**Medium.** Adding more methods later is a feature add; removing
passkeys would be a security regression we wouldn't do.

## Consequences

### Positive
- Phishing-resistant.
- No password DB to leak.
- Sessions are short and revocable.

### Negative / accepted tradeoffs
- Users on very old devices can't use the app. We accept that.
- Lost-device recovery is a process, not a click.

### Risks
- Supabase Auth bug in WebAuthn. Mitigated by tracking Supabase Auth
  CVEs in dependency-manager and gating with adversarial-reviewer.

## Compliance check

- [x] No SMS PI processor.
- [x] No password storage.
- [x] PIPEDA Safeguards adequate to sensitivity.

## Follow-ups

- [ ] T05 — auth + passkey enrollment with second-opinion-reviewer.
- [ ] T20 — session revocation tested.

---

# ADR-0001: Hosting on Supabase Cloud (ca-central-1) with E2EE as load-bearing mitigation

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 2), architect ratifying

## Context

The user has explicitly chosen Supabase Cloud in `ca-central-1` over
self-hosting, accepting the **US-incorporated-provider tradeoff**:
Supabase Inc. and the underlying AWS region operator are US legal
persons, so US legal process (CLOUD Act, NSLs, FISA 702) can in
principle reach the platform. This ADR does **not** re-litigate the
decision — it captures the *how* of the mitigation so that downstream
agents understand exactly what makes this hosting choice defensible.

The threats this ADR mitigates are T1 (employer subpoena), T5 (provider
compromise), and a foreseeable CLOUD-Act class of risk.

## Decision drivers

- Canadian data residency (`ca-central-1`).
- Team-of-one ops capacity (self-hosting Supabase or vanilla Postgres
  is real ops work).
- Constraint: no third-party PI processor beyond Supabase.
- Constraint: provider must not be able to compel-decrypt content.
- Cost ceiling: ~$50/mo at v1 scale.

## Options considered

### Option A: Supabase Cloud `ca-central-1`, with E2EE doing the heavy lifting (locked)

**Description:** Use Supabase Cloud's managed Postgres + Auth + Storage
+ Edge Functions, all in `ca-central-1`. C3/C4 data is E2EE under the
committee key; the server holds ciphertext. RLS is the second layer
(against an attacker with a stolen session token). Telemetry is
scrubbed at the SDK layer (ADR-0010). No third-party PI processor
beyond Supabase itself.

**Pros:**
- Zero ops; managed Postgres + Auth + Storage + RLS in one stack.
- Canadian region.
- The E2EE design (ADR-0003) means Supabase sees ciphertext for the
  data that matters (T1, T5).
- Fits the budget envelope.

**Cons / accepted tradeoffs:**
- Supabase Inc. is US-incorporated; AWS ca-central is operated by a US
  entity. CLOUD-Act-reachable in principle for whatever Supabase *can*
  produce, which for C3/C4 is ciphertext.
- Edge Functions run inside Supabase — they handle ciphertext +
  metadata only; **plaintext must never appear in an Edge Function**
  (invariant from ADR-0003).
- A subpoena could compel Supabase to produce metadata: row counts,
  timestamps, user IDs, audit-log contents (C1). This is documented
  exposure; we minimize what metadata reveals (no employer names in
  table names; no PI in audit-log content).

### Option B: Self-hosted Supabase on a Canadian provider (e.g., OVHcloud Beauharnois)

**Description:** Run Supabase open-source stack on a non-US-incorporated
Canadian VPS.

**Pros:**
- Eliminates US-incorporated provider in the path.
- Same APIs, same code, in theory.

**Cons:**
- Real ops work for a team of one: patching Postgres, Postgrest,
  GoTrue, Storage, Realtime, etc. Each is a security-critical service.
- Patching delay = larger attack window than Supabase Cloud.
- Backup and HA are now our problem.
- The CLOUD-Act exposure is replaced by the operational risk of
  running production crypto+auth services solo. For this team size,
  the operational risk is higher than the legal risk that E2EE
  already mitigates.
- Realistic CA-incorporated providers (OVH Canada is a French
  subsidiary; CIRA is non-profit DNS only; truly Canadian cloud is
  thin on the ground) still have US/EU corporate parents in many
  cases — the "no US legal hook" promise is harder to keep than it
  looks.

### Option C: Vanilla Postgres on Canadian VPS, hand-rolled auth + storage

**Pros:**
- Smallest provider surface.

**Cons:**
- Hand-rolled auth is a hard no for a tool whose users are protected
  under OHSA s.50. We don't roll our own crypto/auth.
- More ops than Option B.

## Decision

**We choose Option A — locked by user.**

### Rationale

E2EE (ADR-0003) is the load-bearing mitigation. With C3/C4 data as
ciphertext-only on the server, the practical reach of a CLOUD-Act
order is reduced to:
- Metadata (timestamps, row counts, user IDs).
- Audit log (C1, contains no content).
- Auth session tokens (short-lived, passkey-bound).

This is a known, bounded exposure documented in the privacy policy.
The team's operational reality (one person + agent pack) makes
self-hosting a worse risk overall — patches delayed, backup drills
skipped, more bugs in services that don't get the platform team's
attention.

**Operational invariants:**
1. **Region pin:** all Supabase resources in `ca-central-1`. Verified
   on every deploy (CI check reads the project metadata).
2. **E2EE for C3/C4:** every C3/C4 column write goes through the
   encryption module. Integration test asserts ciphertext shape on
   every C3/C4 write.
3. **No new Supabase add-on without ADR.** Realtime, Vector, AI — each
   would be a fresh PI-processor evaluation.
4. **No PI in metadata.** Table names, column names, function names,
   error messages: generic.
5. **Edge Functions handle ciphertext + metadata only** — never
   plaintext. Linted.
6. **Subpoena playbook** exists before launch: who in Supabase Inc. we
   contact, what we can and cannot produce, who the user's privacy
   lawyer is. The deployer cannot ship without it.

### Reversibility

**Hard.** Migrating off Supabase is a project: replace Auth, Storage,
Edge Functions, RLS-as-authz. Estimated several sprints. The E2EE
mitigation means we don't need to migrate under most threat
scenarios; if we ever do, we do it deliberately, not under pressure.

## Consequences

### Positive
- Zero ops.
- Canadian region.
- Cost fits budget.
- E2EE means provider compromise → ciphertext only for the data that
  matters.

### Negative / accepted tradeoffs
- CLOUD-Act-reachable for ciphertext + metadata.
- Single-vendor concentration. Mitigated by ADR-0012 (backup to a
  second Canadian provider, ciphertext only).
- Edge Functions cannot use plaintext — limits some convenience patterns.

### Risks
- Supabase pricing change or feature removal. Mitigated: contract not
  long-term; egress is small; migration possible if needed.
- A future "AI feature" added by Supabase silently processes data. We
  monitor changelog; new add-ons require a fresh ADR.

## Compliance check

- [x] Canadian region.
- [x] Supabase DPA reviewed (standard; SCCs included).
- [x] Listed in `SUBPROCESSORS.md` as the sole PI processor.
- [x] PIPEDA Principle 1 (Accountability) — we identify Supabase and
      document the transfer.
- [x] Privacy policy will name Supabase + the tradeoff.
- [x] Subpoena playbook required before launch (human gate).

## Follow-ups

- [ ] Subpoena response playbook (deployer + privacy lawyer, human gate).
- [ ] `SUBPROCESSORS.md` to list Supabase, Sentry, backup bucket.
- [ ] Region-pin CI check in T01.
- [ ] Plain-language privacy-policy paragraph explaining the tradeoff.

---

# System Design

## Component diagram

```
                         +-----------------------------+
                         | User's browser (PWA)        |
                         |                             |
                         |  SvelteKit app              |
                         |  + libsodium-wrappers       |
                         |  + IndexedDB (encrypted     |
                         |    identity key + cache)    |
                         |  + Service worker (offline) |
                         |  + WebAuthn (passkey)       |
                         |                             |
                         |  PLAINTEXT lives only here  |
                         +--------------+--------------+
                                        |
                          TLS 1.3 / WSS |     -- TRUST BOUNDARY: auth (Supabase Auth)
                                        |     -- TRUST BOUNDARY: E2EE (ciphertext only past this line)
                                        v
                       +-----------------------------------+
                       | Supabase Cloud (ca-central-1)     |
                       |                                   |
                       |  +--------------+                 |
                       |  | Auth (GoTrue,|  passkeys only  |
                       |  | WebAuthn)    |                 |
                       |  +------+-------+                 |
                       |         |                         |
                       |         v                         |
                       |  +--------------+    RLS on every |
                       |  | Postgres     |    table        |
                       |  | (RLS-as-     |                 |
                       |  | authz)       |                 |
                       |  | + Drizzle    |                 |
                       |  |   schema     |                 |
                       |  +------+-------+                 |
                       |         |                         |
                       |  +------+-------+                 |
                       |  | Storage      |  ciphertext     |
                       |  | (blobs)      |  blobs only     |
                       |  +--------------+                 |
                       |                                   |
                       |  +--------------+                 |
                       |  | Edge Funcs   |  ciphertext +   |
                       |  | (export      |  metadata only; |
                       |  | rendering,   |  no plaintext   |
                       |  | retention)   |                 |
                       |  +--------------+                 |
                       +------+----------------+-----------+
                              |                |
              scrubbed events |                | nightly pg_dump
              (no PI)         |                | (encrypted)
                              v                v
                    +-------------------+   +--------------------+
                    | Sentry (EU)       |   | Canadian backup    |
                    | scrubbed at SDK   |   | bucket (B2 or S3   |
                    | NO PI, NO BODIES  |   | ca-central);       |
                    +-------------------+   | ciphertext blob    |
                                            +--------------------+

                    +-------------------+
                    | GitHub Actions CI |
                    | verify.sh, semgrep|
                    | gitleaks          |
                    +-------------------+

                    +-------------------------------+
                    | Worker co-chair export ----   |  -- TRUST BOUNDARY: worker/employer line
                    | rendered as PDF in browser,   |     (only path off the worker side)
                    | encrypted-at-rest snapshot,   |
                    | logged in audit; reviewed     |
                    | by privacy-reviewer per       |
                    | export                        |
                    +-------------------------------+
```

## Trust boundaries

The pack's threat model expects boundaries; here are ours.

**Boundary 1 — auth boundary.** Supabase Auth is the only authenticator.
Nothing in the app trusts a request without a valid Supabase JWT, and
RLS uses `auth.uid()` directly. There is no app-layer "user lookup" that
bypasses this. Outside the auth boundary = unauthenticated; inside = a
named principal.

**Boundary 2 — E2EE boundary.** All C3/C4 fields are ciphertext on the
server. Plaintext lives only in the user's browser, in libsodium's
working buffers and in the SvelteKit component state. Anything crossing
this boundary toward the server MUST be ciphertext; anything crossing
toward the browser MUST be decrypted by the client. Edge Functions sit
on the server side and do not see plaintext.

**Boundary 3 — worker/employer boundary (the export function).** There
is no employer side of this app. The only artifact that crosses the
worker/employer line is an **explicit export** triggered by the worker
co-chair: a finalized PDF (joint minutes, recommendations to employer).
The export:
- Runs in the browser (decrypts → renders PDF → user downloads).
- Is logged in the audit log (timestamp, document ID, who exported).
- Goes through a "this leaves the worker side" interstitial confirming
  the export and what it includes.
- privacy-reviewer reviews any change to export rendering with
  heightened scrutiny.

## Data flow with PI markings

### Concern intake

```
[Browser]
  1. Rep opens intake form. (auth: passkey session)
  2. Rep types concern title + body (C3) + optional source name (C4 if present).
  3. Anonymous toggle ON by default.
  4. Client generates per-concern nonce.
  5. Client encrypts {title, body, source_name?} with committee public key (sealed box).
  6. POST /api/concerns { ciphertext_blob, metadata: {hazard_class, severity, location_id} }
[Boundary 2 - E2EE crossed; only ciphertext leaves browser]
  7. Edge Function validates JWT, RLS allows INSERT given committee membership.
  8. Row inserted: ciphertext columns + plaintext metadata (severity, status='open', created_at).
  9. Audit log appended (C1): {actor_id, action='concern.create', concern_id, ts}.
[Database in ca-central-1, ciphertext at rest]

[Browser of another committee member]
  10. Lists concerns: SELECT ciphertext_blob, metadata FROM concerns (RLS pre-filtered).
  11. Client decrypts each blob with their wrapped copy of committee data key.
  12. Plaintext title shown in list view.
```

### Export (worker co-chair → employer co-chair)

```
[Browser, worker co-chair]
  1. Co-chair selects finalized minutes for export.
  2. Client fetches ciphertext blob from Supabase.
  3. Client decrypts in browser with committee key.
  4. Client renders PDF in browser (no plaintext via server).
  5. Audit log POST: {actor_id, action='export.minutes', minutes_id, recipient_role='employer_co_chair', ts}
[Boundary 3 - worker/employer line: PDF leaves the worker domain]
  6. User downloads PDF; delivery to employer co-chair happens off-app
     (email, paper, etc.). The app does not transmit to the employer.
```

### Inspection (offline + sync)

```
[Browser, on shop floor, no signal]
  1. Inspector opens inspection checklist; PWA service worker provides UI.
  2. Inspector ticks items, attaches photos (C3).
  3. Each photo encrypted client-side immediately with per-record symmetric key
     wrapped to committee public key.
  4. Records queued in IndexedDB as ciphertext.
[Boundary 2 - even local cache is ciphertext at rest in IndexedDB,
 modulo a session-key wrapping layer for quick read in current session]
  5. On reconnect, queue drains: ciphertext blobs uploaded to Supabase Storage;
     row inserted into inspections with metadata only.
```

## PI inventory

Every field, classification per plan §5.4, retention default, encryption posture.

| Entity / field | Class | Encryption | Retention | Notes |
|---|---|---|---|---|
| `users.id` (Supabase auth UUID) | C1 | TLS + AES-256 at rest | Membership + 24mo | Identifier only |
| `users.display_name` | C2 | TLS + AES-256 at rest | Membership + 24mo | First name / chosen name |
| `users.off_employer_contact` (email or phone) | C2 | TLS + AES-256 at rest | Membership + 24mo | NOT employer-domain; validated on entry |
| `users.identity_pubkey` | C1 | TLS only | Membership + 24mo | Public key, no secrecy needed |
| `users.identity_privkey_recovery_blob` | C2 (ciphertext of a secret) | TLS + AES-256 at rest; ciphertext wraps the actual secret | Membership + 24mo | Decrypts only with user passphrase |
| `committee_membership.role[]` | C1 | TLS + AES-256 at rest | Membership + 24mo | {worker_member, worker_co_chair, certified_member} |
| `committee_key.wrapped_privkey_blob` (per member) | C3 (wraps committee key) | E2EE at rest | Membership + 24mo | One row per (committee, member) |
| `concerns.title_ciphertext` | C3 | E2EE | 7y post-closure | Body field of concern |
| `concerns.body_ciphertext` | C3 | E2EE | 7y post-closure | Free text |
| `concerns.source_name_ciphertext` (nullable) | C4 | E2EE + per-record key | 7y post-closure | Identity of original worker complainant |
| `concerns.hazard_class` | C1 | TLS + AES-256 at rest | 7y post-closure | Enum, not PI |
| `concerns.severity` | C1 | TLS + AES-256 at rest | 7y post-closure | Enum |
| `concerns.location_id` | C1 | TLS + AES-256 at rest | 7y post-closure | Site location code |
| `concerns.status` | C1 | TLS + AES-256 at rest | 7y post-closure | Enum |
| `inspections.notes_ciphertext` | C3 | E2EE | 7y | Text |
| `inspections.photo_blob_keys[]` | C1 metadata | Storage blob is C3 ciphertext | 7y | FK to Storage |
| Storage: inspection photos | C3 | E2EE client-side before upload | 7y | Ciphertext blob |
| `minutes.draft_body_ciphertext` | C3 | E2EE | 90 days post-finalization | Working draft |
| `minutes.final_body_ciphertext` | C3 | E2EE | 7y | Finalized; export source |
| `recommendations.body_ciphertext` | C3 | E2EE | 7y | s.9(20) recommendations |
| `recommendations.employer_response_ciphertext` | C3 | E2EE | 7y | Captured employer reply |
| `reprisal_log.body_ciphertext` | C4 | E2EE + per-record key | Active matter + 7y; real-delete | Highest sensitivity |
| `work_refusal.notes_ciphertext` | C4 | E2EE + per-record key | Active matter + 7y | s.43 |
| `s51_evidence.*_ciphertext` | C4 | E2EE + per-record key | Active matter + 7y | s.51 |
| `training_records.evidence_ciphertext` | C2 | E2EE | Membership + 24mo | Certified-member proof |
| `audit_log.*` | C1 | TLS + AES-256 at rest; NOT E2EE | 24mo | Tamper-evident hash chain |
| `audit_log.actor_id` | C1 | TLS + AES-256 at rest | 24mo | Supabase user UUID |
| `audit_log.action` | C1 | TLS + AES-256 at rest | 24mo | Enum |
| `audit_log.target_id` | C1 | TLS + AES-256 at rest | 24mo | FK to affected row |
| `audit_log.prev_hash` | C1 | TLS only | 24mo | Hash chain |
| `feature_flags.*` | C0 | TLS only | n/a | Operational config |
| `document_library.*` | C0 | TLS only | n/a | OHSA quick-ref text, etc. |
| `i18n_strings.*` | C0 | TLS only | n/a | en-CA catalog |

**Fields that do NOT exist (data minimization):**
- No SIN, no DOB, no home address.
- No employer name attached to user (committee context implicit).
- No worker's *role at the workplace* beyond what's needed (no job title).
- No IP address logged in app logs (Supabase platform logs are out of
  app control; documented).
- No geolocation by default on inspections; opt-in per inspection.

## RLS policy outline per table (English; SQL comes later)

The pattern: every policy keys off `auth.uid()` and checks active
membership. `committee_membership_active(user_id)` is a SECURITY DEFINER
helper that returns true when the user has a row in `committee_membership`
with `active = true`. Single-tenant means there's only one committee.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `users` | Self OR committee member | Self (first row only, via Auth trigger) | Self | None (use crypto-shred on role removal) |
| `committee_membership` | Active members only | Co-chair only | Co-chair only | None (mark inactive; 90-day grace then key destroy) |
| `committee_key` | Self's wrapped row only | Co-chair INSERT during invite + member-self-init | Co-chair only | Co-chair only (on member removal) |
| `concerns` | Active members | Active members | Active members | None (use `status='deleted'` + retention job) |
| `inspections` | Active members | Active members | Author OR co-chair (until status='finalized') | None |
| `minutes` (draft) | Active members | Active members | Active members | Co-chair only |
| `minutes` (final) | Active members | Co-chair only | Co-chair only (rare) | Co-chair only |
| `recommendations` | Active members | Active members | Active members until status='sent'; co-chair after | Co-chair only |
| `reprisal_log` | Author OR co-chair OR certified_member | Active members | Author OR co-chair | Co-chair only with 4-eyes |
| `work_refusal` | Certified member OR co-chair | Certified member | Certified member OR co-chair | Co-chair only with 4-eyes |
| `s51_evidence` | Certified member OR co-chair | Certified member | Certified member OR co-chair | Co-chair only with 4-eyes |
| `training_records` | Active members | Self OR co-chair | Self OR co-chair | Co-chair only |
| `audit_log` | Active members | App writes via Edge Function (security definer); no direct write from users | Never | Never (immutable; retention job deletes by age) |
| `feature_flags` | Active members | Co-chair only | Co-chair only | Co-chair only |
| `document_library` | Active members | Co-chair only | Co-chair only | Co-chair only |
| `i18n_strings` | Public | None (loaded via migration) | None | None |

**Helpers (all SECURITY DEFINER, owned by the migration role, called from policies):**
- `is_active_member()` → bool.
- `is_co_chair()` → bool.
- `is_certified_member()` → bool.
- `is_self(uid uuid)` → bool.
- `requires_four_eyes(target_table text, target_id uuid)` → uses a
  `pending_destructive_ops` table where the first member proposes and
  the second member approves; only after both, the row is allowed to
  flip status.

**"4-eyes" pattern:** for destructive ops on C4 (reprisal_log,
work_refusal, s51_evidence), DELETE is gated by a row existing in
`pending_destructive_ops` with two distinct approver IDs.

---

# Capacity and cost sketch

**Scale assumption:** 50 active workers as potential users; ~12 active
committee members (typical OHSA 50+ workplace); peak ~5 concurrent
sessions during a committee meeting.

## Sizing

- **Postgres:** Supabase Pro tier (Small compute — 2 vCPU / 4GB) is
  10x what we need. Day-1 working set is well under 100MB; with 7y
  retention and ~50 concerns/year + monthly inspections + monthly
  minutes, projected database size at year 5 is on the order of
  500MB–2GB. Connections: peak 10 simultaneous.
- **Storage:** photo attachments dominate. Estimate:
  - 12 inspections/year × 20 photos × 1MB (compressed JPEG, encrypted
    overhead +10%) ≈ 264MB/year.
  - 5 critical-injury events × 50 photos × 2MB × occasional ≈ 500MB
    occasional.
  - Year-5 storage: ~3–5GB total. Pro tier includes 100GB.
- **Egress:** Inspections + minutes downloads. ~50 sessions/week ×
  10MB average ≈ 500MB/week ≈ 2GB/month. Pro tier includes 250GB
  egress.
- **Edge Functions:** retention sweep nightly, audit-integrity check
  nightly, export rendering occasional. Well under the 500k-invocation
  Pro allowance.

## Cost (CAD-ish, monthly)

| Item | Cost | Notes |
|---|---|---|
| Supabase Cloud Pro | ~$25 USD / mo | Includes 8GB DB, 100GB Storage, 250GB egress, 100k MAU, PITR |
| Domain (`.ca`) | ~$2 / mo | Annual amortized |
| Sentry SaaS, EU, Team plan | ~$26 USD / mo | Cheapest tier with EU residency; 50k events/mo is plenty |
| Backup bucket (B2 / S3 ca-central) | <$1 / mo | ~5GB ciphertext + low egress |
| GitHub Actions | $0 | Free tier sufficient for this volume |
| **Total** | **~$54 USD / mo (~$74 CAD / mo)** | |

At 10× scale (500 workers, 10 committees — would mean re-opening single-tenancy):
- Multi-tenancy decision re-opens (this would be v2, not a config flip).
- Supabase Pro probably still fits; Storage grows but is well under
  the 100GB allowance.
- Sentry tier may upgrade ($80 USD / mo).
- Cost cliff at v2: roughly $150–200 / mo, still well within any
  reasonable budget.

**Top three cost drivers at v1:** Sentry tier ($26), Supabase Pro
($25), domain (~$2). Sentry is the lever to pull if cost is an issue
(switch to GlitchTip self-hosted; trade dollars for ops hours).

**Cliffs:**
- DB > ~50GB (years away at this profile) → review Supabase Compute
  tier.
- Concurrent sessions > 100 → review connection pooling (PgBouncer is
  Supabase-standard).
- Storage > 100GB → either trim retention or upgrade.

---

# Failure-mode analysis (T1–T12)

For each plan §4 threat: residual risk after this design, and the
specific test the test-writer should write.

### T1 — Employer obtains worker-side content via server subpoena

**Design mitigations:** E2EE for C3/C4 (ADR-0003); ciphertext-only at
rest; Supabase cannot produce plaintext; metadata + audit log can be
compelled (documented).

**Residual:** Metadata still compellable (timestamps, row counts, user
IDs, audit log content). Privacy policy names this exposure.

**Test:** Integration test that:
- Writes a known plaintext to every C3/C4 column path.
- Queries the row directly via the Postgres admin connection (no app
  layer).
- Asserts the column contents are well-formed libsodium ciphertext
  (correct magic bytes / nonce length / minimum size) and do **not**
  contain the plaintext substring.

### T2 — Employer obtains content via worker's employer-owned device

**Design mitigations:** ADR-0008 advisory posture; 15-min auto-lock;
passkey re-auth on resume; no long-lived refresh tokens; panic wipe;
no plaintext disk cache beyond session; opt-in offline cache per
inspection.

**Residual:** A user who deliberately installs on an employer device
and stays logged in during work hours. Documented; this is a policy
problem, not a tech problem.

**Test:** Browser test:
- Sets up logged-in session.
- Backgrounds the tab for 16 minutes.
- Asserts that any sensitive route reads from IndexedDB after passkey
  re-auth (i.e., session is locked until re-auth).
- Triggers "panic wipe" and asserts IndexedDB is empty afterward.

### T3 — Reprisal against an identified complainant (s.50)

**Design mitigations:** Anonymous source toggle defaults ON; `source_name_ciphertext`
is C4 (per-record passphrase); no auto-include in exports; visible
"reveal source" action is audit-logged; export interstitial lists every
field included.

**Residual:** A rep who deliberately reveals a source. Mitigated by audit
log and committee social norms.

**Test:** Integration test:
- Create a concern with anonymous=true.
- Attempt to render an export PDF and assert the output contains no
  `source_name` field whatsoever.
- Toggle reveal and assert the audit log gains an `action='source.reveal'`
  row with actor and target.

### T4 — Insider compromise (co-opted rep)

**Design mitigations:** Tamper-evident audit log (hash chain); 4-eyes
for destructive ops on C4; key rotation on role change; co-chair has
no superuser DB access (Supabase admin separation).

**Residual:** A rep who reads (read-only) without 4-eyes — possible by
design (members need to read). Audit log records reads of C4 records.

**Test:** Integration test:
- Member A proposes DELETE on a reprisal_log row.
- Assert row is NOT actually deleted yet; `pending_destructive_ops`
  has an entry.
- Member B approves; assert row now deleted AND audit log has two
  approve entries.
- Member A tries to approve their own proposal; assert rejected.
- Tamper-evident: corrupt one audit-log row's content; assert the
  daily integrity check job fails AND alerts.

### T5 — Hosting-provider compromise

**Design mitigations:** Same as T1 — E2EE for C3/C4; backups
encrypted with our key, not Supabase's; passkey-bound sessions
limit replay value.

**Residual:** Provider can DoS, can read metadata, can read C1/C2 at
rest (TLS + AES-256 protect from network/disk-snoop but not from
provider-admin access).

**Test:** Same as T1, plus a test that:
- Generates a backup `pg_dump`.
- Attempts to read a C3 ciphertext column from the dump and assert
  it does not yield plaintext without the dump key + committee key.

### T6 — Device theft / loss

**Design mitigations:** Passkey-bound sessions; 15-min auto-lock;
revocation from any active member's settings; biometric lock; panic
wipe.

**Residual:** Brief window before lock if device is grabbed unlocked.

**Test:** Browser test:
- Log in on device A.
- From device B, revoke device A's session.
- On device A, attempt a privileged action; assert it fails with
  401 and triggers re-auth prompt that cannot succeed without
  re-enrollment.

### T7 — Phishing of a worker rep

**Design mitigations:** Passkeys (domain-bound; can't be phished); no
password fallback; no SMS fallback; no email magic links.

**Residual:** A social-engineering attack tricking the user to enroll
a new passkey on an attacker domain. Mitigated by passkey's domain
binding — a passkey for `jhsc.example.ca` does not authenticate at
`jhsc-example.com`.

**Test:** End-to-end test:
- Attempt to register a passkey at `app.example.com`.
- Attempt to use that passkey at `app.evil.com` and assert WebAuthn
  rejects (origin mismatch).

### T8 — Account enumeration / membership disclosure

**Design mitigations:** No public sign-up; invite-only; auth endpoint
doesn't distinguish "unknown user" from "wrong credential."

**Residual:** Knowing the app exists at `app.example.ca` reveals that
some committee uses it. Mitigated by not advertising publicly.

**Test:** Integration test:
- POST auth endpoint with unknown user ID; capture response.
- POST auth endpoint with known user ID, wrong credential; capture
  response.
- Assert responses are byte-identical (status, body, headers, timing
  within tolerance).

### T9 — Telemetry / error-tracker leakage

**Design mitigations:** ADR-0010 Sentry SaaS EU + SDK-layer scrubbing;
allowlist on extras; CI fixture test.

**Residual:** A new code path sends data the scrubber didn't anticipate.

**Test:** Integration test:
- Submit a form containing a known canary string (e.g., `CANARY_PII_X`).
- Trigger an error.
- Capture the would-be Sentry payload (mock the transport).
- Assert payload does NOT contain `CANARY_PII_X` anywhere.

### T10 — Forced disclosure of who installed the app

**Design mitigations:** PWA only (ADR-0011); no app store account; no
install record at Apple/Google.

**Residual:** Browser-side install fingerprinting (e.g., browser cache
of the manifest). Not realistically subpoenable.

**Test:** Inventory test:
- CI fails if `package.json` or build output includes any iOS / Android
  bundler or React Native dependency.

### T11 — Compelled access from a worker rep under duress

**Design mitigations:** v1 = visible audit log + post-coercion
notification (plan §13 item 5: duress mode is v2). Audit log entries
for sensitive reads are visible to all active members.

**Residual:** Single act of coerced access is performed; mitigation
is detection + post-hoc notification, not prevention.

**Test:** Integration test:
- Member A reads a C4 row.
- Member B (any other active member) logs in.
- Assert member B sees a "recent sensitive read" notification or list
  item identifying the read (actor, target, ts).

### T12 — "AI feature" exfiltration

**Design mitigations:** No third-party AI in v1; no client telemetry
to AI services; CSP locks down outbound origins.

**Residual:** A future PR introduces an AI feature without a fresh
human-gate ADR.

**Test:** CSP and dependency tests:
- CI fails if a new outbound origin appears in CSP without an ADR
  reference in the PR description.
- CI fails if `package.json` adds a dependency whose name matches
  known AI SDKs (`openai`, `anthropic`, `cohere`, etc.) without an
  ADR reference.

---

# Ordered task list (refines plan §11.2)

19 tasks. Each lists default reviewers (security, privacy, adversarial)
plus any extra reviewers required. Phase-2 builder loop applies:
test-writer → implementer → verifier → reviewers → second-opinion (where
flagged) → PR → human-gate review.

### T00 — Scaffold project + verify gates

**Goal:** Create `apps/web/` SvelteKit app, wire `scripts/verify.sh`,
GitHub Actions, `.env.example`, `.gitignore`. No features.

**Acceptance:**
- `pnpm verify` passes on a fresh clone.
- CI runs verify on PR.
- gitleaks + semgrep + ts + lint in CI green.
- README explains repo layout in 1 page.
- RLS-coverage check in `verify.sh` (placeholder until tables exist).

**Default reviewers + extras:** standard set.

**Risk:** Low. **Estimate:** S (1 day).

### T01 — Supabase project setup + region pin + CI check

**Goal:** Create Supabase project in `ca-central-1`; wire env, secrets,
and a CI check that asserts the project's region.

**Acceptance:**
- Project exists in `ca-central-1`; verified via Supabase mgmt API.
- CI job fails if the configured project metadata returns a non-CA region.
- `SUBPROCESSORS.md` created with Supabase + (planned) Sentry + (planned) backup bucket.
- Backup PITR enabled (7 days).
- Connection string + service-role key never logged or committed.

**Extras:** **security-reviewer + privacy-reviewer** required (hosting
provider gate per ADR-0001).

**Risk:** Low. **Estimate:** S (1 day).

### T02 — Observability setup (Sentry + structured logs + PI scrubber)

**Goal:** Sentry SaaS EU + SDK-layer scrubber + canary-PII test; structured
logger with PI scrubbing for app logs.

**Acceptance:**
- `beforeSend` strips: cookies, auth headers, query params, all form bodies,
  user IDs; allowlist for category-only breadcrumbs.
- Canary-PII test in CI asserts no canary leaks through the scrubber.
- Logger has a `safeFields` allowlist; everything else dropped or hashed.
- Sentry added to `SUBPROCESSORS.md`.
- Documented in `playbooks/`.

**Extras:** **privacy-reviewer** with heightened scrutiny.

**Risk:** Low. **Estimate:** S (1 day).

### T03 — i18n catalog scaffold (en-CA only)

**Goal:** Wire `svelte-i18n` (or equivalent), seed `en-CA.json`, create
empty `fr-CA.json` skeleton, ESLint rule `no-literal-strings`.

**Acceptance:**
- All UI strings go through `t()`.
- Build fails on hard-coded user-facing strings.
- Locale-aware date/number/currency helpers exist.
- `<html lang>` set correctly.

**Extras:** **localization-specialist** owns; accessibility-specialist reviews
language attributes.

**Risk:** Low. **Estimate:** S (0.5 day).

### T04 — Schema baseline + RLS-on-everything + policy tests

**Goal:** Initial Drizzle migration: `users`, `committee_membership`,
`committee_key`, `audit_log`. RLS enabled with policies per the outline above.

**Acceptance:**
- Every table has RLS enabled.
- CI check finds zero tables without RLS.
- Positive + negative policy tests for each table.
- Audit log is append-only at the DB level (REVOKE UPDATE/DELETE except for
  retention-job role).
- Migration is reversible (down migration exists).

**Extras:** **migration-handler** owns; **security-reviewer + adversarial-reviewer**.

**Risk:** Medium. **Estimate:** M (2 days).

### T05 — Auth: passkeys + TOTP bootstrap + session model

**Goal:** Implement Supabase Auth with WebAuthn passkeys; first-device TOTP
enrollment that is consumed and destroyed on first passkey set; 15-min
sessions; session list + revoke-all.

**Acceptance:**
- Login flow: invite → TOTP from invite → passkey enroll → passkey-only
  thereafter.
- No password is ever set on the account.
- Session token TTL ≤ 15 min; no long-lived refresh token.
- Session list in settings; revoke-all works.
- T7 test passes (passkey origin binding).
- T8 test passes (account enumeration prevented).
- Minimum-browser-baseline gate in onboarding.

**Extras:** **second-opinion-reviewer** mandatory (auth). **security-reviewer + adversarial-reviewer** with heightened scrutiny.

**Risk:** High. **Estimate:** L (4 days).

### T06 — Committee + invite + role assignment

**Goal:** Co-chair can invite a worker member; role flags
(worker_member, worker_co_chair, certified_member); active/inactive flag;
removal flow that triggers key-rotation hook (implemented in T07).

**Acceptance:**
- Invite flow works end-to-end (T05 prerequisite).
- Role changes audit-logged.
- Removal marks inactive immediately; 90-day grace before key destroy.
- Co-chair cannot remove themselves without another co-chair (4-eyes).
- Single-tenancy assertion: no `committee_id` parameter exists anywhere
  in the API surface (CI test enforces).

**Extras:** **adversarial-reviewer** with heightened scrutiny.

**Risk:** Medium. **Estimate:** M (2 days).

### T07 — E2EE key core: identity keys, committee key, wrapping, rotation

**Goal:** libsodium-wrappers module; identity key generation; recovery
passphrase enrollment; committee key generation; per-member wrap;
rotation on member removal.

**Acceptance:**
- All seven invariants from ADR-0003 are encoded as tests.
- T1 ciphertext-shape test passes.
- T5 backup-ciphertext test passes.
- Recovery passphrase: user must type-back to confirm before exit.
- Rotation: integration test removes a member and asserts (a) their
  wrapped row is deleted, (b) remaining members have a new wrap, (c)
  new C3 writes use the new public key, (d) old C3 ciphertext stays
  readable to remaining members via the rotated wrap chain.
- No private key material in any URL, query string, log line, or
  Sentry event (canary test).

**Extras:** **second-opinion-reviewer** mandatory (crypto). **security-reviewer + adversarial-reviewer** with heightened scrutiny. **privacy-reviewer** signs off.

**Risk:** High. **Estimate:** L (5 days).

### T08 — Member concern intake (anonymous-by-default) + hazard register read

**Goal:** Committee-members-only intake form; anonymous toggle defaults
ON; encrypts client-side; concerns list view with decrypt-and-render.

**Acceptance:**
- T3 test passes (anonymous concerns never expose source field).
- Title + body + optional source_name encrypted with committee key.
- source_name is C4 (additional per-record key).
- "Reveal source" action gated by passphrase + audit-logged.
- RLS denies inserts unless `is_active_member()`.
- Route inventory test asserts no public-write route exists.
- Form is WCAG 2.0 AA; designer + accessibility-specialist sign off.

**Extras:** **privacy-reviewer** with heightened scrutiny.

**Risk:** Medium. **Estimate:** M (3 days).

### T09 — Hazard register: status workflow + filtering + edit

**Goal:** Triage concerns into hazard register with status, severity,
location, owner, dates.

**Acceptance:**
- Status enum: open, triaged, controls-in-progress, monitoring, closed.
- Closed entries start retention clock.
- Severity, location, owner are C1 metadata (not encrypted) — confirmed
  with privacy-reviewer.
- Filtering by status/severity/location.
- All edits audit-logged.

**Extras:** standard.

**Risk:** Low. **Estimate:** M (2 days).

### T10 — Inspections: offline + photo + sync

**Goal:** Monthly inspection checklists; offline-first via service worker;
photo capture; client-side encryption before upload; sync queue.

**Acceptance:**
- Inspector can complete an inspection fully offline.
- Photos encrypted client-side before any network call.
- Queue persists across PWA close/reopen.
- Sync on reconnect; conflicts surfaced for user review.
- GPS off by default; opt-in per inspection.
- Photos in Supabase Storage are ciphertext.

**Extras:** **security-reviewer + accessibility-specialist** (mobile UX).

**Risk:** Medium. **Estimate:** L (4 days).

### T11 — Meeting prep + draft minutes + finalize-and-export

**Goal:** Pull unresolved items; draft minutes; finalize by co-chair;
export to PDF in browser.

**Acceptance:**
- Drafts are C3; retention 90 days post-finalization.
- Finalized minutes are C3; retention 7y.
- Export rendering is in-browser (no plaintext to server).
- Export interstitial lists every field included before download.
- Export audit-logged with target ID + recipient role.
- T3 source-name exclusion test passes for exports.

**Extras:** **privacy-reviewer** with heightened scrutiny (export = T3 surface).

**Risk:** Medium. **Estimate:** L (4 days).

### T12 — Recommendations to employer + 21-day timer

**Goal:** Draft recommendations; co-chair signs and exports; 21-day
response timer; employer-response capture.

**Acceptance:**
- 21-day clock starts on "sent" action.
- Reminder at day 14, 18, 21.
- Employer-response capture is a separate manual entry by the rep (no
  inbound channel).
- Export rendering identical posture to T11.

**Extras:** **privacy-reviewer** on exports.

**Risk:** Medium. **Estimate:** M (3 days).

### T13 — Reprisal log (C4, 4-eyes destructive ops)

**Goal:** Highest-confidentiality entry type. Per-record passphrase;
4-eyes deletion; visible "recent sensitive read" notification (T11
mitigation).

**Acceptance:**
- All writes are C4 (per-record key wrapping).
- DELETE requires `pending_destructive_ops` two-member approval.
- Reads are audit-logged with high salience; T11 test passes.
- Author can read; co-chair can read; certified_member can read.
- No automatic inclusion in any export.

**Extras:** **second-opinion-reviewer** + **privacy-reviewer** + **adversarial-reviewer** all with heightened scrutiny.

**Risk:** High. **Estimate:** L (4 days).

### T14 — Work refusal (s.43) + critical injury (s.51) checklists

**Goal:** Certified-member-only checklists for s.43 and s.51 workflows;
protected notes (C4); Ministry-of-Labour notification timing for s.51.

**Acceptance:**
- Access restricted to certified_member + co-chair.
- Notes are C4.
- s.51 evidence photo capture goes through inspection's encrypted-upload
  path.
- Ministry notification deadline countdown surfaced; user actions are
  off-app (the app does not call the Ministry).

**Extras:** **second-opinion-reviewer** + **privacy-reviewer**.

**Risk:** High. **Estimate:** L (4 days).

### T15 — Training records + document library + reminders

**Goal:** Certified-member status, refresher dates, training evidence;
OHSA/Reg quick-ref doc library; reminders engine.

**Acceptance:**
- Training records C2; evidence blobs E2EE.
- Document library is C0 — read-only seed content via migrations.
- Reminders: certified-member refresh, monthly inspection, annual review.
- Reminder content does not include PI (just a link into the app).

**Extras:** standard.

**Risk:** Low. **Estimate:** M (2 days).

### T16 — Right of access / correction / deletion + retention job

**Goal:** PIPEDA Principle 9 endpoints; daily retention job hard-deletes
per the schedule in plan §8.

**Acceptance:**
- "Export my data" produces a JSON bundle (decrypted in browser, downloaded).
- Correction endpoints for user-owned fields.
- Deletion = real delete (or crypto-shred for E2EE'd records).
- Retention job runs daily; logged; alerts on failure.
- Retention deletions are audit-logged.
- Test fixtures simulate aged data; assert deletion.

**Extras:** **privacy-reviewer** owns approval.

**Risk:** Medium. **Estimate:** M (3 days).

### T17 — Backup + restore drill playbook

**Goal:** Nightly `pg_dump` to Canadian bucket, encrypted with escrowed key;
quarterly restore drill into a scratch project; alert if backup is stale.

**Acceptance:**
- Backup runs nightly; alerts on >36h freshness.
- Restore playbook produces a signed report.
- First end-to-end drill executed and signed before launch (human gate per plan §13.F).
- `SUBPROCESSORS.md` updated with backup bucket.

**Extras:** **security-reviewer**.

**Risk:** Medium. **Estimate:** M (2 days).

### T18 — Audit log integrity check job + sensitive-read notification

**Goal:** Daily hash-chain integrity check; alerts on mismatch; T11
"recent sensitive read" notification surface.

**Acceptance:**
- Audit log uses prev-hash chain; CI test covers tampering detection.
- Integrity job runs daily; alerts on mismatch.
- T11 test passes.

**Extras:** **adversarial-reviewer**.

**Risk:** Medium. **Estimate:** S (1.5 days).

### T19 — Session revocation, panic wipe, onboarding copy

**Goal:** "Forget this device" + "Wipe local data" + "Revoke all sessions"
actions; first-launch advisory copy (ADR-0008); plain-language privacy
notice referencing ADR-0001 tradeoff.

**Acceptance:**
- T6 test passes (revocation).
- T2 test passes (panic wipe).
- Onboarding copy reviewed by tech-writer + privacy-reviewer.
- WCAG 2.0 AA on every onboarding screen.

**Extras:** **privacy-reviewer + accessibility-specialist + tech-writer**.

**Risk:** Low. **Estimate:** S (1.5 days).

---

**Ordering rationale:**
- T00–T03 are scaffolding; required by everything.
- T04 (RLS) precedes any data-bearing table.
- T05 (auth) precedes T07 (crypto) because passkey-derived secrets
  protect the identity-key local store.
- T07 (crypto core) precedes T08 (first feature using E2EE) — it's the
  riskiest task; fail fast.
- T08–T15 are feature builds in roughly increasing sensitivity (T13–T14
  are C4-heavy and benefit from earlier crypto + RLS hardening).
- T16 (rights endpoints) needs all data shapes in place to test.
- T17–T19 close out the cross-cutting obligations.

**Human-gate items in this task list:**
- T01: hosting region confirmation.
- T05: auth — second-opinion-reviewer + human PR review.
- T07: crypto — second-opinion-reviewer + human PR review.
- T11/T12: export rendering — privacy-reviewer heightened.
- T13: reprisal log — second-opinion + privacy + adversarial.
- T16: retention schedule sign-off (plan §13.D, before launch).
- T17: first restore drill (plan §13.F, before launch).

---

# Open question for the user

**All resolved 2026-05-22 — user confirmed architect's defaults across Q1, Q2, and explicitly confirmed Sentry SaaS (ADR-0010) over self-hosted GlitchTip. These are no longer open.**

**Q1: Backup bucket provider — Backblaze B2 (Canadian region) or AWS S3 ca-central-1?** → **RESOLVED: Backblaze B2, Canadian region.**

Both work. B2 has lower egress costs and is a smaller, simpler vendor.
AWS S3 is the boring choice. Since the bucket holds ciphertext blobs only
(not a PI processor for plaintext), the choice is operational, not
privacy-substantive. Decision needs to be made before T17 ships.
~~Default if you don't reply:~~ Backblaze B2 in Canadian region (lower
cost, smaller subprocessor footprint). This is reversible easily.

**Q2: Minimum-supported-browser baseline.** → **RESOLVED: architect's default.**

Passkeys / WebAuthn need a fairly modern browser. Proposed baseline:
- Safari 16.4+ (iOS 16.4+ for PWA push).
- Chrome / Edge 109+.
- Firefox 122+ (passkey UX matured here).
- Android: 12+.

Older browsers are blocked at first launch with a "your browser is too
old, here's why" screen. ~~Default if you don't reply:~~ the above. This
is reversible by changing one constant. Surface if any committee member
is known to be on older hardware.

These are the only ambiguities that would materially change the design.

---

# Handoff

**Next agent: threat-modeler.**

Inputs to read:
- `/home/user/agent-os/.context/decisions.md` (this file — all 12 ADRs +
  system design + RLS outline + PI inventory + failure-mode analysis).
- `/home/user/agent-os/JHSC-APP-PLAN.md` (plan §4 threat table, §5.3
  crypto model, §5.4 data classification).
- `/home/user/agent-os/.context/constraints.md` (PIPEDA / Ontario baseline).

**STRIDE-first targets — highest-risk components, in this order:**

1. **E2EE key handling (ADR-0003 + T07).** Verify the seven invariants
   as testable assertions. STRIDE the key wrap, the rotation flow on
   member removal, the recovery-passphrase enrollment, and the IndexedDB
   storage of the identity private key. The whole hosting tradeoff rests
   on this layer.

2. **Concern intake (ADR-0007 + T08).** Anonymous-by-default toggle is
   the strongest s.50 mitigation; verify it is *structurally* enforced
   (RLS + form default + export exclusion) not just defaulted-on. Look
   especially at the source-reveal path.

3. **Export to employer co-chair (T11 + T12).** The only path off the
   worker side. STRIDE the export rendering, the field selection, the
   audit-log capture, and the in-browser PDF generation. Any way to leak
   `source_name` here is a launch blocker.

4. **Reprisal log (T13).** Highest-sensitivity entry type. STRIDE the
   4-eyes destructive op, the per-record passphrase, the visible
   sensitive-read notification, and the access-by-role rules.

5. **Auth + session model (T05).** Passkey enrollment, TOTP bootstrap
   destruction, session TTL, revocation. Verify T7 (origin binding) and
   T8 (enumeration) are structurally enforced.

Lower priority but still required for full STRIDE coverage:
- Inspection sync + offline cache (T10).
- Backup encryption chain (T17).
- Audit log integrity + retention job (T18 + T16).

Output goes to `.context/threat-model.md` per plan §11.

After the threat-modeler completes, the orchestrator routes to:
- **designer** (audience, primary task, content shape — plan §11.3 task 5).
- **observability-setup** (T02 scope — Sentry scrubber + structured logs).
