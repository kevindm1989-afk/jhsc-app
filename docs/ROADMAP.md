# JHSC Safety-Reporting App — Remaining-Work Roadmap

_Authoritative, deduplicated roadmap synthesized from the ADR record (`.context/decisions.md`, 29 ADRs), the threat model (`.context/threat-model.md`, F-01..F-182), the known-gaps register (`.context/known-gaps.md`), the launch-requirement sources, and the actual code/git state. Statuses are grounded against the codebase and git — not the ADR "Proposed/Accepted" labels._

**As of 2026-07-14.** Phase 1 (member onboarding + full co-chair management: invite, E2EE setup, F-172 grant ceremony, 4-eyes role/remove) is **complete on trunk — PRs #315-320 merged** (origin/main HEAD = `abea6b7`, the #320 merge). The final sub-PR **P1-8e** (the co-chair role-change/remove/reactivate UI carrying the three F-181/F-182 Phase-1 mitigations — honest remove/reactivate copy + the tested-as-known pgTAP/vitest battery) landed in **PR #320**. _(The synthesis readers ran against a stale local checkout — origin/main was still at `e522635` locally when the map was built — and wrongly reported P1-8e as in-flight; that has been corrected here. The immediate next build is the F-182 key-rotation fix, which rewrites the same `committee_remove_member` / `committee_reactivate_member` + remove/reactivate UI P1-8e just shipped.)_

## What this app is

A private, invite-only, **worker-side-only** JHSC PWA (SvelteKit + `adapter-static`, TypeScript) on Supabase Cloud pinned to `ca-central-1`, **English at launch** (i18n scaffolded for later fr-CA), with **E2EE** as the load-bearing mitigation for cloud-hosted PI (ADR-0001/0003). Public sign-up is "never"; employer-IdP SSO is a hard architectural "never". Lifecycle is Build → Verify → Ship, and Ship terminates in a single explicit human gate: the production deploy.

## A note on the two "phase" taxonomies

The record blends two numbering schemes. This roadmap uses the **product-delivery arc** (Phase 0 → 0a → 1 → 2a → 2b → 3 → 4, defined by ADR-0025..0029) as the spine, and folds the **M0–M11 production-readiness milestone ladder** (the 2026-06-12 roadmap) into three cross-cutting tracks: *Registers* (M3–M5), *Ops hardening* (M6–M9), and *Launch* (M10–M11).

## Phase / track status

