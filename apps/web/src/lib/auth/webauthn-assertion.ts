/**
 * WebAuthn `navigator.credentials.get` → `SignedAssertion` wrapper.
 *
 * The browser's WebAuthn API speaks BufferSource (ArrayBuffer / TypedArray)
 * but the mint-session Edge Function expects base64url strings (see
 * `supabase/functions/mint-session/assertion.ts`). This wrapper handles the
 * encoding conversion so `signInViaMintSession`'s `getAssertion` callback
 * has a clean drop-in for production use.
 *
 * The challenge passed in is the base64url string the server minted via
 * `requestChallenge`; we decode it to a Uint8Array for the browser, then
 * re-encode the response fields back to base64url for the server.
 *
 * Cancellation contract: returns `null` when:
 *   - the platform authenticator is unavailable (no `navigator.credentials`)
 *   - the user dismisses the prompt (NotAllowedError, AbortError, ...)
 *   - the returned credential isn't an `AuthenticatorAssertionResponse`
 *     (defensive — should never happen in a get() flow but guards against
 *     a future spec change that introduces a different response subtype)
 *
 * `signInViaMintSession` treats `null` / thrown errors uniformly as
 * `{status: 'cancelled'}`, so this wrapper can be wired in directly with
 * no additional error reshaping at the call site.
 */

import type { SignedAssertion } from './sign-in-flow';

export interface WebauthnGetAssertionOptions {
  /** The server-minted base64url challenge from `requestChallenge`. */
  challenge: string;
  /** RP-ID — typically the registrable domain (e.g. `jhsc.example`). */
  rpId: string;
  /**
   * Override the WebAuthn entry point — production leaves this undefined
   * (defaults to `navigator.credentials`); tests inject a stub that returns
   * a canned PublicKeyCredential-shape object.
   */
  credentials?: CredentialsContainer;
  /**
   * Override the base64url decoder — production leaves this undefined.
   * Exposed for tests that want to verify the wrapper handed the right
   * bytes to the browser without inspecting raw ArrayBuffer internals.
   */
  decodeBase64Url?: (b64url: string) => Uint8Array;
}

const BASE64URL_PAD = ['', '===', '==', '='];

export function base64UrlDecode(b64url: string): Uint8Array {
  // Convert URL-safe alphabet back to standard then pad to 4-byte boundary.
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + BASE64URL_PAD[b64url.length % 4];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!);
  // btoa returns standard base64; convert to URL-safe alphabet + strip padding.
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Drive a single WebAuthn assertion ceremony for sign-in. Production
 * callers pass this as `getAssertion` to `signInViaMintSession`:
 *
 *   await signInViaMintSession({
 *     client,
 *     rpId,
 *     origin,
 *     getAssertion: (challenge) => webauthnGetAssertion({ challenge, rpId }),
 *     setJwt
 *   });
 */
export async function webauthnGetAssertion(
  opts: WebauthnGetAssertionOptions
): Promise<SignedAssertion | null> {
  const credentials =
    opts.credentials ??
    (typeof globalThis.navigator !== 'undefined' ? globalThis.navigator.credentials : undefined);
  if (!credentials) return null;

  const decodeBase64Url = opts.decodeBase64Url ?? base64UrlDecode;
  const challengeBytes = decodeBase64Url(opts.challenge);

  let credential: Credential | null;
  try {
    credential = await credentials.get({
      publicKey: {
        // TS 6 narrows the Uint8Array buffer parameter; the WebAuthn types
        // want the BufferSource narrow form. Cast at the boundary — the
        // runtime contract is identical.
        challenge: challengeBytes as BufferSource,
        rpId: opts.rpId,
        // Empty allowCredentials lets the platform surface every eligible
        // credential — typical for sign-in with a residentKey (e.g. a
        // platform passkey). Discovery is governed by the RP-ID match.
        allowCredentials: [],
        userVerification: 'preferred'
      }
    });
  } catch {
    // NotAllowedError / AbortError / SecurityError / etc. — treat all as
    // cancellation per signInViaMintSession's contract.
    return null;
  }

  if (!credential) return null;
  const pub = credential as PublicKeyCredential;
  const response = pub.response;
  // Guard against a future subtype that isn't AuthenticatorAssertionResponse
  // (today only AuthenticatorAttestationResponse + AuthenticatorAssertionResponse
  // exist; navigator.credentials.get returns the latter). The duck-typing on
  // `signature` keeps us decoupled from instanceof gating that breaks under
  // bundler-level class identity drift.
  const assertResp = response as AuthenticatorAssertionResponse;
  if (!assertResp || !('signature' in assertResp) || !('authenticatorData' in assertResp)) {
    return null;
  }

  return {
    credentialId: base64UrlEncode(pub.rawId),
    clientDataJSON: base64UrlEncode(assertResp.clientDataJSON),
    authenticatorData: base64UrlEncode(assertResp.authenticatorData),
    signature: base64UrlEncode(assertResp.signature)
  };
}
