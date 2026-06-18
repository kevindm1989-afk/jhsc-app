# JHSC App

A private, **worker-side** application for an Ontario **Joint Health and
Safety Committee (JHSC)** — built for the worker members, the worker
co-chair, and worker certified member(s). It supports the worker side's
OHSA duties (concern intake, hazard register, monthly inspections,
meeting prep, recommendations, work-refusal (s.43) and critical-injury
(s.51) workflows) while keeping deliberation content readable **only** by
authorized worker members.

> **Out of scope by design:** employer members, the employer co-chair, HR,
> managers, supervisors, and any third party. See `JHSC-APP-PLAN.md` for the
> full product scope and `.context/decisions.md` for the ratified ADRs.

> **Not legal advice.** A privacy lawyer and a labour-law lawyer must review
> the app before any production launch.

---

## Security posture

The system is built so that even if the server, the hosting provider, or a
worker's device is compromised, worker-side content cannot be read without a
key held by an authorized worker member.

- **End-to-end encryption** of committee content (WebCrypto +
  `libsodium-wrappers-sumo`; the WASM build requires CSP
  `'wasm-unsafe-eval'` — JS `eval` / `new Function` remain forbidden).
- **Recovery passphrase** derived with **Argon2id**; the recovery blob is
  encrypted client-side and never leaves the device in plaintext.
- **Passkey (WebAuthn)** device enrollment with a TOTP bootstrap; sign-in
  via the mint-session ceremony (ES256 + JWKS, ADR-0023).
- **Panic-wipe** destructive ceremony with audit-before-side-effect
  ordering (F-106 / M-106a — server logs the action before any local
  data is destroyed) and a four-regex confirmation contract (F-115).
- **F-39 client revocation loop** — Edge Function 401 responses
  automatically clear the in-memory JWT and broadcast across tabs via
  `BroadcastChannel`.
- **Offline-first PWA** — inspections and concerns are queued locally with
  per-entry HMAC integrity tags and synced when online.
- **No third-party JS at runtime** — Sentry SDK is bundled, never loaded
  from a CDN; system-font stack only (no Google Fonts); strict CSP with
  `script-src 'self' 'wasm-unsafe-eval'` (no `unsafe-eval` / `unsafe-inline`).
- **PII-scrubbing observability** — the structured logger and Sentry
  `beforeSend` drop denylisted fields; canary tests enforce the contract.
- **Data residency** — Supabase project pinned to `ca-central-1`.
- **Bilingual (en-CA / fr-CA)** and **AODA / WCAG 2.0 AA** accessible.

The threat model and privacy reviews live under `.context/` and the
`*-review-t19.md` files at the repo root.

---

## Stack

| Layer         | Choice                                                     |
| ------------- | ---------------------------------------------------------- |
| Frontend      | SvelteKit 5 (`@sveltejs/adapter-static`), TypeScript       |
| Crypto        | `libsodium-wrappers`, WebCrypto, Argon2id                  |
| Backend       | Supabase (Postgres + RLS + Edge Functions), `ca-central-1` |
| Observability | `@sentry/sveltekit` (bundled), structured PII-safe logger  |
| Tests         | Vitest (+ Testing Library), pgTAP, Deno (edge functions)   |

---

## Repository layout

```
apps/web/              SvelteKit app (@jhsc/web)
  src/lib/             feature modules (see below)
  test/                Vitest unit + integration suites (T02–T19)
supabase/              migrations, seed, config.toml, edge functions
i18n/                  en-CA / fr-CA catalogs (root)
observability/         logging, audit-log, alerts, dashboards, Sentry scrub
scripts/               verify.sh + the individual gate scripts
.semgrep/              project-specific semgrep rules
design-tokens.json     design-system tokens (consumed via $lib/tokens)
.context/              ADRs, threat model, privacy/test plans
JHSC-APP-PLAN.md       product plan with all blocking decisions locked
```

Feature modules under `apps/web/src/lib/`: `audit-integrity`, `auth`,
`backup`, `concerns`, `crypto`, `export`, `i18n`, `inspections`, `lock`,
`log`, `observability`, `onboarding`, `photo`, `recovery`, `reprisal`,
`retention`, `s51-evidence`, `sw`, `work-refusal`.

---

## Prerequisites

| Tool         | Version             | Why                                    |
| ------------ | ------------------- | -------------------------------------- |
| Node         | 22.x (see `.nvmrc`) | Project runtime (`>=22 <23`)           |
| pnpm         | 10.33.0             | Workspace package manager              |
| Supabase CLI | latest              | Local stack for integration tests      |
| Deno         | 1.46+               | Edge-function test runner              |
| `pg_prove`   | latest              | pgTAP SQL-level tests                  |
| gitleaks     | 8.21+               | Secrets scan in `scripts/verify.sh`    |
| semgrep      | 1.95+               | Static analysis in `scripts/verify.sh` |

CI (`.github/workflows/ci.yml`) provisions all of these on a GitHub-hosted
runner. Locally, install only what a given task needs.

---

## Quick start

```sh
nvm use                 # Node 24 per .nvmrc
pnpm install            # workspace deps (run from the repo root)

pnpm dev                # dev server (apps/web)
pnpm test               # Vitest suite
pnpm verify             # full gate stack (scripts/verify.sh)
```

Copy `.env.example` to `apps/web/.env` for local Sentry/Supabase config.
`.env` is gitignored; the build reads the Sentry DSN via dynamic env so it
works without a `.env` (CI / fresh clones).

---

## Scripts (repo root)

| Command             | Action                                                     |
| ------------------- | ---------------------------------------------------------- |
| `pnpm dev`          | `vite dev` in `apps/web`                                   |
| `pnpm build`        | production build (`adapter-static`, `NODE_ENV=production`) |
| `pnpm test`         | Vitest run (currently **1437 pass / 2 skipped**)           |
| `pnpm typecheck`    | `svelte-check` + `tsc --noEmit` (strict)                   |
| `pnpm lint`         | ESLint                                                     |
| `pnpm format:check` | Prettier check                                             |
| `pnpm verify`       | full verification gate stack                               |

---

## CI gates

Five jobs, all **blocking** on PRs to `main`
(`.github/workflows/ci.yml`, pinned by
`apps/web/test/T19/ci-workflow.test.ts`):

1. **build-and-test** — build, strict typecheck, Vitest.
2. **hardening-gates** — `scripts/verify.sh`: ESLint, Prettier,
   token-audit, i18n raw-string scan, gitleaks, semgrep, `pnpm audit`,
   audit-log enum coverage, bundle hygiene, region pin,
   recovery-surface lint, Vitest, Deno edge-function tests, plus the
   onboarding test-prop strip gate
   (`scripts/check-onboarding-test-props-stripped.sh`) running against
   a real `NODE_ENV=production` build.
3. **committee-db-tests** — pgTAP against the committee membership +
   RLS migrations under `supabase/test/*.sql`.
4. **supabase-live-stack** — end-to-end GoTrue → `auth.uid()` → RLS
   chain against a live local Supabase stack.
5. **mint-live-e2e** — ES256 + JWKS verification end-to-end against
   the mint-session ceremony (ADR-0023 asymmetric-JWT contract).

All five run on `ubuntu-22.04` (pinned — drift to `ubuntu-latest`
would silently change Docker / Postgres versions) with
`cancel-in-progress: true` concurrency so a rapid push storm doesn't
queue redundant runs.

---

## License

See `LICENSE` (currently a placeholder — choose a license before publishing).
