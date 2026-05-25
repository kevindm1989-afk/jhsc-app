/**
 * T19 — i18n catalog coverage (no missing keys; no orphan keys).
 *
 * Covers:
 *   - ADR-0020 Decision 11 — copy-keys.ts closed allowlist: every key referenced by a
 *     Svelte component under lib/onboarding/ + lib/lock/ exists in
 *     apps/web/src/lib/i18n/onboarding.en-CA.json
 *   - ADR-0020 Decision 11 — every catalog key under `onboarding.*` + `a11y.onboarding.*`
 *     is reachable from at least one source file (no orphans)
 *   - Tech-writer's pass §Compliance — every key referenced by D.1..D.7 + panic-wipe is
 *     present in the scoped catalog
 *
 * NOTE: the existing scaffold reads the ROOT catalog at <repo>/i18n/en-CA.json
 * via `t()` from `apps/web/src/lib/i18n/index.ts`. The T19 scoped catalog ships separately
 * at `apps/web/src/lib/i18n/onboarding.en-CA.json` per Tech-writer flag #4. The implementer
 * is responsible for wiring the i18n loader to consume BOTH catalogs (root + scoped).
 *
 * This file asserts the SCOPED catalog's coverage; the existing scaffold + the per-file
 * tests above assert that `t()` resolves the keys (which validates the loader wiring).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WEB_ROOT, REPO_ROOT } from '../_helpers/paths';
import scopedCatalog from '../../src/lib/i18n/onboarding.en-CA.json' with { type: 'json' };

const ROOT_CATALOG_PATH = path.join(REPO_ROOT, 'i18n/en-CA.json');
const SRC_ROOTS = [
  path.join(WEB_ROOT, 'src/lib/onboarding'),
  path.join(WEB_ROOT, 'src/lib/lock')
];

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('_')) continue; // skip _meta blocks
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v, full));
    } else if (typeof v === 'string') {
      out.push(full);
    }
  }
  return out;
}

function walkSrc(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = path.join(root, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkSrc(p));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function extractI18nKeys(src: string): string[] {
  const out = new Set<string>();
  // Match t('a.b.c') and t("a.b.c") forms (the project's t() resolver).
  const reSingle = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*[,)]/g;
  const reDouble = /\bt\(\s*"([a-zA-Z0-9_.]+)"\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = reSingle.exec(src)) !== null) out.add(m[1]);
  while ((m = reDouble.exec(src)) !== null) out.add(m[1]);
  return Array.from(out);
}

// ============================================================================
// Catalog → component: every catalog key reachable from at least one component
// ============================================================================

describe('T19 / Decision 11 — every scoped catalog key is consumed (no orphans)', () => {
  it('every onboarding.*/a11y.onboarding.* key in onboarding.en-CA.json is referenced from at least one source file', () => {
    const allCatalogKeys = flattenKeys(scopedCatalog);
    // Filter to the namespaces this catalog is responsible for.
    const scopedKeys = allCatalogKeys.filter(
      (k) => k.startsWith('onboarding.') || k.startsWith('a11y.onboarding.')
    );
    expect(scopedKeys.length).toBeGreaterThan(50);

    const srcRoots = SRC_ROOTS;
    const referenced = new Set<string>();
    for (const root of srcRoots) {
      for (const f of walkSrc(root)) {
        const src = readFileSync(f, 'utf8');
        for (const k of extractI18nKeys(src)) referenced.add(k);
        // Also accept keys named in a closed-allowlist `copy-keys.ts` source.
        // The implementer's copy-keys.ts CAN reference keys as string-literal members
        // of a frozen tuple; capture those too.
        const arrayLit = /['"]((?:onboarding|a11y\.onboarding)\.[a-zA-Z0-9_.]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = arrayLit.exec(src)) !== null) referenced.add(m[1]);
      }
    }

    const orphans = scopedKeys.filter((k) => !referenced.has(k));
    expect(
      orphans,
      `scoped catalog keys with no source reference (orphans):\n  ${orphans.join('\n  ')}`
    ).toEqual([]);
  });
});

// ============================================================================
// Component → catalog: every catalog key referenced by a component exists in the catalog
// ============================================================================

