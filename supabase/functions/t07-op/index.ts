/**
 * t07-op — Edge Function handler (T07.1 increment 2; mirrors t14-op).
 *
 * Adapter-static, so this is an Edge Function (not a +server.ts). Builds a
 * JWT-bound supabase client; the T07.1 RPCs run as the caller's auth.uid()
 * and gate authz (session-live, active member, co-chair) internally. All key
 * material is client-sealed (ADR-0003 Invariant 1).
 *
 * Dispatch by op:
 *   enroll_identity | store_recovery | record_restored | record_viewed |
 *   issue_reset     | init_key       | wrap_member     | record_unwrap  |
 *   rotate          | finalize_rotate| revoke_member
 *
 * Deferred to subsequent T07.1 increments (per the keystone PR plan):
 *   - F-02 sealed-box enrollment challenge (G-T07-9)
 *   - SupabaseKeyStore (G-T07-2) + KeyStore interface split (G-T07-10/15)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
import {
  enrollIdentityKeypair,
  finalizeCommitteeDataKeyRotation,
  initCommitteeDataKey,
  issueRecoveryBlobReset,
  recordCommitteeDataKeyUnwrap,
  recordRecoveryBlobRestored,
  recordRecoveryBlobViewed,
  revokeCommitteeMember,
  rotateCommitteeDataKey,
  storeRecoveryBlob,
  wrapCommitteeDataKeyForMember,
  type OpResult,
  type RotationTrigger,
  type RpcPort
} from './core.ts';

withFunctionName('t07-op');

type Op =
  | { op: 'enroll_identity'; public_key_hex: string; pubkey_fingerprint: string }
  | { op: 'store_recovery'; blob_ciphertext_hex: string; kdf_params: Record<string, unknown> }
  | { op: 'record_restored'; device_fingerprint_hashed: string }
  | { op: 'record_viewed'; enrollment_session_id: string }
  | { op: 'issue_reset'; target_user_id: string }
  | { op: 'init_key' }
  | {
      op: 'wrap_member';
      member_user_id: string;
      key_id: string;
      wrapped_ciphertext_hex: string;
      rotation_id?: string | null;
    }
  | { op: 'record_unwrap'; key_id: string }
  | { op: 'rotate'; trigger: RotationTrigger }
  | {
      op: 'finalize_rotate';
      rotation_id: string;
      new_key_id: string;
      members_rewrapped_count: number;
    }
  | { op: 'revoke_member'; removed_member_id: string; rotation_id: string };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  const requestId = req.headers.get('X-Request-ID') ?? undefined;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json({ error: 'rls_denied' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }
  );

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

  let result: OpResult<unknown>;
  switch (body.op) {
    case 'enroll_identity':
      result = await enrollIdentityKeypair(rpc, body);
      break;
    case 'store_recovery':
      result = await storeRecoveryBlob(rpc, body);
      break;
    case 'record_restored':
      result = await recordRecoveryBlobRestored(rpc, body);
      break;
    case 'record_viewed':
      result = await recordRecoveryBlobViewed(rpc, body);
      break;
    case 'issue_reset':
      result = await issueRecoveryBlobReset(rpc, body);
      break;
    case 'init_key':
      result = await initCommitteeDataKey(rpc);
      break;
    case 'wrap_member':
      result = await wrapCommitteeDataKeyForMember(rpc, body);
      break;
    case 'record_unwrap':
      result = await recordCommitteeDataKeyUnwrap(rpc, body);
      break;
    case 'rotate':
      result = await rotateCommitteeDataKey(rpc, body);
      break;
    case 'finalize_rotate':
      result = await finalizeCommitteeDataKeyRotation(rpc, body);
      break;
    case 'revoke_member':
      result = await revokeCommitteeMember(rpc, body);
      break;
    default:
      return json({ ok: false, error: 'bad_request' }, 400);
  }

  log.info({
    event: 't07.op',
    attributes: { route: body.op, outcome: result.ok ? 'ok' : result.reason },
    request_id: requestId
  });
  if (result.ok) return json({ ok: true, data: result.data }, 200);
  return json({ ok: false, error: result.reason }, result.status);
});
