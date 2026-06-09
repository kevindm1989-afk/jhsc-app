/**
 * T19.1 — DeviceInfoCard (read-only "what am I running" card on /settings).
 *
 * Pins:
 *   - Section data-testid + heading via t().
 *   - Five info rows: fingerprint, install, theme, reduced-motion, baseline.
 *   - The baseline capability list renders one pill per check with the
 *     pass/fail class binding so a future refactor can't silently drop
 *     a probe.
 *   - Catalog keys are present.
 *
 * The component reads navigator.userAgent + navigator.platform via
 * composeDeviceFingerprint, capability probes via runExtendedBaseline,
 * and matchMedia for install/reduced-motion state. jsdom provides the
 * navigator (default UA/platform) and an inert matchMedia that returns
 * `matches: false` for any query — that's enough for the structural pins.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DeviceInfoCard from '../../src/lib/ui/DeviceInfoCard.svelte';

const SOURCE_PATH = resolve(__dirname, '../../src/lib/ui/DeviceInfoCard.svelte');

afterEach(() => {
  cleanup();
});

describe('T19.1 — DeviceInfoCard source pins', () => {
  it('the component file exists at the expected path', () => {
    expect(existsSync(SOURCE_PATH)).toBe(true);
  });

  it('every settings.deviceInfo.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const di = catalog.settings.deviceInfo;
    expect(di).toBeDefined();
    expect(typeof di.heading).toBe('string');
    expect(typeof di.intro).toBe('string');
    expect(typeof di.unavailable).toBe('string');
    for (const k of ['browser', 'install', 'theme', 'reduced_motion', 'connection', 'baseline']) {
      expect(typeof di.label[k]).toBe('string');
    }
    for (const k of ['online', 'offline']) {
      expect(typeof di.connection[k]).toBe('string');
    }
    for (const k of ['send', 'sent', 'helper']) {
      expect(typeof di.sentry_test[k]).toBe('string');
    }
    for (const k of ['installed', 'browser']) {
      expect(typeof di.install[k]).toBe('string');
    }
    for (const k of ['light', 'dark', 'system']) {
      expect(typeof di.theme[k]).toBe('string');
    }
    for (const k of ['on', 'off']) {
      expect(typeof di.reduced_motion[k]).toBe('string');
    }
    for (const k of ['webcrypto', 'indexeddb', 'service_worker', 'locks', 'passkey', 'argon2id']) {
      expect(typeof di.capability[k]).toBe('string');
    }
  });
});

describe('T19.1 — DeviceInfoCard render', () => {
  it('renders the device-info-section data-testid', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      expect(screen.getByTestId('device-info-section')).toBeDefined();
    });
  });

  it('renders six info rows (fingerprint / install / theme / reduced-motion / connection / baseline)', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      expect(screen.getByTestId('device-info-fingerprint')).toBeDefined();
      expect(screen.getByTestId('device-info-install')).toBeDefined();
      expect(screen.getByTestId('device-info-theme')).toBeDefined();
      expect(screen.getByTestId('device-info-reduced-motion')).toBeDefined();
      expect(screen.getByTestId('device-info-connection')).toBeDefined();
      expect(screen.getByTestId('device-info-baseline')).toBeDefined();
    });
  });

  it('renders the Sentry test-event button + helper', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      const btn = screen.getByTestId('device-info-sentry-test-button');
      expect(btn).toBeDefined();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      // Helper line below the button.
      const section = screen.getByTestId('device-info-section');
      expect(section.textContent ?? '').toMatch(/test event/i);
    });
  });

  it('the test-event button flips to a sent state after click', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      expect(screen.getByTestId('device-info-sentry-test-button')).toBeDefined();
    });
    const btn = screen.getByTestId('device-info-sentry-test-button') as HTMLButtonElement;
    btn.click();
    await waitFor(() => {
      expect(btn.disabled).toBe(true);
      expect(btn.textContent ?? '').toMatch(/sent/i);
    });
  });

  it('renders one capability pill per baseline check (six pills)', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      const pills = screen.getAllByTestId('capability-pill');
      // Six capabilities defined in BaselineCheckKey: webcrypto,
      // indexeddb, service_worker, locks, passkey, argon2id.
      expect(pills.length).toBe(6);
    });
  });

  it('each capability pill carries a data-capability-key + pass|fail class binding', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      const pills = screen.getAllByTestId('capability-pill');
      const keys = pills.map((p) => p.getAttribute('data-capability-key'));
      expect(keys).toEqual([
        'webcrypto',
        'indexeddb',
        'service_worker',
        'locks',
        'passkey',
        'argon2id'
      ]);
      for (const p of pills) {
        const cls = p.className;
        expect(cls.includes('pass') || cls.includes('fail')).toBe(true);
      }
    });
  });

  it('surfaces the catalog heading via t()', async () => {
    render(DeviceInfoCard);
    await waitFor(() => {
      expect(screen.getByText('This device')).toBeDefined();
    });
  });
});
