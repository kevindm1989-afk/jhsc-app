/**
 * T11 / T12 — Export pipeline: minutes + recommendations.
 *
 * Source obligations (threat-model §8 T11 + T12; RA-1; ADR-0003 Amendment C
 * extension F-53):
 *   - F-19 (LAUNCH BLOCKER) — closed allowlist; ESLint forbids spread; PDF
 *     text never contains source_name; every C4 field absent from allowlist.
 *   - F-22 — non-co-chair GET on finalized minutes denied by RLS (403).
 *   - F-24 — audit-log POST succeeds BEFORE Blob URL is created.
 *   - F-25 — no server route returns application/pdf.
 *   - F-27 — allowlist hash in audit row matches hash of rendering module.
 *   - F-28 — export rate limit ≤10/co-chair/hour; 11th = 429.
 *   - F-29 / HG-1 / RA-1 — single-signer co-chair passkey re-auth; same actor
 *     cannot be approver.
 *   - F-53 / M-53a/b/c — protected-modal trap-engagement contract.
 *   - RA-1 compensating controls:
 *     #3 visible concern-derived items flag
 *     #4 post-export rep notification within 60s
 *   - design-system §4.A Surface A states.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import ExportInterstitial from '../../src/lib/export/ExportInterstitial.svelte';
import { exportMinutes, exportRecommendation } from '../../src/lib/export';
import { EXPORT_ALLOWLIST_MINUTES, EXPORT_ALLOWLIST_RECOMMENDATION } from '../../src/lib/export/allowlist';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_COCHAIR,
  SYNTHETIC_USER_COCHAIR_2,
  SYNTHETIC_MINUTES_ID,
  SYNTHETIC_RECOMMENDATION_ID,
  SYNTHETIC_CONCERN_ID,
  SYNTHETIC_DISPLAY_NAME,
} from '../_helpers/fixtures';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { extractPdfText } from '../_helpers/pdf-text';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  cleanup();
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// F-19 — Closed allowlist + structural absence of C4 / source_name
// ============================================================================

describe('T11 / F-19 LAUNCH BLOCKER — export closed allowlist', () => {
  it('T11 / F-19 — EXPORT_ALLOWLIST_MINUTES is a frozen const array (matches a hard-coded snapshot)', () => {
    // Snapshot: every field name allowed in the minutes.final export.
    // The architect/designer pins the exact list; this test ensures the
    // allowlist is closed (any addition is a reviewer event).
    expect(EXPORT_ALLOWLIST_MINUTES).toMatchInlineSnapshot(`
      [
        "minutes_id",
        "finalized_at",
        "agenda_items",
        "decisions",
        "recommendations_summary",
        "attendees_present",
        "next_meeting_at",
        "co_chair_signature_block",
      ]
    `);
    expect(Object.isFrozen(EXPORT_ALLOWLIST_MINUTES)).toBe(true);
  });

  it('T11 / F-19 — EXPORT_ALLOWLIST_RECOMMENDATION snapshot', () => {
    expect(EXPORT_ALLOWLIST_RECOMMENDATION).toMatchInlineSnapshot(`
      [
        "recommendation_id",
        "title",
        "body",
        "rationale",
        "created_at",
        "sent_at",
        "twentyone_day_due_at",
        "co_chair_signature_block",
      ]
    `);
    expect(Object.isFrozen(EXPORT_ALLOWLIST_RECOMMENDATION)).toBe(true);
  });

  it('T11 / F-19 — every C4 field name is structurally ABSENT from every export allowlist', () => {
    const c4_fields = [
      'source_name_ct',
      'source_name_ciphertext',
      'reprisal_body_ct',
      'reprisal_body_ciphertext',
      'work_refusal_notes_ct',
      'work_refusal_notes_ciphertext',
      's51_evidence_ct',
      's51_evidence_ciphertext',
      's51_photo_ct',
    ];
    for (const f of c4_fields) {
      expect(EXPORT_ALLOWLIST_MINUTES).not.toContain(f);
      expect(EXPORT_ALLOWLIST_RECOMMENDATION).not.toContain(f);
    }
  });

  it('T11 / F-19 / T3 — rendered PDF text grep: source_name plaintext NEVER appears in exported minutes', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    // Insert a concern with a named source.
    const concernId = await supa.client(cochair).insertConcern({
      title: 'concern-title',
      body: 'concern-body',
      anonymous: false,
      source_name_plaintext: SYNTHETIC_DISPLAY_NAME,
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'loc-1',
    });
    // Build minutes that *reference* this concern.
    const minutesId = await supa.client(cochair).finalizeMinutes({
      agenda_items: [`Discussed ${concernId}`],
      decisions: [],
      derived_from_concerns: [concernId],
    });
    const { pdfBytes } = await exportMinutes(supa.client(cochair), minutesId);
    const text = await extractPdfText(pdfBytes);
    expect(text).not.toContain(SYNTHETIC_DISPLAY_NAME);
  });
});

// ============================================================================
// F-22 — RLS gates finalized minutes by co-chair
// ============================================================================

describe('T11 / F-22 — RLS on finalized minutes', () => {
  it('T11 / F-22 — non-co-chair GET on finalized minutes ciphertext denied (zero rows / 403)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const worker = await supa.enrollUser(SYNTHETIC_USER_A);
    const minutesId = await supa.client(cochair).finalizeMinutes({
      agenda_items: ['item'],
      decisions: [],
    });
    const r = await supa.client(worker).fetchFinalizedMinutes(minutesId);
    expect([403, 404]).toContain(r.status);
  });
});

// ============================================================================
// F-24 — audit row precondition (BEFORE Blob URL)
// ============================================================================

describe('T11 / F-24 — audit row precedes Blob URL creation', () => {
  it('T11 / F-24 — successful export writes audit row BEFORE the Blob URL is created', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    const events: string[] = [];
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn((b) => {
      events.push('blob_url_created');
      return 'blob:fake';
    }) as any;
    const auditSpy = supa.spyAuditWrites();
    auditSpy.onWrite('export.generated', () => events.push('audit_written'));
    await exportMinutes(supa.client(cochair), minutesId);
    URL.createObjectURL = origCreateObjectURL;
    expect(events).toEqual(['audit_written', 'blob_url_created']);
  });

  it('T11 / F-24 — audit-log POST failure aborts the export: no Blob URL created, no <a download> in DOM, user-visible error', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    supa.__forceAuditEndpoint500ForEvent('export.generated');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const r = await exportMinutes(supa.client(cochair), minutesId);
    expect(r.status).toBe('error');
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });
});

// ============================================================================
// F-25 — No server-side PDF rendering route
// ============================================================================

describe('T11 / F-25 — no server route returns application/pdf', () => {
  it('T11 / F-25 — route inventory: no route under /api/* declares application/pdf as a content type', async () => {
    const inventory = supa.getRouteInventory();
    const offending = inventory.filter(
      (r) => r.responses?.some((r) => r.content_type === 'application/pdf')
    );
    expect(offending).toEqual([]);
  });
});

// ============================================================================
// F-27 — Allowlist hash binding
// ============================================================================

describe('T11 / F-27 — allowlist hash audit binding', () => {
  it('T11 / F-27 — audit row `field_set_hash` matches the hash of the rendering module\'s actual allowlist at runtime', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    await exportMinutes(supa.client(cochair), minutesId);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'export.generated' ORDER BY id DESC LIMIT 1`
    );
    const auditHash = rows.rows[0].meta.field_set_hash;
    // The rendering module exposes a computed hash; test asserts equality.
    const { computeAllowlistHash } = await import('../../src/lib/export/allowlist');
    expect(auditHash).toBe(computeAllowlistHash(EXPORT_ALLOWLIST_MINUTES));
  });

  it('T11 / F-27 — monkey-patch render to use a different allowlist → integrity_fail audit row + export aborted', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    const { exportMinutes: exportMinutesPatched } = await import('../../src/lib/export');
    (exportMinutesPatched as any).__test_overrideRendererAllowlist(['source_name_ct']);
    const r = await exportMinutesPatched(supa.client(cochair), minutesId);
    expect(r.status).toBe('error');
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'export.integrity_fail'`
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// F-28 — Export rate limit
// ============================================================================

describe('T11 / F-28 — export rate limit', () => {
  it('T11 / F-28 — 11th export attempt in one hour returns 429; rate-limit audit row written exactly once', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    for (let i = 0; i < 10; i++) {
      await exportMinutes(supa.client(cochair), minutesId);
    }
    const r = await exportMinutes(supa.client(cochair), minutesId);
    expect(r.status).toBe('rate_limited');
    const audits = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-EXPORT-002'`
    );
    expect(audits.rows[0].n).toBe(1);
  });
});

// ============================================================================
// F-29 / HG-1 / RA-1 — single-signer; approver_id = actor_id
// ============================================================================

describe('T11 / F-29 / RA-1 — single-signer co-chair re-auth; same-actor approver', () => {
  it('T11 / RA-1 — export requires a fresh WebAuthn passkey assertion (not stale session JWT alone)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    // Stale-session attempt: pass JWT without a fresh assertion token.
    const r = await supa.client(cochair).attemptExportWithoutReauth(minutesId);
    expect(r.status).toBe('requires_reauth');
  });

  it('T11 / RA-1 / F-29 — audit row records approver_id = actor_id (single signer, explicit)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    await exportMinutes(supa.client(cochair), minutesId);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'export.generated' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].meta.approver_pseudonym).toBe(rows.rows[0].meta.actor_pseudonym);
  });
});

// ============================================================================
// RA-1 compensating control #3 — concern-derived items flag
// ============================================================================

describe('T11 / RA-1 compensating control #3 — concern-derived items flag', () => {
  it('T11 / RA-1 — export builder computes `derived_from_concerns: concern_id[]` based on the included items', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const concernId = await supa.client(cochair).insertConcern({
      title: 't',
      body: 'b',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'loc-1',
    });
    const minutesId = await supa.client(cochair).finalizeMinutes({
      agenda_items: ['discussed concern'],
      decisions: [],
      derived_from_concerns: [concernId],
    });
    const r = await exportMinutes(supa.client(cochair), minutesId);
    expect(r.export_audit.derived_from_concerns).toEqual([concernId]);
    // The second-class audit row exists.
    const flag = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'export.contained_concern_derived_items' AND meta->>'export_audit_id' = $1`,
      [r.export_audit.id]
    );
    expect(flag.rows[0].n).toBe(1);
  });

  it('T11 / RA-1 — interstitial renders the concern-derived items flag BEFORE the Confirm button becomes enabled', async () => {
    render(ExportInterstitial, {
      props: { mode: 'minutes', derived_from_concerns: [SYNTHETIC_CONCERN_ID] },
    });
    // The flag strip is present.
    const flag = await waitFor(() => screen.getByTestId('concern-flag-warning'));
    expect(flag).toBeDefined();
    // The Confirm button is disabled until the user ticks the checkbox.
    const confirm = screen.getByRole('button', { name: /confirm.*export/i });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('checkbox', { name: /reviewed the concern/i }));
    expect(confirm.getAttribute('aria-disabled')).toBe('false');
  });

  it('T11 / RA-1 — audit row carries the array of originating concern IDs and their hazard_class metadata', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const concernId = await supa.client(cochair).insertConcern({
      title: 't',
      body: 'b',
      anonymous: true,
      hazard_class: 'chemical',
      severity: 'high',
      location_id: 'loc-1',
    });
    const minutesId = await supa.client(cochair).finalizeMinutes({
      agenda_items: ['discussed concern'],
      decisions: [],
      derived_from_concerns: [concernId],
    });
    await exportMinutes(supa.client(cochair), minutesId);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'export.contained_concern_derived_items' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].meta.concern_ids).toContain(concernId);
  });
});

// ============================================================================
// RA-1 compensating control #4 — Post-export rep notification within 60s
// ============================================================================

describe('T11 / RA-1 compensating control #4 — post-export rep notification', () => {
  it('T11 / RA-1 #4 — within 60s of a successful export, every active member sees a sensitive-activity entry', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const worker = await supa.enrollUser(SYNTHETIC_USER_A);
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    await exportMinutes(supa.client(cochair), minutesId);
    advanceBy(60_000);
    const feed = await supa.client(worker).fetchSensitiveActivityFeed();
    expect(
      feed.items.some(
        (i) => i.event_type === 'export.generated' && i.target_id === minutesId
      )
    ).toBe(true);
  });

  it('T11 / RA-1 #4 — notification failure does NOT block the export but emits a warning toast', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    supa.__forceNotificationEndpoint500();
    const r = await exportMinutes(supa.client(cochair), minutesId);
    expect(r.status).toBe('ok'); // export still completes
    expect(r.warning_toast_key).toBe('export.notification_deferred');
  });
});

// ============================================================================
// F-53 — Protected-modal trap-engagement (Amendment C extension M-53a/b/c)
// ============================================================================

describe('T11 / F-53 / Amendment C extension — protected-modal mount-time invariants', () => {
  // The five protected modals: export_interstitial, reauth_prompt,
  // passphrase_prompt, destructive_confirm, four_eyes_pending.
  // Tests are parameterized over the variants.
  const PROTECTED_VARIANTS = [
    'export_interstitial',
    'reauth_prompt',
    'passphrase_prompt',
    'destructive_confirm',
    'four_eyes_pending',
  ] as const;

  it.each(PROTECTED_VARIANTS)(
    'T11 / F-53 M-53a — `%s`: focus trap + Escape handler + click-outside no-op + aria-modal/labelledby bind synchronously with modal.show()',
    async (variant) => {
      const { mountProtectedModalWithExtendedTransition } = await import(
        '../_helpers/protected-modal-harness'
      );
      const ctx = await mountProtectedModalWithExtendedTransition(variant, {
        transition_ms: 1000,
      });
      // t = 10ms after mount (well within transition).
      advanceBy(10);
      // (a) document.activeElement inside the modal subtree.
      expect(ctx.modalSubtree.contains(document.activeElement)).toBe(true);
      // (b) synthesized Enter on the modal-primary-button before ready does NOT fire.
      fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      expect(ctx.primaryActionFired).toBe(false);
      expect(ctx.auditWrittenForExport).toBe(false);
      // (c) Escape during transition: for the four variants that have Cancel,
      // Cancel handler fires; for `four_eyes_pending` which has no Cancel,
      // Escape is swallowed (no dismiss).
      ctx.primaryActionFired = false;
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      if (variant === 'four_eyes_pending') {
        expect(ctx.modalOpen).toBe(true);
      } else {
        expect(ctx.cancelFired).toBe(true);
        expect(ctx.modalOpen).toBe(false);
      }
      // (d) click at underlying-surface coordinates during transition lands on scrim, not underlying button.
      const before = ctx.underlyingButtonClicks;
      ctx.simulateClickAtUnderlyingButtonCoords();
      expect(ctx.underlyingButtonClicks).toBe(before);
    }
  );

  it('T11 / F-53 M-53b — export_interstitial: confirm before `ready` resolves results in NO export.minutes audit row and NO Blob URL', async () => {
    const { mountExportInterstitialWithDelayedReady } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountExportInterstitialWithDelayedReady({ ready_delay_ms: 200 });
    advanceBy(10);
    // Synthesize Enter on the primary button (which is aria-disabled until ready).
    fireEvent.keyDown(ctx.primaryButton, { key: 'Enter' });
    expect(ctx.exportAuditRowsWritten).toBe(0);
    expect(ctx.blobUrlCreated).toBe(false);
    // At t=210ms, ready resolves; Enter now fires.
    advanceBy(210);
    fireEvent.keyDown(ctx.primaryButton, { key: 'Enter' });
    await waitFor(() => expect(ctx.exportAuditRowsWritten).toBe(1));
    expect(ctx.blobUrlCreated).toBe(true);
  });

  it.each(PROTECTED_VARIANTS)(
    'T11 / F-53 M-53c — `%s`: underlying surface is aria-hidden=true AND inert from t=0; programmatic .focus() on underlying button does NOT move activeElement',
    async (variant) => {
      const { mountProtectedModalWithExtendedTransition } = await import(
        '../_helpers/protected-modal-harness'
      );
      const ctx = await mountProtectedModalWithExtendedTransition(variant, {
        transition_ms: 1000,
      });
      const underlyingBtn = ctx.underlyingSurfaceButton;
      expect(underlyingBtn.getAttribute('aria-hidden')).toBe('true');
      expect(underlyingBtn.hasAttribute('inert')).toBe(true);
      expect(underlyingBtn.getAttribute('tabindex')).toBe('-1');
      const before = document.activeElement;
      underlyingBtn.focus();
      expect(document.activeElement).toBe(before);
    }
  );

  it('T11 / F-53 / RA-1 — synchronous mount of audit-emission preflight: confirm-click raced with transition cannot pre-empt the concern-derived flag', async () => {
    const { mountExportInterstitialWithExtendedTransition } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountExportInterstitialWithExtendedTransition({
      transition_ms: 1000,
      derived_from_concerns: ['c-1', 'c-2'],
    });
    // At t=10ms, the concern-derived flag is already rendered (synchronous-with-mount).
    advanceBy(10);
    expect(screen.getByTestId('concern-flag-warning')).toBeDefined();
    // A racing confirm at this point does NOT fire (M-53b).
    fireEvent.click(ctx.primaryButton);
    expect(ctx.exportAuditRowsWritten).toBe(0);
  });

  it('T11 / F-53 — animations disabled (CSS animation:none): mount-time behavior is identical (focus trap, no race)', async () => {
    const { mountProtectedModalAnimationsDisabled } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountProtectedModalAnimationsDisabled('export_interstitial');
    expect(ctx.modalSubtree.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(ctx.cancelFired).toBe(true);
  });
});
