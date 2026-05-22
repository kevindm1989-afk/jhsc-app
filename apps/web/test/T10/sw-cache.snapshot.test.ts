/**
 * T10 — Service-worker plaintext-cache allowlist (HG-3 / ADR-0013).
 *
 * Source obligations:
 *   - ADR-0013 — closed allowlist of URL patterns; `/api/**` is never cached;
 *     `X-Data-Class: C3|C4` response header forces no-cache; lock/logout/
 *     panic-wipe clears non-static caches; SW version bump invalidates all.
 *   - threat-model §8 T10 — F-10 (no /api/* response that returned C3 content
 *     ends up in Cache Storage).
 *   - audit-log.md §1 — `client.cache_policy_violation` enum value.
 *   - alerts.md (HG-3 / cache-policy regression detector).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installServiceWorkerInColdCache,
  loginAndVisit,
  enumerateCacheStorage,
  craftResponseWithDataClass,
  routeFetchThroughSW,
  triggerLockOrPanicWipe,
  bumpServiceWorkerVersion,
} from '../_helpers/sw-test-harness';
import expectedSnapshot from './sw-cache.expected-snapshot.json';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { SYNTHETIC_USER_A } from '../_helpers/fixtures';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  restoreClock();
  await supa.tearDown();
});

describe('T10 / HG-3 / ADR-0013 / F-10 — service-worker cache policy', () => {
  it('T10 / HG-3 (snapshot) — cold-cache + scripted login + visit → Cache Storage matches the frozen allowlist snapshot exactly', async () => {
    await installServiceWorkerInColdCache();
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginAndVisit(user, [
      '/',
      '/inspections',
      '/concerns',
      '/reprisal',
      '/minutes',
      '/library',
      '/feature-flags',
    ]);
    const actual = await enumerateCacheStorage();
    // Stable comparator: sort URLs; strip build-hash from `/_app/<chunk>.<hash>.js`.
    const normalize = (s: string) =>
      s.replace(/\/_app\/([^/]+)\.[a-f0-9]+\.(js|css)$/, '/_app/$1.[hash].$2');
    const actualSorted = actual
      .map((e) => ({ ...e, url: normalize(e.url) }))
      .sort((a, b) => a.url.localeCompare(b.url));
    const expectedSorted = (expectedSnapshot as any[]).slice().sort((a, b) =>
      a.url.localeCompare(b.url)
    );
    expect(actualSorted).toEqual(expectedSorted);
  });

  it('T10 / ADR-0013 rule 2 — ANY /api/** response is never placed in any cache', async () => {
    await installServiceWorkerInColdCache();
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginAndVisit(user, ['/api/concerns', '/api/feature-flags', '/api/minutes/some-id']);
    const actual = await enumerateCacheStorage();
    for (const entry of actual) {
      expect(entry.url).not.toMatch(/\/api\//);
    }
  });

  it('T10 / ADR-0013 rule 3 (sanity check) — response with `X-Data-Class: C3` header is forwarded to the page but NOT cached; cache_policy_violation audit queues', async () => {
    await installServiceWorkerInColdCache();
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const sess = await supa.loginAs(user);
    const fakeC3 = craftResponseWithDataClass('C3', { url: '/library/some-doc', body: 'plaintext-leak-attempt' });
    const piped = await routeFetchThroughSW(fakeC3);
    expect(piped.received_in_page).toBe(true);
    const cacheEntries = await enumerateCacheStorage();
    expect(cacheEntries.find((e) => e.url === '/library/some-doc')).toBeUndefined();
    await sess.flushOfflineAudit();
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'client.cache_policy_violation' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].meta.data_class).toBe('C3');
    expect(rows.rows[0].meta.route).toBe('/library/some-doc');
  });

  it('T10 / ADR-0013 rule 3 — `X-Data-Class: C4` response: same as C3 — never cached; violation queued', async () => {
    await installServiceWorkerInColdCache();
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const sess = await supa.loginAs(user);
    const fakeC4 = craftResponseWithDataClass('C4', { url: '/api/sensitive/read', body: 'c4-attempt' });
    await routeFetchThroughSW(fakeC4);
    const cacheEntries = await enumerateCacheStorage();
    expect(cacheEntries.find((e) => e.url === '/api/sensitive/read')).toBeUndefined();
    await sess.flushOfflineAudit();
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'client.cache_policy_violation' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].meta.data_class).toBe('C4');
  });

  it('T10 / ADR-0013 rule 4 — lock / logout / panic-wipe deletes every cache not in the static-asset allowlist', async () => {
    await installServiceWorkerInColdCache();
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginAndVisit(user, ['/', '/library', '/feature-flags']);
    await triggerLockOrPanicWipe('lock');
    const after = await enumerateCacheStorage();
    // Static-asset caches (the build allowlist of `/_app/**` etc.) remain;
    // dynamic caches (C0/C1 short-lived) are deleted.
    const dynamic = after.filter((e) => e.cache_name.includes('dynamic'));
    expect(dynamic).toEqual([]);
  });

  it('T10 / ADR-0013 rule 5 — service-worker version bump (build-hash mismatch) forces full cache rebuild', async () => {
    await installServiceWorkerInColdCache({ version: 'build-aaa' });
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginAndVisit(user, ['/library', '/feature-flags']);
    const before = await enumerateCacheStorage();
    expect(before.length).toBeGreaterThan(0);
    await bumpServiceWorkerVersion('build-bbb');
    const after = await enumerateCacheStorage();
    // All cache names from the prior build are gone.
    expect(after.find((e) => e.cache_name.includes('build-aaa'))).toBeUndefined();
  });
});
