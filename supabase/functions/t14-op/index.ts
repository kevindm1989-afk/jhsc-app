/**
 * t14-op — Edge Function handler (T14.1; mirrors reprisal-op).
 *
 * Adapter-static, so this is an Edge Function (not a +server.ts). Builds a
 * JWT-bound supabase client; the work_refusal / s51_evidence RPCs run as the
 * caller's auth.uid() and gate F-21 internally. All ciphertext is client-sealed.
 *
 * Dispatch by op: wr_submit | wr_read | wr_update | s51_submit | s51_read |
 * s51_update. The pseudonymized feed is served by reprisal-op (the Amendment D
 * view already includes work_refusal.* / s51_evidence.* events).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import { assertSessionLive, SessionNotLiveError } from '../_shared/session-live-precheck.ts';
import { log, withFunctionName } from '../_shared/log.ts';
import {
  readS51,
  readWorkRefusal,
  submitS51,
  submitWorkRefusal,
  updateS51,
  updateWorkRefusal,
  type OpResult,
  type RpcPort
} from './core.ts';

withFunctionName('t14-op');

type Op =
  | { op: 'wr_submit'; title_ct: string; notes_ct: string; passphrase?: string | null }
  | { op: 'wr_read'; id: string; passphrase?: string | null }
  | { op: 'wr_update'; id: string; title_ct?: string; notes_ct?: string }
  | { op: 's51_submit'; title_ct: string; notes_ct: string; photos_ct?: string[]; passphrase?: string | null }
  | { op: 's51_read'; id: string; passphrase?: string | null }
  | { op: 's51_update'; id: string; title_ct?: string; notes_ct?: string };

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
      log.error({ event: 't14.key_parity.fail', outcome: 'mismatch' });
      return json({ error: 'service_unavailable' }, 503);
    }
    throw e;
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json({ error: 'rls_denied' }, 401);

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
    return { data, error: error ? { code: (error as { code?: string }).code ?? null, message: error.message } : null };
  };

  let body: Op;
  try { body = (await req.json()) as Op; } catch { return json({ error: 'bad_request' }, 400); }

  let result: OpResult<unknown>;
  switch (body.op) {
    case 'wr_submit':  result = await submitWorkRefusal(rpc, body); break;
    case 'wr_read':    result = await readWorkRefusal(rpc, body); break;
    case 'wr_update':  result = await updateWorkRefusal(rpc, body); break;
    case 's51_submit': result = await submitS51(rpc, body); break;
    case 's51_read':   result = await readS51(rpc, body); break;
    case 's51_update': result = await updateS51(rpc, body); break;
    default: return json({ ok: false, error: 'bad_request' }, 400);
  }

  log.info({ event: 't14.op', attributes: { route: body.op, outcome: result.ok ? 'ok' : result.reason }, request_id: requestId });
  if (result.ok) return json({ ok: true, data: result.data }, 200);
  return json({ ok: false, error: result.reason }, result.status);
});
