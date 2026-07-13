<script>
  /**
   * FingerprintCompareBlock — the SHARED 16×4 NATO-hybrid identity-fingerprint
   * render consumed by BOTH the P1-9 member waiting screen (Surface L) and the
   * P1-8d co-chair grant confirm (Surface K screen 3).
   *
   * This component is the cross-surface F-172 byte-match invariant made
   * structural: because the same code renders both sides, the two humans (and
   * the two screen readers, if either party uses one) see and hear the SAME
   * words for the SAME group — group-for-group — so the out-of-band compare
   * lines up. Extracting it removes the drift risk of two hand-kept copies
   * (design-system.md §4 "Reuse, don't reinvent" / Open-question #1).
   *
   * The block renders ONLY the fingerprint artifact (an optional micro-label,
   * the high-contrast display box, and an optional "Copy fingerprint"
   * affordance). The surrounding copy (the compare instruction / read-aloud
   * callout) and the polite "ready" live region stay in each parent, because
   * their wording is surface-specific; only the fingerprint block itself is
   * byte-identical.
   *
   * The per-group SR label REUSES the shared `a11y.settings.setup.fingerprint
   * .group_label` key verbatim (do NOT fork it) with the identical NATO-hex
   * fill — the whole point of the invariant. Letters a–f are NATO-phoneticized
   * (spoken in isolation b/c/d/e collapse into the English "E-set"); digits 0–9
   * stay plain.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13 (it consumes the plain-JS
   * ShareUrlButton and is consumed by the plain-JS SetupCommitteeEncryptionCard).
   */
  import { t } from '$lib/i18n';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';

  /** The contiguous 64-hex fingerprint (canonical lowercase). Never key material. */
  export let fingerprint = '';
  /** aria-label for the role="group" wrapper (surface-specific; may embed {name}). */
  export let regionLabel = '';
  /** Visible micro-label above the box (surface-specific; aria-hidden decoration). */
  export let label = '';
  /** data-testid on the high-contrast box (surface-specific). */
  export let testid = '';
  /** Whether to render the "Copy fingerprint" affordance under the box. */
  export let showCopy = false;
  /** ShareUrlButton copy label / result-announce keys (surface-specific copy). */
  export let copyLabelKey = '';
  export let copiedKey = '';
  export let copyErrorKey = '';
  export let copiedAnnounceKey = '';
  export let errorAnnounceKey = '';

  // The six confusable hex LETTERS a-f are NATO-phoneticized for the per-group
  // screen-reader label; digits 0-9 stay plain (Surface L OQ-1 resolution).
  const NATO_HEX = { a: 'alpha', b: 'bravo', c: 'charlie', d: 'delta', e: 'echo', f: 'foxtrot' };

  // The 64-hex split into 16 atomic groups of 4 (pubkeyFingerprint() order,
  // lowercase) — the exact split both surfaces mirror so the two humans compare
  // group-for-group.
  $: groups = fingerprint.length === 64 ? (fingerprint.match(/.{4}/g) ?? []) : [];

  /**
   * The per-group screen-reader label: a positional landmark plus the 4 glyphs
   * spelled glyph-by-glyph, a-f NATO-phoneticized, e.g. "group 3 of 16, charlie
   * 3 delta 4". The `{chars}` fill is data, not translatable.
   * @param {number} index 1-based group position @param {string} group 4 glyphs
   */
  function groupLabel(index, group) {
    return t('a11y.settings.setup.fingerprint.group_label', {
      index,
      chars: group
        .split('')
        .map((ch) => NATO_HEX[ch] ?? ch)
        .join(' ')
    });
  }
</script>

<div class="fp-block">
  {#if label}
    <span class="fp-label" aria-hidden="true">{label}</span>
  {/if}
  <!-- High-contrast display box (the audited max-contrast pair OneTimeCodeCard /
       D.T19.f use for load-bearing text). The role="group" wrapper names the
       whole fingerprint so an SR user hears the shape up front. The explicit
       role="list"/"listitem" restores list semantics that WebKit/Safari strips
       from any <ol> with `list-style: none`. -->
  <div class="fp-box" data-testid={testid}>
    <div class="fp-group" role="group" aria-label={regionLabel}>
      <ol class="fp-list" role="list">
        {#each groups as group, i}
          <li class="fp-item" role="listitem">
            <!-- role="img" swaps the visible glyphs for a spelled, positional
                 aria-label in the a11y tree (per-group OneTimeCodeCard mechanism). -->
            <span class="fp-glyphs" role="img" aria-label={groupLabel(i + 1, group)}>{group}</span>
          </li>
        {/each}
      </ol>
    </div>
  </div>
  {#if showCopy}
    <!-- The one clipboard affordance. The fingerprint is a PUBLIC value (SHA-256
         of the public key), so copy is correct here. Copies the CONTIGUOUS
         64-hex — the paste-compare target. -->
    <ShareUrlButton
      url={fingerprint}
      labelKey={copyLabelKey}
      {copiedKey}
      errorKey={copyErrorKey}
      {copiedAnnounceKey}
      {errorAnnounceKey}
      fullTarget={true}
    />
  {/if}
</div>

<style>
  /* Colour / border / radius / font bind to the app CSS-variable token palette;
     spacing + type sizing use rem literals matching the sibling OneTimeCodeCard /
     SetupCommitteeEncryptionCard convention (this project exposes no
     spacing-scale custom properties). */
  .fp-block {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
    inline-size: 100%;
  }
  .fp-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-fg-muted);
  }
  /* High-contrast display box — the audited max-contrast pair OneTimeCodeCard /
     D.T19.f use for load-bearing text. */
  .fp-box {
    inline-size: 100%;
    padding: 1rem;
    border: var(--border-width-thick) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg);
  }
  /* Groups flow left-to-right and wrap ONLY at group boundaries — a 4-char group
     is atomic (a single span), so it can never split across a line. */
  .fp-list {
    display: flex;
    flex-wrap: wrap;
    column-gap: 0.5rem;
    row-gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fp-item {
    margin: 0;
  }
  .fp-glyphs {
    font-family: var(--font-mono);
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--color-fg);
    user-select: all;
  }
</style>
