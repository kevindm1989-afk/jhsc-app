/**
 * Sibling .ts module to D4RecoveryPassphrase.svelte that re-exports the
 * test-only seams. The Svelte component itself does NOT export these
 * symbols; production bundles strip this sibling at build time via the
 * `__test_seams.ts` `import.meta.env.PROD` guard.
 *
 * Per ADR-0020 Decision 8 + F-102 M-102b — see __test_seams.ts header.
 */

export {
  __test_only_get_passphrase_ref,
  __setPassphraseRefForTest,
  __test_advance_through_type_back,
  __clearAllPassphraseRefsForTest
} from '../__test_seams';
