/**
 * T19.1 — RecoveryReissueCard (print a fresh recovery sheet from /settings).
 *
 * Pins:
 *   - Structural shape: section testid, heading, intro, two warning
 *     bullets, generate button.
 *   - F-108 contract — the passphrase <code> carries NO aria-live /
 *     role="alert" / role="status" (the surrounding success panel has
 *     role="status" but the <code> itself does not).
 *   - Happy path: identity is provided → button click generates a real
 *     passphrase + serializes + offers download → success surface
 *     renders with the passphrase + filename.
 *   - Signed-out path: getCurrentUserId() returns null → button click
 *     surfaces signed_out error.
 *   - No-identity path: provider throws / returns wrong length → button
 *     click surfaces no_identity error.
 *
 * Mocking strategy:
 *   - JSDOM's URL.createObjectURL doesn't exist by default; the download
 *     path in downloadRecoveryBlobJson uses it. Stubbed in beforeEach
 *     so the download "succeeds" without actually triggering a browser
 *     download.
 *   - The BLAKE2b fallback path is forced on (jsdom has no Argon2id
 *     WASM) so encryptRecoveryBlob runs fast + deterministic.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import RecoveryReissueCard from '../../src/lib/recovery/RecoveryReissueCard.svelte';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { __setTestOverrideUseBlake2bFallback } from '../../src/lib/crypto/recovery-blob';

const USER_ID = '11111111-2222-3333-4444-555555555555';

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const body = btoa(JSON.stringify({ sub, jti: 'sess-1', iat: 1700000000, exp: 1700001000 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.sig`;
}

beforeEach(() => {
  __setTestOverrideUseBlake2bFallback(() => true);
  setJwt(makeJwt(USER_ID));
  // Stub URL.createObjectURL / revokeObjectURL so downloadRecoveryBlobJson
  // doesn't blow up in jsdom (it lacks these by default).
  const g = globalThis as unknown as { URL: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void } };
  if (typeof g.URL.createObjectURL !== 'function') {
    g.URL.createObjectURL = () => 'blob:fake-url';
  }
  if (typeof g.URL.revokeObjectURL !== 'function') {
    g.URL.revokeObjectURL = () => {};
  }
});
afterEach(() => {
  cleanup();
  clearJwt();
  __setTestOverrideUseBlake2bFallback(null);
});

describe('T19.1 — RecoveryReissueCard structural pins', () => {
  it('renders section data-testid + heading + intro + two warning bullets', () => {
    render(RecoveryReissueCard, { props: { getIdentityPrivateKey: async () => new Uint8Array(32) } });
    expect(screen.getByTestId('recovery-reissue-section')).toBeDefined();
    expect(screen.getByText('Print a new recovery sheet')).toBeDefined();
    const lis = screen
      .getByTestId('recovery-reissue-section')
      .querySelectorAll('.recovery-reissue-warnings > li');
    expect(lis.length).toBe(2);
  });

  it('renders the Generate button in the idle state', () => {
    render(RecoveryReissueCard, { props: { getIdentityPrivateKey: async () => new Uint8Array(32) } });
    expect(screen.getByTestId('recovery-reissue-button')).toBeDefined();
  });
});

describe('T19.1 — RecoveryReissueCard happy path', () => {
  it(
    'click → generates passphrase + offers download + renders success surface',
    { timeout: 15000 },
    async () => {
      const idPriv = new Uint8Array(32).fill(11);
      render(RecoveryReissueCard, {
        props: { getIdentityPrivateKey: async () => idPriv }
      });
      fireEvent.click(screen.getByTestId('recovery-reissue-button'));
      await waitFor(
        () => {
          const success = screen.getByTestId('recovery-reissue-success');
          expect(success.getAttribute('role')).toBe('status');
        },
        { timeout: 12000 }
      );
      // Filename surfaced.
      const filename = screen.getByTestId('recovery-reissue-filename').textContent ?? '';
      expect(filename).toMatch(/jhsc-recovery-/);
      // Passphrase rendered as <code>.
      const pp = screen.getByTestId('recovery-reissue-passphrase');
      expect(pp.tagName.toLowerCase()).toBe('code');
      // F-108 contract: the passphrase element carries no live-region.
      expect(pp.getAttribute('aria-live')).toBeNull();
      expect(pp.getAttribute('role')).not.toBe('alert');
      expect(pp.getAttribute('role')).not.toBe('status');
      // Crockford-base32 32-char hyphenated shape (4 groups of 4).
      expect(pp.textContent ?? '').toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){3,}$/);
    }
  );
});

describe('T19.1 — RecoveryReissueCard guards', () => {
  it('surfaces signed_out error when no JWT is set', async () => {
    clearJwt();
    render(RecoveryReissueCard, {
      props: { getIdentityPrivateKey: async () => new Uint8Array(32).fill(7) }
    });
    fireEvent.click(screen.getByTestId('recovery-reissue-button'));
    await waitFor(() => {
      const err = screen.getByTestId('recovery-reissue-error');
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent ?? '').toMatch(/sign in/i);
    });
  });

  it('surfaces no_identity error when the provider throws', async () => {
    render(RecoveryReissueCard, {
      props: {
        getIdentityPrivateKey: async () => {
          throw new Error('not found');
        }
      }
    });
    fireEvent.click(screen.getByTestId('recovery-reissue-button'));
    await waitFor(() => {
      const err = screen.getByTestId('recovery-reissue-error');
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent ?? '').toMatch(/identity/i);
    });
  });

  it('surfaces no_identity error when the provider returns a wrong-length key', async () => {
    render(RecoveryReissueCard, {
      props: { getIdentityPrivateKey: async () => new Uint8Array(16) }
    });
    fireEvent.click(screen.getByTestId('recovery-reissue-button'));
    await waitFor(() => {
      const err = screen.getByTestId('recovery-reissue-error');
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent ?? '').toMatch(/identity/i);
    });
  });
});

describe('T19.1 — RecoveryReissueCard catalog coverage', () => {
  it('every settings.recoveryReissue.* key referenced is present in the root catalog', () => {
    const catalog = JSON.parse(
      require('node:fs').readFileSync(
        require('node:path').resolve(__dirname, '../../../../i18n/en-CA.json'),
        'utf8'
      )
    );
    const rr = catalog.settings.recoveryReissue;
    expect(rr).toBeDefined();
    for (const k of ['heading', 'intro', 'generate', 'generating', 'reset']) {
      expect(typeof rr[k]).toBe('string');
    }
    for (const k of ['old_sheet_still_works', 'server_backup_unchanged']) {
      expect(typeof rr.warning[k]).toBe('string');
    }
    for (const k of ['heading', 'body', 'file_label', 'passphrase_label']) {
      expect(typeof rr.success[k]).toBe('string');
    }
    for (const k of ['signed_out', 'no_identity', 'download_failed', 'unknown']) {
      expect(typeof rr.error[k]).toBe('string');
    }
  });
});
