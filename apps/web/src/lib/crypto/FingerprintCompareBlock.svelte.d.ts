/**
 * Type declaration so `lang="ts"` callers (the P1-8d co-chair grant card,
 * ADR-0029) can import this JSDoc-script component without a TS
 * module-resolution error. The component itself stays JSDoc-typed per G-T07-13
 * (it consumes the plain-JS ShareUrlButton and is consumed by the plain-JS
 * SetupCommitteeEncryptionCard).
 *
 * The shared 16×4 NATO-hybrid fingerprint render — the cross-surface F-172
 * byte-match mirror both Surface L (member waiting) and Surface K screen 3
 * (co-chair grant confirm) consume.
 */
import { SvelteComponent } from 'svelte';

export interface FingerprintCompareBlockProps {
  /** The contiguous 64-hex fingerprint (canonical lowercase). */
  fingerprint?: string;
  /** aria-label for the role="group" wrapper (surface-specific; may embed {name}). */
  regionLabel?: string;
  /** Visible micro-label above the box (surface-specific; aria-hidden decoration). */
  label?: string;
  /** data-testid on the high-contrast box (surface-specific). */
  testid?: string;
  /** Whether to render the "Copy fingerprint" affordance under the box. */
  showCopy?: boolean;
  /** ShareUrlButton copy label / result-announce keys (surface-specific copy). */
  copyLabelKey?: string;
  copiedKey?: string;
  copyErrorKey?: string;
  copiedAnnounceKey?: string;
  errorAnnounceKey?: string;
}

export default class FingerprintCompareBlock extends SvelteComponent<FingerprintCompareBlockProps> {}