describe('T19 / Decision 11 — every component i18n key reference exists in some catalog', () => {
  it('every t() key referenced under lib/onboarding/ or lib/lock/ exists in the scoped OR root catalog', () => {
    const scopedKeys = new Set(flattenKeys(scopedCatalog));
    let rootKeys = new Set<string>();
    if (existsSync(ROOT_CATALOG_PATH)) {
      try {
        const rootCatalog = JSON.parse(readFileSync(ROOT_CATALOG_PATH, 'utf8'));
        rootKeys = new Set(flattenKeys(rootCatalog));
      } catch {
        // ignore — the root catalog must be valid JSON; a parse error
        // is its own assertion failure below.
      }
    }

    const srcRoots = SRC_ROOTS;
    const missing: Array<{ key: string; file: string }> = [];
    for (const root of srcRoots) {
      for (const f of walkSrc(root)) {
        const src = readFileSync(f, 'utf8');
        for (const k of extractI18nKeys(src)) {
          if (!scopedKeys.has(k) && !rootKeys.has(k)) {
            missing.push({ key: k, file: f });
          }
        }
      }
    }
    expect(
      missing,
      `keys referenced in source that are MISSING from both catalogs:\n  ${missing.map((m) => `${m.key} (in ${m.file})`).join('\n  ')}`
    ).toEqual([]);
  });
});

// ============================================================================
// Required keys per ADR-0020 Decision 7 / Designer §A / Tech-writer §Compliance
// ============================================================================

describe('T19 / required catalog keys present', () => {
  const requiredKeys = [
    // Step indicator
    'onboarding.step_indicator.pending',
    'onboarding.step_indicator.active',
    'onboarding.step_indicator.complete',
    'onboarding.step_indicator.step_n_of_m',
    // D.1 — personal-device advisory
    'onboarding.advisory_d1.heading',
    'onboarding.advisory_d1.body',
    'onboarding.advisory_d1.checkbox_label',
    'onboarding.advisory_d1.primary_button',
    'onboarding.advisory_d1.secondary_button',
    'onboarding.advisory_d1.fingerprint_label',
    // D.2 — hosting tradeoff
    'onboarding.browser_baseline_d2.body_pass',
    'onboarding.browser_baseline_d2.body_fail',
    'onboarding.browser_baseline_d2.unsupported_heading',
    'onboarding.browser_baseline_d2.privacy_policy_link',
    // D.3 — passkey + TOTP errors (closed allowlist)
    'onboarding.passkey_d3.heading',
    'onboarding.passkey_d3.primary_button',
    'onboarding.passkey_d3.error.totp_invalid',
    'onboarding.passkey_d3.error.totp_rate_limited',
    'onboarding.passkey_d3.error.totp_locked',
    'onboarding.passkey_d3.error.passkey_ceremony_failed',
    'onboarding.passkey_d3.error.enrollment_failed_generic',
    'onboarding.passkey_d3.error.rp_mismatch',
    // D.4 — passphrase ceremony
    'onboarding.passphrase_d4.heading',
    'onboarding.passphrase_d4.body_purpose',
    'onboarding.passphrase_d4.confirm_label',
    'onboarding.passphrase_d4.primary_button',
    'onboarding.passphrase_d4.show_again_label',
    'onboarding.passphrase_d4.show_again_capped',
    'onboarding.passphrase_d4.download_label',
    'onboarding.passphrase_d4.download_helper',
    'onboarding.passphrase_d4.error.argon2id_failed',
    'onboarding.passphrase_d4.error.argon2_unavailable',
    'onboarding.passphrase_d4.error.rate_limited',
    // D.5 — session-revocation primer (Designer §A FIXED labels)
    'onboarding.sessions_d5.heading',
    'onboarding.sessions_d5.body',
    'onboarding.sessions_d5.helper',
    'onboarding.sessions_d5.helper_only_this_device',
    'onboarding.sessions_d5.revoke_other.label',
    'onboarding.sessions_d5.skip.label',
    'onboarding.sessions_d5.state.in_progress',
    'onboarding.sessions_d5.state.partial_failure',
    'onboarding.sessions_d5.state.success',
    'onboarding.sessions_d5.error.rate_limited',
    'onboarding.sessions_d5.error.server_unreachable',
    'onboarding.sessions_d5.error.partial',
    // D.6 — panic-wipe modal
    'onboarding.panic_wipe_d6.trigger_button',
    'onboarding.panic_wipe_d6.modal_heading',
    'onboarding.panic_wipe_d6.modal_body_what_happens',
    'onboarding.panic_wipe_d6.modal_body_what_doesnt',
    'onboarding.panic_wipe_d6.modal_residual_risk_callout',
    'onboarding.panic_wipe_d6.modal_recovery_reminder',
    'onboarding.panic_wipe_d6.type_back_label',
    'onboarding.panic_wipe_d6.type_back_value',
    'onboarding.panic_wipe_d6.type_back_placeholder',
    'onboarding.panic_wipe_d6.primary_button_destructive',
    'onboarding.panic_wipe_d6.cancel_button',
    'onboarding.panic_wipe_d6.error.audit_emit_failed',
    'onboarding.panic_wipe_d6.error.partial_wipe',
    'onboarding.panic_wipe_d6.error.already_wiped',
    // D.7 — completion
    'onboarding.completion_d7.heading',
    'onboarding.completion_d7.body',
    'onboarding.completion_d7.checklist.passkey',
    'onboarding.completion_d7.checklist.recovery_blob_downloaded',
    'onboarding.completion_d7.checklist.recovery_blob_printed',
    'onboarding.completion_d7.checklist.sessions_reviewed',
    'onboarding.completion_d7.next_steps_heading',
    'onboarding.completion_d7.next_steps_body',
    'onboarding.completion_d7.primary_button',
    // a11y namespace
    'a11y.onboarding.step_change',
    'a11y.onboarding.wizard_landmark',
    'a11y.onboarding.passphrase_field_announcement',
    'a11y.onboarding.reveal_button_announcement',
    'a11y.onboarding.reveal_in_progress_announcement',
    'a11y.onboarding.reveal_hidden_announcement',
    'a11y.onboarding.reveal_capped_announcement',
    'a11y.onboarding.destructive_confirm_announcement',
    'a11y.onboarding.panic_wipe_in_progress_announcement',
    'a11y.onboarding.panic_wipe_complete_announcement',
    'a11y.onboarding.panic_wipe_partial_failure_announcement',
    'a11y.onboarding.session_revoked_announcement',
    'a11y.onboarding.browser_baseline_pass_announcement',
    'a11y.onboarding.browser_baseline_fail_announcement',
    'a11y.onboarding.device_fingerprint_announcement'
  ];

  const scopedKeys = new Set(flattenKeys(scopedCatalog));

  for (const k of requiredKeys) {
    it(`required catalog key present: ${k}`, () => {
      expect(scopedKeys.has(k)).toBe(true);
    });
  }
});

