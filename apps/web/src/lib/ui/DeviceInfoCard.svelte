<script>
  /**
   * DeviceInfoCard — read-only "what am I running" surface for /settings.
   *
   * Surfaces concrete browser/device facts so a worker can:
   *   - Confirm which device they're on (the same UA + platform string
   *     the D.1 onboarding fingerprint card shows — composeDeviceFingerprint).
   *   - See whether the runtime meets the JHSC baseline (every capability
   *     probe from runExtendedBaseline — WebCrypto, IndexedDB, Service
   *     Worker, Web Locks, WebAuthn, Argon2id). Failed checks are
   *     visually flagged so the worker knows why some surfaces won't
   *     work yet.
   *   - See the install state (PWA installed via display-mode:standalone
   *     vs. running in a regular browser tab).
   *   - See the active theme override and reduced-motion preference.
   *
   * Read-only. No backend calls. No PI sent anywhere — the UA + platform
   * string never leaves the device (mirroring the F-101 M-101c contract
   * the D.1 fingerprint card honours).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13 — Svelte 5's esrap
   * codegen cannot serialize TS annotations on `let`.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { composeDeviceFingerprint } from '$lib/onboarding/device-fingerprint';
  import { runExtendedBaseline } from '$lib/onboarding/browser-baseline';
  import { theme } from '$lib/ui/theme';

  /** @type {ReturnType<typeof composeDeviceFingerprint> | null} */
  let fingerprint = null;
  /** @type {ReturnType<typeof runExtendedBaseline> | null} */
  let baseline = null;
  /** @type {'installed' | 'browser' | 'unknown'} */
  let installState = 'unknown';
  let reducedMotion = false;

  onMount(() => {
    fingerprint = composeDeviceFingerprint();
    baseline = runExtendedBaseline();
    installState = detectInstallState();
    reducedMotion = detectReducedMotion();
  });

  /** @returns {'installed' | 'browser' | 'unknown'} */
  function detectInstallState() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return 'unknown';
    }
    try {
      const standalone = window.matchMedia('(display-mode: standalone)').matches;
      // iOS Safari uses navigator.standalone instead of display-mode.
      // Treat undefined as 'browser' (the common case) so we don't
      // false-positive on browsers without the iOS extension.
      const iosStandalone =
        // @ts-expect-error iOS-only Navigator extension; not in lib.dom.
        typeof navigator !== 'undefined' && navigator.standalone === true;
      return standalone || iosStandalone ? 'installed' : 'browser';
    } catch {
      return 'unknown';
    }
  }

  /** @returns {boolean} */
  function detectReducedMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /** @param {string} key */
  function capabilityLabel(key) {
    return t(`settings.deviceInfo.capability.${key}`);
  }
</script>

<section
  class="device-info-section"
  aria-labelledby="device-info-heading"
  data-testid="device-info-section"
>
  <h2 id="device-info-heading">{t('settings.deviceInfo.heading')}</h2>
  <p class="muted">{t('settings.deviceInfo.intro')}</p>

  <dl class="device-info-list">
    <div class="device-info-row" data-testid="device-info-fingerprint">
      <dt>{t('settings.deviceInfo.label.browser')}</dt>
      <dd>
        {#if fingerprint}
          <code>{fingerprint.display}</code>
        {:else}
          <span class="muted">{t('settings.deviceInfo.unavailable')}</span>
        {/if}
      </dd>
    </div>

    <div class="device-info-row" data-testid="device-info-install">
      <dt>{t('settings.deviceInfo.label.install')}</dt>
      <dd>
        {#if installState === 'installed'}
          <span class="device-info-badge device-info-badge-good"
            >{t('settings.deviceInfo.install.installed')}</span
          >
        {:else if installState === 'browser'}
          <span class="device-info-badge device-info-badge-neutral"
            >{t('settings.deviceInfo.install.browser')}</span
          >
        {:else}
          <span class="muted">{t('settings.deviceInfo.unavailable')}</span>
        {/if}
      </dd>
    </div>

    <div class="device-info-row" data-testid="device-info-theme">
      <dt>{t('settings.deviceInfo.label.theme')}</dt>
      <dd>
        {#if $theme === 'light'}
          {t('settings.deviceInfo.theme.light')}
        {:else if $theme === 'dark'}
          {t('settings.deviceInfo.theme.dark')}
        {:else}
          {t('settings.deviceInfo.theme.system')}
        {/if}
      </dd>
    </div>

    <div class="device-info-row" data-testid="device-info-reduced-motion">
      <dt>{t('settings.deviceInfo.label.reduced_motion')}</dt>
      <dd>
        {#if reducedMotion}
          <span class="device-info-badge device-info-badge-good"
            >{t('settings.deviceInfo.reduced_motion.on')}</span
          >
        {:else}
          <span class="device-info-badge device-info-badge-neutral"
            >{t('settings.deviceInfo.reduced_motion.off')}</span
          >
        {/if}
      </dd>
    </div>

    <div class="device-info-row" data-testid="device-info-baseline">
      <dt>{t('settings.deviceInfo.label.baseline')}</dt>
      <dd>
        {#if baseline}
          <ul class="capability-list">
            {#each baseline.checks as check (check.key)}
              <li
                class="capability-pill"
                class:pass={check.pass}
                class:fail={!check.pass}
                data-testid="capability-pill"
                data-capability-key={check.key}
              >
                <span class="capability-dot" aria-hidden="true">
                  {#if check.pass}✓{:else}✗{/if}
                </span>
                <span>{capabilityLabel(check.key)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <span class="muted">{t('settings.deviceInfo.unavailable')}</span>
        {/if}
      </dd>
    </div>
  </dl>
</section>

<style>
  .device-info-section {
    margin-block-start: 1.25rem;
  }
  .device-info-list {
    display: block;
    margin-block: 0.75rem 0;
    padding: 0;
  }
  .device-info-row {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) 1fr;
    gap: 0.5rem 1rem;
    padding-block: 0.5rem;
    border-block-end: 1px solid var(--color-border);
  }
  .device-info-row:last-child {
    border-block-end: 0;
  }
  .device-info-row dt {
    color: var(--color-fg-muted);
    font-weight: 500;
    font-size: 0.8125rem;
  }
  .device-info-row dd {
    margin: 0;
    color: var(--color-fg);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .device-info-row dd code {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    word-break: break-all;
  }

  /* Inline badge — a tinted chip for short-status values (Installed,
     Browser, Reduced motion on/off). Two variants share spacing. */
  .device-info-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    border: 1px solid;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-weight: 500;
  }
  .device-info-badge-good {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .device-info-badge-neutral {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }

  /* Capability pill row — one pill per baseline check, colour-coded
     pass/fail with a unicode check / cross prefix so the signal is
     readable without colour. */
  .capability-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .capability-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border: 1px solid;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .capability-pill.pass {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .capability-pill.fail {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .capability-dot {
    font-weight: 700;
  }
</style>
