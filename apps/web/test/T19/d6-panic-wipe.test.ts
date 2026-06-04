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
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { WEB_ROOT } from '../_helpers/paths';
import { renderPanicWipe, resetTestConfigs } from '../_helpers/render-with-test-config';
import { t } from '../../src/lib/i18n';

const PANIC_WIPE_SOURCE = nodePath.join(WEB_ROOT, 'src/lib/lock/panic-wipe.ts');

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
  resetTestConfigs();
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
    const src = readFileSync(PANIC_WIPE_SOURCE, 'utf8');
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
    const p = PANIC_WIPE_SOURCE;
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
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
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
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 200 });
    const primary = screen.getByRole('button', { name: t('onboarding.panic_wipe_d6.primary_button_destructive') });
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    // Type into the literal-phrase input — value should NOT update.
    const input = screen.getByRole('textbox', { name: /type WIPE/i });
    fireEvent.input(input, { target: { value: 'WIPE' } });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('ready (awaiting phrase + click) — after ready resolves, the input accepts keystrokes; primary enables when phrase matches', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 200 });
    advanceBy(210);
    const input = screen.getByRole('textbox', { name: /type WIPE/i });
    fireEvent.input(input, { target: { value: 'WIPE' } });
    expect((input as HTMLInputElement).value).toBe('WIPE');
    const primary = screen.getByRole('button', { name: t('onboarding.panic_wipe_d6.primary_button_destructive') });
    expect(primary.getAttribute('aria-disabled')).toBe('false');
  });

  it('in-progress overlay — role="alert" announces the wipe; spinner OR static-text per reduced-motion', async () => {
    renderPanicWipe({
      open: true,
      surface: 'settings',
      readyDelayMs: 0,
      forceWipeInProgress: true
    });
    const overlay = screen.getByTestId('panic-wipe-in-progress-overlay');
    expect(overlay.getAttribute('aria-busy')).toBe('true');
    expect(overlay.textContent ?? '').toMatch(/wiping/i);
  });

  it('partial-failure — overlay transitions to error_state with the enumerated failed classes', async () => {
    renderPanicWipe({
      open: true,
      surface: 'settings',
      readyDelayMs: 0,
      forceClearFailure: 'caches',
      autoSubmit: true
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
    renderPanicWipe({
      open: true,
      surface: 'settings',
      readyDelayMs: 0,
      forceWipeInProgress: true
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

// ============================================================================
// A-T19-RR-1 — audit_failed UI branch (BLOCKING)
//
// When panicWipe() returns 'audit_failed', the modal must surface the
// `error.audit_emit_failed` copy inside a role="alert" and must NOT show the
// in-progress overlay or the complete toast (current code leaves
// wipeState='in_progress' forever). The destructive side-effect must not have
// fired. The injected store seam is `__test_store` (panicWipe uses it).
// ============================================================================

describe('T19 / A-T19-RR-1 — audit_failed UI branch', () => {
  async function renderWithFailingAuditStore() {
    const { MemoryWipeStore } = await import('../../src/lib/lock/wipe-store');
    const store = new MemoryWipeStore();
    store.__debugForceAuditFailure();
    renderPanicWipe({
      open: true,
      surface: 'settings',
      readyDelayMs: 0,
      store
    });
    const input = screen.getByRole('textbox', { name: /type WIPE/i });
    fireEvent.input(input, { target: { value: 'WIPE' } });
    const primary = screen.getByRole('button', {
      name: t('onboarding.panic_wipe_d6.primary_button_destructive')
    });
    await fireEvent.click(primary);
    return store;
  }

  it('renders the error.audit_emit_failed copy inside a role="alert" after a failing-audit confirm', async () => {
    await renderWithFailingAuditStore();
    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(
        alert,
        'expected a role="alert" element after audit_failed; modal must not stay in_progress'
      ).not.toBeNull();
      expect(alert!.textContent ?? '').toContain(
        t('onboarding.panic_wipe_d6.error.audit_emit_failed')
      );
    });
  });

  it('does NOT render the in-progress overlay after audit_failed', async () => {
    await renderWithFailingAuditStore();
    await waitFor(() => {
      // settle: the alert must be present before we assert the overlay is gone.
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(
      screen.queryByTestId('panic-wipe-in-progress-overlay'),
      'in-progress overlay must be cleared once panicWipe resolves audit_failed'
    ).toBeNull();
  });

  it('does NOT render the complete toast after audit_failed', async () => {
    await renderWithFailingAuditStore();
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(
      screen.queryByTestId('panic-wipe-complete-toast'),
      'complete toast must not appear when the audit emit failed'
    ).toBeNull();
  });

  it('did NOT perform the destructive side-effect (no databases cleared, localStorage untouched)', async () => {
    const store = await renderWithFailingAuditStore();
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(store.__debugListClearedDatabases()).toEqual([]);
    expect(store.__debugListClearedCaches()).toEqual([]);
    expect(store.__debugLocalStorageCleared()).toBe(false);
    expect(store.__debugSessionStorageCleared()).toBe(false);
    expect(store.__debugSessionCookieTornDown()).toBe(false);
  });

  // WCAG 2.4.3 — the destructive button that held focus unmounts on the
  // idle→audit_failed transition; focus must move to the audit_failed Cancel,
  // not be stranded on a detached node / dropped to <body>.
  it('moves focus to the audit_failed Cancel button (focus not orphaned)', async () => {
    await renderWithFailingAuditStore();
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    });
    const cancel = screen.getByRole('button', {
      name: t('onboarding.panic_wipe_d6.cancel_button')
    });
    await waitFor(() => {
      expect(
        document.activeElement,
        'focus must land on the audit_failed Cancel button, not <body>'
      ).toBe(cancel);
    });
  });
});

// ============================================================================
// A-T19-RR-2 — Cancel closes + focus restore + close announcement (BLOCKING)
// ============================================================================

describe('T19 / A-T19-RR-2 — Cancel: close, focus restore, announcement', () => {
  it('(a) clicking Cancel removes the role="dialog" from the DOM', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    const cancel = screen.getByRole('button', {
      name: t('onboarding.panic_wipe_d6.cancel_button')
    });
    await fireEvent.click(cancel);
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog'),
        'dialog must be removed from the DOM after Cancel (open=false)'
      ).toBeNull();
    });
  });

  it('(a) clicking Cancel dispatches a `close` CustomEvent', async () => {
    const { component } = renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
    let closeFired = false;
    component.$on('close', () => {
      closeFired = true;
    });
    const cancel = screen.getByRole('button', {
      name: t('onboarding.panic_wipe_d6.cancel_button')
    });
    await fireEvent.click(cancel);
    await waitFor(() => {
      expect(closeFired, 'Cancel must dispatch a `close` event').toBe(true);
    });
  });

  it('(b) closing via Cancel restores focus to the trigger that opened the modal', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
    // Opening moves focus into the dialog (away from the trigger).
    await waitFor(() => {
      expect(document.activeElement).not.toBe(trigger);
    });

    const cancel = screen.getByRole('button', {
      name: t('onboarding.panic_wipe_d6.cancel_button')
    });
    await fireEvent.click(cancel);

    await waitFor(() => {
      expect(
        document.activeElement,
        'focus must be restored to the opener trigger after Cancel'
      ).toBe(trigger);
    });
    trigger.remove();
  });

  it('(c) after Cancel, an aria-live region (surviving unmount) announces the close', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
    const cancel = screen.getByRole('button', {
      name: t('onboarding.panic_wipe_d6.cancel_button')
    });
    await fireEvent.click(cancel);
    await waitFor(() => {
      const live = Array.from(document.querySelectorAll('[aria-live]')).find((el) =>
        (el.textContent ?? '').includes(t('a11y.onboarding.modal_close_announcement'))
      );
      expect(
        live,
        'a surviving aria-live region must announce the close after Cancel'
      ).not.toBeUndefined();
    });
  });

  it('(regression guard) pressing Escape does NOT close the dialog (§3.5 — Escape is inert)', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
    const dialog = screen.getByRole('dialog');
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog'),
      'Escape must be inert — dialog stays in the DOM'
    ).not.toBeNull();
  });
});

