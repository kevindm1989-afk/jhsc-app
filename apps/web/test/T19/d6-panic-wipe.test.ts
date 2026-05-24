/**
 * T19 — D.6 Panic-wipe library + modal (additive to scaffold).
 *
 * Covers:
 *   - F-106 / M-106a — audit-BEFORE-side-effect: on TestWipeStore.__debugForceAuditFailure,
 *     panicWipe() returns {status: 'audit_failed', destruction_attempted: false} and NO
 *     clearXxx call is made
 *   - F-106 / M-106b — audit row meta is EXACTLY {surface, wipe_scope, completed,
 *     partial_failure_classes}; no IP / no UA / no device_id / no actor_pseudonym in meta
 *   - F-106 / M-106c — partial-failure double-row attribution: when a clearXxx fails AFTER
 *     audit-emit, a SECOND audit row is written with completed=false +
 *     partial_failure_classes enumerating the failed subsystems (audit-log is append-only;
 *     not an UPDATE)
 *   - F-109 / M-109a + G-T19-8 — BrowserWipeStore.clearCaches enumerates via caches.keys()
 *     dynamically (no hard-coded array of cache names in panic-wipe.ts)
 *   - F-113 / M-113a — post-wipe lockout: a second panicWipe() within the same session
 *     returns {status: 'no_op', reason: 'already_wiped'} and emits NO second audit row
 *   - F-115 / M-115 — modal copy four-regex contract:
 *       /irreversible|cannot be undone/i
 *       /server|committee/i
 *       /recovery passphrase|recovery sheet/i
 *       /co-?chair|invite/i
 *   - Designer §G — panic-wipe state matrix:
 *     ready-delay-pending, ready (awaiting phrase + click), in-progress overlay,
 *     partial-failure, complete
 *   - Designer §G — INVERTED two-layer focus ring on panic-overlay: inner layer uses
 *     color.{mode}.onboarding.panic_overlay_fg, NOT border.focus
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { existsSync, readFileSync } from 'node:fs';
import PanicWipeModal from '../../src/lib/lock/PanicWipeModal.svelte';
import { t } from '../../src/lib/i18n';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
});

// ============================================================================
// F-106 M-106a — audit-BEFORE-side-effect: forced audit failure aborts wipe
// ============================================================================

describe('T19 / F-106 M-106a — audit-emit failure aborts the wipe (no clearXxx fires)', () => {
  it('TestWipeStore.__debugForceAuditFailure() causes panicWipe() to skip every clearXxx', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    store.__debugForceAuditFailure();

    const result = await panicWipe({ store, surface: 'settings' });

    expect(result.status).toBe('audit_failed');
    expect(result.destruction_attempted).toBe(false);
    expect(store.__debugListClearedDatabases()).toEqual([]);
    expect(store.__debugListClearedCaches()).toEqual([]);
  });

  it('on audit failure, no clearSessionStorage / clearLocalStorage / tearDownSessionCookie call fires', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    store.__debugForceAuditFailure();

    await panicWipe({ store, surface: 'settings' });

    expect(store.__debugSessionStorageCleared()).toBe(false);
    expect(store.__debugLocalStorageCleared()).toBe(false);
    expect(store.__debugSessionCookieTornDown()).toBe(false);
  });
});

// ============================================================================
// F-106 M-106b — audit row meta is the closed allowlist
// ============================================================================

describe('T19 / F-106 M-106b — audit row meta is the closed allowlist', () => {
  it('the emitted audit row meta has EXACTLY the four allowlisted keys', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    await panicWipe({ store, surface: 'settings' });
    const rows = store.__debugListEmittedAuditRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = rows[0].meta;
    expect(new Set(Object.keys(meta))).toEqual(
      new Set(['surface', 'wipe_scope', 'completed', 'partial_failure_classes'])
    );
  });

  it('audit row event_type === "panic_wipe.invoked"', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    await panicWipe({ store, surface: 'settings' });
    const rows = store.__debugListEmittedAuditRows();
    expect(rows[0].event_type).toBe('panic_wipe.invoked');
  });

  it('wipe_scope === "local_only" (Q4 user-adjudicated; v1 is local-only)', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    await panicWipe({ store, surface: 'settings' });
    const rows = store.__debugListEmittedAuditRows();
    expect((rows[0].meta as { wipe_scope?: string }).wipe_scope).toBe('local_only');
  });

  it('meta does NOT contain ip / userAgent / navigator.* / device_id keys (no PI)', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    await panicWipe({ store, surface: 'settings' });
    const rows = store.__debugListEmittedAuditRows();
    const meta = rows[0].meta as Record<string, unknown>;
    for (const banned of ['ip', 'ip_address', 'userAgent', 'user_agent', 'device_id', 'fingerprint']) {
      expect(Object.keys(meta)).not.toContain(banned);
    }
  });

  it('panic-wipe.ts source has no reference to navigator.* or `ip` inside the audit-meta construction', () => {
    const src = readFileSync('/home/user/agent-os/apps/web/src/lib/lock/panic-wipe.ts', 'utf8');
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/navigator\./);
    expect(stripped).not.toMatch(/['"]ip['"]\s*:/);
    expect(stripped).not.toMatch(/userAgent/);
  });
});

// ============================================================================
// F-106 M-106c — partial-failure double-row attribution (audit-log append-only)
// ============================================================================

describe('T19 / F-106 M-106c — partial-failure produces a SECOND audit row', () => {
  it('__debugForceClearFailure("caches") produces two audit rows; the second has completed=false + partial_failure_classes=["caches"]', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    store.__debugForceClearFailure('caches');

    await panicWipe({ store, surface: 'settings' });

    const rows = store.__debugListEmittedAuditRows();
    expect(rows.length).toBe(2);
    expect(rows[0].event_type).toBe('panic_wipe.invoked');
    expect(rows[1].event_type).toBe('panic_wipe.invoked');
    // The second row carries the partial-failure attribution.
    const meta2 = rows[1].meta as { completed: boolean; partial_failure_classes: string[] };
    expect(meta2.completed).toBe(false);
    expect(meta2.partial_failure_classes).toEqual(['caches']);
  });

  it('audit log is append-only (NOT an UPDATE) — both rows exist independently', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    store.__debugForceClearFailure('caches');
    await panicWipe({ store, surface: 'settings' });
    const rows = store.__debugListEmittedAuditRows();
    // First row was the "attempted" record (completed=true OR completed=null per
    // the implementer; this row MUST still exist after the second row writes).
    expect(rows.length).toBe(2);
    expect(rows[0]).not.toBe(rows[1]);
  });
});

// ============================================================================
// F-109 M-109a + G-T19-8 — dynamic caches.keys() enumeration
// ============================================================================

describe('T19 / F-109 M-109a + G-T19-8 — BrowserWipeStore.clearCaches enumerates dynamically', () => {
  it('panic-wipe.ts source uses `caches.keys()` and does NOT hard-code a cache-name array', () => {
    const p = '/home/user/agent-os/apps/web/src/lib/lock/panic-wipe.ts';
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, 'utf8');
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Dynamic enumeration MUST appear (production callsite reads caches.keys()).
    expect(stripped).toMatch(/caches\.keys\(\)/);
    // A literal array of cache-name strings MUST NOT appear (defense-in-depth).
    expect(stripped).not.toMatch(/\[\s*['"]jhsc-(static|api|sw)/);
    expect(stripped).not.toMatch(/CACHE_NAMES\s*=\s*\[/);
  });

  it('BrowserWipeStore.clearCaches clears every cache returned by caches.keys() (jsdom shim)', async () => {
    // The implementer ships a BrowserWipeStore that depends on the global caches API.
    const mod = await import('../../src/lib/lock/wipe-store');
    expect(typeof (mod as { BrowserWipeStore?: unknown }).BrowserWipeStore).toBe('function');
    // Install a tiny jsdom shim for the Cache Storage API.
    const cacheNames = new Set(['cache-a', 'cache-b', 'cache-c']);
    (globalThis as { caches?: unknown }).caches = {
      keys: async () => Array.from(cacheNames),
      delete: async (name: string) => {
        cacheNames.delete(name);
        return true;
      }
    };
    const store = new (mod as { BrowserWipeStore: new () => { clearCaches: (names: readonly string[]) => Promise<{ ok: boolean; failed: readonly string[] }> } }).BrowserWipeStore();
    // The production caller passes the result of caches.keys() to clearCaches.
    const names = await (globalThis as { caches: { keys: () => Promise<string[]> } }).caches.keys();
    const r = await store.clearCaches(names);
    expect(r.ok).toBe(true);
    expect(cacheNames.size).toBe(0);
    // Cleanup.
    delete (globalThis as { caches?: unknown }).caches;
  });
});

// ============================================================================
// F-113 M-113a — post-wipe lockout: second panicWipe() returns no_op
// ============================================================================

describe('T19 / F-113 M-113a — post-wipe lockout', () => {
  it('a second panicWipe() in the same session returns {status: "no_op", reason: "already_wiped"} and emits no second audit row', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/memory-wipe-store');
    const store = new MemoryWipeStore();
    const first = await panicWipe({ store, surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(first.status);
    const auditCountAfterFirst = store.__debugListEmittedAuditRows().length;

    const second = await panicWipe({ store, surface: 'settings' });
    expect(second.status).toBe('no_op');
    expect((second as { reason?: string }).reason).toBe('already_wiped');

    const auditCountAfterSecond = store.__debugListEmittedAuditRows().length;
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });
});

// ============================================================================
// F-115 M-115 — modal copy four-regex contract
// ============================================================================

describe('T19 / F-115 M-115 — panic-wipe modal copy four-regex contract', () => {
  it('catalog modal-body text matches /irreversible|cannot be undone/i', () => {
    const body =
      t('onboarding.panic_wipe_d6.modal_body_what_happens') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_body_what_doesnt') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_residual_risk_callout') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_recovery_reminder');
    expect(body).toMatch(/irreversible|cannot be undone/i);
  });

  it('catalog modal-body text matches /server|committee/i', () => {
    const body =
      t('onboarding.panic_wipe_d6.modal_body_what_happens') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_body_what_doesnt') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_residual_risk_callout') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_recovery_reminder');
    expect(body).toMatch(/server|committee/i);
  });

  it('catalog modal-body text matches /recovery passphrase|recovery sheet/i', () => {
    const body =
      t('onboarding.panic_wipe_d6.modal_body_what_happens') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_body_what_doesnt') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_residual_risk_callout') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_recovery_reminder');
    expect(body).toMatch(/recovery passphrase|recovery sheet/i);
  });

  it('catalog modal-body text matches /co-?chair|invite/i', () => {
    const body =
      t('onboarding.panic_wipe_d6.modal_body_what_happens') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_body_what_doesnt') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_residual_risk_callout') +
      ' ' +
      t('onboarding.panic_wipe_d6.modal_recovery_reminder');
    expect(body).toMatch(/co-?chair|invite/i);
  });

  it('rendered PanicWipeModal body composes all four catalog clauses (regex applied to rendered DOM)', async () => {
    render(PanicWipeModal, { props: { open: true, surface: 'settings', __test_ready_delay_ms: 0 } });
    const modal = screen.getByRole('dialog', { name: /wipe this device/i });
    const text = modal.textContent ?? '';
    expect(text).toMatch(/irreversible|cannot be undone/i);
    expect(text).toMatch(/server|committee/i);
    expect(text).toMatch(/recovery passphrase|recovery sheet/i);
    expect(text).toMatch(/co-?chair|invite/i);
  });
});

// ============================================================================
// Designer §G — panic-wipe state matrix
// ============================================================================

describe('T19 / Designer §G — panic-wipe state matrix', () => {
  it('ready-delay-pending — primary button is aria-disabled and literal-phrase input is keystroke-gated', async () => {
    render(PanicWipeModal, {
      props: { open: true, surface: 'settings', __test_ready_delay_ms: 200 }
    });
    const primary = screen.getByRole('button', { name: t('onboarding.panic_wipe_d6.primary_button_destructive') });
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    // Type into the literal-phrase input — value should NOT update.
    const input = screen.getByRole('textbox', { name: /type WIPE/i });
    fireEvent.input(input, { target: { value: 'WIPE' } });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('ready (awaiting phrase + click) — after ready resolves, the input accepts keystrokes; primary enables when phrase matches', async () => {
    render(PanicWipeModal, {
      props: { open: true, surface: 'settings', __test_ready_delay_ms: 200 }
    });
    advanceBy(210);
    const input = screen.getByRole('textbox', { name: /type WIPE/i });
    fireEvent.input(input, { target: { value: 'WIPE' } });
    expect((input as HTMLInputElement).value).toBe('WIPE');
    const primary = screen.getByRole('button', { name: t('onboarding.panic_wipe_d6.primary_button_destructive') });
    expect(primary.getAttribute('aria-disabled')).toBe('false');
  });

  it('in-progress overlay — role="alert" announces the wipe; spinner OR static-text per reduced-motion', async () => {
    render(PanicWipeModal, {
      props: {
        open: true,
        surface: 'settings',
        __test_ready_delay_ms: 0,
        __test_force_wipe_in_progress: true
      }
    });
    const overlay = screen.getByTestId('panic-wipe-in-progress-overlay');
    expect(overlay.getAttribute('aria-busy')).toBe('true');
    expect(overlay.textContent ?? '').toMatch(/wiping/i);
  });

  it('partial-failure — overlay transitions to error_state with the enumerated failed classes', async () => {
    render(PanicWipeModal, {
      props: {
        open: true,
        surface: 'settings',
        __test_ready_delay_ms: 0,
        __test_force_clear_failure: 'caches',
        __test_auto_submit: true
      }
    });
    advanceBy(50);
    await waitFor(() => {
      const err = document.querySelector('[role="alert"][data-testid="panic-wipe-partial-failure"]');
      expect(err).not.toBeNull();
    });
    const err = document.querySelector('[role="alert"][data-testid="panic-wipe-partial-failure"]')!;
    expect(err.textContent ?? '').toMatch(/caches/i);
  });
});

// ============================================================================
// Designer §G — INVERTED focus ring on panic-overlay
// ============================================================================

describe('T19 / Designer §G — inverted focus ring on panic-overlay', () => {
  it('the in-progress overlay focus ring inner layer is bound to color.{mode}.onboarding.panic_overlay_fg (NOT border.focus)', async () => {
    render(PanicWipeModal, {
      props: {
        open: true,
        surface: 'settings',
        __test_ready_delay_ms: 0,
        __test_force_wipe_in_progress: true
      }
    });
    const overlay = screen.getByTestId('panic-wipe-in-progress-overlay');
    // The overlay carries a data-attribute or CSS variable referencing the
    // panic_overlay_fg token (the implementer encodes the binding so the
    // test can verify the inverted-ring rule without sniffing computed CSS).
    const ring = overlay.getAttribute('data-focus-ring-inner-token') ?? '';
    expect(ring).toMatch(/onboarding\.panic_overlay_fg/);
    // Defensive — explicitly NOT bound to the standard focus ring.
    expect(ring).not.toMatch(/border\.focus/);
  });
});

// ============================================================================
// Type-back value — FIXED to "WIPE" (language-neutral, uppercase)
// ============================================================================

describe('T19 / design-system §3.5 — type-back value is "WIPE"', () => {
  it('the catalog type_back_value === "WIPE" exactly', () => {
    expect(t('onboarding.panic_wipe_d6.type_back_value')).toBe('WIPE');
  });

  it('the type-back placeholder is "WIPE" (uppercase, language-neutral so fr-CA reuses unchanged)', () => {
    expect(t('onboarding.panic_wipe_d6.type_back_placeholder')).toBe('WIPE');
  });
});
