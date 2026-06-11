<script>
  /**
   * /saved-views — manage the worker's saved views.
   *
   * Lists every view the worker has bookmarked, grouped by route.
   * Each row exposes a deep link, a rename action (inline input),
   * and a delete action (single-step, with no destructive confirm
   * because saved views are recoverable: just re-bookmark from the
   * register surface).
   *
   * Reads + writes the same localStorage store as SaveViewButton +
   * SavedViewsRail. No backend — these are per-device worker
   * affordances.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import {
    deleteSavedView,
    exportSavedViews,
    hrefForSavedView,
    importSavedViews,
    listSavedViews,
    renameSavedView
  } from '$lib/saved-views/saved-views';

  /** @type {import('$lib/saved-views/saved-views').SavedView[]} */
  let views = [];

  /** @type {HTMLInputElement | null} */
  let importInput = null;

  /** @type {'idle' | 'imported' | 'error'} */
  let importState = 'idle';
  let importMessage = '';
  /** @type {ReturnType<typeof setTimeout> | null} */
  let importResetTimer = null;

  /** Id of the view currently being renamed (or null). */
  let renamingId = null;
  let renameDraft = '';

  function refresh() {
    views = listSavedViews();
  }

  function startRename(view) {
    renamingId = view.id;
    renameDraft = view.name;
  }

  function cancelRename() {
    renamingId = null;
    renameDraft = '';
  }

  function commitRename(id) {
    const next = renameDraft.trim();
    if (!next) {
      cancelRename();
      return;
    }
    renameSavedView(id, next);
    cancelRename();
    refresh();
  }

  function remove(id) {
    deleteSavedView(id);
    refresh();
  }

  /** @param {KeyboardEvent} e @param {string} id */
  function onRenameKey(e, id) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  function flashImportState(state, message) {
    importState = state;
    importMessage = message;
    if (importResetTimer) clearTimeout(importResetTimer);
    importResetTimer = setTimeout(() => {
      importState = 'idle';
      importMessage = '';
      importResetTimer = null;
    }, 2500);
  }

  function downloadExport() {
    if (typeof window === 'undefined') return;
    const env = exportSavedViews();
    const blob = new Blob([JSON.stringify(env, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `jhsc-saved-views-${env.exportedAt.slice(0, 10)}.json`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function triggerImport() {
    importInput?.click();
  }

  /** @param {Event} event */
  async function onImportFile(event) {
    const target = /** @type {HTMLInputElement} */ (event.target);
    const file = target.files?.[0];
    target.value = ''; // allow re-importing the same file later
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = importSavedViews(parsed);
      refresh();
      flashImportState(
        'imported',
        t('common.savedViewsPage.import_announce', {
          added: String(result.added.length),
          skipped: String(result.skipped)
        })
      );
    } catch {
      flashImportState('error', t('common.savedViewsPage.import_error'));
    }
  }

  onMount(() => {
    refresh();
  });
</script>

<svelte:head>
  <title>{t('common.savedViewsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card saved-views-page" data-testid="saved-views-page">
  <header class="svp-header">
    <h1>{t('common.savedViewsPage.heading')}</h1>
    <p class="muted">{t('common.savedViewsPage.intro')}</p>
  </header>

  <div class="svp-io" data-testid="saved-views-io" data-print="hide">
    <button
      type="button"
      class="btn-outline svp-io-btn"
      data-testid="saved-views-export"
      on:click={downloadExport}
    >
      {t('common.savedViewsPage.export')}
    </button>
    <button
      type="button"
      class="btn-outline svp-io-btn"
      data-testid="saved-views-import"
      on:click={triggerImport}
    >
      {t('common.savedViewsPage.import')}
    </button>
    <input
      type="file"
      accept="application/json,.json"
      class="svp-io-file"
      data-testid="saved-views-import-input"
      bind:this={importInput}
      on:change={onImportFile}
    />
    {#if importState !== 'idle'}
      <span
        class="svp-io-status"
        class:is-error={importState === 'error'}
        class:is-ok={importState === 'imported'}
        data-testid="saved-views-import-status"
        data-state={importState}
        aria-live="polite"
      >
        {importMessage}
      </span>
    {/if}
  </div>

  {#if views.length === 0}
    <p class="svp-empty muted" data-testid="saved-views-empty">
      {t('common.savedViewsPage.empty')}
    </p>
  {:else}
    <ul class="svp-list" data-testid="saved-views-list">
      {#each views as v (v.id)}
        <li class="svp-row" data-testid="saved-views-row" data-id={v.id}>
          {#if renamingId === v.id}
            <input
              type="text"
              class="svp-rename-input"
              data-testid="saved-views-rename-input"
              bind:value={renameDraft}
              on:keydown={(e) => onRenameKey(e, v.id)}
              aria-label={t('common.savedViewsPage.rename_aria')}
              maxlength="80"
            />
            <button
              type="button"
              class="btn-outline svp-rename-confirm"
              data-testid="saved-views-rename-confirm"
              on:click={() => commitRename(v.id)}
            >
              {t('common.savedViewsPage.rename_confirm')}
            </button>
            <button
              type="button"
              class="svp-rename-cancel"
              data-testid="saved-views-rename-cancel"
              on:click={cancelRename}
              aria-label={t('common.savedViewsPage.rename_cancel_aria')}
            >
              ×
            </button>
          {:else}
            <a
              href={hrefForSavedView(v)}
              class="svp-name-link"
              data-testid="saved-views-link"
              data-route={v.route}
              data-id={v.id}
            >
              <strong class="svp-name">{v.name}</strong>
              <span class="svp-route">{v.route}{v.search}</span>
            </a>
            <button
              type="button"
              class="svp-action"
              data-testid="saved-views-rename"
              on:click={() => startRename(v)}
            >
              {t('common.savedViewsPage.rename')}
            </button>
            <button
              type="button"
              class="svp-action svp-action-danger"
              data-testid="saved-views-delete"
              on:click={() => remove(v.id)}
            >
              {t('common.savedViewsPage.delete')}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <p class="svp-footer" data-print="hide">
    <a href="/" data-testid="saved-views-back-to-home">
      {t('common.savedViewsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .saved-views-page {
    margin-block-start: 1rem;
  }
  .svp-header {
    margin-block-end: 0.75rem;
  }
  .svp-header h1 {
    margin-block: 0 0.25rem;
  }
  .svp-empty {
    font-size: 0.875rem;
  }
  .svp-io {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-block-end: 0.75rem;
  }
  .svp-io-btn {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .svp-io-file {
    display: none;
  }
  .svp-io-status {
    font-size: 0.8125rem;
    padding-inline: 0.625rem;
    padding-block: 0.25rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .svp-io-status.is-error {
    background: var(--color-tint-red-bg);
    border-color: var(--color-tint-red-border);
    color: var(--color-tint-red-fg);
  }
  .svp-io-status.is-ok {
    background: var(--color-tint-green-bg);
    border-color: var(--color-tint-green-border);
    color: var(--color-tint-green-fg);
  }
  .svp-list {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: grid;
    gap: 0.375rem;
  }
  .svp-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
  }
  .svp-name-link {
    flex: 1;
    display: grid;
    gap: 0.125rem;
    text-decoration: none;
    color: var(--color-fg);
    min-inline-size: 12rem;
  }
  .svp-name-link:hover {
    text-decoration: none;
  }
  .svp-name {
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .svp-route {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }
  .svp-action {
    border: none;
    background: transparent;
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
  }
  .svp-action:hover {
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .svp-action-danger {
    color: var(--color-destructive);
  }
  .svp-action-danger:hover {
    background: var(--color-tint-red-bg);
    color: var(--color-destructive);
  }
  .svp-rename-input {
    flex: 1;
    min-height: 2.25rem;
    padding-inline: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.8125rem;
    min-inline-size: 12rem;
  }
  .svp-rename-confirm {
    min-height: 2.25rem;
    padding-inline: 0.75rem;
    font-size: 0.8125rem;
  }
  .svp-rename-cancel {
    background: transparent;
    border: none;
    color: var(--color-fg-muted);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
  }
  .svp-rename-cancel:hover {
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .svp-footer {
    margin-block-start: 1rem;
  }
</style>
