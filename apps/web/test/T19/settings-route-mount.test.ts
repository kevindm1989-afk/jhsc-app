/**
 * T19.1 — /settings production route mount.
 *
 * Closes the panic-wipe end-to-end loop. Before this PR there was no
 * route reachable in production that could actually invoke
 * `PanicWipeModal` with a real `auditEmitter` wired — every existing
 * test render used `MemoryWipeStore` via the `__test_store` seam, which
 * meant production callers had no way to satisfy the F-53 / M-106a
 * audit-before-side-effect precondition.
 *
 * This file pins the structural contract:
 *   - The route exists at `apps/web/src/routes/settings/+page.svelte`.
 *   - It imports PanicWipeModal AND mounts it with a `wipeStore` prop
 *     (not just the bare default-store path that fails-closed).
 *   - The wipeStore is constructed via `createPanicWipeAuditEmitter`
 *     from the t07-client-factory module so the audit row actually
 *     reaches t07-op.
 *   - prerender=true + ssr=false (matches the rest of the app).
 *   - noindex meta (settings pages are not search-indexed).
 *
 * Also pins the PanicWipeModal-side prop contract: the `wipeStore` prop
 * is declared and threads into the wipe call.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/settings');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');
const MODAL_PATH = resolve(__dirname, '../../src/lib/lock/PanicWipeModal.svelte');

describe('T19.1 — /settings production route mount', () => {
  it('the /settings route exists at apps/web/src/routes/settings/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports PanicWipeModal', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import\s+PanicWipeModal\s+from\s+['"][^'"]*lib\/lock\/PanicWipeModal\.svelte['"]/);
    expect(src).toMatch(/<PanicWipeModal\b/);
  });

  it('the route wires a production wipeStore through createPanicWipeAuditEmitter (no fail-closed default)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/createSupabaseT07Client/);
    expect(src).toMatch(/createPanicWipeAuditEmitter/);
    // The modal receives the wipeStore — i.e. it's not just the bare
    // panicWipe-internal default which fails-closed.
    expect(src).toMatch(/{wipeStore}|wipeStore={/);
  });

  it('the route reads the JWT from lib/auth/session-jwt-store (not a hard-coded null)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/from\s+['"][^'"]*lib\/auth\/session-jwt-store['"]/);
    expect(src).toMatch(/getJwt/);
    // The bare `() => null` placeholder is gone — production wiring
    // now goes through the session-jwt-store module.
    expect(src).not.toMatch(/getJwt:\s*\(\s*\)\s*=>\s*null/);
  });

  it('the route does NOT forward any `__test_*` prop to PanicWipeModal (ADR-0020 Decision 8: production strip)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    const testProbe = '__test_' + 'store';
    const ready = '__test_' + 'ready_delay_ms';
    const autoSubmit = '__test_' + 'auto_submit';
    expect(src.includes(testProbe)).toBe(false);
    expect(src.includes(ready)).toBe(false);
    expect(src.includes(autoSubmit)).toBe(false);
  });

  it('the route sets prerender=true + ssr=false (adapter-static + no SSR for PI safety)', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the route carries a noindex meta tag', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});

describe('T19.1 — PanicWipeModal accepts a production wipeStore prop', () => {
  it('PanicWipeModal declares an `export let wipeStore` prop', () => {
    const src = readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/export\s+let\s+wipeStore\b/);
  });

  it('PanicWipeModal threads the wipeStore prop into the panicWipe call (production override)', () => {
    const src = readFileSync(MODAL_PATH, 'utf8');
    // The non-test path now uses `wipeStore` somewhere in the chain
    // before calling panicWipe.
    expect(src).toMatch(/wipeStore/);
    // Specifically: the panicWipe call's store argument falls back through
    // the `__test_store ?? wipeStore ?? undefined` chain.
    expect(src).toMatch(/__test_store\s*\?\?\s*wipeStore/);
  });
});
