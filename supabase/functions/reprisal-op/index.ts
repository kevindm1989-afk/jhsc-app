/**
 * reprisal-op — Edge Function handler (T13.1; mirrors concern-op/index.ts).
 *
 * Runtime: Deno. Builds a JWT-bound supabase client so the reprisal RPCs run as
 * the caller's auth.uid() (gated by session_is_live + is_active_member inside
 * each), dispatches by op, and returns the {ok,reason,status} contract as JSON.
 *
 * Ops: submit | read | update | propose_status | approve_status |
 * propose_forensic | approve_forensic | feed. `read` is the HG-6 audited C4
 * read (audit-before-ciphertext); `feed` reads the Amendment D pseudonymized
 * reprisal_feed view. All ciphertext is client-sealed (E2EE); the wire carries
 * bytea hex. The dispatch + error mapping is unit-tested in test/core.test.ts;
 * index.ts is proven by the live stack (like committee-op / concern-op).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import { assertSessionLive, SessionNotLiveError } from '../_shared/session-live-precheck.ts';
import {
  approveForensic,
  approveStatus,
  proposeForensic,
  proposeStatus,
  readReprisal,
  submitReprisal,
  updateReprisal,
  type OpResult,
  type RpcPort
} from './core.ts';

withFunctionName('reprisal-op');

type Op =
  | { op: 'submit'; title_ct: string; body_ct: string; passphrase?: string | null }
  | { op: 'read'; id: string; passphrase?: string | null }
  | { op: 'update'; id: string; title_ct?: string; body_ct?: string }
  | { op: 'propose_status'; reprisal_id: string; new_status: string }
  | { op: 'approve_status'; pending_id: string }
  | { op: 'propose_forensic'; audit_log_id: string; reveal_reason: string }
  | { op: 'approve_forensic'; pending_id: string }
  | { op: 'feed' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  const requestId = req.headers.get('X-Request-ID') ?? undefined;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ADR-0024 §2 — cold-start HMAC pseudonym key parity check.
  try {
    await assertKeyParity();
  } catch (e) {
    if (e instanceof KeyParityError) {
      log.error({ event: 'reprisal.key_parity.fail', outcome: 'mismatch' });
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

  // `feed` is the Amendment D view read (pseudonymized), not an RPC.
  if (body.op === 'feed') {
    const { data, error } = await supabase.from('reprisal_feed').select('*');
    if (error) {
      log.warn({ event: 'reprisal.op', attributes: { route: 'feed', outcome: 'rls_denied' }, request_id: requestId });
      return json({ ok: false, error: 'rls_denied' }, 403);
    }
    log.info({ event: 'reprisal.op', attributes: { route: 'feed', outcome: 'ok' }, request_id: requestId });
    return json({ ok: true, data }, 200);
  }

  let result: OpResult<unknown>;
  switch (body.op) {
    case 'submit':
      result = await submitReprisal(rpc, body);
      break;
    case 'read':
      result = await readReprisal(rpc, body);
      break;
    case 'update':
      result = await updateReprisal(rpc, body);
      break;
    case 'propose_status':
      result = await proposeStatus(rpc, body);
      break;
    case 'approve_status':
      result = await approveStatus(rpc, body);
      break;
    case 'propose_forensic':
      result = await proposeForensic(rpc, body);
      break;
    case 'approve_forensic':
      result = await approveForensic(rpc, body);
      break;
    default:
      return json({ ok: false, error: 'bad_request' }, 400);
  }

  // Audit/observability: op + outcome only (no PI; reason is a closed literal).
  log.info({
    event: 'reprisal.op',
    attributes: { route: body.op, outcome: result.ok ? 'ok' : result.reason },
    request_id: requestId
  });

  if (result.ok) return json({ ok: true, data: result.data }, 200);
  return json({ ok: false, error: result.reason }, result.status);
});
