/**
 * Render helpers that inject test-only configuration through the
 * production-stripped "test config" seams instead of `__test_*` Svelte props
 * (issue #120 / A-T19-RR-4). Components no longer declare `export let __test_*`
 * — the names would otherwise compile into the production bundle and trip
 * `scripts/check-onboarding-test-props-stripped.sh`. Tests set the config via
 * the seam BEFORE render; the component reads it at init under
 * `!import.meta.env.PROD` (tree-shaken out of prod).
 *
 * The seam state is a module-level singleton, so suites MUST call
 * `resetTestConfigs()` in `afterEach` to avoid config bleed across tests.
 */
import { render } from '@testing-library/svelte';
import PanicWipeModal from '../../src/lib/lock/PanicWipeModal.svelte';
import {
  setPanicWipeTestConfig,
  clearPanicWipeTestConfig,
  type PanicWipeTestConfig
} from '../../src/lib/lock/panic-wipe-test-config';

/** Real (production) PanicWipeModal props — passed as actual Svelte props. */
interface PanicWipeRealProps {
  open?: boolean;
  surface?: string;
  wipeStore?: unknown;
}

/**
 * Render PanicWipeModal. Real props (`open`, `surface`, `wipeStore`) are passed
 * as Svelte props; everything else is test config routed through the seam.
 */
export function renderPanicWipe(opts: PanicWipeTestConfig & PanicWipeRealProps = {}) {
  const { open, surface, wipeStore, ...testCfg } = opts;
  setPanicWipeTestConfig(testCfg);
  const props: Record<string, unknown> = {};
  if (open !== undefined) props.open = open;
  if (surface !== undefined) props.surface = surface;
  if (wipeStore !== undefined) props.wipeStore = wipeStore;
  return render(PanicWipeModal, { props });
}

/** Clear every test-config seam. Call in `afterEach` of any suite using these helpers. */
export function resetTestConfigs(): void {
  clearPanicWipeTestConfig();
}
