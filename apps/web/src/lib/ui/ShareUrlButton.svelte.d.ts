/**
 * Type declaration so `lang="ts"` callers (the committee one-time-code custody
 * card, ADR-0029 P1-8c) can import this JSDoc-script component without a TS
 * module-resolution error. The component itself stays JSDoc-typed per G-T07-13.
 *
 * All props are optional; the historical register-surface call sites mount it
 * as `<ShareUrlButton />` (copy the current URL). The committee custody card
 * overrides `url` + the label/announce keys to copy the redeem LINK only (F-170).
 */
import { SvelteComponent } from 'svelte';

export interface ShareUrlButtonProps {
  /** Explicit string to copy; defaults to `window.location.href` when null. */
  url?: string | null;
  labelKey?: string;
  copiedKey?: string;
  errorKey?: string;
  copiedAnnounceKey?: string;
  errorAnnounceKey?: string;
  /** Meet the 44px general-app touch target instead of the compact size. */
  fullTarget?: boolean;
}

export default class ShareUrlButton extends SvelteComponent<ShareUrlButtonProps> {}
