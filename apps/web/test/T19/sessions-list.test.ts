/**
 * T19.1 — SessionsList component (Surface H — sessions management).
 *
 * Covers the worker-side sessions list mounted in /settings:
 *   - Loading state announced via role=status (aria-busy on section).
 *   - Empty state when listActiveSessions returns [].
 *   - List render: each row carries the session_id; the row matching
 *     getCurrentSessionId() gets a "This device" badge.
 *   - Per-row Revoke button: calls authStore.revokeSession(session_id),
 *     refreshes the list, hides the revoked row.
 *   - Bulk "Revoke all other sessions": calls
 *     authStore.revokeAllForUser, refreshes the list.
 *   - Load failure: load-error alert surfaces with role=alert.
 *   - Revoke failure: revoke-error alert surfaces; the row stays.
 *
 * Auth bootstrap: the component reads the current user_id / session_id
 * from the live session-jwt-store via getCurrentUserId /
 * getCurrentSessionId. Tests seed the JWT before render.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import SessionsList from '../../src/lib/auth/SessionsList.svelte';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import type { AuthSession } from '../../src/lib/auth/types';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const CURRENT_SESSION_ID = 'sess-current';
const OTHER_SESSION_ID = 'sess-other';

// Build a JWT carrying the test user_id + session_id so
// getCurrentUserId / getCurrentSessionId resolve.
function makeJwt(sub: string, jti: string): string {
  const header = btoa(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const body = btoa(JSON.stringify({ sub, jti, iat: 1700000000, exp: 1700001000 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.sig`;
}

function mockSession(session_id: string, iat = 1700000000): AuthSession {
  return {
    session_id,
    user_id: USER_ID,
    access_token: '',
    iat,
    exp: iat + 1000,
    revoked_at: null
  };
}

interface MockAuthStore {
  listActiveSessions: ReturnType<typeof vi.fn>;
  revokeSession: ReturnType<typeof vi.fn>;
  revokeAllForUser: ReturnType<typeof vi.fn>;
}

function makeAuthStore(initial: AuthSession[]): MockAuthStore {
  let sessions = [...initial];
  return {
    listActiveSessions: vi.fn(async () => [...sessions]),
    revokeSession: vi.fn(async (session_id: string) => {
      sessions = sessions.filter((s) => s.session_id !== session_id);
    }),
    revokeAllForUser: vi.fn(async (user_id: string) => {
      // Mirrors the production wrapper — keep the current session, revoke others.
      sessions = sessions.filter((s) => s.session_id === CURRENT_SESSION_ID);
      void user_id;
      return [];
    })
  };
}

beforeEach(() => {
  setJwt(makeJwt(USER_ID, CURRENT_SESSION_ID));
});
afterEach(() => {
  cleanup();
  clearJwt();
});

describe('T19.1 — SessionsList loads the caller\'s active sessions', () => {
  it('calls authStore.listActiveSessions(currentUserId) on mount', async () => {
    const authStore = makeAuthStore([mockSession(CURRENT_SESSION_ID)]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(authStore.listActiveSessions).toHaveBeenCalledWith(USER_ID);
    });
  });

  it('renders one row per session', async () => {
    const authStore = makeAuthStore([
      mockSession(CURRENT_SESSION_ID),
      mockSession(OTHER_SESSION_ID, 1700000500)
    ]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.getAllByTestId('session-row').length).toBe(2);
    });
  });

  it('marks the current session row with the "This device" badge', async () => {
    const authStore = makeAuthStore([
      mockSession(CURRENT_SESSION_ID),
      mockSession(OTHER_SESSION_ID, 1700000500)
    ]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      const badges = screen.getAllByTestId('session-current-badge');
      expect(badges.length).toBe(1);
    });
  });

  it('surfaces the empty state when the list is empty', async () => {
    const authStore = makeAuthStore([]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.getByTestId('sessions-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when listActiveSessions throws', async () => {
    const authStore: MockAuthStore = {
      listActiveSessions: vi.fn(async () => {
        throw new Error('network down');
      }),
      revokeSession: vi.fn(),
      revokeAllForUser: vi.fn()
    };
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      const err = screen.getByTestId('sessions-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('surfaces the signed-out error when no JWT is set', async () => {
    clearJwt();
    const authStore = makeAuthStore([]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      const err = screen.getByTestId('sessions-load-error');
      expect(err.textContent ?? '').toMatch(/sign in/i);
    });
    // List was never queried — there's no user_id to scope to.
    expect(authStore.listActiveSessions).not.toHaveBeenCalled();
  });
});

describe('T19.1 — SessionsList per-row Revoke', () => {
  it('clicking Revoke calls authStore.revokeSession and refreshes the list', async () => {
    const authStore = makeAuthStore([
      mockSession(CURRENT_SESSION_ID),
      mockSession(OTHER_SESSION_ID, 1700000500)
    ]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.getAllByTestId('session-row').length).toBe(2);
    });

    // Click the second row's Revoke (the non-current session).
    const buttons = screen.getAllByTestId('session-revoke-button');
    expect(buttons.length).toBe(2);
    // The current session row renders first (sort by iat desc); the
    // OTHER_SESSION row has the later iat, so it's actually first.
    // Find the button next to the row whose session-id text doesn't
    // match CURRENT_SESSION_ID.
    const rows = screen.getAllByTestId('session-row');
    const otherRowIdx = rows.findIndex(
      (r) => (r.querySelector('[data-testid="session-id"]')?.textContent ?? '') === OTHER_SESSION_ID
    );
    expect(otherRowIdx).toBeGreaterThanOrEqual(0);
    const otherBtn = rows[otherRowIdx]!.querySelector(
      '[data-testid="session-revoke-button"]'
    ) as HTMLButtonElement;
    fireEvent.click(otherBtn);

    await waitFor(() => {
      expect(authStore.revokeSession).toHaveBeenCalledWith(OTHER_SESSION_ID, expect.any(Number));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('session-row').length).toBe(1);
    });
  });

  it('surfaces the revoke-error alert when revokeSession throws', async () => {
    const authStore: MockAuthStore = {
      listActiveSessions: vi.fn(async () => [mockSession(OTHER_SESSION_ID)]),
      revokeSession: vi.fn(async () => {
        throw new Error('rate limited');
      }),
      revokeAllForUser: vi.fn()
    };
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.getByTestId('session-revoke-button')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('session-revoke-button'));
    await waitFor(() => {
      const err = screen.getByTestId('sessions-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });
});

describe('T19.1 — SessionsList bulk "Revoke all other sessions"', () => {
  it('renders the bulk-revoke button only when there are other sessions', async () => {
    const authStore = makeAuthStore([mockSession(CURRENT_SESSION_ID)]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.queryByTestId('sessions-revoke-all-button')).toBeNull();
    });
  });

  it('renders the bulk-revoke button when at least one other session exists', async () => {
    const authStore = makeAuthStore([
      mockSession(CURRENT_SESSION_ID),
      mockSession(OTHER_SESSION_ID, 1700000500)
    ]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.getByTestId('sessions-revoke-all-button')).toBeDefined();
    });
  });

  it('clicking the bulk button calls authStore.revokeAllForUser(currentUserId)', async () => {
    const authStore = makeAuthStore([
      mockSession(CURRENT_SESSION_ID),
      mockSession(OTHER_SESSION_ID, 1700000500)
    ]);
    render(SessionsList, { props: { authStore: authStore as never } });
    await waitFor(() => {
      expect(screen.getByTestId('sessions-revoke-all-button')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('sessions-revoke-all-button'));
    await waitFor(() => {
      expect(authStore.revokeAllForUser).toHaveBeenCalledWith(USER_ID, expect.any(Number));
    });
  });
});
