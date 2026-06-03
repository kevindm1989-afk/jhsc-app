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
import type { UserRow } from './types.ts';

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
    }
  });

  if (!result.ok) {
    return json({ ok: false, reason: result.reason }, result.status);
  }
  return json({ ok: true, data: result.data }, 200);
});
