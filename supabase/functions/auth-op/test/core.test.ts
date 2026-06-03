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
import type { CredentialRow, SessionRow, UserRow } from '../types.ts';

function depsWith(opts: {
  users?: Record<string, UserRow>;
  sessions?: Record<string, SessionRow>;
  userSessions?: Record<string, SessionRow[]>;
  userCredentials?: Record<string, CredentialRow[]>;
}): AuthOpDeps {
  return {
    async getUserById(user_id: string): Promise<UserRow | null> {
      return opts.users?.[user_id] ?? null;
    },
    async getSessionById(session_id: string): Promise<SessionRow | null> {
      return opts.sessions?.[session_id] ?? null;
    },
    async listActiveSessionsForUser(user_id: string): Promise<SessionRow[]> {
      return opts.userSessions?.[user_id] ?? [];
    },
    async listCredentialsForUser(user_id: string): Promise<CredentialRow[]> {
      return opts.userCredentials?.[user_id] ?? [];
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
    depsWith({ users: { [userId]: row } })
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

// ----------------------------------------------------------------------------
// get_session — read-only by session_id
// ----------------------------------------------------------------------------

const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001';
const sessionRow: SessionRow = {
  session_id: sessionId,
  user_id: '00000000-0000-4000-8000-000000000001',
  access_token: '',
  iat: 1_700_000_000_000,
  exp: 1_700_000_900_000,
  device_fingerprint: 'fp-hashed',
  revoked_at: null
};

Deno.test('handleAuthOp — get_session returns the row for an existing session', async () => {
  const result = await handleAuthOp(
    { op: 'get_session', session_id: sessionId },
    depsWith({ sessions: { [sessionId]: sessionRow } })
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data, sessionRow);
  }
});

Deno.test('handleAuthOp — get_session returns not_found for unknown id (404)', async () => {
  const result = await handleAuthOp(
    { op: 'get_session', session_id: 'zzzzzzzz-0000-4000-8000-000000000000' },
    depsWith({})
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, 'not_found');
    assertEquals(result.status, 404);
  }
});

Deno.test('handleAuthOp — get_session with no session_id returns bad_request (400)', async () => {
  const result = await handleAuthOp({ op: 'get_session' }, depsWith({}));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'bad_request');
});

// ----------------------------------------------------------------------------
// list_active_sessions — by user_id, empty list is a normal state
// ----------------------------------------------------------------------------

Deno.test('handleAuthOp — list_active_sessions returns the rows for the user', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const rows: SessionRow[] = [
    sessionRow,
    { ...sessionRow, session_id: 'aaaaaaaa-0000-4000-8000-000000000002' }
  ];
  const result = await handleAuthOp(
    { op: 'list_active_sessions', user_id: userId },
    depsWith({ userSessions: { [userId]: rows } })
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data, rows);
  }
});

Deno.test('handleAuthOp — list_active_sessions returns {ok:true, data:[]} when the user has no active sessions', async () => {
  // Empty result is NOT not_found — it's a normal state (e.g., right
  // after logout-everywhere). The dispatcher must return the empty
  // array, not 404.
  const result = await handleAuthOp(
    { op: 'list_active_sessions', user_id: '00000000-0000-4000-8000-000000000099' },
    depsWith({})
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data, []);
  }
});

Deno.test('handleAuthOp — list_active_sessions with no user_id returns bad_request (400)', async () => {
  const result = await handleAuthOp({ op: 'list_active_sessions' }, depsWith({}));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'bad_request');
});

// ----------------------------------------------------------------------------
// list_credentials_for_user — read-only by user_id
// ----------------------------------------------------------------------------

const credUserId = '00000000-0000-4000-8000-000000000001';
const credentialRow: CredentialRow = {
  credentialId: 'cred-abc',
  user_id: credUserId,
  rpId: 'jhsc.example',
  publicKey: '\\xdeadbeef',
  counter: 5,
  aaguid: 'd548b250-0000-4000-8000-000000000000',
  transports: ['internal'],
  device_label: 'iPhone (work)'
};

Deno.test('handleAuthOp — list_credentials_for_user returns the rows for the user', async () => {
  const result = await handleAuthOp(
    { op: 'list_credentials_for_user', user_id: credUserId },
    depsWith({ userCredentials: { [credUserId]: [credentialRow] } })
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data, [credentialRow]);
  }
});

Deno.test('handleAuthOp — list_credentials_for_user returns {ok:true, data:[]} for a user with no credentials', async () => {
  // A user mid-enrollment or post-revocation has zero credentials —
  // this is a normal state, NOT 404.
  const result = await handleAuthOp(
    { op: 'list_credentials_for_user', user_id: '00000000-0000-4000-8000-000000000099' },
    depsWith({})
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.data, []);
  }
});

Deno.test('handleAuthOp — list_credentials_for_user with no user_id returns bad_request (400)', async () => {
  const result = await handleAuthOp({ op: 'list_credentials_for_user' }, depsWith({}));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, 'bad_request');
});
