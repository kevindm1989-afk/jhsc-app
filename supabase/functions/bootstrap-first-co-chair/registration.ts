/**
 * bootstrap-first-co-chair / registration — WebAuthn REGISTRATION verification
 * (ADR-0025 §A2, mirror of mint-session/assertion.ts).
 *
 * Wraps @simplewebauthn/server's verifyRegistrationResponse behind a small,
 * testable seam so the bootstrap handler stays thin and the verification path
 * can be exercised with a real (generated) attestation in test.
 *
 * F-37 parity with the assertion path: the server-issued single-use challenge,
 * the rp_id, and the expected origin are pinned at verification; an attacker-
 * supplied public key reaches the RPC ONLY if the entire ceremony verified
 * (verified === true). The handler then passes ONLY verification.registrationInfo.credential.{publicKey,id}
 * to the SQL — body-supplied credentialId/publicKey are never trusted.
 *
 * Attestation policy: `attestation: 'none'` is intentional (no privacy-sensitive
 * AAGUIDs leaked) — the WebAuthn ceremony still proves possession of the
 * attestation private key; only the issuer chain is not collected.
 *
 * Returns ONLY the VERIFIED credential material the caller needs. No raw input
 * is reflected; the verification outcome is a boolean.
 */

import { verifyRegistrationResponse } from 'npm:@simplewebauthn/server@13';

export interface RawAttestation {
  /** base64url credential id from navigator.credentials.create() rawId. */
  credentialId: string;
  /** base64url. */
  attestationObject: string;
  /** base64url. */
  clientDataJSON: string;
  /** transports reported by the authenticator (informational; stored as-is). */
  transports?: string[];
}

export interface RegistrationContext {
  /** Relying-party id (eTLD+1) the credential will be bound to (F-37). */
  rpId: string;
  /** The exact origin the attestation must have been produced for (F-37). */
  expectedOrigin: string;
  /** The single-use, server-issued challenge the attestation must echo. */
  expectedChallenge: string;
}

export interface RegistrationVerification {
  verified: boolean;
  /** Only populated when verified === true. */
  credential?: {
    /** COSE-encoded credential public key (bytes), to store byte-for-byte. */
    publicKey: Uint8Array;
    /** WebAuthn credential id (string) — `verifyRegistrationResponse` returns
     *  the canonical id; the caller persists THIS, not the body's. */
    id: string;
    /** Authenticator AAGUID (uuid string), or null if absent. */
    aaguid: string | null;
    /** Initial signature counter (>= 0). */
    counter: number;
  };
}

export async function verifyWebAuthnRegistration(
  input: RawAttestation,
  ctx: RegistrationContext
): Promise<RegistrationVerification> {
  try {
    const verification = await verifyRegistrationResponse({
      response: {
        id: input.credentialId,
        rawId: input.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: input.clientDataJSON,
          attestationObject: input.attestationObject,
          transports: input.transports as never
        }
      },
      expectedChallenge: ctx.expectedChallenge,
      expectedOrigin: ctx.expectedOrigin,
      expectedRPID: ctx.rpId,
      // C8 — server-side UV enforcement (browser `userVerification:'required'`
      // is advisory; the library rejects any UV-bit-clear attestation here).
      requireUserVerification: true,
      // C7 — algorithm pin. Only ES256 (-7) and RS256 (-257) accepted —
      // matches the mint-session assertion path. Defends against alg downgrade
      // (e.g. EdDSA -8) by hostile authenticators.
      supportedAlgorithmIDs: [-7, -257]
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { verified: false };
    }
    const info = verification.registrationInfo;

    // C9 — fmt='none' enforcement. ADR-0025 chose `attestation: 'none'`
    // deliberately (no privacy-sensitive AAGUID chain collection). Non-none
    // formats imply an attestation cert chain this EF does not verify; refuse.
    if (info.fmt !== 'none') {
      return { verified: false };
    }
    return {
      verified: true,
      credential: {
        publicKey: info.credential.publicKey,
        id: info.credential.id,
        aaguid: info.aaguid ?? null,
        counter: info.credential.counter ?? 0
      }
    };
  } catch {
    return { verified: false };
  }
}
