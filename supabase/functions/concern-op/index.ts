/**
 * concern-op — Edge Function handler (T08.1; mirrors committee-op/index.ts).
 *
 * Runtime: Deno (Supabase Edge Function). Composes the tested core.ts: extracts
 * the caller's minted GoTrue JWT, builds a JWT-bound supabase client so the
 * concern RPCs run as the real auth.uid() (and session_is_live()/
 * is_active_member() gate inside each), dispatches by op, and returns the
 * {ok,reason,status} contract as JSON.
 *
 * Ops: submit | update | reveal | list. `list` calls the SECURITY DEFINER RPC
 * `concern_list_default` (migration 0040 — supersedes the direct
 * `concerns_default_view` read so the authenticated PostgREST role does not hit
 * the PG view-invoker EXECUTE check on the REVOKE'd `_committee_pseudonym`; same
 * F-18 no-source_name_ct rows + shape). All ciphertext is sealed client-side
 * (E2EE); the wire carries bytea as PostgREST hex (`\x…`).
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
  revealSource,
  submitConcern,
  updateConcern,
  type OpResult,
  type RpcPort
} from './core.ts';

withFunctionName('concern-op');

type Op =
  | { op: 'submit'; title_ct: string; body_ct: string; hazard_class: string; severity: string; location_id: string; anonymous: boolean; source_name_ct?: string | null; source_passphrase?: string | null }
  | { op: 'update'; id: string; title_ct?: string; body_ct?: string; hazard_class?: string; severity?: string; location_id?: string }
  | { op: 'reveal'; id: string; passphrase?: string | null }
  | { op: 'list' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

serveWithCors(async (req) => {
  const requestId = req.headers.get('X-Request-ID') ?? undefined;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ADR-0024 §2 — cold-start HMAC pseudonym key parity check.
  try {
    await assertKeyParity();
  } catch (e) {
    if (e instanceof KeyParityError) {
      log.error({ event: 'concern.key_parity.fail', outcome: 'mismatch' });
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

  const rpc: RpcPort = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    return {
      data,
      error: error ? { code: (error as { code?: string }).code ?? null, message: error.message } : null
    };
  };

  let body: Op;
  try {
    body = (await req.json()) as Op;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  // `list` reads via the SECURITY DEFINER RPC `concern_list_default` (migration
  // 0040), NOT a direct `concerns_default_view` SELECT. PostgreSQL requires the
  // view INVOKER to hold EXECUTE on `_committee_pseudonym` (which the widened
  // view at migration 0039 calls), but that helper is REVOKE'd from the
  // `authenticated` role (deanonymization lock-down, 0002:205) — so the direct
  // view read raises permission-denied for the authenticated PostgREST caller.
  // The RPC derives the pseudonym under the definer's rights and keeps the same
  // F-18 (no source_name_ct) / F-149 (no raw actor_id) rows + shape the view
  // returned. The session_is_live()/is_active_member() gate stays per-caller.
  if (body.op === 'list') {
    const { data, error } = await supabase.rpc('concern_list_default');
    if (error) {
      log.warn({ event: 'concern.op', attributes: { route: 'list', outcome: 'rls_denied' }, request_id: requestId });
      return json({ ok: false, error: 'rls_denied' }, 403);
    }
    log.info({ event: 'concern.op', attributes: { route: 'list', outcome: 'ok' }, request_id: requestId });
    return json({ ok: true, data }, 200);
  }

  let result: OpResult<unknown>;
  switch (body.op) {
    case 'submit':
      result = await submitConcern(rpc, body);
      break;
    case 'update':
      result = await updateConcern(rpc, body);
      break;
    case 'reveal':
      result = await revealSource(rpc, body);
      break;
    default:
      return json({ ok: false, error: 'bad_request' }, 400);
  }

  // Audit/observability: op + outcome only (no PI; reason is a closed literal).
  log.info({
    event: 'concern.op',
    attributes: { route: body.op, outcome: result.ok ? 'ok' : result.reason },
    request_id: requestId
  });

  if (result.ok) return json({ ok: true, data: result.data }, 200);
  return json({ ok: false, error: result.reason }, result.status);
});
