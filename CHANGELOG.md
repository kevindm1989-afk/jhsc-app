# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Worker-side JHSC application (`apps/web`, `@jhsc/web`) — SvelteKit 5 +
  Supabase, offline-first PWA, bilingual en-CA / fr-CA, AODA / WCAG 2.0 AA.
- Feature modules: onboarding (passkey enrollment, Argon2id recovery
  passphrase, panic-wipe), end-to-end-encrypted concern intake and hazard
  register, offline inspection queue with per-entry HMAC integrity, photo
  capture with EXIF/GPS stripping, export pipeline, reprisal log,
  work-refusal (s.43) and critical-injury (s.51) workflows, retention,
  backup, and audit-log integrity.
- Client-side cryptography (`libsodium` + WebCrypto), recovery-blob
  encryption, and committee/identity key handling.
- PII-safe observability: structured browser logger + Supabase edge-function
  logger with a shared safe-fields allowlist, and a Sentry `beforeSend`
  scrubber with canary tests.
- Verification gate stack (`scripts/verify.sh`): ESLint, Prettier,
  token-audit, i18n raw-string scan, gitleaks, semgrep (project rules +
  auto), `pnpm audit`, audit-log enum coverage, bundle hygiene,
  Supabase-region pin, recovery-surface lint, Vitest, pgTAP, and Deno
  edge-function tests.
- Project-specific semgrep rules under `.semgrep/` and a `.gitleaks.toml`
  allowlist for synthetic test fixtures.

### Changed

- Separated the application into its own repository, carved out of the
  Agent OS framework it was authored with.
- CI: build the app before `verify.sh` so the bundle-hygiene gate scans the
  built bundle; install semgrep into an isolated virtualenv to avoid
  `--user` dependency conflicts; **promoted `hardening-gates` to a blocking
  required check** once `verify.sh` passed end-to-end.
- Sentry DSN read via dynamic env so the build succeeds without a `.env`
  (CI / fresh clones).

### Fixed

- Hardening-gate backlog cleared while preserving all behaviour and tests:
  - a11y: documented the panic-wipe focus-trap and the test-contracted
    `aria-disabled` / `role="region"` attributes via justified
    `svelte-ignore`;
  - token-audit: `verify-tokens.sh` now ignores comments and
    `var(--token, …)` fallbacks, flagging only genuine raw colors;
  - i18n: `PhotoCaptureSurface` consumes the `photo.*` catalog via `t()`;
  - semgrep: fixed two invalid rule files (the real cause of the gate's
    exit 7), removed the forbidden audit-event alias literal from
    `inspections/queue.ts`, and guarded/justified the read-only `resolveDot`
    catalog traversal;
  - Deno edge-function tests: pinned `std@0.224.0`, corrected
    `assertNotMatch` argument order, and run with `--allow-env`.

### Status

- `build-and-test` and `hardening-gates` CI jobs are green and blocking.
- Test suite: **662 passing, 2 skipped**; strict typecheck clean.
- Pre-production: a privacy lawyer and a labour-law lawyer must review before
  launch (see `JHSC-APP-PLAN.md`).
