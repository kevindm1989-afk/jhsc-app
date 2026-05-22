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
  };
}

/**
 * Typed token surface for scaffold consumers. Designer regenerates this
 * accessor in lock-step with design-tokens.json.
 */
export const tokens = {
  color: {
    state: {
      danger: raw.color?.state?.danger ?? '',
      warning: raw.color?.state?.warning ?? '',
      success: raw.color?.state?.success ?? '',
      info: raw.color?.state?.info ?? ''
    }
  }
} as const;

export type Tokens = typeof tokens;