// ============================================================================
// A11Y-T19-2 — modal focus trap: Tab / Shift+Tab cycle within the dialog
// (WCAG 2.1.2 / 2.4.3 — the focus-trap WRAP logic in onKeyDown). Previously
// only the focus-restore and audit-failed focus-move paths were tested.
// ============================================================================

describe('T19 / A11Y-T19-2 — focus trap wraps Tab / Shift+Tab', () => {
  const FOCUSABLE_SEL =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusablesIn(dialog: HTMLElement): HTMLElement[] {
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)).filter(
      (el) => !el.hasAttribute('aria-hidden')
    );
  }

  // Mount the modal and wait until the deferred onOpenFocus() has settled
  // initial focus onto the first focusable (the type-back input). Doing this
  // first prevents that late .focus() from stealing focus mid-test.
  async function mountReady(): Promise<HTMLElement[]> {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0 });
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(focusablesIn(dialog).length).toBeGreaterThanOrEqual(2));
    const focusables = focusablesIn(dialog);
    await waitFor(() => expect(document.activeElement).toBe(focusables[0]));
    return focusables;
  }

  it('Tab on the last focusable wraps to the first', async () => {
    const focusables = await mountReady();
    const dialog = screen.getByRole('dialog');
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(
      document.activeElement,
      'Tab on the last focusable must wrap focus to the first (trap)'
    ).toBe(first);
  });

  it('Shift+Tab on the first focusable wraps to the last', async () => {
    const focusables = await mountReady();
    const dialog = screen.getByRole('dialog');
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);
    await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(
      document.activeElement,
      'Shift+Tab on the first focusable must wrap focus to the last (trap)'
    ).toBe(last);
  });

  it('Tab in the middle of the focus ring does not force a wrap', async () => {
    const focusables = await mountReady();
    const dialog = screen.getByRole('dialog');
    if (focusables.length < 3) return; // needs an interior element to exercise
    const middle = focusables[1];

    middle.focus();
    expect(document.activeElement).toBe(middle);
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    // The handler only intervenes at the boundaries; a mid-ring Tab leaves
    // focus untouched (the browser would advance it natively).
    expect(document.activeElement).toBe(middle);
  });
});

