<script>
  /**
   * ShareUrlButton — "Copy share URL" affordance the route pages mount
   * next to their CSV download / filter chrome.
   *
   * Each register surface is a deep, URL-driven view: a filter, sort,
   * and date range collapse into one shareable URL. A worker co-chair
   * who narrows /concerns to "open + severity high + last 7 days" can
   * hand that URL to a peer (or paste it into the minutes draft) so
   * everyone lands on the same view.
   *
   * Behaviour:
   *   - On click, copies `window.location.href` (the canonical current
   *     URL) to the clipboard via the async Clipboard API. We read
   *     from `window.location` rather than the SvelteKit `$page` store
   *     so the component is decoupled from SvelteKit's stub and can be
   *     unit-tested in isolation.
   *   - Shows a transient "Copied" state for ~1.5s, then snaps back.
   *   - Read-only navigator.clipboard is required (Safari/Chrome/FF);
   *     in the rare environment where it's unavailable the button
   *     announces a failure via aria-live without crashing.
   *
   * `data-print="hide"` so the button doesn't appear in printed views.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  /** ms to keep the "Copied" state visible before reverting. */
  const COPIED_MS = 1500;

  /** @type {'idle' | 'copied' | 'error'} */
  let status = 'idle';

  /** @type {ReturnType<typeof setTimeout> | null} */
  let resetTimer = null;

  async function copyToClipboard(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('clipboard-unavailable');
    }
    await navigator.clipboard.writeText(text);
  }

  async function handleClick() {
    if (status === 'copied') return;
    try {
      const href = typeof window !== 'undefined' ? window.location.href : '';
      await copyToClipboard(href);
      status = 'copied';
    } catch {
      status = 'error';
    }
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      status = 'idle';
      resetTimer = null;
    }, COPIED_MS);
  }
</script>

<button
  type="button"
  class="btn-outline share-url-btn"
  class:is-copied={status === 'copied'}
  class:is-error={status === 'error'}
  data-testid="share-url-btn"
  data-state={status}
  data-print="hide"
  on:click={handleClick}
>
  {#if status === 'copied'}
    {t('common.shareUrl.copied')}
  {:else if status === 'error'}
    {t('common.shareUrl.error')}
  {:else}
    {t('common.shareUrl.button')}
  {/if}
</button>

<!-- Polite live region so the copy result reaches assistive tech without
     stealing focus. -->
<span class="visually-hidden" aria-live="polite" data-testid="share-url-live">
  {#if status === 'copied'}
    {t('common.shareUrl.copied_announce')}
  {:else if status === 'error'}
    {t('common.shareUrl.error_announce')}
  {/if}
</span>

<style>
  .share-url-btn {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
    margin-block-end: 0.75rem;
    margin-inline-start: 0.25rem;
  }
  .share-url-btn.is-copied {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .share-url-btn.is-error {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
