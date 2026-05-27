/**
 * mint-session / signing — EdDSA (Ed25519) JWT minting for the passkey-login
 * path (ADR-0023 / threat-model §3.12, F-118; ADR-0003 Invariant 4).
 *
 * Runtime: Deno (Supabase Edge Function). Crypto is libsodium ONLY (ADR-0003 —
 * the `no-non-libsodium-crypto` gate forbids crypto.subtle / crypto-js /
 * node-forge); we therefore sign with Ed25519 (RFC 8037 "EdDSA") rather than
 * ES256. Supabase JWKS supports Ed25519 (OKP) keys, so this stays asymmetric +
 * JWKS — the adjudicated trust model (no shared secret, no service_role).
 *
 * Two tokens are signed with the SAME isolated key (F-118):
 *   - the user's short-lived GoTrue session token (role=authenticated), and
 *   - the mint_writer role token the handler presents to PostgREST.
 *
 * Key custody: the private key (an OKP JWK: x=public, d=32-byte seed) comes from
 * the MINT_SIGNING_JWK env secret; absent that (local dev/CI) an ephemeral
 * keypair is generated at boot. `publicJwk()` is the JWKS source of truth.
 */

interface Sodium {
  ready: Promise<void>;
  crypto_sign_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_sign_seed_keypair(seed: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_sign_detached(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_sign_verify_detached(sig: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
  crypto_hash_sha256(message: Uint8Array): Uint8Array;
}
import sodiumImport from 'npm:libsodium-wrappers@0.7.15';
const sodium = sodiumImport as unknown as Sodium;

export interface SessionClaims {
  sub: string;
  role: 'authenticated';
  session_id: string;
  iat: number;
  exp: number;
}

interface KeyState {
  privateKey: Uint8Array; // 64-byte Ed25519 secret key
  publicKey: Uint8Array; // 32-byte Ed25519 public key
  kid: string;
}

let keyPromise: Promise<KeyState> | null = null;

function env(name: string): string | undefined {
  return Deno.env.get(name) ?? undefined;
}

// ---- base64url helpers (no crypto; btoa/atob only) --------------------------

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

async function thumbprint(xB64url: string): Promise<string> {
  await sodium.ready;
  // RFC 7638 thumbprint for an OKP key: SHA-256 over the canonical members.
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${xB64url}"}`;
  return b64urlFromBytes(sodium.crypto_hash_sha256(new TextEncoder().encode(canonical)));
}

async function fromSeed(seed: Uint8Array, kid?: string): Promise<KeyState> {
  await sodium.ready;
  const kp = sodium.crypto_sign_seed_keypair(seed);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, kid: kid ?? (await thumbprint(b64urlFromBytes(kp.publicKey))) };
}

async function generateEphemeral(): Promise<KeyState> {
  await sodium.ready;
  const kp = sodium.crypto_sign_keypair();
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, kid: await thumbprint(b64urlFromBytes(kp.publicKey)) };
}

function loadKey(): Promise<KeyState> {
  if (!keyPromise) {
    const raw = env('MINT_SIGNING_JWK');
    if (raw) {
      const jwk = JSON.parse(raw) as { d?: string; kid?: string };
      if (!jwk.d) throw new Error('MINT_SIGNING_JWK missing private seed (d)');
      keyPromise = fromSeed(bytesFromB64url(jwk.d), jwk.kid);
    } else {
      keyPromise = generateEphemeral();
    }
  }
  return keyPromise;
}

// ---- JWS (EdDSA) ------------------------------------------------------------

async function jws(header: Record<string, unknown>, payload: Record<string, unknown>, priv: Uint8Array): Promise<string> {
  await sodium.ready;
  const signingInput = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
  const sig = sodium.crypto_sign_detached(new TextEncoder().encode(signingInput), priv);
  return `${signingInput}.${b64urlFromBytes(sig)}`;
}

export async function signSessionJwt(claims: SessionClaims): Promise<string> {
  const { privateKey, kid } = await loadKey();
  return jws(
    { alg: 'EdDSA', typ: 'JWT', kid },
    { ...claims, aud: env('MINT_JWT_AUD') ?? 'authenticated', iss: env('MINT_JWT_ISS') ?? 'jhsc-mint' },
    privateKey
  );
}

export async function signMintWriterToken(nowMs: number, ttlSeconds = 30): Promise<string> {
  const { privateKey, kid } = await loadKey();
  const iat = Math.floor(nowMs / 1000);
  return jws(
    { alg: 'EdDSA', typ: 'JWT', kid },
    { role: 'mint_writer', aud: env('MINT_JWT_AUD') ?? 'authenticated', iss: env('MINT_JWT_ISS') ?? 'jhsc-mint', iat, exp: iat + ttlSeconds },
    privateKey
  );
}

/** The public verification key, JWKS-ready (OKP/Ed25519; no private `d`). */
export async function publicJwk(): Promise<{ kty: string; crv: string; x: string; kid: string; use: string; alg: string }> {
  const { publicKey, kid } = await loadKey();
  return { kty: 'OKP', crv: 'Ed25519', x: b64urlFromBytes(publicKey), kid, use: 'sig', alg: 'EdDSA' };
}

/** Verify a token under the locally-held public key (tests + a JWKS self-check). */
export async function verifyWithLocalKey(token: string): Promise<boolean> {
  await sodium.ready;
  const { publicKey } = await loadKey();
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    return sodium.crypto_sign_verify_detached(bytesFromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`), publicKey);
  } catch {
    return false;
  }
}

/** Test seam: drop the cached key so a test can swap MINT_SIGNING_JWK. */
export function __resetKeyForTest(): void {
  keyPromise = null;
}