// ============================================================================
// A-T19-RR-3 — re-onboard lockout reset (MEDIUM)
//
// Contract pinned (see test-writer report for the softened scope):
//   1. fresh-store regression guard: completed → no_op on the same store.
//   2. `resetPanicWipeLockout` is an EXPORTED, production-callable function
//      (renamed from `__resetPanicWipeLockoutForTest`) and is no-throw /
//      idempotent. Full default-singleton re-onboard coverage needs a
//      default-store success seam that does not yet exist (BrowserWipeStore
//      audit always fails), so that branch is NOT pinned here.
// ============================================================================

describe('T19 / A-T19-RR-3 — re-onboard lockout reset', () => {
  it('(regression guard) fresh store: first wipe completes, second on the same store is no_op', async () => {
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    const { MemoryWipeStore } = await import('../../src/lib/lock/wipe-store');
    const store = new MemoryWipeStore();
    const first = await panicWipe({ store, surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(first.status);
    const second = await panicWipe({ store, surface: 'settings' });
    expect(second.status).toBe('no_op');
    expect((second as { reason?: string }).reason).toBe('already_wiped');
  });

  it('exports `resetPanicWipeLockout` (production name, NOT the __...ForTest alias)', async () => {
    const mod = await import('../../src/lib/lock/panic-wipe');
    expect(
      typeof (mod as { resetPanicWipeLockout?: unknown }).resetPanicWipeLockout,
      'resetPanicWipeLockout must be exported as a production-callable function'
    ).toBe('function');
  });

  it('`resetPanicWipeLockout` is idempotent / no-throw (callable repeatedly with no args)', async () => {
    const mod = (await import('../../src/lib/lock/panic-wipe')) as {
      resetPanicWipeLockout: () => void;
    };
    expect(() => {
      mod.resetPanicWipeLockout();
      mod.resetPanicWipeLockout();
    }).not.toThrow();
  });
});
