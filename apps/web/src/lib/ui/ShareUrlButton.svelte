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

  /**
   * Optional explicit string to copy. When null (the default) the button copies
   * the canonical current URL (`window.location.href`) — the original register-
   * surface "share this view" behaviour. The committee invite/re-send custody
   * card (ADR-0029 P1-8c / F-170) passes the redeem LINK here so the ONE
   * clipboard affordance copies the link ONLY, never the one-time code.
   * @type {string | null}
   */
  export let url = null;

  /**
   * Catalog keys for the button/live-region copy. Defaults reproduce the
   * original "Copy share URL" wording verbatim, so existing call sites
   * (`<ShareUrlButton />`) are unchanged. The committee card overrides them
   * with the LINK-labelled "Copy link" / "Link copied" strings.
   */
  export let labelKey = 'common.shareUrl.button';
  export let copiedKey = 'common.shareUrl.copied';
  export let errorKey = 'common.shareUrl.error';
  export let copiedAnnounceKey = 'common.shareUrl.copied_announce';
  export let errorAnnounceKey = 'common.shareUrl.error_announce';

  /**
   * When true, the control meets the general-app 44px touch target
   * (`touch_target.min`) instead of the compact register-chrome size — used by
   * the committee custody card per Surface K's touch-target requirement.
   * @type {boolean}
   */
  export let fullTarget = false;

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
      const href = url != null ? url : typeof window !== 'undefined' ? window.location.href : '';
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
  class:full-target={fullTarget}
  data-testid="share-url-btn"
  data-state={status}
  data-print="hide"
  on:click={handleClick}
>
  {#if status === 'copied'}
    {t(copiedKey)}
  {:else if status === 'error'}
    {t(errorKey)}
  {:else}
    {t(labelKey)}
  {/if}
</button>

<!-- Polite live region so the copy result reaches assistive tech without
     stealing focus. -->
<span class="visually-hidden" aria-live="polite" data-testid="share-url-live">
  {#if status === 'copied'}
    {t(copiedAnnounceKey)}
  {:else if status === 'error'}
    {t(errorAnnounceKey)}
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
  /* Committee custody card: honour the general-app 44px touch target. */
  .share-url-btn.full-target {
    min-height: 2.75rem;
    font-size: 0.875rem;
    margin-inline-start: 0;
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
