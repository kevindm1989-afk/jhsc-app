/**
 * mint-session live-stack e2e (Deno) — proves the asymmetric-key trust wiring
 * end-to-end against a running Supabase stack (ADR-0023 / F-118, F-117/F-119).
 *
 * Run by the `mint-live-e2e` CI job after `supabase start` with the mint public
 * key registered as a standby signing key (supabase/signing_keys.test.json).
 * It reuses the REAL signing.ts, so it also exercises the production signer.
 *
 * Asserts:
 *   1. the stack's JWKS publishes the mint key (kid=jhsc-local-mint), so
 *      PostgREST/GoTrue will validate tokens signed by it;
 *   2. a self-minted role=mint_writer token is accepted by PostgREST and may
 *      invoke a mint_* RPC (live proof the mint_writer EXECUTE grant works);
 *   3. an anon caller is DENIED the same RPC (F-117/F-119 at the HTTP layer).
 *
 * NOT covered here (next increment): the full Edge Function + real WebAuthn
 * assertion path; this validates the token-trust + grant boundary the whole
 * mint path depends on.
 */

import { signMintWriterToken } from '../supabase/functions/mint-session/signing.ts';

const URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const MINT_KID = 'jhsc-local-mint';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  Deno.exit(1);
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

// (1) The mint key must be published in the stack JWKS.
const jwksRes = await fetch(`${URL}/auth/v1/.well-known/jwks.json`, { headers: { apikey: ANON } });
if (!jwksRes.ok) fail(`JWKS endpoint returned ${jwksRes.status}`);
const jwks = (await jwksRes.json()) as { keys: Array<{ kid?: string }> };
if (!jwks.keys?.some((k) => k.kid === MINT_KID)) {
  fail(`JWKS does not publish the mint key (kid=${MINT_KID}); keys=${JSON.stringify(jwks.keys?.map((k) => k.kid))}`);
}
ok(`JWKS publishes the mint key (kid=${MINT_KID})`);

// (2) A mint_writer token must be accepted and able to call a mint RPC.
const writer = await signMintWriterToken(Date.now());
const rpcRes = await fetch(`${URL}/rest/v1/rpc/mint_issue_challenge`, {
  method: 'POST',
  headers: { apikey: ANON, Authorization: `Bearer ${writer}`, 'content-type': 'application/json' },
  body: JSON.stringify({ p_rp_id: 'app.example.test', p_origin: 'https://app.example.test' })
});
if (rpcRes.status !== 200) {
  fail(`mint_writer mint_issue_challenge expected 200, got ${rpcRes.status}: ${await rpcRes.text()}`);
}
const challenge = await rpcRes.json();
if (typeof challenge !== 'string' || challenge.length < 16) fail(`unexpected challenge payload: ${JSON.stringify(challenge)}`);
ok('mint_writer token accepted by PostgREST and issued a challenge (JWKS trust + EXECUTE grant live)');

// (3) An anon caller must be DENIED the mint RPC (least privilege, F-117/F-119).
const anonRes = await fetch(`${URL}/rest/v1/rpc/mint_issue_challenge`, {
  method: 'POST',
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'content-type': 'application/json' },
  body: JSON.stringify({ p_rp_id: 'app.example.test', p_origin: 'https://app.example.test' })
});
if (anonRes.status === 200) fail('anon was able to call mint_issue_challenge — least-privilege boundary broken');
ok(`anon is denied the mint RPC (status ${anonRes.status})`);

console.log('mint-session live e2e: PASS');
