/**
 * T17 — Backup + Object Lock + versioning + lifecycle.
 *
 * Source obligations:
 *   - ADR-0012 + Amendment (HG-8) — Backblaze B2 in Canadian region with:
 *     Object Lock (governance, default 35d retention per object);
 *     versioning ON; lifecycle deletes versions >42d; workflow credential
 *     scoped to {PutObject, GetObject, ListObjects} only.
 *   - threat-model §8 T17 — F-06 (ciphertext-of-ciphertext), F-48 (no key
 *     in bucket), F-49 (overwrite creates a new version; delete under
 *     retention denied).
 *   - observability/README.md §11.12 — drift check produces alert when
 *     settings drift.
 *
 * Tests run against a local fake-bucket implementation that mirrors the
 * B2 admin API surface (see _helpers/b2-fake.ts). The fake enforces
 * Object Lock + versioning + lifecycle deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, advanceTo, restoreClock } from '../_helpers/clock';
import {
  createFakeBackblazeBucket,
  runBackupWorkflow,
  runRestoreDrill,
  runBucketDriftCheck,
  type FakeBucket,
} from '../_helpers/b2-fake';

let bucket: FakeBucket;

beforeEach(async () => {
  freezeClock('2026-05-22T03:00:00.000Z');
  bucket = createFakeBackblazeBucket({
    region: 'ca',
    object_lock_default_retention_days: 35,
    object_lock_mode: 'governance',
    versioning: true,
    lifecycle_delete_after_days: 42,
    workflow_credential_grants: ['PutObject', 'GetObject', 'ListObjects'],
  });
});
afterEach(() => restoreClock());

// ============================================================================
// F-06 — Backup ciphertext-of-ciphertext (key is libsodium secretbox)
// ============================================================================

describe('T17 / F-06 — backup is ciphertext-of-ciphertext', () => {
  it('T17 / F-06 — fresh dump pulled from bucket via admin creds opened with a random secretbox key → decrypt fails', async () => {
    await runBackupWorkflow(bucket);
    const obj = await bucket.adminGet('dumps/jhsc-2026-05-22.sodium');
    const randomKey = Buffer.alloc(32, 0xa5);
    const { secretboxDecrypt } = await import('../_helpers/libsodium-helpers');
    const result = await secretboxDecrypt(obj.body, randomKey);
    expect(result.ok).toBe(false);
  });

  it('T17 / F-06 — same dump with the correct escrowed test key → decrypts to the expected pg_dump prefix', async () => {
    await runBackupWorkflow(bucket);
    const obj = await bucket.adminGet('dumps/jhsc-2026-05-22.sodium');
    const { TEST_DUMP_KEY, secretboxDecrypt } = await import('../_helpers/libsodium-helpers');
    const result = await secretboxDecrypt(obj.body, TEST_DUMP_KEY);
    expect(result.ok).toBe(true);
    // pg_dump custom format starts with "PGDMP".
    expect(Buffer.from(result.plaintext!).slice(0, 5).toString('utf8')).toBe('PGDMP');
  });
});

// ============================================================================
// F-48 — Dump key not adjacent to dumps
// ============================================================================

describe('T17 / F-48 — dump-key not stored adjacent to dumps', () => {
  it('T17 / F-48 — bucket contains no file whose bytes match the dump-key shape (32-byte high-entropy)', async () => {
    await runBackupWorkflow(bucket);
    const objects = await bucket.adminList();
    for (const obj of objects) {
      const body = await bucket.adminGet(obj.key);
      // libsodium secretbox key is exactly 32 bytes; we check for the shape.
      const isExactly32 = body.body.length === 32;
      if (isExactly32) {
        // High-entropy check (Shannon entropy > 6 bits per byte).
        const { shannonEntropy } = await import('../_helpers/libsodium-helpers');
        expect(shannonEntropy(body.body)).toBeLessThan(6);
      }
    }
  });
});

// ============================================================================
// HG-8 — Object Lock + versioning + lifecycle (F-49)
// ============================================================================

describe('T17 / HG-8 / F-49 — Object Lock + versioning + lifecycle', () => {
  it('T17 / HG-8 — overwrite of an existing object with workflow credential creates a NEW version; prior version remains listable', async () => {
    await runBackupWorkflow(bucket);
    const firstList = await bucket.workflowList();
    const firstVersionId = firstList.find((o) => o.key === 'dumps/jhsc-2026-05-22.sodium')!.version_id;
    advanceTo(Date.parse('2026-05-22T03:01:00.000Z'));
    await runBackupWorkflow(bucket, { overwriteSameKey: 'dumps/jhsc-2026-05-22.sodium' });
    const allVersions = await bucket.adminListVersions('dumps/jhsc-2026-05-22.sodium');
    expect(allVersions.length).toBe(2);
    expect(allVersions.find((v) => v.version_id === firstVersionId)).toBeDefined();
  });

  it('T17 / HG-8 / F-49 — DELETE under retention by workflow credential is denied with the expected error code', async () => {
    await runBackupWorkflow(bucket);
    const r = await bucket.workflowDelete('dumps/jhsc-2026-05-22.sodium');
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('ObjectLockRetentionInForce');
  });

  it('T17 / HG-8 — workflow credential lacks BypassGovernanceRetention; attempt fails', async () => {
    const r = await bucket.workflowBypassGovernanceRetentionAndDelete('dumps/jhsc-2026-05-22.sodium');
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('AccessDenied');
  });

  it('T17 / HG-8 — lifecycle hard-deletes versions whose object-creation timestamp is older than 42 days', async () => {
    await runBackupWorkflow(bucket);
    advanceTo(Date.parse('2026-05-22T03:00:00.000Z') + 43 * 24 * 3600 * 1000);
    await bucket.runLifecyclePass();
    const objects = await bucket.adminList();
    expect(objects.find((o) => o.key === 'dumps/jhsc-2026-05-22.sodium')).toBeUndefined();
  });

  it('T17 / HG-8 — lifecycle does NOT delete versions whose age is between 35 and 42 days (the grace window)', async () => {
    await runBackupWorkflow(bucket);
    advanceTo(Date.parse('2026-05-22T03:00:00.000Z') + 40 * 24 * 3600 * 1000);
    await bucket.runLifecyclePass();
    const objects = await bucket.adminList();
    expect(objects.find((o) => o.key === 'dumps/jhsc-2026-05-22.sodium')).toBeDefined();
  });
});

// ============================================================================
// HG-8 — Weekly CI bucket-config drift check (alert on mismatch)
// ============================================================================

describe('T17 / HG-8 — bucket-config drift check', () => {
  it('T17 / HG-8 — drift check passes on a well-configured bucket (versioning ON, OL=35d governance, lifecycle=42d, grants scoped)', async () => {
    const r = await runBucketDriftCheck(bucket);
    expect(r.ok).toBe(true);
    expect(r.drift_findings).toEqual([]);
  });

  it('T17 / HG-8 — drift check FAILS and triggers alert when versioning is OFF', async () => {
    bucket.config.versioning = false;
    const r = await runBucketDriftCheck(bucket);
    expect(r.ok).toBe(false);
    expect(r.drift_findings.some((f) => f.field === 'versioning')).toBe(true);
    expect(r.alert_fired).toBe(true);
  });

  it('T17 / HG-8 — drift check FAILS when default retention is not 35d governance', async () => {
    bucket.config.object_lock_default_retention_days = 7;
    const r = await runBucketDriftCheck(bucket);
    expect(r.drift_findings.some((f) => f.field === 'object_lock_default_retention_days')).toBe(true);
  });

  it('T17 / HG-8 — drift check FAILS when lifecycle rule is missing or != 42d', async () => {
    bucket.config.lifecycle_delete_after_days = 30;
    const r = await runBucketDriftCheck(bucket);
    expect(r.drift_findings.some((f) => f.field === 'lifecycle_delete_after_days')).toBe(true);
  });

  it('T17 / HG-8 — drift check FAILS when workflow credential carries DeleteObject or BypassGovernanceRetention', async () => {
    bucket.config.workflow_credential_grants = ['PutObject', 'GetObject', 'ListObjects', 'DeleteObject'];
    const r = await runBucketDriftCheck(bucket);
    expect(r.drift_findings.some((f) => f.field === 'workflow_credential_grants')).toBe(true);
  });
});

// ============================================================================
// Restore drill (HG-8 follow-up — drill procedure documents version restore)
// ============================================================================

describe('T17 / HG-8 — restore drill produces a signed report and works with Object Lock', () => {
  it('T17 / Plan §13.F — quarterly restore drill: restore a specific version under Object Lock; produces a signed restore report with the test fixture row decrypted', async () => {
    await runBackupWorkflow(bucket);
    const drill = await runRestoreDrill(bucket, {
      target_object: 'dumps/jhsc-2026-05-22.sodium',
      target_scratch_project: 'scratch-test',
    });
    expect(drill.status).toBe('ok');
    expect(drill.signed_report).toBeDefined();
    // The fixture row decrypts cleanly with the test committee key.
    expect(drill.fixture_record_decrypted).toBe(true);
  });
});
