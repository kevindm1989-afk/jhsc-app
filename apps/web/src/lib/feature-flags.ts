/**
 * In-process feature-flag system.
 *
 * Per JHSC-APP-PLAN.md §5.2 and ADR-0010 posture: NO third-party flag SaaS.
 * Flags live as a typed module here (compile-time defaults) plus an
 * optional Postgres `feature_flags` table with RLS (architect/migration-
 * handler wires when needed). At scaffold time the SaaS-less in-process
 * surface is sufficient.
 *
 * Adding a flag:
 *   1. Add a key to FlagId.
 *   2. Add a default in DEFAULTS.
 *   3. Document removal trigger in the same PR.
 *
 * Evaluation context: a flag is resolved against the current authenticated
 * actor (`actor_pseudonym`) and the route. The default context is used
 * at scaffold time.
 */

export type FlagId =
  | 'scaffold.example' // example flag used by the verifier smoke test
  | 'export.dual_signer' // RA-1 follow-up; off by default
  | 'recovery.show_again'; // ADR-0003 Amendment F / HG-12; on by default once T07 wires

export interface FlagContext {
  actor_pseudonym?: string;
  route?: string;
  env?: 'dev' | 'test' | 'ci' | 'staging' | 'prod';
}

const DEFAULTS: Record<FlagId, boolean> = {
  'scaffold.example': true,
  'export.dual_signer': false,
  'recovery.show_again': false
};

// Compile-time overrides hook — production wires this to the
// `feature_flags` Postgres table via a server-side load on the layout
// data path. At scaffold time, this returns DEFAULTS only.
const overrides: Partial<Record<FlagId, boolean>> = {};

export function isEnabled(id: FlagId, _ctx: FlagContext = {}): boolean {
  if (id in overrides) {
    const v = overrides[id];
    if (typeof v === 'boolean') return v;
  }
  return DEFAULTS[id];
}

export function listFlags(): ReadonlyArray<{ id: FlagId; default: boolean }> {
  return (Object.keys(DEFAULTS) as FlagId[]).map((id) => ({ id, default: DEFAULTS[id] }));
}

/**
 * Lifecycle hook called from +layout.svelte onMount. Reserved for future
 * panic-wipe / lock-on-idle / visibility-change handlers; no-op now.
 */
export function setupSafetyHandlers(): void {
  /* intentional no-op at scaffold */
}
