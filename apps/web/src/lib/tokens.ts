/**
 * Typed accessor over /home/user/agent-os/design-tokens.json.
 *
 * Components read from this module ONLY; never from raw hex / px / rgba
 * literals in their own templates. The token-audit gate
 * (scripts/verify-tokens.sh) enforces this by greping for hex / px in
 * src/ outside of files matching `*.tokens.*` or `tokens/`.
 *
 * The structure mirrors design-tokens.json. When the designer amends the
 * tokens file, this typed accessor is regenerated in the same PR. For
 * scaffolding, we expose only the surfaces the placeholder routes consume
 * so the file stays small; the implementer extends it per-task.
 */
import tokensJson from '../../../../design-tokens.json' with { type: 'json' };

// The raw JSON shape is intentionally typed as `unknown` and narrowed by
// per-property accessors. Full typing is a designer-owned follow-up.
const raw = tokensJson as unknown as RawTokens;

interface RawTokens {
  color?: {
    state?: {
      danger?: string;
      warning?: string;
      success?: string;
      info?: string;
    };
    light?: {
      foreground?: { primary?: string };
      focus_ring?: { outer?: string; inner?: string };
    };
  };
  border_width?: {
    hairline?: string;
    default?: string;
    thick?: string;
    c4_stripe?: string;
    step_indicator?: string;
    focus_inner?: string;
    focus_outer?: string;
  };
}

/**
 * Typed token surface for scaffold consumers. Designer regenerates this
 * accessor in lock-step with design-tokens.json.
 *
 * Components must read CSS-variable bindings via Svelte's `style:` directive
 * referencing `tokens.focus.*` and `tokens.color.foreground.primary`, not
 * hard-code the hex values. This file is on the token-audit allowlist
 * (verify-tokens.sh excludes `tokens.ts`).
 */
export const tokens = {
  color: {
    state: {
      danger: raw.color?.state?.danger ?? '',
      warning: raw.color?.state?.warning ?? '',
      success: raw.color?.state?.success ?? '',
      info: raw.color?.state?.info ?? ''
    },
    foreground: {
      primary: raw.color?.light?.foreground?.primary ?? ''
    }
  },
  focus: {
    outer: raw.color?.light?.focus_ring?.outer ?? '',
    inner: raw.color?.light?.focus_ring?.inner ?? ''
  },
  border_width: {
    hairline: raw.border_width?.hairline ?? '',
    default: raw.border_width?.default ?? '',
    thick: raw.border_width?.thick ?? '',
    c4_stripe: raw.border_width?.c4_stripe ?? '',
    step_indicator: raw.border_width?.step_indicator ?? '',
    focus_inner: raw.border_width?.focus_inner ?? '',
    focus_outer: raw.border_width?.focus_outer ?? ''
  }
} as const;

export type Tokens = typeof tokens;
