/**
 * mint-session / webauthn — pure, hermetically-testable WebAuthn decisions
 * (ADR-0002 passkey integrity). The signature/COSE verification itself is done
 * by @simplewebauthn/server in index.ts; this module holds the small policy
 * choices we want under test.
 */

/**
 * Sign-counter clone detection. A WebAuthn authenticator increments its signature
 * counter on each assertion; a non-increasing counter (when the stored value is
 * already > 0) signals a possibly cloned authenticator and the login must be
 * rejected. A stored counter of 0 means the authenticator does not implement a
 * counter (or this is its first use) — accept.
 */
export function evaluateCounter(storedCounter: number, presentedCounter: number): boolean {
  if (storedCounter === 0) return true;
  return presentedCounter > storedCounter;
}
