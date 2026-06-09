/**
 * T19.1 — RecoveryVerifierCard (read-only "verify my sheet" surface).
 *
 * Pins the structural shape + the verify happy + failure paths:
 *   - Section + heading + intro render via t().
 *   - File input + passphrase input + verify button present.
 *   - The passphrase input carries the F-108 defensive attribute set
 *     (autocomplete=off, spellcheck=false, autocapitalize=none,
 *     autocorrect=off) so Chromium cloud-spellcheck doesn't round-trip
 *     the passphrase. This is the same contract the D.6 type-back
 *     input honours; the verifier surface re-applies it.
 *   - The verify button is disabled until BOTH inputs have content.
 *   - On a real successful verification, a role=status success panel
 *     renders with the blob_id.
 *   - On a wrong-passphrase failure, a role=alert panel renders with
 *     the canonical 'decrypt_failed' copy.
 *
 * Note: the libsodium Argon2id path needs a real WASM runtime; jsdom's
 * lack of it means we use the test override exposed by recovery-blob.ts
 * to make decryptRecoveryBlob's KDF call return deterministically.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import RecoveryVerifierCard from '../../src/lib/recovery/RecoveryVerifierCard.svelte';
import { encryptRecoveryBlob, __setTestOverrideUseBlake2bFallback } from '../../src/lib/crypto/recovery-blob';
import { serializeRecoveryBlobJson } from '../../src/lib/onboarding/recovery-blob-download';

beforeEach(() => {
  // Use the BLAKE2b fallback path so the KDF runs deterministically
  // in jsdom (no libsodium WASM). The recovery-blob module's tests
  // rely on the same override.
  __setTestOverrideUseBlake2bFallback(() => true);
});
afterEach(() => {
  cleanup();
  __setTestOverrideUseBlake2bFallback(null);
});

describe('T19.1 — RecoveryVerifierCard structural pins', () => {
  it('renders the section data-testid + heading via t()', () => {
    render(RecoveryVerifierCard);
    expect(screen.getByTestId('recovery-verify-section')).toBeDefined();
    expect(screen.getByText('Verify your recovery sheet')).toBeDefined();
  });

  it('renders the file input + passphrase input + verify button', () => {
    render(RecoveryVerifierCard);
    expect(screen.getByTestId('recovery-verify-file-input')).toBeDefined();
    expect(screen.getByTestId('recovery-verify-passphrase')).toBeDefined();
    expect(screen.getByTestId('recovery-verify-button')).toBeDefined();
  });

  it('F-108: passphrase input carries the defensive attribute set', () => {
    render(RecoveryVerifierCard);
    const pp = screen.getByTestId('recovery-verify-passphrase');
    expect(pp.getAttribute('autocomplete')).toBe('off');
    expect(pp.getAttribute('spellcheck')).toBe('false');
    expect(pp.getAttribute('autocapitalize')).toBe('none');
    expect(pp.getAttribute('autocorrect')).toBe('off');
  });

  it('passphrase input is type=password (never type=text)', () => {
    render(RecoveryVerifierCard);
    const pp = screen.getByTestId('recovery-verify-passphrase');
    expect(pp.getAttribute('type')).toBe('password');
  });

  it('verify button is disabled until both inputs have content', async () => {
    render(RecoveryVerifierCard);
    const btn = screen.getByTestId('recovery-verify-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Type a passphrase only — still disabled (no JSON).
    const pp = screen.getByTestId('recovery-verify-passphrase') as HTMLInputElement;
    fireEvent.input(pp, { target: { value: 'a passphrase' } });
    await waitFor(() => expect(btn.disabled).toBe(true));
  });
});

describe('T19.1 — RecoveryVerifierCard happy path', () => {
  it('verifies a real serialized blob with the right passphrase → role=status success', { timeout: 15000 }, async () => {
    // Build a real recovery blob (BLAKE2b fallback in tests).
    const idPriv = new Uint8Array(32).fill(11);
    const passphrase = 'correct horse battery staple';
    const blob = await encryptRecoveryBlob(idPriv, passphrase);
    const json = serializeRecoveryBlobJson({
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      kdf_params: { ops: blob.kdf_params.ops, mem: blob.kdf_params.mem_bytes, salt: blob.salt }
    });
    const jsonText = JSON.stringify(json);

    render(RecoveryVerifierCard);
    const file = new File([jsonText], 'jhsc-recovery-test.json', { type: 'application/json' });
    // jsdom's File constructor doesn't reliably implement File.text(); stub
    // it so the component's `await file.text()` resolves with the right
    // contents instead of hanging.
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: () => Promise.resolve(jsonText)
    });
    const fileInput = screen.getByTestId('recovery-verify-file-input') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file]
    });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(screen.getByTestId('recovery-verify-file-name').textContent).toMatch(
        /jhsc-recovery-test\.json/
      );
    });

    const pp = screen.getByTestId('recovery-verify-passphrase') as HTMLInputElement;
    fireEvent.input(pp, { target: { value: passphrase } });

    const btn = screen.getByTestId('recovery-verify-button') as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(
      () => {
        const success = screen.getByTestId('recovery-verify-success');
        expect(success.getAttribute('role')).toBe('status');
        // The blob_id is surfaced in monospace.
        expect(screen.getByTestId('recovery-verify-blob-id').textContent).toBe(json.blob_id);
      },
      { timeout: 12000 }
    );
  });
});

describe('T19.1 — RecoveryVerifierCard failure paths', () => {
  it('wrong passphrase → role=alert with the decrypt_failed copy', { timeout: 15000 }, async () => {
    const idPriv = new Uint8Array(32).fill(11);
    const blob = await encryptRecoveryBlob(idPriv, 'real passphrase');
    const json = serializeRecoveryBlobJson({
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      kdf_params: { ops: blob.kdf_params.ops, mem: blob.kdf_params.mem_bytes, salt: blob.salt }
    });
    const jsonText = JSON.stringify(json);

    render(RecoveryVerifierCard);
    const file = new File([jsonText], 'sheet.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: () => Promise.resolve(jsonText)
    });
    const fileInput = screen.getByTestId('recovery-verify-file-input') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    fireEvent.change(fileInput);

    // Wait for onFile's await file.text() to resolve before clicking
    // Verify; without this, jsonText is still '' and the verify path
    // surfaces 'not_json' instead of 'decrypt_failed'.
    await waitFor(() => {
      expect(screen.getByTestId('recovery-verify-file-name').textContent).toMatch(/sheet\.json/);
    });

    const pp = screen.getByTestId('recovery-verify-passphrase') as HTMLInputElement;
    fireEvent.input(pp, { target: { value: 'wrong passphrase' } });

    fireEvent.click(screen.getByTestId('recovery-verify-button'));

    await waitFor(
      () => {
        const err = screen.getByTestId('recovery-verify-error');
        expect(err.getAttribute('role')).toBe('alert');
        expect(err.textContent ?? '').toMatch(/passphrase|decrypt/i);
      },
      { timeout: 12000 }
    );
  });

  it('malformed JSON → role=alert with the not_json copy', async () => {
    render(RecoveryVerifierCard);
    const badText = 'not json at all';
    const file = new File([badText], 'bad.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: () => Promise.resolve(badText)
    });
    const fileInput = screen.getByTestId('recovery-verify-file-input') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    fireEvent.change(fileInput);

    const pp = screen.getByTestId('recovery-verify-passphrase') as HTMLInputElement;
    fireEvent.input(pp, { target: { value: 'whatever' } });
    fireEvent.click(screen.getByTestId('recovery-verify-button'));

    await waitFor(() => {
      const err = screen.getByTestId('recovery-verify-error');
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent ?? '').toMatch(/not valid json/i);
    });
  });
});

describe('T19.1 — RecoveryVerifierCard catalog coverage', () => {
  it('every settings.recoveryVerify.* key referenced is present in the root catalog', () => {
    const catalog = JSON.parse(
      require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    const rv = catalog.settings.recoveryVerify;
    expect(rv).toBeDefined();
    for (const k of [
      'heading',
      'intro',
      'file_label',
      'passphrase_label',
      'passphrase_helper',
      'verify',
      'verifying',
      'reset'
    ]) {
      expect(typeof rv[k]).toBe('string');
    }
    for (const k of ['heading', 'body', 'blob_id_label']) {
      expect(typeof rv.success[k]).toBe('string');
    }
    for (const k of [
      'not_json',
      'wrong_shape',
      'wrong_version',
      'bad_base64',
      'bad_nonce_length',
      'decrypt_failed',
      'argon2_unavailable',
      'file_read',
      'unknown'
    ]) {
      expect(typeof rv.error[k]).toBe('string');
    }
  });
});
