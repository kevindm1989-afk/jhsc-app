/**
 * mint-session / signing — ES256 (asymmetric) JWT minting for the passkey-login
 * path (ADR-0023 / threat-model §3.12, F-118).
 *
 * Runtime: Deno (Supabase Edge Function). Uses only WebCrypto (no imports), so
 * it is hermetically unit-testable under `deno test --allow-read --allow-env`
 * (no network) — the npm-dependent verification + supabase-js wiring lives in
 * index.ts and is proven by the live stack.
 *
 * Two tokens are signed with the SAME isolated key (F-118 — no shared secret,
 * no service_role):
 *   - the user's short-lived GoTrue session token (role=authenticated), and
 *   - the mint_writer role token the handler presents to PostgREST so it may
 *     invoke the mint_* RPCs (which are granted EXECUTE to mint_writer only).
 *
 * Key custody: the private key is read from the MINT_SIGNING_JWK env secret (a
 * P-256 private JWK). When absent (local dev / CI) an ephemeral keypair is
 * generated at boot, so no key material lives in the repo. Production sets the
 * secret out-of-band and publishes the matching public JWK as the project JWKS
 * (a tracked follow-up); `publicJwk()` is the JWKS source of truth.
 */

export interface SessionClaims {
  sub: string;
  role: 'authenticated';
  session_id: string;
  iat: number;
  exp: number;
}

interface KeyState {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** RFC 7638 JWK thumbprint — stable per key, used as the JWS `kid`. */
  kid: string;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

let keyPromise: Promise<KeyState> | null = null;

function env(name: string): string | undefined {
  return Deno.env.get(name) ?? undefined;
}

// ---- base64url helpers ------------------------------------------------------

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str: string): string {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- key loading ------------------------------------------------------------

async function thumbprint(x: string, y: string): Promise<string> {
  // RFC 7638: SHA-256 over the canonical (lexicographically-keyed) JWK members.
  const canonical = `{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return b64urlFromBytes(new Uint8Array(digest));
}

async function importFromJwk(jwk: JsonWebKey & { kid?: string }): Promise<KeyState> {
  // Sanitize to only the members WebCrypto accepts for an EC key import. JWK
  // sets in the wild (e.g. Supabase signing keys) carry kid/alg/use/key_ops/ext;
  // a private EC key cannot declare key_ops:['verify'], so importing the raw
  // object fails. Rebuild a clean private/public JWK and keep `kid` separately.
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    ALG,
    false,
    ['sign']
  );
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    ALG,
    true,
    ['verify']
  );
  // Honour the JWK's own `kid` when present so the JWS header matches the key's
  // entry in the published JWKS (PostgREST/GoTrue select the verifying key by
  // `kid`); otherwise fall back to the RFC-7638 thumbprint.
  const kid = jwk.kid ?? (await thumbprint(jwk.x!, jwk.y!));
  return { privateKey, publicKey, kid };
}

async function generateEphemeral(): Promise<KeyState> {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, kid: await thumbprint(pub.x!, pub.y!) };
}

function loadKey(): Promise<KeyState> {
  if (!keyPromise) {
    const raw = env('MINT_SIGNING_JWK');
    keyPromise = raw ? importFromJwk(JSON.parse(raw) as JsonWebKey) : generateEphemeral();
  }
  return keyPromise;
}

// ---- JWS (ES256) ------------------------------------------------------------

async function jws(header: Record<string, unknown>, payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const signingInput = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
  // WebCrypto ECDSA emits the IEEE-P1363 (r‖s) raw signature JWS ES256 expects.
  const sig = await crypto.subtle.sign(SIGN_ALG, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

export async function signSessionJwt(claims: SessionClaims): Promise<string> {
  const { privateKey, kid } = await loadKey();
  return jws(
    { alg: 'ES256', typ: 'JWT', kid },
    { ...claims, aud: env('MINT_JWT_AUD') ?? 'authenticated', iss: env('MINT_JWT_ISS') ?? 'jhsc-mint' },
    privateKey
  );
}

export async function signMintWriterToken(nowMs: number, ttlSeconds = 30): Promise<string> {
  const { privateKey, kid } = await loadKey();
  const iat = Math.floor(nowMs / 1000);
  return jws(
    { alg: 'ES256', typ: 'JWT', kid },
    { role: 'mint_writer', aud: env('MINT_JWT_AUD') ?? 'authenticated', iss: env('MINT_JWT_ISS') ?? 'jhsc-mint', iat, exp: iat + ttlSeconds },
    privateKey
  );
}

/** The public verification key, JWKS-ready (kid/use/alg attached, no private `d`). */
export async function publicJwk(): Promise<JsonWebKey & { kid: string; use: string; alg: string }> {
  const { publicKey, kid } = await loadKey();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  delete (jwk as JsonWebKey).d;
  return { ...jwk, kid, use: 'sig', alg: 'ES256' };
}

/** Verify a token under the locally-held public key (tests + a JWKS self-check). */
export async function verifyWithLocalKey(token: string): Promise<boolean> {
  const { publicKey } = await loadKey();
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return crypto.subtle.verify(
    SIGN_ALG,
    publicKey,
    bytesFromB64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
}

/** Test seam: drop the cached key so a test can swap MINT_SIGNING_JWK. */
export function __resetKeyForTest(): void {
  keyPromise = null;
}
