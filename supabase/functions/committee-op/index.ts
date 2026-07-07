/**
 * committee-op — Edge Function handler (ADR-0023 increment 5).
 *
 * Runtime: Deno (Supabase Edge Function). Composes the tested `core.ts`:
 * extracts the caller's minted GoTrue JWT from the Authorization header,
 * builds a JWT-bound supabase client so the committee RPCs run as the real
 * auth.uid() (and session_is_live() consults the jti), dispatches by op, and
 * returns the {ok,reason,status} contract as JSON.
 *
 * Verified end-to-end by the live `supabase start` CI stage; the dispatch +
 * error-mapping logic is unit-tested in test/core.test.ts.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import { assertSessionLive, SessionNotLiveError } from '../_shared/session-live-precheck.ts';
import { serveWithCors } from '../_shared/cors.ts';
import {
  activateMembership,
  inviteMember,
  issueInvite,
  listPendingInvites,
  listRoster,
  reactivateMember,
  reissueTotp,
  removeMember,
  setRoles,
  type OpResult,
  type RpcPort
} from './core.ts';

withFunctionName('committee-op');

type Op =
  | {
      op: 'invite';
      target_user_id: string;
      roles: string[];
      display_name?: string | null;
      off_employer_contact?: string | null;
    }
  | { op: 'activate'; invite_id: string; enrolling_uid: string }
  | { op: 'set_roles'; target_user_id: string; roles: string[]; second_approver_id?: string | null }
  | { op: 'remove'; target_user_id: string; second_approver_id?: string | null }
  | { op: 'reactivate'; target_user_id: string }
  // ADR-0029 P1-3 — new co-chair-side issuance arm. The raw 6-digit `code`
  // rides this body only; it is forwarded into `issue_member_invite` and
  // NEVER touches any log line / outcome attribute (F-176 / Decision 8).
  | { op: 'issue_invite'; roles: string[]; code: string; ttl_minutes: number }
  // ADR-0029 P1-6 — co-chair-side "re-send code" arm. Re-arms a fresh 15-min
  // TOTP against an EXISTING invite; carries NO ttl_minutes / roles (re-send
  // does not re-issue the invite). The raw 6-digit `code` rides this body only;
  // it is forwarded into `reissue_member_totp` and NEVER touches any log line /
  // outcome attribute (F-176 / Decision 8).
  | { op: 'reissue_totp'; invite_id: string; code: string }
  // ADR-0029 P1-8a — the TWO co-chair-gated READ arms (Amendment A-8.3). Both
  // are PARAMETERLESS (the co-chair identity is the JWT-bound auth.uid(), the
  // roster/pending-invite list is whole-committee) and forward a SETOF RPC
  // co-chair-gated SQL-side (F-178). NO new EF-level gate — the existing
  // method / key-parity / session-live prechecks cover them.
  | { op: 'list_roster' }
  | { op: 'list_pending_invites' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function dispatch(rpc: RpcPort, body: Op): Promise<OpResult<unknown>> {
  switch (body.op) {
    case 'invite':
      return inviteMember(rpc, body);
    case 'activate':
      return activateMembership(rpc, body);
    case 'set_roles':
      return setRoles(rpc, body);
    case 'remove':
      return removeMember(rpc, body);
    case 'reactivate':
      return reactivateMember(rpc, body);
    case 'issue_invite':
      return issueInvite(rpc, body);
    case 'reissue_totp':
      return reissueTotp(rpc, body);
    case 'list_roster':
      return listRoster(rpc);
    case 'list_pending_invites':
      return listPendingInvites(rpc);
    default:
      return { ok: false, reason: 'unknown', status: 400 };
  }
}

serveWithCors(async (req) => {
  const requestId = req.headers.get('X-Request-ID');
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ADR-0024 §2 — cold-start HMAC pseudonym key parity check.
  try {
    await assertKeyParity();
  } catch (e) {
    if (e instanceof KeyParityError) {
      log.error({ event: 'committee.key_parity.fail', outcome: 'mismatch' });
      return json({ error: 'service_unavailable' }, 503);
    }
    throw e;
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'rls_denied' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }
  );

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
      return json({ error: 'rls_denied' }, 401);
    }
    throw e;
  }

  // Adapt supabase-js .rpc() to the core's RpcPort shape.
  const rpc: RpcPort = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    return {
      data,
      error: error
        ? { code: (error as { code?: string }).code ?? null, message: error.message }
        : null
    };
  };

  let body: Op;
  try {
    body = (await req.json()) as Op;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const result = await dispatch(rpc, body);
  // Audit/observability: only the op + outcome (no PI; reason is a closed literal).
  log.info({
    event: 'committee.op',
    attributes: { route: body?.op ?? 'unknown', outcome: result.ok ? 'ok' : result.reason },
    requestId: requestId ?? undefined
  });

  if (result.ok) return json({ ok: true, data: result.data }, 200);
  return json({ ok: false, error: result.reason }, result.status);
});
