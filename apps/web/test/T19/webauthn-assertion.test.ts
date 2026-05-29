/**
 * T19.1 — WebAuthn navigator.credentials.get wrapper unit tests.
 *
 * Hermetic: tests inject a stub `credentials` container that returns a
 * canned PublicKeyCredential shape (no real platform authenticator).
 * Covers the encoding bridge (base64url ↔ Uint8Array), the get-request
 * shape (challenge bytes match the decoded server nonce, RP-ID is
 * forwarded), the cancellation paths (no credentials API, thrown
 * NotAllowedError, null credential, wrong response subtype), and the
 * base64url helper edge cases (round-trip, URL-safe alphabet).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  webauthnGetAssertion
} from '../../src/lib/auth/webauthn-assertion';

function bytes(...n: number[]): Uint8Array {
  return new Uint8Array(n);
}

function pubKeyCredential(opts: {
  rawId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}): unknown {
  return {
    rawId: opts.rawId.buffer.slice(opts.rawId.byteOffset, opts.rawId.byteOffset + opts.rawId.byteLength),
    type: 'public-key',
    response: {
      clientDataJSON: opts.clientDataJSON.buffer.slice(
        opts.clientDataJSON.byteOffset,
        opts.clientDataJSON.byteOffset + opts.clientDataJSON.byteLength
      ),
      authenticatorData: opts.authenticatorData.buffer.slice(
        opts.authenticatorData.byteOffset,
        opts.authenticatorData.byteOffset + opts.authenticatorData.byteLength
      ),
      signature: opts.signature.buffer.slice(
        opts.signature.byteOffset,
        opts.signature.byteOffset + opts.signature.byteLength
      )
    }
  };
}

describe('T19.1 — base64url helpers', () => {
  it('round-trips arbitrary byte sequences', () => {
    const cases = [
      bytes(),
      bytes(0),
      bytes(0xff, 0x00, 0xab),
      bytes(1, 2, 3, 4, 5, 6),
      bytes(0xfe, 0xfd, 0xfc, 0xfb)
    ];
    for (const original of cases) {
      const encoded = base64UrlEncode(original);
      const decoded = base64UrlDecode(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    }
  });

  it('uses the URL-safe alphabet (`-` / `_` instead of `+` / `/`)', () => {
    // 0xfb, 0xff, 0xbf → base64 std: "+/+/" → url-safe: "-_-_"
    const encoded = base64UrlEncode(bytes(0xfb, 0xff, 0xbf));
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('decodes padded and unpadded inputs identically', () => {
    // "AQI" (3 base64 chars = 2 bytes) — len%4 === 3 so the helper appends one `=`.
    const decoded = base64UrlDecode('AQI');
    expect(Array.from(decoded)).toEqual([1, 2]);
  });
});

describe('T19.1 — webauthnGetAssertion DOM bridge', () => {
  it('decodes the challenge to bytes + forwards rpId + base64url-encodes the response fields', async () => {
    const challengeBytes = bytes(1, 2, 3, 4, 5);
    const challenge = base64UrlEncode(challengeBytes);

    const fakeRawId = bytes(0xaa, 0xbb);
    const fakeClientData = bytes(0xcc, 0xdd);
    const fakeAuthData = bytes(0xee, 0xff);
    const fakeSig = bytes(0x01, 0x02, 0x03);

    let capturedRequest: PublicKeyCredentialRequestOptions | undefined;
    const credentials = {
      async get(req: { publicKey: PublicKeyCredentialRequestOptions }) {
        capturedRequest = req.publicKey;
        return pubKeyCredential({
          rawId: fakeRawId,
          clientDataJSON: fakeClientData,
          authenticatorData: fakeAuthData,
          signature: fakeSig
        });
      }
    } as unknown as CredentialsContainer;

    const result = await webauthnGetAssertion({
      challenge,
      rpId: 'jhsc.example',
      credentials
    });

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.credentialId).toBe(base64UrlEncode(fakeRawId));
    expect(result.clientDataJSON).toBe(base64UrlEncode(fakeClientData));
    expect(result.authenticatorData).toBe(base64UrlEncode(fakeAuthData));
    expect(result.signature).toBe(base64UrlEncode(fakeSig));

    expect(capturedRequest?.rpId).toBe('jhsc.example');
    expect(Array.from(new Uint8Array(capturedRequest!.challenge as ArrayBuffer))).toEqual([
      1, 2, 3, 4, 5
    ]);
  });

  it('returns null when navigator.credentials is unavailable (older browser / non-secure context)', async () => {
    const result = await webauthnGetAssertion({
      challenge: base64UrlEncode(bytes(1, 2)),
      rpId: 'jhsc.example',
      credentials: undefined as unknown as CredentialsContainer
    });
    expect(result).toBeNull();
  });

  it('returns null when credentials.get throws (NotAllowedError / user cancellation)', async () => {
    const credentials = {
      async get() {
        const e = new Error('NotAllowedError');
        e.name = 'NotAllowedError';
        throw e;
      }
    } as unknown as CredentialsContainer;
    const result = await webauthnGetAssertion({
      challenge: base64UrlEncode(bytes(1, 2)),
      rpId: 'jhsc.example',
      credentials
    });
    expect(result).toBeNull();
  });

  it('returns null when credentials.get resolves to null (no credential available)', async () => {
    const credentials = {
      async get() {
        return null;
      }
    } as unknown as CredentialsContainer;
    const result = await webauthnGetAssertion({
      challenge: base64UrlEncode(bytes(1, 2)),
      rpId: 'jhsc.example',
      credentials
    });
    expect(result).toBeNull();
  });

  it('returns null when the credential response is not an AuthenticatorAssertionResponse (defensive)', async () => {
    // Simulate a credential whose response lacks the assertion fields.
    const credentials = {
      async get() {
        return {
          rawId: bytes(1, 2).buffer,
          type: 'public-key',
          response: {
            // Missing signature + authenticatorData — looks like an
            // AuthenticatorAttestationResponse leaked from a create() call.
            clientDataJSON: bytes(3, 4).buffer
          }
        };
      }
    } as unknown as CredentialsContainer;
    const result = await webauthnGetAssertion({
      challenge: base64UrlEncode(bytes(1, 2)),
      rpId: 'jhsc.example',
      credentials
    });
    expect(result).toBeNull();
  });

  it('uses the injected base64url decoder when supplied (defense-in-depth for future encoding swaps)', async () => {
    const decode = vi.fn(() => bytes(99, 99, 99));
    const credentials = {
      async get(req: { publicKey: PublicKeyCredentialRequestOptions }) {
        expect(Array.from(new Uint8Array(req.publicKey.challenge as ArrayBuffer))).toEqual([
          99, 99, 99
        ]);
        return pubKeyCredential({
          rawId: bytes(1),
          clientDataJSON: bytes(2),
          authenticatorData: bytes(3),
          signature: bytes(4)
        });
      }
    } as unknown as CredentialsContainer;
    await webauthnGetAssertion({
      challenge: 'whatever-the-decoder-gets-ignored',
      rpId: 'jhsc.example',
      credentials,
      decodeBase64Url: decode
    });
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
