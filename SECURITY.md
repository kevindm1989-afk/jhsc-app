# Security Policy

This is a worker-side JHSC application handling sensitive health-and-safety
deliberation content. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's private vulnerability reporting:
**Security → Advisories → Report a vulnerability** on this repository
(https://github.com/kevindm1989-afk/jhsc-app/security/advisories/new). This is
the only intake channel for security reports.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (or a proof-of-concept — please don't publish it
  publicly),
- affected versions/commit, and any suggested remediation.

We aim to acknowledge reports within a few business days. Please allow
reasonable time for a fix before any public disclosure.

## Scope

In scope:

- the SvelteKit app (`apps/web`),
- the Supabase schema, RLS policies, and edge functions (`supabase/`),
- the client-side cryptography (`apps/web/src/lib/crypto`, `recovery`,
  `auth`) and the offline-queue integrity path (`apps/web/src/lib/inspections`),
- the observability PII-scrubbing path (`observability/`,
  `apps/web/src/lib/log`, `.../observability/sentry-scrub.ts`).

Out of scope:

- third-party services (Supabase, Sentry) themselves — report those upstream,
- social-engineering and physical attacks,
- findings that require a pre-compromised authorized worker member's keys
  (the threat model explicitly bounds what device/co-chair compromise can
  reach — see `.context/threat-model.md`).

## Security model (summary)

- **End-to-end encryption** of committee content with `libsodium` + WebCrypto;
  the server never holds plaintext or decryption keys.
- **Argon2id** recovery passphrase; the recovery blob is encrypted client-side.
- **Passkey (WebAuthn)** device enrollment; **no co-chair/admin superuser** —
  a single compromised account must not equal full data loss.
- **No third-party JS at runtime** (Sentry SDK bundled, not CDN-loaded);
  system-font stack only.
- **PII-safe logging** — denylisted fields are dropped at emit on both the
  browser logger and the Supabase edge-function logger; canary tests
  (`apps/web/test/T02/`) enforce the contract.
- **Data residency** pinned to `ca-central-1`.

Full detail: `.context/threat-model.md`, the `privacy-review-*.md` and
`security-review-t19.md` files, and `JHSC-APP-PLAN.md`.

## Secrets

No real secrets are committed. `.env` is gitignored; the Sentry DSN is read
via dynamic env at runtime. `scripts/verify.sh` runs **gitleaks** on every
CI run; `.gitleaks.toml` allowlists only synthetic, clearly-labelled test
fixtures (e.g. the Sentry-scrub key-shape canary).
