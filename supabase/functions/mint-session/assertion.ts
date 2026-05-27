/**
 * mint-session / assertion — WebAuthn assertion verification (ADR-0002,
 * threat-model §3.1 F-37). Wraps @simplewebauthn/server's
 * verifyAuthenticationResponse behind a small, testable seam so the mint
 * handler stays thin and the verification path can be exercised with a real
 * (generated) assertion in test/assertion.test.ts.
 *
 * Returns ONLY whether the assertion verified + the authenticator's new signature
 * counter; the caller resolves the uid server-side and applies clone detection.
 */

import { verifyAuthenticationResponse } from 'npm:@simplewebauthn/server@13';

export interface RawAssertion {
  /** base64url credential id. */
  credentialId: string;
  /** base64url, as sent by the authenticator. */
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export interface AssertionContext {
  /** COSE-encoded credential public key (as stored at registration). */
  publicKey: Uint8Array;
  /** Current stored signature counter. */
  storedCounter: number;
  /** Relying-party id (eTLD+1) the credential was bound to (F-37). */
  rpId: string;
  /** The exact origin the assertion must have been produced for (F-37). */
  expectedOrigin: string;
  /** The single-use, server-issued challenge the assertion must echo. */
  expectedChallenge: string;
}

export interface AssertionVerification {
  verified: boolean;
  /** The authenticator's reported counter (>= storedCounter when verified). */
  newCounter: number;
}

export async function verifyWebAuthnAssertion(
  input: RawAssertion,
  ctx: AssertionContext
): Promise<AssertionVerification> {
  try {
    const verification = await verifyAuthenticationResponse({
      response: {
        id: input.credentialId,
        rawId: input.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: input.clientDataJSON,
          authenticatorData: input.authenticatorData,
          signature: input.signature
        }
      },
      expectedChallenge: ctx.expectedChallenge,
      expectedOrigin: ctx.expectedOrigin,
      expectedRPID: ctx.rpId,
      credential: { id: input.credentialId, publicKey: ctx.publicKey, counter: ctx.storedCounter },
      requireUserVerification: false
    });
    return {
      verified: verification.verified,
      newCounter: verification.authenticationInfo?.newCounter ?? ctx.storedCounter
    };
  } catch {
    return { verified: false, newCounter: ctx.storedCounter };
  }
}
