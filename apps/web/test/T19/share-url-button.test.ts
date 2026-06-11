/**
 * T19 — ShareUrlButton (clipboard affordance) + rollout pin.
 *
 * Covers:
 *   - The component renders, copies $page.url.href on click, and
 *     announces success/failure via aria-live.
 *   - Every register surface + /report + /audit + /sensitive-feed
 *     mounts the button so the worker can deep-link any view.
 *   - The i18n keys the button reads from are present in the catalog.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ShareUrlButton from '../../src/lib/ui/ShareUrlButton.svelte';

const ROUTES = [
  'training',
  'work-refusal',
  's51-evidence',
  'reprisal',
  'minutes',
  'inspections',
  'library',
  'recommendations',
  'concerns',
  'audit',
  'sensitive-feed',
  'report'
] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T19 — ShareUrlButton', () => {
  it('renders the idle button label by default', () => {
    render(ShareUrlButton);
    const btn = screen.getByTestId('share-url-btn');
    expect(btn.textContent?.trim()).toMatch(/copy/i);
    expect(btn.getAttribute('data-state')).toBe('idle');
  });

  it('writes $page.url.href to navigator.clipboard on click', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText }
    });
    render(ShareUrlButton);
    const btn = screen.getByTestId('share-url-btn');
    await fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(typeof writeText.mock.calls[0]![0]).toBe('string');
    expect(writeText.mock.calls[0]![0]).toMatch(/^https?:\/\//);
  });

  it('shows the copied state + announces via aria-live after a successful copy', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText }
    });
    render(ShareUrlButton);
    await fireEvent.click(screen.getByTestId('share-url-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('share-url-btn').getAttribute('data-state')).toBe('copied');
    });
    expect(screen.getByTestId('share-url-live').textContent?.trim()).toMatch(/copied/i);
  });

  it('shows the error state when navigator.clipboard.writeText rejects', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(global.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText }
    });
    render(ShareUrlButton);
    await fireEvent.click(screen.getByTestId('share-url-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('share-url-btn').getAttribute('data-state')).toBe('error');
    });
    expect(screen.getByTestId('share-url-live').textContent?.trim()).toMatch(
      /could not|fail/i
    );
  });

  it('shows the error state when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(global.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: undefined
    });
    render(ShareUrlButton);
    await fireEvent.click(screen.getByTestId('share-url-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('share-url-btn').getAttribute('data-state')).toBe('error');
    });
  });

  it('carries data-print="hide" so it does not appear in printed views', () => {
    render(ShareUrlButton);
    expect(screen.getByTestId('share-url-btn').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — ShareUrlButton is mounted on every register surface + /report', () => {
  for (const route of ROUTES) {
    it(`/${route} imports + mounts <ShareUrlButton />`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /import\s+ShareUrlButton\s+from\s+['"]\$lib\/ui\/ShareUrlButton\.svelte['"]/
      );
      expect(src).toContain('<ShareUrlButton />');
    });
  }
});

describe('T19 — common.shareUrl.* i18n keys', () => {
  it('catalog has the button + state + announcement strings', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.shareUrl.button).toBe('string');
    expect(typeof catalog.common.shareUrl.copied).toBe('string');
    expect(typeof catalog.common.shareUrl.error).toBe('string');
    expect(typeof catalog.common.shareUrl.copied_announce).toBe('string');
    expect(typeof catalog.common.shareUrl.error_announce).toBe('string');
  });
});