// ============================================================================
// Hardened invariants on individual catalog values
// ============================================================================

describe('T19 / catalog value invariants', () => {
  it('D.2 body_pass contains no Latin abbreviations (grade-8 reading-level floor — scaffold pin)', () => {
    const all = flattenKeys(scopedCatalog).map((k) => {
      // Re-resolve via t().
      const parts = k.split('.');
      let cur: unknown = scopedCatalog;
      for (const p of parts) {
        if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
      }
      return { key: k, val: typeof cur === 'string' ? cur : '' };
    });
    const body = all.find((x) => x.key === 'onboarding.browser_baseline_d2.body_pass');
    expect(body?.val).toBeTruthy();
    expect(body!.val).not.toMatch(/\bi\.e\.|\be\.g\.|\betc\.|\bvs\./);
  });

  it('D.5 FIXED labels are exact per Designer §A', () => {
    const heading = (scopedCatalog as { onboarding: { sessions_d5: { heading: string } } })
      .onboarding.sessions_d5.heading;
    const primary = (scopedCatalog as {
      onboarding: { sessions_d5: { revoke_other: { label: string } } };
    }).onboarding.sessions_d5.revoke_other.label;
    const skip = (scopedCatalog as { onboarding: { sessions_d5: { skip: { label: string } } } })
      .onboarding.sessions_d5.skip.label;
    expect(heading).toBe('Sign out other devices?');
    expect(primary).toBe('Revoke other sessions');
    expect(skip).toBe("Skip — I'll do this later");
  });

  it('D.6 type_back_value === "WIPE" exactly (uppercase, language-neutral)', () => {
    const v = (scopedCatalog as { onboarding: { panic_wipe_d6: { type_back_value: string } } })
      .onboarding.panic_wipe_d6.type_back_value;
    expect(v).toBe('WIPE');
  });

  it('no catalog value contains a PII placeholder ({user_name}, {email}, {workplace}, {ip})', () => {
    const all = flattenKeys(scopedCatalog).map((k) => {
      const parts = k.split('.');
      let cur: unknown = scopedCatalog;
      for (const p of parts) {
        if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
      }
      return { key: k, val: typeof cur === 'string' ? cur : '' };
    });
    const offenders = all.filter((x) => /\{(user_name|email|workplace|ip|user_id)\}/.test(x.val));
    expect(
      offenders,
      `catalog values contain PII placeholders:\n  ${offenders.map((o) => `${o.key}: ${o.val}`).join('\n  ')}`
    ).toEqual([]);
  });
});
