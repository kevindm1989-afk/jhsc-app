/**
 * auth-op / core test — dispatcher + get_user.
 *
 * Closes the first slice of G-T05-1: proves the op-dispatcher routes
 * correctly + that `get_user` returns the persistence layer's
 * UserRow shape unchanged on success and the canonical
 * `not_found` / `bad_request` / `not_implemented` envelopes on the
 * other paths.
 *
 * The dispatcher is the contract every future T05.1 PR extends; the
 * stubbed-default behaviour (`not_implemented` 501) is what the
 * browser-side `SupabaseAuthStore` depends on for the staged rollout.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handleAuthOp, type AuthOpDeps } from '../core.ts';
import type { UserRow } from '../types.ts';

function depsWith(rows: Record<string, UserRow>): AuthOpDeps {
  return {
    async getUserById(user_id: string): Promise<UserRow | null> {
      return rows[user_id] ?? null;
    }
  };
}

Deno.test('handleAuthOp — get_user returns the row for an existing user', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const row: UserRow = {
    id: userId,
    totp_destroyed_at: 1_700_000_000_000,
    role: 'authenticated',
    active: true
  };
  const result = await handleAuthOp(
    { op: 'get_user', user_id: userId },
    depsWith({ [userId]: row })
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data, row);
  }
});

Deno.test('handleAuthOp — get_user returns not_found for unknown user (404)', async () => {
  const result = await handleAuthOp(
    { op: 'get_user', user_id: '99999999-0000-4000-8000-000000000000' },
    depsWith({})
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, 'not_found');
    assertEquals(result.status, 404);
  }
});

Deno.test('handleAuthOp — get_user with no user_id returns bad_request (400)', async () => {
  const result = await handleAuthOp({ op: 'get_user' }, depsWith({}));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, 'bad_request');
    assertEquals(result.status, 400);
  }
});

Deno.test('handleAuthOp — get_user with empty user_id returns bad_request (400)', async () => {
  const result = await handleAuthOp(
    { op: 'get_user', user_id: '' },
    depsWith({})
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, 'bad_request');
    assertEquals(result.status, 400);
  }
});

Deno.test('handleAuthOp — unknown op returns not_implemented (501) — staged-rollout default', async () => {
  // The dispatcher's default branch is what the browser-side
  // SupabaseAuthStore depends on while the remaining ~30 AuthStore
  // methods land incrementally. Each future PR adds a case + tests.
  const result = await handleAuthOp(
    { op: 'consume_totp_and_enroll_passkey', user_id: 'x', totp_code: 'y' },
    depsWith({})
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, 'not_implemented');
    assertEquals(result.status, 501);
  }
});

Deno.test('handleAuthOp — empty / malformed input returns bad_request (400)', async () => {
  // Tests both the missing-op case and the non-string op case.
  const r1 = await handleAuthOp({ op: '' as unknown as string }, depsWith({}));
  assertEquals(r1.ok, false);
  if (!r1.ok) assertEquals(r1.reason, 'not_implemented'); // default case via empty string

  const r2 = await handleAuthOp(
    { op: 123 as unknown as string },
    depsWith({})
  );
  assertEquals(r2.ok, false);
  if (!r2.ok) {
    assertEquals(r2.reason, 'bad_request');
    assertEquals(r2.status, 400);
  }
});