| Phase / Track | Title | Status | Key gate |
|---|---|---|---|
| 0 | Foundation (arch, CI, observability, threat model) | ✅ done | — |
| auth-bringup | Auth bring-up: JWKS trust + first-co-chair bootstrap (ADR-0025) | ✅ done (operator config remains) | HG-AUTH-JWKS |
| 0a | First co-chair crypto-provisioning ceremony (ADR-0026) | ✅ done | HG-AUTH-PHASE0A |
| 1 | Member onboarding + full co-chair management (ADR-0029) | ✅ done (PRs #315-320 merged) | HG-ONBOARD-PHASE1 |
| 2a | Concerns E2EE workflow (ADR-0027) | ✅ done | HG-CONCERNS-PHASE2A |
| 2b | Reprisal E2EE + governance (ADR-0028) | 🟡 partial (PR1 merged, PR2 pending) | HG-REPRISAL-PHASE2B |
| 2c/2d | Future E2EE read features | ⏸️ deferred (no ADR yet) | future ADR |
| **F-182** | **Key-rotation-on-membership-change (TOP follow-up)** | 🔴 pending — **immediate next build** (P1-8e predecessor now merged) | threat-modeler re-pass + PIA + user HG |
| registers | Work-refusal/s51 cutover, 6 demo registers, derived-view repoint, role enforcement (M3–M5) | 🟡 partial | HG-5/3/4 (inspections) |
| ops | Retention/backup/integrity provisioning + observability + session-live (M6–M9) | 🟠 in-flight | HG-15, deploy gate |
| 3 | Launch / Ship (M10–M11) | 🔴 pending | HG-10, HG-9, deploy gate |
| 4 | SRE / distributed tracing | ⏸️ deferred | 90d prod data + SLO |

### What is genuinely shipped (git-grounded)

- **Auth, committee, crypto core, concerns, reprisal (file/read/feed), retention, audit-integrity, backup jobs** are live in source: 45 migrations, 9 edge functions. Concerns (Phase 2a) and reprisal PR1 (Phase 2b, commit `25c4e09`) are cut over to production with demo helpers removed.
- **Committee onboarding (ADR-0029)** is the most actively-developed area and is now **fully merged**: **P1-8a..e + P1-9** through PR #320 (origin/main HEAD `abea6b7`). P1-8e carries the co-chair role-change/remove/reactivate UI **and all three F-181/F-182 Phase-1 mitigations** (honest remove/reactivate copy + the tested-as-known pgTAP/vitest battery) — all now on trunk.
- **E2EE (T07)** is partial: wrap/unwrap/recovery/grant + SHA-256 fingerprint are live; committee-key **rotation** is scaffolded (substrate exists) but has no removal-triggered flow — this is the F-182 gap.
- **Panic-wipe + session-revoke** are wired via `/settings`; the **export engine** is code-complete but has **no route** and is imported nowhere — not user-reachable.

### What is NOT built despite appearing on the plan

- **Inspections, minutes, recommendations, training, library** are demo-only viewers (route + Viewer + `demo-*` provider, **no table/EF/migration**).
- **Work-refusal (s.43) and s.51-evidence**: the T14 **backend exists** (migration `06_t14`, `t14-op` EF, both tables) but the routes still render demo data — no production-flows for work-refusal, no supabase client for s51. This is the highest-leverage "nearly there" item.
- **Derived/aggregate views over demo data**: `/search` builds its index once at mount over the demo providers, and `/report` renders a demo-note — both read demo data and **will not function on real registers until repointed** at cutover. `/saved-views` is **localStorage-only** (client-local, no PI, no backend needed).
- **Hazard status workflow** is explicitly deferred (ADR-0027 Decision 6).
- **/audit and /sensitive-feed** viewers are demo-only (though `audit_log` is written for real by every EF).

## Launch blockers (now → deployable, AODA/PIPEDA-compliant)

These stand between the current state and a compliant public launch. fr-CA is **not** on this list — it is a respected deferral.

1. **Accessibility statement page (AODA IASR s.14)** — missing; no `/accessibility` route or design-system surface. *S + approval.*
2. **Accessibility feedback mechanism (AODA)** — missing; today only "ask your co-chair". *S.*
3. **Design-system Surface J for AODA artifacts (Advisory A-6)** — designer must add it; §4 has no such surface. *S.*
4. **WCAG 2.0 AA per-surface sign-off + real assistive-technology pass** — hard AODA minimum; per-surface a11y-specialist gate. *M + real-AT.*
5. **F-19 source_name export-leak structural enforcement** — the T3 launch blocker: closed-const allowlist + ESLint no-spread + PDF byte-grep so complainant source_name / C4 never reaches the employer co-chair. *M (with the export pipeline).*
6. **Panic-wipe functional in prod (G-T19-PRIV-3)** — `emitAudit` is a fail-closed stub; panic-wipe destroys nothing until the audit transport lands. *M.*
7. **Retention sweep pg_cron (G-T16-3)** — PIPEDA 4.5 HARD GATE; library shipped, 03:30 ET cron not provisioned. *S + HG-15.*
8. **Backup storage + monthly restore drill (G-T17-1/5)** — 4 store methods throw `not_implemented`; no bucket, no drill (PIPEDA 4.7, RA-2 control #4). *M + HG-15.*
9. **Integrity-check pg_cron (G-T18-1)** — runner shipped, 04:30 ET schedule not provisioned. *S.*
10. **Session-revocation uniformity (M1 / F-121)** — open HIGH. **F-116** (the EF-dispatch obligation) is **already enforced** (committee-op/concern-op/t07-op/auth-op carry the dispatcher-side `session_is_live` precheck); the live-open surface is **F-121**: read-path ops (`getUser`/`getSession`/`listActiveSessions`/`listCredentials` + concern list-view) **and** the auth-op revoke ops (`revokeMySession`/`revokeAllMySessions`/`revokeMyPasskey`) do not gate on `session_is_live()`, so a revoked-but-unexpired JWT can enumerate/act for ≤300s. *M.*
11. **Privacy policy published + privacy lawyer review (HG-10)** — PIPEDA openness + legal sign-off. *M + external.*
12. **Labour lawyer (OHSA s.50) review (HG-10)** — worker-side posture + export model must not become a reprisal vector. *external.*
13. **HG-10 consent-copy ratification** — concern-intake purpose (G-T08-11), reprisal consent (G-T13-13), export interstitial (G-T11-17/18). *S each, blocked on counsel.*
14. **Retention schedule final approval (HG-9)** — PIPEDA principle 5; schedule drafted, sign-off outstanding. *S.*
15. **Complaints / challenge-compliance contact published (PIPEDA principle 10)** — bundled with privacy policy. *S.*
16. **Subpoena / legal-process playbook** — Supabase/AWS CLOUD-Act reachable; E2EE is the stated mitigation. *M.*
17. **External penetration test of staging** — authn, RLS, panic-wipe, export, 9 EFs; firm not chosen. *L, external.*
18. **Incident-response plan + breach-notification readiness (PIPEDA s.10.1)** — OPC + individual notice, 24-mo records, comms templates. *M.*
19. **HG-15 new-physical-table re-ratification** — retention/backup/integrity tables + `auth.users`-as-GoTrue-PI-store. *S.*
20. **License selection** — LICENSE is a placeholder. *S.*
21. **Production CI/CD + first-PI-deploy human gate (M11)** — PR→staging→soak→canary→prod, tested rollback, on-call. *M.*

## Recommended execution order

Ranked for launchability + highest-severity security first, dependency-aware. **Rank 1 (land P1-8e) is now ✅ DONE (PR #320, merged 2026-07-14).** The effective next builds are rank 2 (F-182) and rank 3 (F-121), which are independent of each other and can run in parallel.

1. ✅ **DONE — P1-8e merged (PR #320).** Completed Phase 1: the co-chair role-change/remove/reactivate UI + the three F-181/F-182 Phase-1 mitigations (honest remove/reactivate copy + the tested-as-known battery), all on trunk (`abea6b7`).
2. **F-182 key-rotation-on-membership-change** — **the immediate next build.** The explicitly-flagged TOP follow-up and the highest ACTIVE residual now that reprisal is live: a single co-chair can silently restore a removed member's crypto access via the retained wrap with no 4-eyes / no Ceremony 4. Its predecessor (P1-8e) is now on trunk. Ship all four sub-parts (delete-wrap + rotate + re-wrap-remaining + Ceremony-4-on-reactivate) together or it re-opens; subsumes the Amdt-A regrant-wrap question. *XL — threat-modeler re-pass + PIA + user HG.*
3. **M1 session-revocation uniformity (F-121)** — cheap open HIGH on live surfaces; F-116 is already enforced at dispatch, so scope is the read-path ops + concern list-view + the auth-op revoke ops. Also unblocks M5 role enforcement; independent of rank 2, run in parallel. *M — security-reviewer.*
4. **Phase 2b PR2 — reprisal governance** (4-eyes status-approval + forensic break-glass; the app's highest-privilege op). Server + transport already exist; needs the read migration, four compositions, and two UIs. *L — HG-REPRISAL-PHASE2B.*
5. **Real-PI-deploy hard gates** — panic-wipe audit transport, retention pg_cron, integrity pg_cron, backup storage + restore drill. *M — HG-15 + deploy gate.*
6. **T14 work-refusal + s.51 UI cutover** — backend done; highest-leverage nearly-there feature. *M — standard review.*
7. **M7 export pipeline** — F-19 structural enforcement + OHSA 21-day timer + WebAuthn re-auth verify + notification fanout + real PDF lib + route. *L — HG-10 + HG-1/RA-1.*
8. **M4 remaining registers** — inspections (T10.1, largest), minutes, recommendations, training, library + `/audit` and `/sensitive-feed` live wiring + repoint `/search` and `/report` off the demo providers (`/saved-views` is client-local, no backend). *XL — HG-5/3/4 for inspections.*
9. **M5 role enforcement** across UI + EF dispatch (depends on M1 rank 3 + the registers existing). *M.*
10. **M9 observability completion** — A-BACKUP-002/003, A-EXPORT-002, SLOs, per-surface Sentry allowlist. *M.*
11. **AODA artifacts** — statement + feedback + Surface J (start early for the approval loop). *S — user + lawyer.*
12. **Phase 3 launch-gate stack (M10)** — pen-test, lawyer reviews (HG-10), retention approval (HG-9), policies published, subpoena playbook, IR plan, license, HG-15, restore drill signed. Line up counsel + vendor in parallel. *L, external.*
13. **M11 production CI/CD + first PI deploy.** *M — production-deploy human gate (never automated).*

## Respected deferrals — do NOT build these now

- **Phase 4 distributed tracing** — until ~90d prod data + a defensible SLO; the audit log is the trace at this scale. Re-open only on the three named triggers.
- **Phase 2c/2d E2EE read features** — write the ADR first; they inherit the 2a PR1 infra.
- **Concern status/triage workflow** (ADR-0027 Decision 6) — future additive migration.
- **Idle-timeout holder-wipe** (ADR-0027 Decision 1b) — the six wipe triggers already cover it.
- **C4 key_id-widening on reprisal_read** (ADR-0028 Decision 1b) — default is probe-first parity; escalate only on reviewer objection.
- **Audit-row cryptographic signing → v2** (RA-2) — hash-only chain + backup-diff backstop in v1.
- **Duress mode → v2** (O-1/F-41); **server-cascade panic-wipe → v2** (G-T19-3, v1 is local-only by adjudication).
- **fr-CA localization** — English + accommodations satisfies AODA; deferred to a later pass + a second HG-10.
- **v1 NOT-DOING set** — native shell, server-side PDF, push, real-time collab, cross-province, **multi-committee tenancy** (CI-banned), public/anonymous intake, employer surfaces, native passkey sync, SIEM export.
- **Regrant-overwrites-wrap semantics** (ADR-0029 Amdt A) — **resolve inside the F-182 fix (rank 2)**, not piecemeal; do not silently change wrap semantics.
- **/saved-views backend** — localStorage-only client-local state; needs no backend cutover (unlike `/search` and `/report`, which must be repointed at register cutover).
- **Stored-fingerprint backfill/column-drop** (Amdt A-6.1); **server-side paged concerns RPC** (2a Decision 8, until >500–1000 rows); **`stillborn_init` rotation enum** (ADR-0026 Amdt A) — cosmetic future changes.

## Human-gate & merge policy (unchanged, load-bearing)

`main` is trunk; branch-per-task; PR to `main`; **the user merges**. Five blocking CI jobs gate every PR (`build-test`, `hardening-gates`, `committee-db-tests`, `supabase-live-stack`, `mint-live-e2e`). Non-automatable human gates: privacy policy & ToS, retention schedule, any cross-border transfer, any new subprocessor, regulator response, breach-notification decisions, and **any production deploy touching auth/PI**. Auth/authz/session changes get extra review, never autonomous merge. `.context/` memory changes travel as their own dedicated PR; `constraints.md` is never auto-edited.

_Not legal advice — a privacy lawyer (PIPEDA/Ontario) and a labour lawyer (OHSA s.50) must review before any production launch._