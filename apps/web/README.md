# JHSC App — `apps/web`

Worker-side JHSC (Ontario Joint Health & Safety Committee) PWA. SvelteKit

- Vitest + Supabase. **Worker-side-only by construction** — see
  `/JHSC-APP-PLAN.md` for the product context and `/.context/decisions.md`
  for the ratified ADRs and amendments.

> **Status — scaffold only.** Phase-2 implementer fills in feature code
> task-by-task per `.context/test-plan.md` §6. Tests are read-only.

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

- Unit + integration tests under `apps/web/test/**`.
- **T02 tests pass** in the scaffold (the Sentry scrubber, structured
  logger, and CI-gate semgrep-rule-file existence checks are all wired).
- **T05/T07/T08/T10/T11/T13/T14/T16/T17/T18/T19 tests fail** with
  `module not found` on the feature code those tasks own. This is the
  intended failure mode at scaffold time — see `.context/test-plan.md`
  §6 (the implementer makes them pass task-by-task).

Edge-function tests live in `supabase/functions/_shared/test/` and run
under Deno (`deno test --allow-read ...`); they are not part of the
Vitest run.

pgTAP tests live in `supabase/test/` and run under `pg_prove` against
a `supabase start` local stack.

---

## What's intentionally NOT wired at scaffold

- **Sentry SDK init.** `apps/web/src/hooks.client.ts` /
  `hooks.server.ts` carry the structured-logger handler only. The
  Sentry SDK is bundled (npm) by the T02 implementer; the
  `beforeSend` / `beforeBreadcrumb` from
  `$lib/observability/sentry-scrub` are wired then.
- **Supabase auth + RLS schema.** Migrations land per-task (T05 / T06 /
  T07 / T08 / T13 / T14 / T16 / T18) per the architect's task list.
- **Feature-code modules.** `src/lib/{auth,crypto,concerns,reprisal,
inspections,export,photo,onboarding,lock}/...` do not exist yet; the
  tests import them and fail at module-resolution time.
- **Test helpers under `test/_helpers/`** that depend on a running
  Supabase / EXIF parser / B2 fake / SW harness. The stubbed
  `_helpers/supabase-test.ts` throws `NOT_IMPLEMENTED`; the implementer
  of T05 (the first task) wires it.

The full per-task acceptance criteria are in `.context/test-plan.md` §4.

---

## Project layout

```
apps/web/
├── src/
│   ├── app.html                                  # System-font stack only (no Google Fonts)
│   ├── app.d.ts
│   ├── hooks.client.ts                           # Logger + Sentry hook (Sentry wired by T02)
│   ├── hooks.server.ts                           # request_id propagation (logging.md §6)
│   ├── lib/
│   │   ├── observability/sentry-scrub.ts         # Port of observability/sentry-scrub.ts spec
│   │   ├── log/                                  # Structured logger (browser + server)
│   │   ├── i18n/                                 # en-CA catalog loader
│   │   ├── tokens.ts                             # Typed accessor over /design-tokens.json
│   │   ├── feature-flags.ts                      # In-process flag system (no SaaS)
│   │   ├── sw/                                   # Service-worker skeleton (ADR-0013 allowlist)
│   │   └── crypto/sodium.ts                      # libsodium-wrappers wrapper (ADR-0003)
│   └── routes/                                   # Placeholder landing page
└── test/                                         # READ-ONLY (test-writer owns)
    ├── _helpers/
    └── T02 … T19/                                # ~325 failing tests at scaffold hand-off
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
