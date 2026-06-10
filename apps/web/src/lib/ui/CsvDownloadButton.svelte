<script>
  /**
   * CsvDownloadButton — small "Download CSV" affordance the route
   * pages mount next to their register viewer.
   *
   * The route passes an `onClick` callback that returns the CSV
   * string plus a filename. The button handles the actual browser
   * download via `triggerCsvDownload`. The button is `data-print="hide"`
   * so it doesn't appear in printed register exports.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import { triggerCsvDownload } from './csv';

  /**
   * Returns the CSV body + filename for download. May be synchronous
   * or async; the button awaits before triggering the download.
   * @type {() => ({ csv: string, filename: string } | Promise<{ csv: string, filename: string }>)}
   */
  export let onClick;

  let busy = false;

  async function handleClick() {
    if (busy) return;
    busy = true;
    try {
      const result = await onClick();
      triggerCsvDownload(result);
    } finally {
      busy = false;
    }
  }
</script>

<button
  type="button"
  class="btn-outline csv-download-btn"
  data-testid="csv-download-btn"
  data-print="hide"
  disabled={busy}
  aria-busy={busy ? 'true' : 'false'}
  on:click={handleClick}
>
  {busy ? t('common.csvDownload.busy') : t('common.csvDownload.button')}
</button>

<style>
  .csv-download-btn {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
    margin-block-end: 0.75rem;
  }
</style>
