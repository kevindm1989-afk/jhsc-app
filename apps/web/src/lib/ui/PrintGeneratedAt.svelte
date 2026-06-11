<script>
  /**
   * PrintGeneratedAt — small print-only footer rendering the date +
   * time the worker hit Print. Mounted at the layout level so every
   * paper handout carries provenance (committee meetings need to
   * know which day's data they're looking at).
   *
   * The timestamp is captured on mount, not on every render, so a
   * page open for hours still prints the time the worker actually
   * opened it. (Pressing Print right after page open is the common
   * case; if a worker leaves the tab open overnight they can reload
   * before printing.)
   *
   * `data-print="print-only"` keeps it off screen; the global rule
   * in app.html (`[data-print='print-only'] { display: block }`)
   * reveals it at print time.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';

  let stamp = '';

  /** Format a Date as "YYYY-MM-DD HH:MM" in local time. */
  function fmt(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }

  onMount(() => {
    stamp = fmt(new Date());
  });
</script>

<p class="pga" data-testid="print-generated-at" data-print="print-only">
  {t('common.print.generated_at', { stamp })}
</p>

<style>
  .pga {
    /* Default to off-screen; the global print rule in app.html
       flips display on at print time. */
    display: none;
    margin: 1rem 0 0;
    padding-block-start: 0.5rem;
    border-block-start: 1px solid var(--color-border);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
</style>
