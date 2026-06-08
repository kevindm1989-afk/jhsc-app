/**
 * T19.1 — jwt-claims helper.
 *
 * Pins the decode-only JWT-claims helper used by SessionsList to figure
 * out "which session is this browser?" without round-tripping the server.
 *
 * SAFETY contract pinned by this test:
 *   - decodeJwtClaims does NOT verify the signature (that's the server's
 *     trust boundary). The helper is for UI-affordance hints only.
 *   - getCurrentUserId reads the live session-jwt-store; flips with
 *     setJwt / clearJwt.
 *   - Malformed input never throws — returns null.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  decodeJwtClaims,
  getCurrentUserId,
  getCurrentSessionId
} from '../../src/lib/auth/jwt-claims';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';

// Helper — build a JWT with a known payload. Header + signature are
// placeholders; the decoder ignores them.
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.placeholdersig`;
}

beforeEach(() => {
  clearJwt();
});
afterEach(() => {
  clearJwt();
});

describe('T19.1 — decodeJwtClaims', () => {
  it('returns the payload for a well-formed JWT', () => {
    const jwt = makeJwt({ sub: 'user-1', jti: 'session-2', exp: 1234567890 });
    const claims = decodeJwtClaims(jwt);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('user-1');
    expect(claims?.jti).toBe('session-2');
    expect(claims?.exp).toBe(1234567890);
  });

  it('returns null for null / undefined / empty input', () => {
    expect(decodeJwtClaims(null)).toBeNull();
    expect(decodeJwtClaims(undefined)).toBeNull();
    expect(decodeJwtClaims('')).toBeNull();
  });

  it('returns null for a malformed JWT (wrong segment count)', () => {
    expect(decodeJwtClaims('a.b')).toBeNull();
    expect(decodeJwtClaims('a.b.c.d')).toBeNull();
    expect(decodeJwtClaims('not-a-jwt')).toBeNull();
  });

  it('returns null for a JWT with a non-base64url payload segment', () => {
    expect(decodeJwtClaims('a.!!!.b')).toBeNull();
  });

  it('returns null for a JWT with a non-JSON payload', () => {
    const garbage = btoa('not json').replace(/=+$/, '');
    expect(decodeJwtClaims(`a.${garbage}.b`)).toBeNull();
  });

  it('handles base64url with - and _ chars (RFC 7515 §2)', () => {
    // Force a payload whose base64 contains `+` and `/` so the
    // base64url variant uses `-` and `_`.
    const payload = { sub: 'user-with-special-chars-???' };
    const b64 = btoa(JSON.stringify(payload));
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `a.${b64url}.b`;
    const claims = decodeJwtClaims(jwt);
    expect(claims?.sub).toBe('user-with-special-chars-???');
  });
});

describe('T19.1 — getCurrentUserId reads the live session-jwt-store', () => {
  it('returns null when no JWT is set', () => {
    expect(getCurrentUserId()).toBeNull();
  });

  it('returns the sub claim after setJwt', () => {
    setJwt(makeJwt({ sub: 'user-xyz', jti: 'sess-1' }));
    expect(getCurrentUserId()).toBe('user-xyz');
  });

  it('returns null after clearJwt', () => {
    setJwt(makeJwt({ sub: 'user-xyz' }));
    expect(getCurrentUserId()).toBe('user-xyz');
    clearJwt();
    expect(getCurrentUserId()).toBeNull();
  });

  it('returns null when the JWT has no sub claim', () => {
    setJwt(makeJwt({ jti: 'sess-1' }));
    expect(getCurrentUserId()).toBeNull();
  });

  it('returns null when the sub claim is an empty string', () => {
    setJwt(makeJwt({ sub: '' }));
    expect(getCurrentUserId()).toBeNull();
  });
});

describe('T19.1 — getCurrentSessionId reads the live session-jwt-store', () => {
  it('returns null when no JWT is set', () => {
    expect(getCurrentSessionId()).toBeNull();
  });

  it('returns the jti claim after setJwt', () => {
    setJwt(makeJwt({ sub: 'user-xyz', jti: 'sess-42' }));
    expect(getCurrentSessionId()).toBe('sess-42');
  });

  it('returns null when the JWT has no jti claim', () => {
    setJwt(makeJwt({ sub: 'user-xyz' }));
    expect(getCurrentSessionId()).toBeNull();
  });
});
