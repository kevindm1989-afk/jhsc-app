/**
 * concern-op — Edge Function handler (T08.1; mirrors committee-op/index.ts).
 *
 * Runtime: Deno (Supabase Edge Function). Composes the tested core.ts: extracts
 * the caller's minted GoTrue JWT, builds a JWT-bound supabase client so the
 * concern RPCs run as the real auth.uid() (and session_is_live()/
 * is_active_member() gate inside each), dispatches by op, and returns the
 * {ok,reason,status} contract as JSON.
 *
 * Ops: submit | update | reveal | list. `list` reads concerns_default_view
 * (F-18 — no source_name_ct). All ciphertext is sealed client-side (E2EE); the
 * wire carries bytea as PostgREST hex (`\x…`).
 *
 * Verified end-to-end by the live `supabase start` CI stage; the dispatch +
 * error-mapping logic is unit-tested in test/core.test.ts.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
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

Deno.serve(async (req) => {
  const requestId = req.headers.get('X-Request-ID') ?? undefined;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'rls_denied' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }
  );

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

  // `list` is a view read (F-18), not an RPC — handle it directly.
  if (body.op === 'list') {
    const { data, error } = await supabase.from('concerns_default_view').select('*');
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
