# JHSC App — `apps/web`

Worker-side JHSC (Ontario Joint Health & Safety Committee) PWA. SvelteKit

- Vitest + Supabase. **Worker-side-only by construction** — see
  `/JHSC-APP-PLAN.md` for the product context and `/.context/decisions.md`
  for the ratified ADRs and amendments.

> **Status — Phase 3 in flight.** Auth (T05 / T05.1), key-management
> (T07 / T07.1), concerns (T08 / T08.1), and onboarding (T19) have
> shipped substantial production wire-up; ~1437 Vitest pass / 2 skipped.
> Remaining sibling-task production wire-ups (T10.1 / T11.1 / T13.1 /
> T14.1 / T16 retention / T17 backup / T18 integrity) are tracked in
> `.context/known-gaps.md`. Test files in `apps/web/test/T**` are
> read-only (test-writer owns).

---

## Prerequisites

| Tool         | Version             | Why                                 |
| ------------ | ------------------- | ----------------------------------- |
| Node         | 22.x (see `.nvmrc`) | Project runtime                     |
| pnpm         | 10.33.0+            | Package manager (workspace root)    |
| Supabase CLI | latest              | Local stack for integration tests   |
| Deno         | 1.46+               | Edge-function test runner           |
| `pg_prove`   | latest              | pgTAP SQL-level tests               |
| gitleaks     | 8.21+               | Secrets scan in `scripts/verify.sh` |
| semgrep      | 1.95+               | Static analysis in CI               |

The CI workflow (`.github/workflows/ci.yml`) provisions all six in a
GitHub-hosted runner; local devs install what they need to iterate on a
given task.

---

## Quick start (clean machine)

```sh
# From the repo root (/home/user/agent-os):
nvm use                          # picks Node 22 per .nvmrc
pnpm install                     # installs workspace deps

# Web app
pnpm -C apps/web dev             # http://localhost:3000

# Tests (Vitest unit + integration)
pnpm -C apps/web test

# Full verification gate stack (all of the above + secrets/static/audit)
bash scripts/verify.sh
```

---

## What runs in `pnpm test`

The full Vitest suite (currently **1437 pass / 2 skipped**) covers
T02 (observability), T05 / T05.1 (auth + mint-session), T07 / T07.1
(key management), T08 / T08.1 (concerns), and T19 / T19.1 (onboarding,
panic-wipe, route mounts). T10 / T11 / T13 / T14 / T16 / T17 / T18
sibling-task production wire-ups are still in flight; the library-only
halves are shipped and tested.

Edge-function tests live in `supabase/functions/auth-op/test/` and
related directories; they run under Deno
(`deno test --allow-read ...`) and are part of the
`hardening-gates` CI job, not the Vitest run.

pgTAP tests live in `supabase/test/` and run under `pg_prove` against
a `supabase start` local stack (the `committee-db-tests` CI job runs
this against a fresh container).

---

## Production routes

| Route         | Purpose                                        |
| ------------- | ---------------------------------------------- |
| `/`           | Landing — branches on `$isSignedIn`            |
| `/onboarding` | D.1 → D.7 wizard (mounted by `OnboardingFlow`) |
| `/sign-in`    | Mint-session passkey ceremony                  |
| `/settings`   | Sign-out + panic-wipe trigger                  |
| `/privacy`    | Placeholder privacy summary (HG-10 pending)    |
| `/+error`     | Customized error page (404 + generic)          |

All routes are `prerender = true; ssr = false` per `+page.ts`
(adapter-static; no PI on the route surface). The shared layout
(`/+layout.svelte`) provides the sticky top bar, brand mark, primary
nav, theme toggle, and mobile bottom tab bar.

---

## Project layout

```
apps/web/
├── src/
│   ├── app.html                                # System-font stack + boot CSS tokens
│   ├── app.css                                 # Worker-hub global styles
│   ├── app.d.ts
│   ├── hooks.client.ts                         # Sentry init + cross-tab JWT sync + panic-wipe hooks
│   ├── service-worker.ts                       # PWA registration + cache versioning
│   ├── lib/
│   │   ├── auth/                               # Mint-session, WebAuthn, JWT store, F-39 revocation loop
│   │   ├── concerns/                           # Encrypted concern intake (T08)
│   │   ├── crypto/                             # libsodium-wrappers-sumo wrappers, recovery-blob
│   │   ├── i18n/                               # en-CA / fr-CA catalog loader
│   │   ├── inspections/                        # Offline queue + HMAC integrity (T10 library-only)
│   │   ├── lock/                               # PanicWipeModal + BrowserWipeStore (F-106)
│   │   ├── log/                                # Structured logger (browser + server)
│   │   ├── observability/sentry-scrub.ts       # PI-scrubbing Sentry beforeSend
│   │   ├── onboarding/                         # OnboardingFlow + step components D3-D7
│   │   ├── recovery/                           # Hold-to-reveal show-again controller (Amendment F)
│   │   ├── reprisal/                           # Encrypted reprisal intake (T13 library-only)
│   │   ├── server-client/                      # Edge Function factories (auth-op / t07-op / etc.)
│   │   ├── sw/                                 # Service-worker control channel
│   │   ├── tokens.ts                           # Typed accessor over /design-tokens.json
│   │   └── ui/                                 # BottomTabBar / Icon / ThemeToggle
│   ├── routes/                                 # Production routes (see table above)
│   └── lib/feature-flags.ts                    # In-process flag system (no SaaS)
├── static/
│   ├── manifest.webmanifest                    # PWA manifest (theme_color = #2563eb)
│   ├── icon.svg                                # Brand mark (worker-hub blue)
│   └── .well-known/security.txt                # RFC 9116
└── test/                                       # READ-ONLY (test-writer owns)
    ├── _helpers/
    └── T02 … T19/                              # 1437 passing / 2 skipped
```

---

## Pointers

- **Plan:** `/JHSC-APP-PLAN.md`
- **ADRs + amendments + RA-1/RA-2:** `/.context/decisions.md`
- **Test plan:** `/.context/test-plan.md`
- **Threat model:** `/.context/threat-model.md`
- **Privacy review:** `/.context/privacy-review.md`
- **Design system + tokens:** `/.context/design-system.md` + `/design-tokens.json`
- **Observability contract:** `/observability/` (six files)
- **i18n catalog:** `/i18n/en-CA.json`
