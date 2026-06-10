<script>
  /**
   * SkeletonRows — N placeholder rows with a subtle shimmer, used by
   * each register viewer's loading branch in place of a "Loading…"
   * text label.
   *
   * The component renders as a presentational ladder of rounded
   * rectangles so the worker reads "stuff is coming" without a layout
   * shift when the real rows paint. Reduced-motion users get a static
   * tinted block (no shimmer animation).
   *
   * `aria-hidden="true"` because the surrounding wrapper carries the
   * `role="status"` + `aria-label` for the loading announcement.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */

  /** How many skeleton rows to render (default matches the typical
   *  first-page slice of 3). */
  export let count = 3;
</script>

<div class="sr-list" aria-hidden="true" data-testid="skeleton-rows">
  {#each [...Array(count).keys()] as i (i)}
    <div class="sr-row" data-testid="skeleton-row">
      <div class="sr-bar sr-bar-pin"></div>
      <div class="sr-bar sr-bar-title"></div>
      <div class="sr-bar sr-bar-meta"></div>
    </div>
  {/each}
</div>

<style>
  .sr-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .sr-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.4rem;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
  }
  .sr-row + .sr-row {
    border-block-start: 1px solid var(--color-border);
  }
  .sr-bar {
    height: 0.625rem;
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    /* The shimmer pass uses a soft gradient layered onto the muted
       background — falls back to the flat muted colour for reduced-
       motion users. */
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--color-fg-muted) 10%, transparent) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    background-repeat: no-repeat;
    background-position: -150% 0;
    animation: sr-shimmer 1.6s ease-in-out infinite;
  }
  .sr-bar-pin {
    width: 4.5rem;
  }
  .sr-bar-title {
    width: 80%;
    height: 0.875rem;
  }
  .sr-bar-meta {
    width: 55%;
    height: 0.5rem;
  }

  @keyframes sr-shimmer {
    0% {
      background-position: -150% 0;
    }
    100% {
      background-position: 150% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sr-bar {
      animation: none;
      background-image: none;
    }
  }
</style>
