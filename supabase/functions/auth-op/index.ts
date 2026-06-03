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

  let input: AuthOpInput;
  try {
    input = (await req.json()) as AuthOpInput;
  } catch {
    return json({ ok: false, reason: 'bad_request', status: 400 }, 400);
  }

  const supabase = callerClient(req.headers.get('authorization'));

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
