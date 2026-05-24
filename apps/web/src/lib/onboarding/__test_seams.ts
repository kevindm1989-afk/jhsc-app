/**
 * Test-only seams for the T19 onboarding wizard.
 *
 * Per ADR-0020 Decision 8 + F-102 M-102b: these seams MUST NOT be reachable
 * from production code. The module-top-level guard below throws when the
 * file is imported under MODE === 'production'. The build-time CI gate
 * (`scripts/check-onboarding-test-props-stripped.sh`) additionally greps
 * the production bundle for the symbol names below; any leak is a fail.
 *
 * Test code imports this module via the standard `import {…} from '../__test_seams'`
 * shape. The runtime throw on production ensures any accidental production
 * import (e.g., via a transitive dependency) fails-loud rather than
 * silently leaking the seam.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'production') {
  // HUMAN-APPROVED: production builds throw on import of this module; the
  // build-time grep gate is the structural enforcement. Throwing at import
  // time is the runtime defense-in-depth.
  throw new Error('__test_seams imported in production build');
}

// Per-component passphrase-ref bag. The KEYS are component-instance ids
// (the D4 component generates one via `crypto.randomUUID()` on mount); the
// VALUES are the live passphrase string for that instance. This keeps the
// seam from violating F-104 M-104a (no module-level let outside the
// component closure for the in-memory passphrase) — the module-level state
// here is the SEAM ITSELF, not the passphrase.
//
// Tests that drive the wizard observe a single D.4 instance at a time;
// `__test_only_get_passphrase_ref()` returns the most-recently-seeded
// value (the test contract).
const passphraseRefs = new Map<string, string>();
let __lastSeededRef = '';

export function __setPassphraseRefForTest(s: string, instanceId?: string): void {
  __lastSeededRef = s;
  if (instanceId) passphraseRefs.set(instanceId, s);
}

export function __test_only_get_passphrase_ref(instanceId?: string): string {
  if (instanceId && passphraseRefs.has(instanceId)) return passphraseRefs.get(instanceId) ?? '';
  return __lastSeededRef;
}

export async function __test_advance_through_type_back(): Promise<void> {
  __lastSeededRef = '';
  passphraseRefs.clear();
}

export function __clearAllPassphraseRefsForTest(): void {
  __lastSeededRef = '';
  passphraseRefs.clear();
}
