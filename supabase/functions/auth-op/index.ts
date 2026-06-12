/**
 * auth-op — Edge Function HTTP handler (T05.1 / G-T05-1 entry point).
 *
 * Runtime: Deno (Supabase Edge Function). The auth-op dispatcher routes
 * every browser-side `AuthStore` method call through one endpoint
 * (`/functions/v1/auth-op`) — same op-dispatch pattern as concern-op,
 * reprisal-op, t07-op.
 *
 * verify_jwt = TRUE for every op except those that ship without a
 * caller session (none yet wired). The caller's session is validated
 * against `auth_sessions.revoked_at` upstream by the project's session-
 * is-live middleware (F-116) before any handler code runs.
 *
 * The security-critical orchestration is the testable `core.ts`; this
 * file is the Deno.serve + JSON envelope wrapper.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import { assertSessionLive, SessionNotLiveError } from '../_shared/session-live-precheck.ts';
import { handleAuthOp, type AuthOpInput } from './core.ts';
import type { CredentialRow, SessionRow, UserRow } from './types.ts';

// Convert a Postgres timestamptz (ISO 8601 string) to ms-epoch as the
// AuthStore interface expects. `null` and `undefined` pass through.
function tsToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

withFunctionName('auth-op');

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function callerClient(authorization: string | null) {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  return createClient(url, anon, {
    global: { headers: { Authorization: authorization ?? '', apikey: anon } },
    auth: { persistSession: false }
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ ok: false, reason: 'bad_request', status: 405 }, 405);
  }

  // ADR-0024 §2 — cold-start HMAC pseudonym key parity check.
  // Memoised per-process after first match; throws on mismatch so a process
  // running under a stale env-var key cannot silently corrupt the audit trail.
  try {
    await assertKeyParity();
  } catch (e) {
    if (e instanceof KeyParityError) {
      log.error({ event: 'auth.key_parity.fail', outcome: 'mismatch' });
      return json({ ok: false, reason: 'service_unavailable', status: 503 }, 503);
    }
    throw e;
  }

  let input: AuthOpInput;
  try {
    input = (await req.json()) as AuthOpInput;
  } catch {
    return json({ ok: false, reason: 'bad_request', status: 400 }, 400);
  }

  const supabase = callerClient(req.headers.get('authorization'));

  // F-116 / ADR-0023 Amendment A — dispatcher-side session_is_live precheck.
  // BELT-AND-BRACES with the existing SECURITY DEFINER RPCs that also check
  // session_is_live() internally. Fails fast on a revoked session BEFORE any
  // other DB round-trip. The CI grep scripts/verify-session-live-uniformity.sh
  // structurally requires this call before the first privileged RPC.
  try {
    await assertSessionLive(async () => {
      const { data, error } = await supabase.rpc('session_is_live');
      return !error && data === true;
    });
  } catch (e) {
    if (e instanceof SessionNotLiveError) {
      return json({ ok: false, reason: 'rls_denied', status: 401 }, 401);
    }
    throw e;
  }

  const result = await handleAuthOp(input, {
    async getUserById(user_id: string): Promise<UserRow | null> {
      // The browser-side AuthStore.getUser uses RLS auth.uid() to
      // ensure the caller can only see themselves; RLS enforces that
      // here via the Authorization-bound caller client.
      const { data, error } = await supabase
        .from('users')
        .select('id, totp_destroyed_at, role, active')
        .eq('id', user_id)
        .maybeSingle();

      if (error) {
        log.error({ event: 'auth.get_user.query_failed', error_class: error.code });
        return null;
      }
      if (!data) return null;
      return data as UserRow;
    },

    async getSessionById(session_id: string): Promise<SessionRow | null> {
      // RLS policy `auth_sessions_select_self` enforces caller-scoped
      // visibility: `auth.uid() = user_id`. A row owned by another
      // user surfaces as null rather than a permission error.
      const { data, error } = await supabase
        .from('auth_sessions')
        .select('session_id, user_id, device_fingerprint, created_at, expires_at, revoked_at')
        .eq('session_id', session_id)
        .maybeSingle();

      if (error) {
        log.error({ event: 'auth.get_session.query_failed', error_class: error.code });
        return null;
      }
      if (!data) return null;
      return {
        session_id: data.session_id as string,
        user_id: data.user_id as string,
        access_token: '', // F-117: server never re-emits the minted token
        iat: tsToMs(data.created_at as string | null) ?? 0,
        exp: tsToMs(data.expires_at as string | null) ?? 0,
        device_fingerprint: (data.device_fingerprint as string | null) ?? undefined,
        revoked_at: tsToMs(data.revoked_at as string | null)
      };
    },

    async listActiveSessionsForUser(user_id: string): Promise<SessionRow[]> {
      // `revoked_at IS NULL` filters server-side; RLS still enforces
      // the caller can only see their own rows (auth.uid() = user_id).
      const { data, error } = await supabase
        .from('auth_sessions')
        .select('session_id, user_id, device_fingerprint, created_at, expires_at, revoked_at')
        .eq('user_id', user_id)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });

      if (error) {
        log.error({ event: 'auth.list_active_sessions.query_failed', error_class: error.code });
        return [];
      }
      if (!data) return [];
      return data.map((row) => ({
        session_id: row.session_id as string,
        user_id: row.user_id as string,
        access_token: '' as const,
        iat: tsToMs(row.created_at as string | null) ?? 0,
        exp: tsToMs(row.expires_at as string | null) ?? 0,
        device_fingerprint: (row.device_fingerprint as string | null) ?? undefined,
        revoked_at: tsToMs(row.revoked_at as string | null)
      }));
    },

    async revokeMySession(
      session_id: string
    ): Promise<{ ok: true } | { ok: false; reason: 'rls_denied' | 'unknown'; status: number }> {
      // `revoke_my_session` is the authenticated-grantable wrapper
      // added in migration 12. It verifies caller ownership (auth.uid()
      // = session.user_id) inside the SECURITY DEFINER body and
      // delegates the UPDATE + audit emission to the canonical
      // `revoke_session` function.
      const { error } = await supabase.rpc('revoke_my_session', {
        p_session_id: session_id
      });
      if (error) {
        // 42501 maps to rls_denied / 403 — the wrapper raises this for
        // both "session does not exist" AND "session belongs to a
        // different user" (avoids leaking which session_ids are valid).
        if (error.code === '42501') {
          return { ok: false, reason: 'rls_denied', status: 403 };
        }
        log.error({
          event: 'auth.revoke_my_session.rpc_failed',
          error_class: error.code
        });
        return { ok: false, reason: 'unknown', status: 500 };
      }
      return { ok: true };
    },

    async revokeAllMySessions() {
      // `revoke_all_my_sessions` is the migration-13 sibling wrapper:
      // bulk-revokes every active session for the caller, returns the
      // count. The RPC returns a single integer; supabase-js gives it
      // back as `data` on success.
      const { data, error } = await supabase.rpc('revoke_all_my_sessions');
      if (error) {
        if (error.code === '42501') {
          return { ok: false as const, reason: 'rls_denied' as const, status: 403 };
        }
        log.error({
          event: 'auth.revoke_all_my_sessions.rpc_failed',
          error_class: error.code
        });
        return { ok: false as const, reason: 'unknown' as const, status: 500 };
      }
      return { ok: true as const, data: { revoked_count: Number(data ?? 0) } };
    },

    async revokeMyPasskey(credential_id: string) {
      // `revoke_my_passkey` is the migration-13 sibling wrapper:
      // verifies caller ownership of the credential, DELETEs it,
      // emits an `auth.passkey.revoked` audit row.
      const { error } = await supabase.rpc('revoke_my_passkey', {
        p_credential_id: credential_id
      });
      if (error) {
        if (error.code === '42501') {
          return { ok: false as const, reason: 'rls_denied' as const, status: 403 };
        }
        log.error({
          event: 'auth.revoke_my_passkey.rpc_failed',
          error_class: error.code
        });
        return { ok: false as const, reason: 'unknown' as const, status: 500 };
      }
      return { ok: true as const };
    },

    async callerUid(): Promise<string | null> {
      // Resolves the caller's auth.uid() from the JWT. Used by the
      // dispatcher to enforce that the AuthStore.revokeAllForUser
      // `user_id` argument matches the caller — defense-in-depth on
      // top of the SQL wrapper's own auth.uid() derivation.
      const { data, error } = await supabase.auth.getUser();
      if (error || !data?.user) return null;
      return data.user.id;
    },

    async listCredentialsForUser(user_id: string): Promise<CredentialRow[]> {
      // RLS policy `webauthn_credentials_select_self` enforces
      // auth.uid() = user_id. The query selects the snake_case
      // columns and renames them to the PasskeyCredential camelCase
      // form so the browser-side AuthStore can consume the response
      // without further mapping.
      const { data, error } = await supabase
        .from('webauthn_credentials')
        .select('credential_id, user_id, public_key, counter, aaguid, transports, device_label, rp_id')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false });

      if (error) {
        log.error({ event: 'auth.list_credentials_for_user.query_failed', error_class: error.code });
        return [];
      }
      if (!data) return [];
      return data.map((row) => ({
        credentialId: row.credential_id as string,
        user_id: row.user_id as string,
        rpId: row.rp_id as string,
        // PostgREST returns bytea as `\x<hex>`; the browser-side
        // doesn't validate the key cryptographically (mint-session
        // does that), so the hex form passes through.
        publicKey: row.public_key as string,
        counter: Number(row.counter ?? 0),
        aaguid: (row.aaguid as string | null) ?? '',
        transports: (row.transports as string[] | null) ?? [],
        device_label: (row.device_label as string | null) ?? ''
      }));
    }
  });

  if (!result.ok) {
    return json({ ok: false, reason: result.reason }, result.status);
  }
  return json({ ok: true, data: result.data }, 200);
});
