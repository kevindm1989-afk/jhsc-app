/**
 * Test-only seams for the T19 onboarding wizard.
 *
 * Per ADR-0020 Decision 8 + F-102 M-102b: these seams MUST NOT be reachable
 * from production code. The build-time CI gate
 * (`scripts/check-onboarding-test-props-stripped.sh`) greps the production
 * bundle for the symbol names below; any leak is a fail.
 *
 * Stripping strategy (G-T19-5 hardening): this module is **side-effect-free
 * at the top level** so a production build tree-shakes it out entirely — the
 * sole production importer (`OnboardingFlow.svelte`) only references these
 * seams inside `if (!import.meta.env.PROD)` branches, which Vite's
 * dead-code-elimination drops in production, leaving the import unused. With
 * no top-level side effect, Rollup then prunes the module from the bundle.
 *
 * The runtime tripwire is preserved but moved INTO the exported functions
 * (`__assertNotProduction()`): a previous top-level `throw` on import was
 * itself a module side effect — it both defeated tree-shaking (leaking the
 * symbols) AND crashed `/onboarding` in a real production build, because the
 * onboarding chunk statically imported this module and evaluated the throw
 * on load. Guarding per-call keeps the fail-loud defense for any accidental
 * production invocation without the side effect.
 */

function __assertNotProduction(): void {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'production') {
    throw new Error('__test_seams invoked in production build');
  }
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
  __assertNotProduction();
  __lastSeededRef = s;
  if (instanceId) passphraseRefs.set(instanceId, s);
}

export function __test_only_get_passphrase_ref(instanceId?: string): string {
  __assertNotProduction();
  if (instanceId && passphraseRefs.has(instanceId)) return passphraseRefs.get(instanceId) ?? '';
  return __lastSeededRef;
}

export async function __test_advance_through_type_back(): Promise<void> {
  __assertNotProduction();
  __lastSeededRef = '';
  passphraseRefs.clear();
}

export function __clearAllPassphraseRefsForTest(): void {
  __assertNotProduction();
  __lastSeededRef = '';
  passphraseRefs.clear();
}
