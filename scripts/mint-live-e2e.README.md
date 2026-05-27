# Mint-session live-stack e2e

Closes the one piece of the passkey-login mint path (T05.1 / ADR-0023) that
cannot be covered hermetically: proving that a token the mint function signs is
actually **trusted** by a real GoTrue + PostgREST via the JWKS, and that the
`mint_writer` least-privilege boundary holds at the HTTP layer.

Everything else is already tested without a stack:
- token signing (`signing.ts`) and the mint orchestration (`core.ts`),
- the real WebAuthn-assertion verification end-to-end
  (`supabase/functions/mint-session/test/assertion.test.ts`),
- the RLS + `mint_writer`-only EXECUTE grants (pgTAP: `supabase/test/mint_rls.sql`).

## What the e2e proves (trust layer)
1. the stack's JWKS publishes the mint **standby** signing key;
2. a self-minted `role=mint_writer` ES256 token is accepted by PostgREST and may
   invoke `mint_issue_challenge` (F-118 trust + the EXECUTE grant, live);
3. an **anon** caller is denied the same RPC (F-117/F-119).

## Requirements
- Docker (running) — the Supabase local stack runs in containers.
- Supabase CLI, Deno, and `jq` on PATH.

This is why it is **not** in this container: no Docker daemon here. Run it where
Docker is available.

## Run
```bash
bash scripts/mint-live-e2e.sh
```
The script:
- generates **one** ES256 key with `supabase gen signing-key` (GoTrue's exact
  format — hand-rolled JWKs caused `failed to decode signing keys` /
  `no signing key detected`; and Ed25519 is rejected with
  `must be one of [RS256 ES256]`, which is why the signer is ES256);
- writes it to `supabase/signing_keys.local.json` (gitignored — **private**
  key material). **The local CLI accepts only ONE signing key**
  (`multiple signing keys detected, only 1 signing key is supported`), so the
  mint function signs with the **same** key GoTrue uses. A *separate*
  validation-only mint key (key isolation) is a **hosted-Supabase** property
  (hosted supports key rotation / multiple JWKS keys); this local harness proves
  the trust + grant boundary, and key isolation is verified in the hosted config;
- forces a clean restart (`supabase stop` then `start`) so the signing-key
  config is actually loaded;
- inserts `signing_keys_path` under `[auth]` in `config.toml`;
- `supabase start`, runs `scripts/mint-live-e2e.ts` as the standby key, then
  restores `config.toml` and deletes the key file on exit (always).

## Known caveats / first-run watch-points
- **`supabase status -o env` keys**: the script expects `API_URL` and `ANON_KEY`.
  If a CLI version renames these, adjust the `eval`/inline-env in the script.
- **`signing_keys_path` resolution**: assumed relative to the `supabase/` config
  dir. If a CLI version resolves it from the repo root, point it at
  `./supabase/signing_keys.local.json` instead (or stage a copy at the root).
- **Asymmetric-JWT friction**: see supabase/cli issues #4098 / #4373 / #4488 if
  `supabase start` complains about the key file.

## Extending to the full served-function HTTP flow (optional, later)
The trust e2e above does not serve the Edge Function. To exercise the real
`POST /functions/v1/mint-session` `challenge`→`assert` path end-to-end:
1. seed a user + `webauthn_credentials` row whose `public_key` is the COSE form
   of a known test keypair (insert via `psql` on `:54322`);
2. `supabase functions serve mint-session --no-verify-jwt` with
   `MINT_SIGNING_JWK` set to the standby key;
3. build a valid assertion for that keypair (reuse the construction in
   `test/assertion.test.ts`) and POST it; assert a token comes back and that it
   then authorizes a committee RPC.
The assertion construction + verification is already proven in
`test/assertion.test.ts`, so this only adds the serve + seed integration.

## Wiring into CI (after a clean local run)
GitHub runners have Docker, so this can become a CI job (it was prototyped as
one and pulled while the signing-key format was unresolved). Once a local run is
green, re-add a `mint-live-e2e` job mirroring `supabase-live-stack` in
`.github/workflows/ci.yml`, calling `bash scripts/mint-live-e2e.sh`. Keep it a
**separate** job so signing-key friction can't red the pgTAP coverage.
